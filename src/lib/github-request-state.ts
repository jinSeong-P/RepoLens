/**
 * Tracks repository requests by the exact GitHub credential revision they
 * captured. Keeping this small state machine separate makes the background
 * worker's cancellation boundary deterministic and testable.
 */
interface GitHubRequestEntry {
  controller: AbortController
  authRevision: string | null
}

interface GitHubAuthCreatedAt {
  createdAt?: unknown
}

interface GitHubSessionCandidate {
  revision?: unknown
  auth?: GitHubAuthCreatedAt | null
}

export class GitHubRequestRegistry {
  private readonly requests: Map<string, GitHubRequestEntry>

  constructor() {
    this.requests = new Map<string, GitHubRequestEntry>()
  }

  register(requestId: string, controller: AbortController): GitHubRequestEntry {
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

  captureAuthRevision(requestId: string, revision: unknown): boolean {
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

  remove(requestId: string, controller?: AbortController): boolean {
    const entry = this.requests.get(requestId)
    if (!entry || (controller && entry.controller !== controller)) return false
    this.requests.delete(requestId)
    return true
  }

  abortAll(): number {
    return this.#abortWhere(() => true)
  }

  abortRevision(revision: unknown): number {
    if (!isUuid(revision)) return 0
    return this.#abortWhere((entry) => entry.authRevision === revision)
  }

  #abortWhere(predicate: (entry: GitHubRequestEntry) => boolean): number {
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
  private readonly revisions: Set<string>
  private readonly createdAts: Set<string>

  constructor() {
    this.revisions = new Set<string>()
    this.createdAts = new Set<string>()
  }

  denyRevision(revision: unknown): boolean {
    if (!isUuid(revision)) return false
    this.revisions.add(revision)
    return true
  }

  denySession(session: unknown): boolean {
    if (!isGitHubSessionCandidate(session)) return false
    if (!this.denyRevision(session?.revision)) return false
    if (isCanonicalTimestamp(session?.auth?.createdAt)) this.createdAts.add(session.auth.createdAt)
    return true
  }

  rejectsSession(session: unknown): boolean {
    if (!isGitHubSessionCandidate(session)) return false
    return (isUuid(session.revision) && this.revisions.has(session.revision))
      || (isCanonicalTimestamp(session.auth?.createdAt) && this.createdAts.has(session.auth.createdAt))
  }

  rejectsDurable(auth: unknown): boolean {
    return Boolean(isGitHubAuthCreatedAt(auth)
      && isCanonicalTimestamp(auth.createdAt)
      && this.createdAts.has(auth.createdAt))
  }

  clear(): void {
    this.revisions.clear()
    this.createdAts.clear()
  }
}

export function makeGitHubRequestKey(portId: unknown, requestId: unknown): string {
  if (!isUuid(portId) || typeof requestId !== 'string' || requestId.length < 1 || requestId.length > 200) {
    throw new TypeError('GitHub request key input is invalid.')
  }
  return `${portId}:${requestId}`
}

function isUuid(value: unknown): value is string {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)
}

function isCanonicalTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 50) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function isGitHubSessionCandidate(value: unknown): value is GitHubSessionCandidate {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isGitHubAuthCreatedAt(value: unknown): value is GitHubAuthCreatedAt {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
