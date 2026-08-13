/*
 * Derived from PocketRisu src/ts/preset/adapter/sse.ts at
 * 85a65f3137b45c8de4a8d21a9887be213b1ac3fc, converted to JavaScript.
 * PocketRisu is Copyright (C) 2024 Kwaroran and licensed under GPL v3.
 */

export interface SseEvent {
  event: string | undefined
  data: string
  id: string | undefined
}

interface EventBoundary {
  start: number
  end: number
}

export async function* parseSseStream(input: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent, void, undefined> {
  const maxBufferChars = 2_000_000
  const reader = input.getReader()
  const decoder = new TextDecoder('utf-8')
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      if (buffer.length > maxBufferChars) throw new Error('SSE event exceeds the safe size limit')
      for (const event of drainEvents(buffer, false)) yield event
      buffer = remainderAfterDrain(buffer)
    }
    buffer += decoder.decode()
    for (const event of drainEvents(buffer, true)) yield event
  } finally {
    reader.releaseLock()
  }
}

export function parseSseEventBlock(raw: string): SseEvent | null {
  if (raw.length === 0) return null
  const lines = raw.split(/\r\n|\n|\r/)
  let event: string | undefined
  let id: string | undefined
  const dataLines: string[] = []
  let sawField = false

  for (const line of lines) {
    if (line.length === 0 || line.startsWith(':')) continue
    sawField = true
    const colonIndex = line.indexOf(':')
    const field = colonIndex === -1 ? line : line.slice(0, colonIndex)
    let value = colonIndex === -1 ? '' : line.slice(colonIndex + 1)
    if (value.startsWith(' ')) value = value.slice(1)

    if (field === 'event') event = value
    if (field === 'data') dataLines.push(value)
    if (field === 'id') id = value
  }

  if (!sawField) return null
  return { event, data: dataLines.join('\n'), id }
}

function* drainEvents(buffer: string, flushTrailing: boolean): Generator<SseEvent, void, undefined> {
  let scan = buffer
  while (true) {
    const boundary = findEventBoundary(scan)
    if (boundary === null) {
      if (flushTrailing && scan.length > 0) {
        const event = parseSseEventBlock(scan)
        if (event) yield event
      }
      return
    }
    const raw = scan.slice(0, boundary.start)
    scan = scan.slice(boundary.end)
    const event = parseSseEventBlock(raw)
    if (event) yield event
  }
}

function remainderAfterDrain(buffer: string): string {
  let scan = buffer
  while (true) {
    const boundary = findEventBoundary(scan)
    if (boundary === null) return scan
    scan = scan.slice(boundary.end)
  }
}

function findEventBoundary(buffer: string): EventBoundary | null {
  let best: EventBoundary | null = null
  for (const delimiter of ['\r\n\r\n', '\n\n', '\r\r']) {
    const index = buffer.indexOf(delimiter)
    if (index !== -1 && (best === null || index < best.start)) {
      best = { start: index, end: index + delimiter.length }
    }
  }
  return best
}
