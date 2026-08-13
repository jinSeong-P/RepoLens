import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GitHubResourceCache,
  githubCacheKey,
  selectGitHubCacheEvictions,
} from '../src/lib/github-cache.js'

const sha = 'a'.repeat(40)

test('builds repository-scoped SHA cache keys without credentials', () => {
  assert.equal(githubCacheKey.repository('Owner', 'Repo'), 'repo:v2:owner/repo')
  assert.equal(githubCacheKey.head('Owner', 'Repo', 'feature/a'), 'head:v2:owner/repo:feature%2Fa')
  assert.equal(githubCacheKey.tree('Owner', 'Repo', sha.toUpperCase()), `tree:recursive-v2:owner/repo:${sha}`)
  assert.equal(githubCacheKey.blob('Owner', 'Repo', sha), `blob:decoded-v2:owner/repo:${sha}`)
  assert.throws(() => githubCacheKey.blob('Owner', 'Repo', 'bad'), /SHA/)
})

test('honors TTL and rejects values containing credential-shaped fields', async () => {
  let now = 1_000
  const storage = memoryStorage()
  const cache = new GitHubResourceCache({ storage, clock: () => now, highWaterBytes: 10_000, targetBytes: 8_000 })

  assert.equal(await cache.set('resource', { value: 1 }, { ttlMs: 100 }), true)
  assert.deepEqual(await cache.get('resource'), { value: 1 })
  assert.equal(await cache.set('secret', { apiKey: 'do-not-store' }), false)
  assert.equal(await cache.set('nested-secret', { auth: { token: 'do-not-store' } }), false)
  assert.equal(storage.entries.has('secret'), false)
  assert.equal(storage.entries.has('nested-secret'), false)

  now = 1_101
  assert.equal(await cache.get('resource'), undefined)
  await cache.writeQueue
  assert.equal(storage.entries.has('resource'), false)
})

test('coalesces a loader while keeping consumer cancellation isolated', async () => {
  const storage = memoryStorage()
  const cache = new GitHubResourceCache({ storage })
  const first = new AbortController()
  const second = new AbortController()
  let loadCalls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const loader = async (sharedSignal) => {
    loadCalls += 1
    assert.equal(sharedSignal.aborted, false)
    await gate
    assert.equal(sharedSignal.aborted, false)
    return { payload: 'public' }
  }

  const firstResult = cache.getOrLoad('shared', loader, { signal: first.signal })
  const secondResult = cache.getOrLoad('shared', loader, { signal: second.signal })
  await Promise.resolve()
  await Promise.resolve()
  first.abort()
  release()

  await assert.rejects(firstResult, (error) => error?.name === 'AbortError')
  assert.deepEqual(await secondResult, { payload: 'public' })
  assert.equal(loadCalls, 1)
  assert.deepEqual(await cache.get('shared'), { payload: 'public' })
})

test('aborts a shared loader after its last consumer leaves', async () => {
  const cache = new GitHubResourceCache({ storage: memoryStorage() })
  const controller = new AbortController()
  let sharedAborted = false
  const result = cache.getOrLoad('abandon', (signal) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => {
      sharedAborted = true
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }, { once: true })
  }), { signal: controller.signal })

  await Promise.resolve()
  await Promise.resolve()
  controller.abort()
  await assert.rejects(result, (error) => error?.name === 'AbortError')
  await Promise.resolve()
  assert.equal(sharedAborted, true)
})

test('evicts least-recently-used entries down to the target size', () => {
  const result = selectGitHubCacheEvictions([
    { key: 'new', size: 30, createdAt: 3, lastAccessAt: 30 },
    { key: 'old', size: 30, createdAt: 1, lastAccessAt: 10 },
    { key: 'middle', size: 30, createdAt: 2, lastAccessAt: 20 },
  ], 90, 45)
  assert.deepEqual(result, { keys: ['old', 'middle'], remainingBytes: 30 })
})

test('cache storage failures remain a transparent optimization miss', async () => {
  const unavailable = {
    read: async () => { throw new Error('unavailable') },
    touch: async () => { throw new Error('unavailable') },
    delete: async () => { throw new Error('unavailable') },
    write: async () => { throw new Error('quota') },
  }
  const cache = new GitHubResourceCache({ storage: unavailable })
  let calls = 0
  const value = await cache.getOrLoad('resource', async () => {
    calls += 1
    return { ok: true }
  })
  assert.deepEqual(value, { ok: true })
  assert.equal(calls, 1)
})

