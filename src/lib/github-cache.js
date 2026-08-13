const DATABASE_NAME = 'repolens-github-cache'
// Version 2 discards v1 entries. V1 could persist an authenticated object
// response before re-checking that its repository was still public.
const DATABASE_VERSION = 2
const ENTRY_STORE = 'entries'
const META_STORE = 'meta'
const META_KEY = 'cache-state'

const MEBIBYTE = 1024 * 1024

export const GITHUB_CACHE_POLICY = Object.freeze({
  metadataTtlMs: 15 * 60 * 1000,
  headTtlMs: 3 * 60 * 1000,
  immutableTtlMs: 30 * 24 * 60 * 60 * 1000,
  highWaterBytes: 64 * MEBIBYTE,
  targetBytes: 48 * MEBIBYTE,
  volatileHighWaterBytes: 16 * MEBIBYTE,
  volatileTargetBytes: 12 * MEBIBYTE,
  volatileMaxTtlMs: 5 * 60 * 1000,
})

/**
 * Bounded persistent and volatile caches for GitHub repository resources.
 *
 * The cache deliberately stores only the caller's normalized payload. It never
 * receives a Request, Response, headers, or credentials. Concurrent consumers
 * share one loader, while each consumer retains independent cancellation.
 * Loads marked `persist: false` keep their results only in the current worker's
 * bounded memory cache, isolated by the supplied coalescing key.
 */
export class GitHubResourceCache {
  constructor(options = {}) {
    this.storage = options.storage ?? createIndexedDbStorage(options.indexedDBImpl)
    this.clock = options.clock ?? (() => Date.now())
    this.highWaterBytes = positiveInteger(options.highWaterBytes, GITHUB_CACHE_POLICY.highWaterBytes)
    this.targetBytes = positiveInteger(options.targetBytes, GITHUB_CACHE_POLICY.targetBytes)
    if (this.targetBytes > this.highWaterBytes) {
      throw new TypeError('GitHub cache target size cannot exceed its high-water size.')
    }
    this.volatileHighWaterBytes = positiveInteger(
      options.volatileHighWaterBytes,
      GITHUB_CACHE_POLICY.volatileHighWaterBytes,
    )
    this.volatileTargetBytes = positiveInteger(
      options.volatileTargetBytes,
      GITHUB_CACHE_POLICY.volatileTargetBytes,
    )
    if (this.volatileTargetBytes > this.volatileHighWaterBytes) {
      throw new TypeError('GitHub volatile cache target size cannot exceed its high-water size.')
    }
    this.volatileMaxTtlMs = positiveInteger(
      options.volatileMaxTtlMs,
      GITHUB_CACHE_POLICY.volatileMaxTtlMs,
    )
    this.inFlight = new Map()
    this.writeQueue = Promise.resolve()
    this.volatileEntries = new Map()
    this.volatileBytes = 0
    this.volatileGeneration = 0
  }

  async get(key, options = {}) {
    requireCacheKey(key)
    const now = this.clock()
    let entry
    try {
      entry = await this.storage.read(key)
    } catch {
      return undefined
    }
    if (!isStoredEntry(entry, key) || entry.expiresAt <= now
      || (typeof options.validate === 'function' && !safeValidate(options.validate, entry.value))) {
      if (options.mutate !== false) this.#enqueueWrite(() => this.storage.delete(key))
      return undefined
    }
    if (options.mutate !== false) this.#enqueueWrite(() => this.storage.touch(key, now))
    return entry.value
  }

