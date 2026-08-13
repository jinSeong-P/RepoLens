import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GITHUB_FLOW_ATTEMPT_STALE_MS,
  GitHubAuthStateError,
  canInvalidateGitHubSession,
  claimGitHubFlowAttempt,
  findGitHubAuthRejectedMarker,
  makeGitHubAuthRejectedMarker,
  matchGitHubFlowAttempt,
  planGitHubAuthInvalidation,
  shouldRejectGitHubAuth,
} from '../src/lib/github-auth-state.js'

const FLOW_ID = '11111111-1111-4111-8111-111111111111'
const ATTEMPT_ID = '22222222-2222-4222-8222-222222222222'
const NEXT_ATTEMPT_ID = '33333333-3333-4333-8333-333333333333'
const OLD_REVISION = '44444444-4444-4444-8444-444444444444'
const NEW_REVISION = '55555555-5555-4555-8555-555555555555'
const VAULT_ID = '66666666-6666-4666-8666-666666666666'
const KEY_VERSION = '77777777-7777-4777-8777-777777777777'
const CREATED_AT = '2026-08-13T01:02:03.000Z'

function flow(overrides = {}) {
  return {
    flowId: FLOW_ID,
    deviceCode: 'device-code-secret',
    nextPollAt: 1_000,
    ...overrides,
  }
}

test('cancelled flows cannot republish pending or connected poll results', () => {
  const claimed = claimGitHubFlowAttempt(flow(), FLOW_ID, ATTEMPT_ID, 2_000)
  assert.equal(matchGitHubFlowAttempt(claimed, { flowId: FLOW_ID, attemptId: ATTEMPT_ID }), true)

  // Cancellation removes the stored flow. Both result branches must use this
  // same predicate immediately before their serialized storage commit.
  const afterCancel = null
  assert.equal(matchGitHubFlowAttempt(afterCancel, { flowId: FLOW_ID, attemptId: ATTEMPT_ID }), false)
  assert.equal(matchGitHubFlowAttempt(afterCancel, { flowId: FLOW_ID, attemptId: ATTEMPT_ID }), false)

  // A replacement flow or a newer attempt is equally unable to accept the old
  // request's pending/connected result.
  assert.equal(matchGitHubFlowAttempt(
    { ...claimed, flowId: NEXT_ATTEMPT_ID },
    { flowId: FLOW_ID, attemptId: ATTEMPT_ID },
  ), false)
  assert.equal(matchGitHubFlowAttempt(
    { ...claimed, activeAttemptId: NEXT_ATTEMPT_ID },
    { flowId: FLOW_ID, attemptId: ATTEMPT_ID },
  ), false)
})

test('only one live poll attempt can claim a flow and an abandoned claim needs a new ID', () => {
  const now = 10_000
  const claimed = claimGitHubFlowAttempt(flow(), FLOW_ID, ATTEMPT_ID, now)
  assert.equal(claimed.activeAttemptId, ATTEMPT_ID)
  assert.equal(claimed.attemptStartedAt, now)
  assert.equal('activeAttemptId' in flow(), false)

  assert.throws(
    () => claimGitHubFlowAttempt(claimed, FLOW_ID, NEXT_ATTEMPT_ID, now + 1),
    (error) => error instanceof GitHubAuthStateError && error.code === 'flow_busy',
  )
  assert.throws(
    () => claimGitHubFlowAttempt(
      claimed,
      FLOW_ID,
      ATTEMPT_ID,
      now + GITHUB_FLOW_ATTEMPT_STALE_MS,
    ),
    (error) => error.code === 'flow_busy',
  )

  const reclaimed = claimGitHubFlowAttempt(
    claimed,
    FLOW_ID,
    NEXT_ATTEMPT_ID,
    now + GITHUB_FLOW_ATTEMPT_STALE_MS,
  )
  assert.equal(reclaimed.activeAttemptId, NEXT_ATTEMPT_ID)
  assert.equal(matchGitHubFlowAttempt(reclaimed, { flowId: FLOW_ID, attemptId: ATTEMPT_ID }), false)
})