test('can coalesce a staged load without persisting it', async () => {
  const storage = memoryStorage()
  const cache = new GitHubResourceCache({ storage })
  assert.deepEqual(await cache.getOrLoad('staged', async () => ({ privateCandidate: true }), {
    persist: false,
  }), { privateCandidate: true })
  assert.equal(storage.entries.has('staged'), false)
})

test('reuses a cloned volatile value by auth revision without writing IndexedDB', async () => {
  const storage = instrumentedStorage()
  const cache = new GitHubResourceCache({ storage })
  let loads = 0
  const load = async () => ({ files: [{ path: 'README.md' }] })
  const first = await cache.getOrLoad('tree', async () => {
    loads += 1
    return load()
  }, { persist: false, coalesceKey: 'tree:auth:first' })
  first.files[0].path = 'mutated'

  assert.deepEqual(await cache.getOrLoad('tree', async () => {
    loads += 1
    return load()
  }, { persist: false, coalesceKey: 'tree:auth:first' }), {
    files: [{ path: 'README.md' }],
  })
  assert.deepEqual(await cache.getOrLoad('tree', async () => {
    loads += 1
    return { revision: 'second' }
  }, { persist: false, coalesceKey: 'tree:auth:second' }), { revision: 'second' })
  assert.equal(loads, 2)
  assert.deepEqual(storage.calls, { read: 3, touch: 0, delete: 0, write: 0 })
})

test('persist false never touches or deletes a durable cache entry', async () => {
  let now = 1_000
  const storage = instrumentedStorage()
  storage.entries.set('invalid', storedEntry('invalid', { ok: false }, 2_000))
  storage.entries.set('expired', storedEntry('expired', { ok: true }, 999))
  const cache = new GitHubResourceCache({ storage, clock: () => now })

  assert.deepEqual(await cache.getOrLoad('invalid', async () => ({ ok: true }), {
    persist: false,
    validate: (value) => value.ok === true,
  }), { ok: true })
  now += 1
  assert.deepEqual(await cache.getOrLoad('expired', async () => ({ ok: true }), {
    persist: false,
  }), { ok: true })
  await cache.writeQueue
  assert.deepEqual(storage.calls, { read: 2, touch: 0, delete: 0, write: 0 })
  assert.equal(storage.entries.has('invalid'), true)
  assert.equal(storage.entries.has('expired'), true)
})

test('expires volatile values at the short TTL cap and revalidates every caller', async () => {
  let now = 1_000
  const storage = instrumentedStorage()
  const cache = new GitHubResourceCache({ storage, clock: () => now, volatileMaxTtlMs: 100 })
  let loads = 0
  const load = async () => ({ version: ++loads })

  assert.deepEqual(await cache.getOrLoad('resource', load, {
    persist: false,
    read: false,
    ttlMs: 10_000,
    validate: (value) => value.version === 1,
  }), { version: 1 })
  assert.deepEqual(await cache.getOrLoad('resource', load, {
    persist: false,
    read: false,
    validate: (value) => value.version === 2,
  }), { version: 2 })
  now = 1_100
  assert.deepEqual(await cache.getOrLoad('resource', load, {
    persist: false,
    read: false,
  }), { version: 3 })
  assert.equal(loads, 3)
  assert.equal(storage.calls.write, 0)
})

test('does not cache credential-shaped, cyclic, or oversized volatile values', async () => {
  const cache = new GitHubResourceCache({
    storage: instrumentedStorage(),
    volatileHighWaterBytes: 80,
    volatileTargetBytes: 60,
  })
  const cyclic = { ok: true }
  cyclic.self = cyclic
  const values = [{ token: 'secret' }, cyclic, { text: 'x'.repeat(100) }]
  for (let index = 0; index < values.length; index += 1) {
    let calls = 0
    const loader = async () => {
      calls += 1
      return values[index]
    }
    await cache.getOrLoad(`unsafe-${index}`, loader, { persist: false, read: false })
    await cache.getOrLoad(`unsafe-${index}`, loader, { persist: false, read: false })
    assert.equal(calls, 2)
  }
})

