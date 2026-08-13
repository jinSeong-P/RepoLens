import test from 'node:test'
import assert from 'node:assert/strict'
import { chatCompletionsUrl, normalizeBaseUrl, normalizeProviderConfig } from '../src/lib/provider-url.js'

test('normalizes HTTPS base URLs and accepts a pasted chat endpoint', () => {
  assert.equal(normalizeBaseUrl('https://api.openai.com/v1/').baseUrl, 'https://api.openai.com/v1')
  assert.equal(normalizeBaseUrl('https://example.com/v1/chat/completions').baseUrl, 'https://example.com/v1')
  assert.equal(chatCompletionsUrl('https://example.com/openai/v1'), 'https://example.com/openai/v1/chat/completions')
})

test('allows loopback HTTP only', () => {
  assert.equal(normalizeBaseUrl('http://localhost:11434/v1').origin, 'http://localhost:11434')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/v1').origin, 'http://127.0.0.1:8080')
  assert.throws(() => normalizeBaseUrl('http://localhost.evil.com/v1'), /HTTPS/)
  assert.throws(() => normalizeBaseUrl('http://10.0.0.5/v1'), /HTTPS/)
})

test('rejects credential, query, fragment, non-http, and encoded separator URLs', () => {
  for (const value of [
    'https://user:pass@example.com/v1',
    'https://example.com/v1?token=secret',
    'https://example.com/v1#frag',
    'file:///tmp/api',
    'data:text/plain,hello',
    'https://example.com/v1%2fshadow',
    'https://example.com\\v1',
  ]) {
    assert.throws(() => normalizeBaseUrl(value), { name: 'ProviderConfigError' })
  }
})

test('normalizes full provider configuration without retaining a key', () => {
  const result = normalizeProviderConfig({
    baseUrl: 'https://api.example.com/v1/',
    model: '  model-a  ',
    streaming: true,
    apiKey: 'must-not-survive',
  })
  assert.deepEqual(result, {
    baseUrl: 'https://api.example.com/v1',
    origin: 'https://api.example.com',
    permissionPattern: 'https://api.example.com/*',
    model: 'model-a',
    streaming: true,
  })
})
