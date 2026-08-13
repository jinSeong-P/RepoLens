import test from 'node:test'
import assert from 'node:assert/strict'
import {
  githubConnectionRecoveryAvailable,
  githubConnectionStatusMessage,
  runSingleFlight,
} from '../src/lib/github-auth-ui.js'

test('single-flight shares one operation across concurrent callers', async () => {
  const holder = { flight: null }
  let calls = 0
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const operation = async () => {
    calls += 1
    await gate
    return 'connected'
  }

  const first = runSingleFlight(holder, 'flight', operation)
  const second = runSingleFlight(holder, 'flight', operation)
  assert.equal(first, second)
  await Promise.resolve()
  assert.equal(calls, 1)

  release()
  assert.deepEqual(await Promise.all([first, second]), ['connected', 'connected'])
  assert.equal(holder.flight, null)
})

test('single-flight releases its slot after resolve and reject', async () => {
  const holder = { flight: null }
  let calls = 0

  assert.equal(await runSingleFlight(holder, 'flight', async () => ++calls), 1)
  assert.equal(holder.flight, null)
  await assert.rejects(
    runSingleFlight(holder, 'flight', async () => {
      calls += 1
      throw new Error('poll failed')
    }),
    /poll failed/,
  )
  assert.equal(holder.flight, null)
  assert.equal(await runSingleFlight(holder, 'flight', async () => ++calls), 3)
})

test('an active GitHub flow keeps the approval status ahead of reconnect warnings', () => {
  assert.equal(githubConnectionStatusMessage({
    vaultStatus: 'unlocked',
    githubAuth: { connected: false },
    githubFlow: { flowId: 'active' },
    githubReconnectRequired: true,
  }), 'GitHub 승인을 기다리는 중…')
  assert.equal(githubConnectionStatusMessage({
    vaultStatus: 'locked',
    githubAuth: { connected: false },
    githubFlow: { flowId: 'transient-active' },
  }), 'GitHub 승인을 기다리는 중…')
})

test('GitHub connection recovery is offered only for relevant GitHub failures', () => {
  const disconnected = {
    vaultStatus: 'unlocked',
    githubAuth: { connected: false },
    job: null,
  }
  assert.equal(githubConnectionRecoveryAvailable(
    { code: 'rate_limit', source: 'github' },
    disconnected,
  ), true)
  assert.equal(githubConnectionRecoveryAvailable(
    { code: 'secondary_rate_limit', source: 'github' },
    disconnected,
  ), true)
  assert.equal(githubConnectionRecoveryAvailable(
    { code: 'github_auth_expired' },
    disconnected,
  ), true)
  assert.equal(githubConnectionRecoveryAvailable(
    { code: 'github_auth_changed' },
    disconnected,
  ), true)
  assert.equal(githubConnectionRecoveryAvailable(
    { code: 'rate_limit' },
    disconnected,
  ), false)
  assert.equal(githubConnectionRecoveryAvailable(
    { code: 'secondary_rate_limit' },
    disconnected,
  ), false)
  assert.equal(githubConnectionRecoveryAvailable(
    { code: 'network', source: 'github' },
    disconnected,
  ), false)
})

test('GitHub connection recovery is hidden when already connected, locked, or busy', () => {
  const error = { code: 'github_auth_expired', source: 'github' }
  assert.equal(githubConnectionRecoveryAvailable(error, {
    vaultStatus: 'unlocked',
    githubAuth: { connected: true },
    job: null,
  }), false)
  assert.equal(githubConnectionRecoveryAvailable(error, {
    vaultStatus: 'locked',
    githubAuth: { connected: false },
    job: null,
  }), false)
  assert.equal(githubConnectionRecoveryAvailable(error, {
    vaultStatus: 'unlocked',
    githubAuth: { connected: false },
    job: {},
  }), false)
})