  async set(key, value, options = {}) {
    requireCacheKey(key)
    const ttlMs = positiveInteger(options.ttlMs, GITHUB_CACHE_POLICY.immutableTtlMs)
    if (!isCacheSafeValue(value)) return false

    const now = this.clock()
    const size = serializedSize({ key, value })
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.targetBytes) return false
    const entry = {
      key,
      value,
      size,
      createdAt: now,
      lastAccessAt: now,
      expiresAt: now + ttlMs,
    }
    try {
      await this.#enqueueWrite(() => this.storage.write(entry, {
        highWaterBytes: this.highWaterBytes,
        targetBytes: this.targetBytes,
      }))
      return true
    } catch {
      // Cache and quota failures must never make repository analysis fail.
      return false
    }
  }

  /**
   * Returns a cached value or runs one shared loader for this key. The loader
   * receives a signal that is aborted only after every active consumer leaves.
   */
  async getOrLoad(key, loader, options = {}) {
    requireCacheKey(key)
    if (typeof loader !== 'function') throw new TypeError('GitHub cache loader must be a function.')
    if (options.signal?.aborted) throw abortError()

    const persist = options.persist !== false
    const coalesceKey = options.coalesceKey ?? key
    requireCacheKey(coalesceKey)
    const volatileTtlMs = persist ? undefined : Math.min(
      positiveInteger(options.ttlMs, this.volatileMaxTtlMs),
      this.volatileMaxTtlMs,
    )
    // Staged/authenticated loads may reuse an already-confirmed persistent
    // public value, but must not mutate IndexedDB even for LRU bookkeeping.
    if (options.read !== false) {
      const cached = await this.get(key, { validate: options.validate, mutate: persist })
      if (options.signal?.aborted) throw abortError()
      if (cached !== undefined) return cached
    }

    const volatileGeneration = this.volatileGeneration
    const volatile = persist ? undefined : this.#getVolatile(coalesceKey, options.validate)
    if (options.signal?.aborted) throw abortError()
    if (volatile !== undefined) return volatile

    // Clearing volatile state creates a new in-flight namespace. An older
    // loader may finish for its existing consumers, but it cannot repopulate
    // or be joined by requests made after clearVolatile().
    const inFlightKey = persist ? `persistent:${coalesceKey}` : `volatile:${volatileGeneration}:${coalesceKey}`
    let shared = this.inFlight.get(inFlightKey)
    let startsFlight = false
    if (!shared) {
      const controller = new AbortController()
      let resolveShared
      let rejectShared
      const promise = new Promise((resolve, reject) => {
        resolveShared = resolve
        rejectShared = reject
      })
      shared = {
        controller,
        consumers: new Set(),
        completed: false,
        settled: false,
        promise,
        resolve(value) {
          if (this.completed) return false
          this.completed = true
          resolveShared(value)
          return true
        },
        reject(error) {
          if (this.completed) return false
          this.completed = true
          rejectShared(error)
          return true
        },
      }
      shared.detach = () => {
        if (this.inFlight.get(inFlightKey) === shared) this.inFlight.delete(inFlightKey)
      }
      this.inFlight.set(inFlightKey, shared)
      startsFlight = true
    }

    const consumer = this.#registerConsumer(shared, options.signal, {
      validate: options.validate,
      volatileTtlMs,
    })
    if (startsFlight) {
      shared.promise.then(
        () => this.#settleShared(inFlightKey, shared),
        () => this.#settleShared(inFlightKey, shared),
      )
      // Register both the flight and its first consumer before invoking the
      // loader. This prevents synchronous re-entry from creating a duplicate,
      // while ensuring an immediate abort is visible to an already-started
      // loader.
      let loaded
      try {
        loaded = loader(shared.controller.signal)
      } catch (error) {
        shared.reject(error)
      }
      Promise.resolve(loaded).then(
        (value) => {
          if (shared.completed) return
          // Publish before the shared promise settles. This closes the gap in
          // which a third caller could otherwise miss both inFlight and the
          // volatile cache. A clear, or cancellation of every consumer, makes
          // the old result ineligible for publication.
          if (!persist
            && volatileGeneration === this.volatileGeneration
            && !shared.controller.signal.aborted
            && shared.consumers.size > 0) {
            const ttlMs = this.#volatileTtlForAcceptedConsumers(shared, value)
            if (ttlMs !== null) this.#setVolatile(coalesceKey, value, ttlMs)
          }
          shared.resolve(value)
        },
        (error) => shared.reject(error),
      )
    }

    try {
      const value = await consumer.promise
      if (typeof options.validate === 'function' && !safeValidate(options.validate, value)) {
        throw new TypeError('GitHub cache loader returned an invalid value.')
      }
      if (persist) {
        await this.set(key, value, { ttlMs: options.ttlMs })
      }
      return value
    } finally {
      consumer.release()
    }
  }

  clearVolatile() {
    this.volatileEntries.clear()
    this.volatileBytes = 0
    this.volatileGeneration += 1
    for (const [key, shared] of this.inFlight) {
      if (!key.startsWith('volatile:')) continue
      if (this.inFlight.get(key) === shared) this.inFlight.delete(key)
      shared.controller.abort()
      shared.reject(abortError())
    }
  }

  #getVolatile(key, validate) {
    const entry = this.volatileEntries.get(key)
    if (!entry) return undefined
    const now = this.clock()
    if (!isStoredEntry(entry, key) || entry.expiresAt <= now
      || (typeof validate === 'function' && !safeValidate(validate, entry.value))) {
      this.#deleteVolatile(key)
      return undefined
    }
    let value
    try {
      value = structuredClone(entry.value)
    } catch {
      this.#deleteVolatile(key)
      return undefined
    }
    entry.lastAccessAt = now
    // Map insertion order is the volatile cache's LRU order. Moving a hit to
    // the end keeps recency exact even when several accesses share a timestamp.
    this.volatileEntries.delete(key)
    this.volatileEntries.set(key, entry)
    return value
  }

  #setVolatile(key, value, ttlMsValue) {
    const ttlMs = positiveInteger(ttlMsValue, this.volatileMaxTtlMs)
    if (!isCacheSafeValue(value)) return false
    let cloned
    try {
      cloned = structuredClone(value)
    } catch {
      return false
    }
    if (!isCacheSafeValue(cloned)) return false

    const size = serializedSize({ key, value: cloned })
    if (!Number.isSafeInteger(size) || size <= 0 || size > this.volatileTargetBytes) return false
    const now = this.clock()
    this.#purgeExpiredVolatile(now)
    const existing = this.volatileEntries.get(key)
    if (existing) this.#deleteVolatile(key)
    this.volatileEntries.set(key, {
      key,
      value: cloned,
      size,
      createdAt: now,
      lastAccessAt: now,
      expiresAt: now + ttlMs,
    })
    this.volatileBytes += size

    if (this.volatileBytes > this.volatileHighWaterBytes) {
      for (const candidateKey of this.volatileEntries.keys()) {
        if (this.volatileBytes <= this.volatileTargetBytes) break
        this.#deleteVolatile(candidateKey)
      }
    }
    return true
  }

  #purgeExpiredVolatile(now) {
    for (const [key, entry] of this.volatileEntries) {
      if (!isStoredEntry(entry, key) || entry.expiresAt <= now) this.#deleteVolatile(key)
    }
  }

  #deleteVolatile(key) {
    const entry = this.volatileEntries.get(key)
    if (!entry) return
    this.volatileEntries.delete(key)
    this.volatileBytes = Math.max(0, this.volatileBytes - (validEntrySize(entry) ?? 0))
  }

  #settleShared(key, shared) {
    shared.settled = true
    if (this.inFlight.get(key) === shared) this.inFlight.delete(key)
  }

  #registerConsumer(shared, signal, options) {
    const token = options
    let active = true
    let rejectConsumer
    const release = () => {
      if (!active) return
      active = false
      signal?.removeEventListener('abort', onAbort)
      shared.consumers.delete(token)
      if (!shared.settled && shared.consumers.size === 0) {
        shared.detach()
        shared.controller.abort()
      }
    }
    const onAbort = () => {
      release()
      rejectConsumer(abortError())
    }
    const promise = new Promise((resolve, reject) => {
      rejectConsumer = reject
      signal?.addEventListener('abort', onAbort, { once: true })
      shared.promise.then(
        (value) => {
          if (!active) return
          resolve(value)
        },
        (error) => {
          if (!active) return
          reject(error)
        },
      )
    })
    shared.consumers.add(token)
    // The caller checked before registration, but an unusual signal-like
    // object could change state while its listener is installed.
    if (signal?.aborted) onAbort()
    return { promise, release }
  }

  #volatileTtlForAcceptedConsumers(shared, value) {
    let accepted = false
    let ttlMs = this.volatileMaxTtlMs
    for (const consumer of shared.consumers) {
      if (typeof consumer.validate === 'function' && !safeValidate(consumer.validate, value)) continue
      accepted = true
      ttlMs = Math.min(ttlMs, consumer.volatileTtlMs)
    }
    return accepted ? ttlMs : null
  }

  #enqueueWrite(operation) {
    const result = this.writeQueue.then(operation, operation)
    this.writeQueue = result.catch(() => {})
    return result
  }
}