test('a stale 401 cannot invalidate a newer GitHub auth session revision', () => {
  assert.equal(canInvalidateGitHubSession(OLD_REVISION, NEW_REVISION), false)
  assert.equal(canInvalidateGitHubSession(OLD_REVISION, OLD_REVISION), true)
  assert.equal(canInvalidateGitHubSession(undefined, OLD_REVISION), false)
  assert.equal(canInvalidateGitHubSession('not-a-revision', 'not-a-revision'), false)
})

test('a revisioned rejection marker blocks the same durable auth after lock and unlock', () => {
  const envelope = { vaultId: VAULT_ID, keyVersion: KEY_VERSION }
  const auth = {
    method: 'oauth',
    token: 'gho_encrypted_elsewhere',
    tokenType: 'bearer',
    login: 'octocat',
    createdAt: CREATED_AT,
  }
  const marker = makeGitHubAuthRejectedMarker({
    ...envelope,
    revision: OLD_REVISION,
    auth,
  })

  assert.deepEqual(marker, {
    version: 1,
    vaultId: VAULT_ID,
    keyVersion: KEY_VERSION,
    revision: OLD_REVISION,
    createdAt: CREATED_AT,
  })
  assert.doesNotMatch(JSON.stringify(marker), /gho_|octocat/)

  // No live session is needed: the same decrypted durable record is rejected
  // after a lock/unlock cycle because its createdAt identity is unchanged.
  assert.equal(shouldRejectGitHubAuth(marker, envelope, auth), true)
  assert.equal(shouldRejectGitHubAuth(marker, envelope, {
    ...auth,
    createdAt: '2026-08-13T01:02:04.000Z',
  }), false)
  assert.equal(shouldRejectGitHubAuth(marker, {
    ...envelope,
    keyVersion: NEW_REVISION,
  }, auth), false)
  assert.equal(shouldRejectGitHubAuth({ ...marker, revision: 'invalid' }, envelope, auth), false)
  assert.equal(shouldRejectGitHubAuth({ ...marker, extra: true }, envelope, auth), false)
})

test('a live auth revision must also match its rejection marker', () => {
  const envelope = { vaultId: VAULT_ID, keyVersion: KEY_VERSION }
  const auth = { createdAt: CREATED_AT }
  const marker = makeGitHubAuthRejectedMarker({
    ...envelope,
    revision: OLD_REVISION,
    auth,
  })

  assert.equal(shouldRejectGitHubAuth(marker, envelope, { ...auth, revision: OLD_REVISION }), true)
  assert.equal(shouldRejectGitHubAuth(marker, envelope, { ...auth, revision: NEW_REVISION }), false)
})

test('a stale local marker cannot mask a matching legacy rejection marker', () => {
  const envelope = { vaultId: VAULT_ID, keyVersion: KEY_VERSION }
  const auth = { createdAt: CREATED_AT }
  const matching = makeGitHubAuthRejectedMarker({
    ...envelope,
    revision: OLD_REVISION,
    auth,
  })
  const stale = { ...matching, createdAt: '2026-08-13T01:02:04.000Z' }

  assert.deepEqual(
    findGitHubAuthRejectedMarker([stale, matching], envelope, auth),
    matching,
  )
  assert.equal(findGitHubAuthRejectedMarker([
    { ...matching, keyVersion: NEW_REVISION },
    { ...matching, extra: true },
  ], envelope, auth), null)
})

test('401 cleanup always drops the live token and is restart safe after either durable write', () => {
  assert.deepEqual(planGitHubAuthInvalidation({
    localMarkerStored: true,
    durableCredentialDeleted: false,
  }), { removeLiveSession: true, keepMemoryDenied: true, restartSafe: true })
  assert.equal(planGitHubAuthInvalidation({
    localMarkerStored: false,
    durableCredentialDeleted: true,
  }).restartSafe, true)
  assert.deepEqual(planGitHubAuthInvalidation({
    localMarkerStored: false,
    durableCredentialDeleted: false,
  }), { removeLiveSession: true, keepMemoryDenied: true, restartSafe: false })
  assert.throws(
    () => planGitHubAuthInvalidation({ localMarkerStored: 'yes', durableCredentialDeleted: false }),
    (error) => error instanceof GitHubAuthStateError && error.code === 'invalid_outcome',
  )
})
