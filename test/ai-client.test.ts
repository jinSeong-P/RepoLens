import test from 'node:test'
import assert from 'node:assert/strict'
import { extractStreamText, requestChat } from '../src/lib/ai-client.js'

const config = { baseUrl: 'https://api.example.com/v1', model: 'test-model', streaming: false }

test('sends bearer auth only to the normalized endpoint and parses JSON', async () => {
  let captured
  const result = await requestChat({
    config,
    apiKey: 'secret-key',
    messages: [{ role: 'user', content: 'hello' }],
    fetchImpl: async (url, init) => {
      captured = { url, init }
      return new Response(JSON.stringify({ choices: [{ message: { content: 'world' } }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    },
  })
  assert.equal(captured.url, 'https://api.example.com/v1/chat/completions')
  assert.equal(captured.init.headers.Authorization, 'Bearer secret-key')
  assert.equal(captured.init.redirect, 'error')
  assert.equal(result.text, 'world')
})

test('redacts an echoed API key in provider errors', async () => {
  await assert.rejects(
    requestChat({
      config,
      apiKey: 'secret-key',
      messages: [{ role: 'user', content: 'hello' }],
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'bad secret-key' } }), { status: 401 }),
    }),
    (error) => error.code === 'auth' && !error.message.includes('secret-key') && error.message.includes('[REDACTED]'),
  )
})

test('extracts text from string and content-part deltas', () => {
  assert.equal(extractStreamText({ choices: [{ delta: { content: 'a' } }] }), 'a')
  assert.equal(extractStreamText({ choices: [{ delta: { content: [{ text: 'a' }, { text: 'b' }] } }] }), 'ab')
  assert.equal(extractStreamText({ usage: { total_tokens: 1 }, choices: [] }), '')
})
