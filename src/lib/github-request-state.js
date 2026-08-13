/**
 * Tracks repository requests by the exact GitHub credential revision they
 * captured. Keeping this small state machine separate makes the background
 * worker's cancellation boundary deterministic and testable.
 */
export class GitHubRequestRegistry {
  constructor() {
    this.requests = new Map()
  }

  register(requestId, controller) {
    if (typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 200) {
      throw new TypeError('GitHub request ID is invalid.')
    }
    if (!controller || typeof controller.abort !== 'function') {
      throw new TypeError('GitHub request controller is invalid.')
    }
    if (this.requests.has(requestId)) throw new TypeError('GitHub request ID is already active.')
    const entry = { controller, authRevision: null }
    this.requests.set(requestId, entry)
    return entry
  }

  captureAuthRevision(requestId, revision) {
    const entry = this.requests.get(requestId)
    if (!entry) return false
    if (!isUuid(revision)) return false
    if (entry.authRevision && entry.authRevision !== revision) {
      entry.controller.abort()
      return false
    }
    entry.authRevision = revision
    return true
  }

  remove(requestId, controller) {
    const entry = this.requests.get(requestId)
    if (!entry || (controller && entry.controller !== controller)) return false
    this.requests.delete(requestId)
    return true
  }

  abortAll() {
    return this.#abortWhere(() => true)
  }

  abortRevision(revision) {
    if (!isUuid(revision)) return 0
    return this.#abortWhere((entry) => entry.authRevision === revision)
  }

  #abortWhere(predicate) {
    let count = 0
    for (const [requestId, entry] of this.requests) {
      if (!predicate(entry)) continue
      this.requests.delete(requestId)
      entry.controller.abort()
      count += 1
    }
    return count
  }
}

/** Worker-memory fail-closed state for credentials rejected by GitHub. */
export class GitHubAuthDenyList {
  constructor() {
    this.revisions = new Set()
    this.createdAts = new Set()
  }

  denyRevision(revision) {
    if (!isUuid(revision)) return false
    this.revisions.add(revision)
    return true
  }

  denySession(session) {
    if (!this.denyRevision(session?.revision)) return false
    if (isCanonicalTimestamp(session?.auth?.createdAt)) this.createdAts.add(session.auth.createdAt)
    return true
  }

  rejectsSession(session) {
    return Boolean(session && (this.revisions.has(session.revision)
      || this.createdAts.has(session.auth?.createdAt)))
  }

  rejectsDurable(auth) {
    return Boolean(auth && this.createdAts.has(auth.createdAt))
  }

  clear() {
    this.revisions.clear()
    this.createdAts.clear()
  }
}

export function makeGitHubRequestKey(portId, requestId) {
  if (!isUuid(portId) || typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 200) {
    throw new TypeError('GitHub request key input is invalid.')
  }
  return `${portId}:${requestId}`
}

function isUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length > 50) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}
