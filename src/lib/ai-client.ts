/*
 * OpenAI-compatible request/response behavior is adapted from PocketRisu
 * src/ts/preset/adapter/openaiCompatible.ts at commit
 * 85a65f3137b45c8de4a8d21a9887be213b1ac3fc.
 * PocketRisu is Copyright (C) 2024 Kwaroran and licensed under
 * GPL-3.0-only. This file was modified for RepoLens on 2026-08-13;
 * see THIRD_PARTY_NOTICES.md for provenance and the change summary.
 */

import { chatCompletionsUrl, normalizeProviderConfig } from './provider-url.js'
import type { ProviderConfigInput } from './provider-url.js'
import { parseSseStream } from './sse.js'

const MAX_OUTPUT_CHARS = 1_500_000

export type AiRequestErrorCode =
  | 'auth'
  | 'request'
  | 'parse'
  | 'limit'
  | 'cancelled'
  | 'network'
  | 'not_found'
  | 'rate_limit'
  | 'provider'

export interface AiRequestErrorOptions {
  status?: number
  requestId?: string
}

export interface ChatRequestOptions {
  config: ProviderConfigInput | null | undefined
  apiKey: unknown
  messages: unknown
  signal?: AbortSignal
  onDelta?: (delta: string) => void
  fetchImpl?: typeof fetch
}

export interface ChatResult {
  text: string
  streamed: boolean
}

interface ChatRequestBody {
  model: string
  messages: unknown[]
  stream: boolean
}

interface FetchOptions {
  fetchImpl: typeof fetch
  url: string
  apiKey: string
  signal?: AbortSignal
  body: ChatRequestBody
}

type UnknownRecord = Record<string, unknown>

export class AiRequestError extends Error {
  readonly code: AiRequestErrorCode
  readonly status: number | undefined
  readonly requestId: string | undefined

  constructor(code: AiRequestErrorCode, message: string, options: AiRequestErrorOptions = {}) {
    super(message)
    this.name = 'AiRequestError'
    this.code = code
    this.status = options.status
    this.requestId = options.requestId
  }
}

export async function requestChat({
  config,
  apiKey,
  messages,
  signal,
  onDelta,
  fetchImpl = fetch,
}: ChatRequestOptions): Promise<ChatResult> {
  const normalized = normalizeProviderConfig(config)
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new AiRequestError('auth', '이 세션에 API 키가 없습니다.')
  }
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new AiRequestError('request', 'AI 요청 메시지가 비어 있습니다.')
  }
  const response = await performFetch({
    fetchImpl,
    url: chatCompletionsUrl(normalized.baseUrl),
    apiKey,
    signal,
    body: {
      model: normalized.model,
      messages,
      stream: normalized.streaming,
    },
  })

  if (!response.ok) throw await deriveHttpError(response, apiKey)

  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''
  if (!normalized.streaming || !contentType.includes('text/event-stream')) {
    return parseJsonResponse(await readJsonResponse(response), false)
  }

  if (!response.body) throw new AiRequestError('parse', 'AI 스트림 응답 본문이 없습니다.')

  let text = ''
  try {
    for await (const event of parseSseStream(response.body)) {
      if (event.data.trim() === '[DONE]') break
      if (!event.data) continue

      let chunk
      try {
        chunk = JSON.parse(event.data)
      } catch {
        throw new AiRequestError('parse', 'AI 스트림 조각을 JSON으로 읽지 못했습니다.')
      }

      const delta = extractStreamText(chunk)
      if (!delta) continue
      text += delta
      if (text.length > MAX_OUTPUT_CHARS) {
        throw new AiRequestError('limit', 'AI 응답이 안전한 크기 제한을 초과했습니다.')
      }
      onDelta?.(delta)
    }
  } catch (error) {
    if (error instanceof AiRequestError) throw error
    if (signal?.aborted) throw new AiRequestError('cancelled', '요청이 중지되었습니다.')
    throw new AiRequestError('network', 'AI 스트림 연결이 응답 완료 전에 끊겼습니다.')
  }

  if (!text.trim()) throw new AiRequestError('parse', 'AI가 비어 있는 응답을 반환했습니다.')
  return { text, streamed: true }
}

async function performFetch({ fetchImpl, url, apiKey, signal, body }: FetchOptions): Promise<Response> {
  try {
    return await fetchImpl(url, {
      method: 'POST',
      headers: {
        Accept: body.stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      redirect: 'error',
      signal,
    })
  } catch (error) {
    if (signal?.aborted || errorName(error) === 'AbortError') {
      throw new AiRequestError('cancelled', '요청이 중지되었습니다.')
    }
    throw new AiRequestError('network', 'AI 서버에 연결할 수 없습니다. 주소와 네트워크 상태를 확인해 주세요.')
  }
}

async function readJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    throw new AiRequestError('parse', 'AI JSON 응답을 읽지 못했습니다.')
  }
}

function parseJsonResponse(raw: unknown, streamed: boolean): ChatResult {
  if (!isPlainObject(raw) || !Array.isArray(raw.choices) || raw.choices.length === 0) {
    throw new AiRequestError('parse', 'AI 응답에 choices가 없습니다.')
  }
  const first = raw.choices[0]
  const content = isPlainObject(first) && isPlainObject(first.message)
    ? extractMessageContent(first.message.content)
    : ''
  if (!content.trim()) throw new AiRequestError('parse', 'AI가 비어 있는 응답을 반환했습니다.')
  if (content.length > MAX_OUTPUT_CHARS) throw new AiRequestError('limit', 'AI 응답이 안전한 크기 제한을 초과했습니다.')
  return { text: content, streamed }
}

function extractMessageContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => isPlainObject(part) && typeof part.text === 'string' ? part.text : '')
    .join('')
}

export function extractStreamText(raw: unknown): string {
  if (!isPlainObject(raw) || !Array.isArray(raw.choices) || raw.choices.length === 0) return ''
  const first = raw.choices[0]
  if (!isPlainObject(first) || !isPlainObject(first.delta)) return ''
  return extractMessageContent(first.delta.content)
}

async function deriveHttpError(response: Response, apiKey: string): Promise<AiRequestError> {
  let message = `AI 서버가 HTTP ${response.status}로 응답했습니다.`
  try {
    const body = (await response.text()).slice(0, 8_000)
    const parsed = JSON.parse(body)
    const candidate = errorMessageCandidate(parsed)
    if (typeof candidate === 'string' && candidate.trim()) message = candidate.trim()
  } catch {
    // Status-based message remains safe and useful.
  }

  if (apiKey) message = message.split(apiKey).join('[REDACTED]')
  message = message.slice(0, 500)
  const requestId = response.headers.get('x-request-id') ?? undefined
  const status = response.status
  const code = status === 401 || status === 403
    ? 'auth'
    : status === 404
      ? 'not_found'
      : status === 429
        ? 'rate_limit'
        : status >= 500
          ? 'provider'
          : 'request'
  return new AiRequestError(code, message, { status, requestId })
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function errorName(error: unknown): string | undefined {
  return isPlainObject(error) && typeof error.name === 'string' ? error.name : undefined
}

function errorMessageCandidate(value: unknown): unknown {
  if (!isPlainObject(value)) return undefined
  if (isPlainObject(value.error) && typeof value.error.message === 'string') return value.error.message
  return value.message
}
