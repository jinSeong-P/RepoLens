import test from 'node:test'
import assert from 'node:assert/strict'
import { GitHubError } from '../src/lib/github.js'
import {
  GITHUB_API_PERMISSION,
  isTrustedSidePanelSender,
  serializeExtensionError,
  validateRepositoryCollectionOptions,
} from '../src/lib/github-rpc.js'

test('accepts GitHub RPC only from the extension side panel', () => {
  const runtimeId = 'extension-id'
  const sidePanelUrl = 'chrome-extension://extension-id/sidepanel.html'
  assert.equal(isTrustedSidePanelSender({ id: runtimeId, url: sidePanelUrl }, runtimeId, sidePanelUrl), true)
  assert.equal(isTrustedSidePanelSender({ id: runtimeId, url: 'chrome-extension://extension-id/other.html' }, runtimeId, sidePanelUrl), false)
  assert.equal(isTrustedSidePanelSender({ id: 'other', url: sidePanelUrl }, runtimeId, sidePanelUrl), false)
  assert.deepEqual(GITHUB_API_PERMISSION, { origins: ['https://api.github.com/*'] })
})

test('validates bounded repository collection options', () => {
  assert.deepEqual(validateRepositoryCollectionOptions(), { maxFiles: 16, depth: 'deep' })
  assert.deepEqual(validateRepositoryCollectionOptions({ maxFiles: 1 }), { maxFiles: 1, depth: 'deep' })
  assert.deepEqual(validateRepositoryCollectionOptions({ maxFiles: 32, depth: 'overview' }), { maxFiles: 32, depth: 'overview' })
  assert.deepEqual(validateRepositoryCollectionOptions({
    maxFiles: 16,
    depth: 'deep',
    expectedSha: 'A'.repeat(40),
  }), { maxFiles: 16, depth: 'deep', expectedSha: 'a'.repeat(40) })
  for (const value of [0, 33, 1.5, '16']) {
    assert.throws(() => validateRepositoryCollectionOptions({ maxFiles: value }), /옵션/)
  }
  assert.throws(() => validateRepositoryCollectionOptions({ maxFiles: 16, depth: 'full' }), /옵션/)
  assert.throws(() => validateRepositoryCollectionOptions({ maxFiles: 16, expectedSha: 'bad' }), /옵션/)
  assert.throws(() => validateRepositoryCollectionOptions({ maxFiles: 16, treeSha: 'a'.repeat(40) }), /옵션/)
})

test('serializes safe GitHub diagnostics including rate-limit reset', () => {
  const error = new GitHubError('rate_limit', '한도 도달', {
    status: 403,
    retryAt: '2026-08-13T01:02:03.000Z',
  })
  assert.deepEqual(serializeExtensionError(error), {
    source: 'github',
    name: 'GitHubError',
    code: 'rate_limit',
    message: '한도 도달',
    status: 403,
    requestId: undefined,
    retryAt: '2026-08-13T01:02:03.000Z',
    reason: undefined,
  })
})

test('serializes a bounded GitHub network failure reason', () => {
  const reason = `TypeError: ${'x'.repeat(300)}`
  const error = new GitHubError('network', 'GitHub API에 연결할 수 없습니다.', { reason })
  const serialized = serializeExtensionError(error)

  assert.equal(serialized.reason, reason.slice(0, 260))
  assert.equal(serialized.source, 'github')
  assert.equal(serialized.name, 'GitHubError')
})
