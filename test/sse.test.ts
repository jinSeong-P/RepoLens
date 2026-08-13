import test from 'node:test'
import assert from 'node:assert/strict'
import { parseSseEventBlock, parseSseStream } from '../src/lib/sse.js'

function streamChunks(chunks) {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk))
      controller.close()
    },
  })
}

test('parses event fields, comments, ids, and multiline data', () => {
  assert.deepEqual(parseSseEventBlock(': ping\nid: 7\nevent: token\ndata: hello\ndata: world'), {
    event: 'token',
    data: 'hello\nworld',
    id: '7',
  })
})

test('handles event boundaries split across chunks', async () => {
  const events = []
  for await (const event of parseSseStream(streamChunks([
    'data: {"a":',
    '1}\r\n\r',
    '\ndata: [DONE]\n\n',
  ]))) events.push(event)
  assert.deepEqual(events.map((event) => event.data), ['{"a":1}', '[DONE]'])
})

test('preserves UTF-8 characters split inside a byte sequence', async () => {
  const bytes = new TextEncoder().encode('data: 한글\n\n')
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(bytes.slice(0, 8))
      controller.enqueue(bytes.slice(8, 10))
      controller.enqueue(bytes.slice(10))
      controller.close()
    },
  })
  const events = []
  for await (const event of parseSseStream(stream)) events.push(event)
  assert.equal(events[0].data, '한글')
})

test('rejects an unbounded event without a delimiter', async () => {
  const huge = `data: ${'x'.repeat(2_000_001)}`
  await assert.rejects(async () => {
    for await (const _event of parseSseStream(streamChunks([huge]))) {
      // The parser must fail before yielding an oversized event.
    }
  }, /safe size limit/)
})
