import { GitHubError } from './github.js'
import { resolveAnalysisFileLimit } from './analysis-settings.js'

export const GITHUB_API_PERMISSION = Object.freeze({ origins: ['https://api.github.com/*'] })

export function isTrustedSidePanelSender(sender, runtimeId, sidePanelUrl) {
  return sender?.id === runtimeId && sender?.url === sidePanelUrl
}

export function validateRepositoryCollectionOptions(value) {
  if (value === undefined) return { maxFiles: resolveAnalysisFileLimit(), depth: 'deep' }
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !['maxFiles', 'depth', 'expectedSha'].includes(key))) {
    throw new GitHubError('request', '파일 선정 옵션이 올바르지 않습니다.')
  }
  try {
    const depth = value.depth === undefined ? 'deep' : value.depth
    if (!['overview', 'deep'].includes(depth)) throw new Error('invalid depth')
    if (value.expectedSha !== undefined
      && (typeof value.expectedSha !== 'string' || !/^[0-9a-f]{40}$/i.test(value.expectedSha))) {
      throw new Error('invalid sha')
    }
    return {
      maxFiles: resolveAnalysisFileLimit(value.maxFiles),
      depth,
      ...(value.expectedSha === undefined ? {} : { expectedSha: value.expectedSha.toLowerCase() }),
    }
  } catch {
    throw new GitHubError('request', '분석 단계와 선택 파일 수 옵션이 올바르지 않습니다.')
  }
}

export function serializeExtensionError(error) {
  return {
    source: error instanceof GitHubError || error?.source === 'github' ? 'github' : undefined,
    name: error?.name === 'GitHubError' ? 'GitHubError' : undefined,
    code: typeof error?.code === 'string' ? error.code : 'unknown',
    message: typeof error?.message === 'string' ? error.message.slice(0, 500) : '알 수 없는 오류가 발생했습니다.',
    status: Number.isInteger(error?.status) ? error.status : undefined,
    requestId: typeof error?.requestId === 'string' ? error.requestId.slice(0, 200) : undefined,
    retryAt: typeof error?.retryAt === 'string' && Number.isFinite(Date.parse(error.retryAt))
      ? error.retryAt.slice(0, 50)
      : undefined,
    reason: typeof error?.reason === 'string'
      ? error.reason.slice(0, 260)
      : undefined,
  }
}
