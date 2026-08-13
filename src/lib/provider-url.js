const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export class ProviderConfigError extends Error {
  constructor(message, field = 'baseUrl') {
    super(message)
    this.name = 'ProviderConfigError'
    this.field = field
  }
}

export function normalizeProviderConfig(input) {
  const normalized = normalizeBaseUrl(input?.baseUrl)
  const model = typeof input?.model === 'string' ? input.model.trim() : ''

  if (!model) {
    throw new ProviderConfigError('Model ID를 입력해 주세요.', 'model')
  }
  if (model.length > 200 || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new ProviderConfigError('Model ID 형식이 올바르지 않습니다.', 'model')
  }

  return {
    baseUrl: normalized.baseUrl,
    origin: normalized.origin,
    permissionPattern: normalized.permissionPattern,
    model,
    streaming: input?.streaming !== false,
  }
}

export function normalizeBaseUrl(input) {
  const raw = typeof input === 'string' ? input.trim() : ''
  if (!raw) throw new ProviderConfigError('API 기준 URL을 입력해 주세요.')
  if (raw.includes('\\')) throw new ProviderConfigError('URL에 역슬래시를 사용할 수 없습니다.')

  let url
  try {
    url = new URL(raw)
  } catch {
    throw new ProviderConfigError('올바른 API 기준 URL을 입력해 주세요.')
  }

  if (url.username || url.password) {
    throw new ProviderConfigError('사용자명이나 비밀번호가 포함된 URL은 사용할 수 없습니다.')
  }
  if (url.search || url.hash) {
    throw new ProviderConfigError('API 기준 URL에는 쿼리나 프래그먼트를 넣을 수 없습니다.')
  }

  const isLoopback = LOOPBACK_HOSTS.has(url.hostname)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback)) {
    throw new ProviderConfigError('외부 AI 서버는 HTTPS만, 로컬 서버는 loopback HTTP만 허용합니다.')
  }
  if (/%(?:2f|5c|2e)/i.test(url.pathname)) {
    throw new ProviderConfigError('인코딩된 경로 구분자가 있는 URL은 사용할 수 없습니다.')
  }

  let path = url.pathname.replace(/\/+$/, '')
  if (path.endsWith('/chat/completions')) {
    path = path.slice(0, -'/chat/completions'.length)
  }
  url.pathname = path || '/'
  url.search = ''
  url.hash = ''

  const baseUrl = `${url.origin}${url.pathname === '/' ? '' : url.pathname}`
  const permissionHost = url.hostname === '[::1]' ? '[::1]' : url.hostname
  const permissionPattern = `${url.protocol}//${permissionHost}/*`

  return {
    baseUrl,
    origin: url.origin,
    permissionPattern,
    isLoopback,
  }
}

export function chatCompletionsUrl(baseUrl) {
  const normalized = normalizeBaseUrl(baseUrl)
  return `${normalized.baseUrl}/chat/completions`
}

export function providerCacheIdentity(config) {
  const normalized = normalizeProviderConfig(config)
  return `${normalized.baseUrl}|${normalized.model}`
}