export const githubCacheKey = Object.freeze({
  repository(owner, repo) {
    return `repo:v2:${repositoryScope(owner, repo)}`
  },
  head(owner, repo, branch) {
    if (typeof branch !== 'string' || branch.length < 1 || branch.length > 500) {
      throw new TypeError('GitHub branch name is invalid.')
    }
    return `head:v2:${repositoryScope(owner, repo)}:${encodeURIComponent(branch)}`
  },
  tree(owner, repo, sha) {
    return `tree:recursive-v2:${repositoryScope(owner, repo)}:${requireSha(sha)}`
  },
  blob(owner, repo, sha) {
    return `blob:decoded-v2:${repositoryScope(owner, repo)}:${requireSha(sha)}`
  },
})

function createIndexedDbStorage(indexedDBImpl = globalThis.indexedDB) {
  if (!indexedDBImpl || typeof indexedDBImpl.open !== 'function') return unavailableStorage()
  let databasePromise

  const open = () => {
    if (!databasePromise) databasePromise = openDatabase(indexedDBImpl).catch((error) => {
      databasePromise = undefined
      throw error
    })
    return databasePromise
  }

  return {
    async read(key) {
      const database = await open()
      return requestToPromise(database.transaction(ENTRY_STORE, 'readonly').objectStore(ENTRY_STORE).get(key))
    },
    async touch(key, lastAccessAt) {
      const database = await open()
      const transaction = database.transaction(ENTRY_STORE, 'readwrite')
      const done = transactionDone(transaction)
      const store = transaction.objectStore(ENTRY_STORE)
      const entry = await requestToPromise(store.get(key))
      if (entry) store.put({ ...entry, lastAccessAt })
      await done
    },
    async delete(key) {
      const database = await open()
      const transaction = database.transaction([ENTRY_STORE, META_STORE], 'readwrite')
      const done = transactionDone(transaction)
      const entries = transaction.objectStore(ENTRY_STORE)
      const metadata = transaction.objectStore(META_STORE)
      const [existing, state] = await Promise.all([
        requestToPromise(entries.get(key)),
        requestToPromise(metadata.get(META_KEY)),
      ])
      if (existing) {
        entries.delete(key)
        metadata.put({
          key: META_KEY,
          totalBytes: Math.max(0, validTotalBytes(state) - existing.size),
        })
      }
      await done
    },
    async write(entry, limits) {
      const database = await open()
      const transaction = database.transaction([ENTRY_STORE, META_STORE], 'readwrite')
      const done = transactionDone(transaction)
      const entries = transaction.objectStore(ENTRY_STORE)
      const metadata = transaction.objectStore(META_STORE)
      entries.put(entry)
      const allEntries = await requestToPromise(entries.getAll())
      let totalBytes = allEntries.reduce((sum, candidate) => sum + (validEntrySize(candidate) ?? 0), 0)
      if (totalBytes > limits.highWaterBytes) {
        const eviction = selectGitHubCacheEvictions(allEntries, totalBytes, limits.targetBytes)
        for (const key of eviction.keys) {
          entries.delete(key)
        }
        totalBytes = eviction.remainingBytes
      }
      metadata.put({ key: META_KEY, totalBytes })
      await done
    },
  }
}

