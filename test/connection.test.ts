import test from 'node:test'
import assert from 'node:assert/strict'
import {
  canReuseConnectionKey,
  connectionMatchesSnapshot,
  isConnectionRecord,
  providerIdentity,
} from '../src/lib/connection.js'

const provider = {
  baseUrl: 'https://api.example.com/v1',
  model: 'model-a',
  streaming: true,
}

test('matches one atomic credential record to an exact provider revision', () => {
  const connection = { provider, apiKey: 'secret', revision: 'revision-a' }
  assert.equal(isConnectionRecord(connection), true)
  assert.equal(connectionMatchesSnapshot(connection, provider, 'revision-a'), true)
  assert.equal(connectionMatchesSnapshot(connection, provider, 'revision-b'), false)
  assert.equal(connectionMatchesSnapshot(connection, { ...provider, model: 'model-b' }, 'revision-a'), false)
})

test('allows key reuse only for the exact normalized base URL', () => {
  const connection = { provider, apiKey: 'secret', revision: 'revision-a' }
  assert.equal(canReuseConnectionKey(connection, { ...provider, model: 'model-b' }), true)
  assert.equal(canReuseConnectionKey(connection, { ...provider, baseUrl: 'https://api.example.com/other' }), false)
  assert.equal(canReuseConnectionKey(connection, { ...provider, baseUrl: 'https://other.example/v1' }), false)
})

test('provider identity includes path, model, and streaming mode', () => {
  assert.notEqual(providerIdentity(provider), providerIdentity({ ...provider, baseUrl: 'https://api.example.com/v2' }))
  assert.notEqual(providerIdentity(provider), providerIdentity({ ...provider, streaming: false }))
})
