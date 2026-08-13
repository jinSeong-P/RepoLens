import { GitHubError } from './github.js'
import { resolveAnalysisFileLimit } from './analysis-settings.js'

export type RepositoryCollectionDepth = 'overview' | 'deep'

export interface RepositoryCollectionOptions {
  maxFiles: number
  depth: RepositoryCollectionDepth
  expectedSha?: string
}

export interface SerializedExtensionError {
  source: 'github' | undefined
  name: 'GitHubError' | undefined
  code: string
  message: string
  status: number | undefined
  requestId: string | undefined
  retryAt: string | undefined
  reason: string | undefined
}

type UnknownRecord = Record<string, unknown>

export const GITHUB_API_PERMISSION: Readonly<chrome.permissions.Permissions> = Object.freeze({
  origins: ['https://api.github.com/*'],
})

export function isTrustedSidePanelSender(
  sender: Pick<chrome.runtime.MessageSender, 'id' | 'url'> | null | undefined,
  runtimeId: string,
  sidePanelUrl: string,
): boolean {
  return sender?.id === runtimeId && sender?.url === sidePanelUrl
}

export function validateRepositoryCollectionOptions(value?: unknown): RepositoryCollectionOptions {
  if (value === undefined) return { maxFiles: resolveAnalysisFileLimit(), depth: 'deep' }
  if (!isPlainObject(value)
    || Object.keys(value).some((key) => !['maxFiles', 'depth', 'expectedSha'].includes(key))) {
    throw new GitHubError('request', '파일 선정 옵션이 올바르지 않습니다.')
  }
  try {
    const depth = value.depth === undefined ? 'deep' : value.depth
    if (!isRepositoryCollectionDepth(depth)) throw new Error('invalid depth')
    if (value.expectedSha !== undefined
      && (typeof value.expectedSha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.expectedSha))) {
      throw new Error('invalid sha')
    }
    return {
      maxFiles: resolveAnalysisFileLimit(value.maxFiles),
      depth,
      ...(typeof value.expectedSha === 'string' ? { expectedSha: value.expectedSha.toLowerCase() } : {}),
    }
  } catch {
    throw new GitHubError('request', '분석 단계와 선택 파일 수 옵션이 올바르지 않습니다.')
  }
}

export function serializeExtensionError(error: unknown): SerializedExtensionError {
  const value = isPlainObject(error) ? error : {}
  return {
    source: error instanceof GitHubError || value.source === 'github' ? 'github' : undefined,
    name: value.name === 'GitHubError' ? 'GitHubError' : undefined,
    code: typeof value.code === 'string' ? value.code : 'unknown',
    message: typeof value.message === 'string' ? value.message.slice(0, 500) : '알 수 없는 오류가 발생했습니다.',
    status: typeof value.status === 'number' && Number.isInteger(value.status) ? value.status : undefined,
    requestId: typeof value.requestId === 'string' ? value.requestId.slice(0, 200) : undefined,
    retryAt: typeof value.retryAt === 'string' && Number.isFinite(Date.parse(value.retryAt))
      ? value.retryAt.slice(0, 50)
      : undefined,
    reason: typeof value.reason === 'string'
      ? value.reason.slice(0, 260)
      : undefined,
  }
}

function isRepositoryCollectionDepth(value: unknown): value is RepositoryCollectionDepth {
  return value === 'overview' || value === 'deep'
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
