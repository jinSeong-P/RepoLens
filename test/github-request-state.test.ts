import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GitHubAuthDenyList,
  GitHubRequestRegistry,
  makeGitHubRequestKey,
} from '../src/lib/github-request-state.js'

const firstRevision = '11111111-1111-4111-8111-111111111111'
const secondRevision = '22222222-2222-4222-8222-222222222222'
const portId = '33333333-3333-4333-8333-333333333333'

test('aborts only repository requests using a replaced GitHub credential revision', () => {
  const registry = new GitHubRequestRegistry()
  const first = new AbortController()
  const second = new AbortController()
  registry.register(makeGitHubRequestKey(portId, 'first'), first)
  registry.register(makeGitHubRequestKey(portId, 'second'), second)
  registry.captureAuthRevision(makeGitHubRequestKey(portId, 'first'), firstRevision)
  registry.captureAuthRevision(makeGitHubRequestKey(portId, 'second'), secondRevision)

  assert.equal(registry.abortRevision(firstRevision), 1)
  assert.equal(first.signal.aborted, true)
  assert.equal(second.signal.aborted, false)
  assert.equal(registry.remove(makeGitHubRequestKey(portId, 'second'), second), true)
})

test('abortAll cancels registered anonymous and authenticated requests and clears them', () => {
  const registry = new GitHubRequestRegistry()
  const anonymous = new AbortController()
  const authenticated = new AbortController()
  registry.register(makeGitHubRequestKey(portId, 'anonymous'), anonymous)
  registry.register(makeGitHubRequestKey(portId, 'authenticated'), authenticated)
  registry.captureAuthRevision(makeGitHubRequestKey(portId, 'authenticated'), firstRevision)

  assert.equal(registry.abortAll(), 2)
  assert.equal(anonymous.signal.aborted, true)
  assert.equal(authenticated.signal.aborted, true)
  assert.equal(registry.abortAll(), 0)
})

test('a request cannot silently switch credential revisions', () => {
  const registry = new GitHubRequestRegistry()
  const controller = new AbortController()
  const key = makeGitHubRequestKey(portId, 'request')
  registry.register(key, controller)

  assert.equal(registry.captureAuthRevision(key, firstRevision), true)
  assert.equal(registry.captureAuthRevision(key, secondRevision), false)
  assert.equal(controller.signal.aborted, true)
})

test('worker deny list blocks a rejected revision and the same durable credential', () => {
  const denyList = new GitHubAuthDenyList()
  const session = {
    revision: firstRevision,
    auth: { createdAt: '2026-08-13T01:02:03.000Z' },
  }

  assert.equal(denyList.denyRevision(firstRevision), true)
  assert.equal(denyList.rejectsSession(session), true)
  assert.equal(denyList.rejectsDurable(session.auth), false)

  assert.equal(denyList.denySession(session), true)
  assert.equal(denyList.rejectsDurable(session.auth), true)
  denyList.clear()
  assert.equal(denyList.rejectsSession(session), false)
  assert.equal(denyList.rejectsDurable(session.auth), false)
})