test('evicts the least-recently-used volatile entry down to target bytes', async () => {
  const size = (key, value) => new TextEncoder().encode(JSON.stringify({ key, value })).byteLength
  const values = {
    a: { text: 'a'.repeat(20) },
    b: { text: 'b'.repeat(20) },
    c: { text: 'c'.repeat(20) },
  }
  const one = size('a', values.a)
  const cache = new GitHubResourceCache({
    storage: instrumentedStorage(),
    volatileHighWaterBytes: one * 2,
    volatileTargetBytes: one * 2 - 1,
  })
  const calls = { a: 0, b: 0, c: 0 }
  const get = (key) => cache.getOrLoad(key, async () => {
    calls[key] += 1
    return values[key]
  }, { persist: false, read: false })

  await get('a')
  await get('b')
  await get('a')
  await get('c')
  await get('a')
  assert.deepEqual(calls, { a: 2, b: 1, c: 1 })
  await get('a')
  await get('b')
  assert.deepEqual(calls, { a: 2, b: 2, c: 1 })
})

test('separates volatile and persistent flights even with the same coalesce key', async () => {
  const storage = instrumentedStorage()
  const cache = new GitHubResourceCache({ storage })
  let volatileRelease
  let persistentRelease
  const volatile = cache.getOrLoad('same', () => new Promise((resolve) => {
    volatileRelease = () => resolve({ source: 'volatile' })
  }), { persist: false, read: false, coalesceKey: 'shared-key' })
  const persistent = cache.getOrLoad('same', () => new Promise((resolve) => {
    persistentRelease = () => resolve({ source: 'persistent' })
  }), { persist: true, read: false, coalesceKey: 'shared-key' })
  volatileRelease()
  persistentRelease()

  assert.deepEqual(await volatile, { source: 'volatile' })
  assert.deepEqual(await persistent, { source: 'persistent' })
  assert.deepEqual(storage.entries.get('same').value, { source: 'persistent' })
  assert.equal(storage.calls.write, 1)
})

test('publishes a volatile result before a settling consumer can start a third load', async () => {
  const cache = new GitHubResourceCache({ storage: instrumentedStorage() })
  let loads = 0
  const loader = async () => ({ load: ++loads })
  const first = cache.getOrLoad('atomic', loader, { persist: false, read: false })
  const second = cache.getOrLoad('atomic', loader, { persist: false, read: false })
  const third = first.then(() => cache.getOrLoad('atomic', loader, { persist: false, read: false }))

  assert.deepEqual(await second, { load: 1 })
  assert.deepEqual(await third, { load: 1 })
  assert.equal(loads, 1)
})

test('applies each coalesced consumer validator independently', async () => {
  const cache = new GitHubResourceCache({ storage: instrumentedStorage() })
  let release
  const loader = () => new Promise((resolve) => { release = resolve })
  const accepts = cache.getOrLoad('validated', loader, {
    persist: false,
    read: false,
    validate: (value) => value.kind === 'tree',
  })
  const rejects = cache.getOrLoad('validated', loader, {
    persist: false,
    read: false,
    validate: (value) => value.kind === 'blob',
  })
  release({ kind: 'tree' })

  assert.deepEqual(await accepts, { kind: 'tree' })
  await assert.rejects(rejects, /invalid value/)
  assert.deepEqual(await cache.getOrLoad('validated', async () => ({ kind: 'replacement' }), {
    persist: false,
    read: false,
    validate: (value) => value.kind === 'tree',
  }), { kind: 'tree' })
})

test('does not publish a value rejected by every active consumer', async () => {
  const cache = new GitHubResourceCache({ storage: instrumentedStorage() })
  let loads = 0
  await assert.rejects(cache.getOrLoad('all-invalid', async () => {
    loads += 1
    return { kind: 'wrong' }
  }, {
    persist: false,
    read: false,
    validate: (value) => value.kind === 'expected',
  }), /invalid value/)

  assert.deepEqual(await cache.getOrLoad('all-invalid', async () => {
    loads += 1
    return { kind: 'expected' }
  }, {
    persist: false,
    read: false,
    validate: (value) => value.kind === 'expected',
  }), { kind: 'expected' })
  assert.equal(loads, 2)
})

test('keeps the shared loader alive while at least one consumer remains', async () => {
  const cache = new GitHubResourceCache({ storage: instrumentedStorage() })
  const firstController = new AbortController()
  const secondController = new AbortController()
  let release
  let sharedSignal
  const loader = (signal) => new Promise((resolve) => {
    sharedSignal = signal
    release = resolve
  })
  const first = cache.getOrLoad('partial-cancel', loader, {
    persist: false,
    read: false,
    signal: firstController.signal,
  })
  const second = cache.getOrLoad('partial-cancel', loader, {
    persist: false,
    read: false,
    signal: secondController.signal,
  })
  firstController.abort()
  assert.equal(sharedSignal.aborted, false)
  release({ ok: true })

  await assert.rejects(first, (error) => error?.name === 'AbortError')
  assert.deepEqual(await second, { ok: true })
  assert.deepEqual(await cache.getOrLoad('partial-cancel', loader, {
    persist: false,
    read: false,
  }), { ok: true })
})

