const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const REJECTED_MARKER_VERSION = 1

// A normal GitHub auth request is bounded to 30 seconds. Giving an abandoned
// attempt another 30 seconds lets an MV3 worker recover without allowing a
// crashed attempt to block the Device Flow until its code expires.
export const GITHUB_FLOW_ATTEMPT_STALE_MS = 60_000

export class GitHubAuthStateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'GitHubAuthStateError'
    this.code = code
  }
}

/**
 * Claims one Device Flow poll attempt.
 *
 * Callers must perform the storage read, this transition, and the storage
 * write inside their serialized state boundary. A returned object is a clone;
 * the supplied flow is never mutated.
 */
export function claimGitHubFlowAttempt(flow, flowId, attemptId, now) {
  if (!isPlainObject(flow) || !isUuid(flowId) || flow.flowId !== flowId || !isUuid(attemptId)) {
    throw stateError('flow_mismatch', 'GitHub 연결 요청이 없거나 일치하지 않습니다.')
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    throw stateError('invalid_time', 'GitHub 연결 시각이 올바르지 않습니다.')
  }

  const activeAttemptId = flow.activeAttemptId
  const attemptStartedAt = flow.attemptStartedAt
  const hasActiveId = activeAttemptId !== undefined && activeAttemptId !== null
  const hasStartedAt = attemptStartedAt !== undefined && attemptStartedAt !== null
  if (hasActiveId !== hasStartedAt) {
    throw stateError('invalid_flow', 'GitHub 연결 요청 상태가 올바르지 않습니다.')
  }

  if (hasActiveId) {
    if (!isUuid(activeAttemptId) || !Number.isSafeInteger(attemptStartedAt) || attemptStartedAt < 0) {
      throw stateError('invalid_flow', 'GitHub 연결 요청 상태가 올바르지 않습니다.')
    }
    // Reusing an attempt ID would let the abandoned request commit after a
    // reclaim. Every network attempt therefore needs a fresh random UUID.
    if (activeAttemptId === attemptId || now - attemptStartedAt < GITHUB_FLOW_ATTEMPT_STALE_MS) {
      throw stateError('flow_busy', 'GitHub 연결 상태를 이미 확인하고 있습니다.')
    }
  }

  return {
    ...structuredClone(flow),
    activeAttemptId: attemptId,
    attemptStartedAt: now,
  }
}

/** Returns true only while a result still owns the exact stored attempt. */
export function matchGitHubFlowAttempt(value, expected) {
  return Boolean(isPlainObject(value)
    && isPlainObject(expected)
    && isUuid(expected.flowId)
    && isUuid(expected.attemptId)
    && value.flowId === expected.flowId
    && value.activeAttemptId === expected.attemptId
    && Number.isSafeInteger(value.attemptStartedAt)
    && value.attemptStartedAt >= 0)
}

/** A 401 may invalidate only the credential revision that made the request. */
export function canInvalidateGitHubSession(errorRevision, sessionRevision) {
  return isUuid(errorRevision) && isUuid(sessionRevision) && errorRevision === sessionRevision
}

/** Creates a token-free tombstone for one rejected durable credential. */
export function makeGitHubAuthRejectedMarker(session) {
  if (!isPlainObject(session) || !isUuid(session.vaultId) || !isUuid(session.keyVersion)
    || !isUuid(session.revision) || !isPlainObject(session.auth)
    || !isCanonicalTimestamp(session.auth.createdAt)) {
    throw stateError('invalid_session', 'GitHub 연결 세션 형식이 올바르지 않습니다.')
  }
  return {
    version: REJECTED_MARKER_VERSION,
    vaultId: session.vaultId,
    keyVersion: session.keyVersion,
    revision: session.revision,
    createdAt: session.auth.createdAt,
  }
}

/**
 * Checks whether a durable GitHub credential is the one represented by a
 * rejection tombstone. `revision` makes the marker auditable and safe to
 * create conditionally after a 401; `createdAt` is the durable identity that
 * remains stable when the vault is locked and unlocked.
 */
export function shouldRejectGitHubAuth(marker, envelope, auth) {
  if (!isPlainObject(marker) || !hasExactKeys(marker, [
    'createdAt', 'keyVersion', 'revision', 'vaultId', 'version',
  ])) return false
  if (marker.version !== REJECTED_MARKER_VERSION
    || !isUuid(marker.vaultId)
    || !isUuid(marker.keyVersion)
    || !isUuid(marker.revision)
    || !isCanonicalTimestamp(marker.createdAt)) return false
  if (!isPlainObject(envelope) || marker.vaultId !== envelope.vaultId
    || marker.keyVersion !== envelope.keyVersion) return false
  if (!isPlainObject(auth) || marker.createdAt !== auth.createdAt
    || !isCanonicalTimestamp(auth.createdAt)) return false

  // This optional comparison also supports callers that have already paired
  // the durable record with a live session revision. Durable vault records do
  // not contain a revision, so their createdAt identity remains lock-stable.
  if (auth.revision !== undefined && marker.revision !== auth.revision) return false
  return true
}

/**
 * Selects a matching token-free tombstone from canonical and migration-era
 * stores. Every candidate is checked independently so a stale local value can
 * never mask a matching legacy session value.
 */
export function findGitHubAuthRejectedMarker(markers, envelope, auth) {
  if (!Array.isArray(markers)) return null
  for (const marker of markers) {
    if (shouldRejectGitHubAuth(marker, envelope, auth)) return structuredClone(marker)
  }
  return null
}

/**
 * Models the fail-closed 401 cleanup order for failure-injection tests. The
 * live session is always discarded once its exact revision has been rejected;
 * restart safety additionally needs either a local tombstone or durable vault
 * deletion to succeed.
 */
export function planGitHubAuthInvalidation(outcome) {
  if (!isPlainObject(outcome)
    || typeof outcome.localMarkerStored !== 'boolean'
    || typeof outcome.durableCredentialDeleted !== 'boolean') {
    throw stateError('invalid_outcome', 'GitHub 연결 폐기 결과가 올바르지 않습니다.')
  }
  return {
    removeLiveSession: true,
    keepMemoryDenied: true,
    restartSafe: outcome.localMarkerStored || outcome.durableCredentialDeleted,
  }
}

function stateError(code, message) {
  return new GitHubAuthStateError(code, message)
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function isCanonicalTimestamp(value) {
  if (typeof value !== 'string' || value.length > 50) return false
  const timestamp = Date.parse(value)
  return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