export function selectGitHubCacheEvictions(entries, totalBytes, targetBytes) {
  if (!Array.isArray(entries) || !Number.isSafeInteger(totalBytes) || totalBytes < 0
    || !Number.isSafeInteger(targetBytes) || targetBytes < 0) {
    throw new TypeError('GitHub cache eviction input is invalid.')
  }
  let remainingBytes = totalBytes
  const keys = []
  const oldestFirst = entries
    .filter((entry) => typeof entry?.key === 'string' && validEntrySize(entry) !== null)
    .sort((left, right) => validTimestamp(left.lastAccessAt) - validTimestamp(right.lastAccessAt)
      || validTimestamp(left.createdAt) - validTimestamp(right.createdAt)
      || left.key.localeCompare(right.key))
  for (const entry of oldestFirst) {
    if (remainingBytes <= targetBytes) break
    keys.push(entry.key)
    remainingBytes = Math.max(0, remainingBytes - entry.size)
  }
  return { keys, remainingBytes }
}

function openDatabase(indexedDBImpl) {
  return new Promise((resolve, reject) => {
    const request = indexedDBImpl.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = (event) => {
      const database = request.result
      if (!database.objectStoreNames.contains(ENTRY_STORE)) {
        const entries = database.createObjectStore(ENTRY_STORE, { keyPath: 'key' })
        entries.createIndex('lastAccessAt', 'lastAccessAt')
        entries.createIndex('expiresAt', 'expiresAt')
      }
      if (!database.objectStoreNames.contains(META_STORE)) {
        database.createObjectStore(META_STORE, { keyPath: 'key' })
      }
      if (event.oldVersion > 0 && event.oldVersion < DATABASE_VERSION) {
        request.transaction.objectStore(ENTRY_STORE).clear()
        request.transaction.objectStore(META_STORE).clear()
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('GitHub cache database could not be opened.'))
    request.onblocked = () => reject(new Error('GitHub cache database upgrade was blocked.'))
  })
}

function unavailableStorage() {
  const unavailable = async () => { throw new Error('IndexedDB is unavailable.') }
  return { read: unavailable, touch: unavailable, delete: unavailable, write: unavailable }
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError')
  return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' })
}

function repositoryScope(owner, repo) {
  return `${requireRepoPart(owner).toLowerCase()}/${requireRepoPart(repo).toLowerCase()}`
}

function requireRepoPart(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw new TypeError('GitHub repository identity is invalid.')
  }
  return value
}