test('volatile cache belongs only to its current cache instance', async () => {
  const storage = instrumentedStorage()
  const first = new GitHubResourceCache({ storage })
  const second = new GitHubResourceCache({ storage })
  let firstLoads = 0
  let secondLoads = 0
  await first.getOrLoad('worker-only', async () => ({ load: ++firstLoads }), {
    persist: false,
    read: false,
  })
  assert.deepEqual(await second.getOrLoad('worker-only', async () => ({ load: ++secondLoads }), {
    persist: false,
    read: false,
  }), { load: 1 })
  assert.equal(firstLoads, 1)
  assert.equal(secondLoads, 1)
  assert.equal(storage.calls.write, 0)
})

test('all-consumer cancellation prevents an abort-ignoring loader from caching', async () => {
  const cache = new GitHubResourceCache({ storage: instrumentedStorage() })
  const controller = new AbortController()
  let release
  let loads = 0
  const first = cache.getOrLoad('cancelled', () => new Promise((resolve) => {
    loads += 1
    release = resolve
  }), { persist: false, read: false, signal: controller.signal })
  controller.abort()
  release({ load: 1 })
  await assert.rejects(first, (error) => error?.name === 'AbortError')
  await Promise.resolve()
  assert.deepEqual(await cache.getOrLoad('cancelled', async () => ({ load: ++loads }), {
    persist: false,
    read: false,
  }), { load: 2 })
})

test('clearVolatile invalidates entries and aborts detached delayed flights', async () => {
  const cache = new GitHubResourceCache({ storage: instrumentedStorage() })
  await cache.getOrLoad('cached', async () => ({ version: 1 }), { persist: false, read: false })
  let oldRelease
  let oldSignal
  const oldFlight = cache.getOrLoad('delayed', (signal) => new Promise((resolve) => {
    oldSignal = signal
    oldRelease = resolve
  }), { persist: false, read: false })
  cache.clearVolatile()
  assert.equal(oldSignal.aborted, true)
  oldRelease({ version: 'old' })
  await assert.rejects(oldFlight, (error) => error?.name === 'AbortError')

  let cachedLoads = 0
  assert.deepEqual(await cache.getOrLoad('cached', async () => ({ version: ++cachedLoads + 1 }), {
    persist: false,
    read: false,
  }), { version: 2 })
  let delayedLoads = 0
  assert.deepEqual(await cache.getOrLoad('delayed', async () => ({ version: ++delayedLoads }), {
    persist: false,
    read: false,
  }), { version: 1 })
  assert.equal(cachedLoads, 1)
  assert.equal(delayedLoads, 1)
})

test('can bypass a durable value while retaining the normal loader contract', async () => {
  const storage = memoryStorage()
  const cache = new GitHubResourceCache({ storage })
  await cache.set('untrusted-durable', { source: 'cache' })
  let loads = 0
  const value = await cache.getOrLoad('untrusted-durable', async () => {
    loads += 1
    return { source: 'network' }
  }, { read: false, persist: false })

  assert.deepEqual(value, { source: 'network' })
  assert.equal(loads, 1)
})

function memoryStorage() {
  const entries = new Map()
  return {
    entries,
    async read(key) { return entries.get(key) },
    async touch(key, lastAccessAt) {
      const entry = entries.get(key)
      if (entry) entries.set(key, { ...entry, lastAccessAt })
    },
    async delete(key) { entries.delete(key) },
    async write(entry) { entries.set(entry.key, structuredClone(entry)) },
  }
}

function instrumentedStorage() {
  const storage = memoryStorage()
  const calls = { read: 0, touch: 0, delete: 0, write: 0 }
  return {
    entries: storage.entries,
    calls,
    async read(key) { calls.read += 1; return storage.read(key) },
    async touch(key, lastAccessAt) { calls.touch += 1; return storage.touch(key, lastAccessAt) },
    async delete(key) { calls.delete += 1; return storage.delete(key) },
    async write(entry, limits) { calls.write += 1; return storage.write(entry, limits) },
  }
}

function storedEntry(key, value, expiresAt) {
  return { key, value, size: 1, createdAt: 1, lastAccessAt: 1, expiresAt }
}