function requireSha(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{40}$/i.test(value)) {
    throw new TypeError('GitHub object SHA is invalid.')
  }
  return value.toLowerCase()
}

function requireCacheKey(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1_024
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError('GitHub cache key is invalid.')
  }
}

function isStoredEntry(value, key) {
  return value !== null && typeof value === 'object'
    && value.key === key
    && Number.isSafeInteger(value.size) && value.size > 0
    && Number.isFinite(value.createdAt)
    && Number.isFinite(value.lastAccessAt)
    && Number.isFinite(value.expiresAt)
    && isCacheSafeValue(value.value)
}

function isCacheSafeValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
  seen.add(value)
  const entries = Array.isArray(value) ? value.entries() : Object.entries(value)
  for (const [key, nested] of entries) {
    if (typeof key === 'string' && /^(?:headers?|authorization|proxy-authorization|token|access[_-]?token|api[_-]?key)$/i.test(key)) return false
    if (!isCacheSafeValue(nested, seen)) return false
  }
  seen.delete(value)
  return true
}

function safeValidate(validate, value) {
  try { return validate(value) === true } catch { return false }
}

function serializedSize(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength } catch { return Number.NaN }
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('GitHub cache limit must be a positive integer.')
  return value
}

function validEntrySize(value) {
  return Number.isSafeInteger(value?.size) && value.size > 0 ? value.size : null
}

function validTotalBytes(value) {
  return Number.isSafeInteger(value?.totalBytes) && value.totalBytes >= 0 ? value.totalBytes : 0
}

function validTimestamp(value) {
  return Number.isFinite(value) ? value : Number.NEGATIVE_INFINITY
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('GitHub cache request failed.'))
  })
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('GitHub cache transaction failed.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('GitHub cache transaction was aborted.'))
  })
}
