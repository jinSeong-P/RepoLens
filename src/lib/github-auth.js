const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code'
const GITHUB_ACCESS_TOKEN_URL = 'https://github.com/login/oauth/access_token'
const GITHUB_USER_URL = 'https://api.github.com/user'

const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code'
const MAX_CLIENT_ID_LENGTH = 100
const MAX_TOKEN_LENGTH = 512
const MAX_PAT_LENGTH = 255
const MAX_DEVICE_CODE_LENGTH = 512
const MAX_AUTH_RESPONSE_BYTES = 64 * 1024
const MAX_DEVICE_LIFETIME_SECONDS = 24 * 60 * 60
const MAX_POLL_INTERVAL_SECONDS = 60
const SLOW_DOWN_SECONDS = 5

const CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+$/
const CLASSIC_PAT_PATTERN = /^ghp_[A-Za-z0-9]{36}$/
const FINE_GRAINED_PAT_PATTERN = /^github_pat_[A-Za-z0-9_]{20,244}$/
const LEGACY_PAT_PATTERN = /^[A-Fa-f0-9]{40}$/
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/

export class GitHubAuthError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'GitHubAuthError'
    this.source = 'github'
    this.code = code
    this.status = Number.isInteger(options.status) ? options.status : undefined
  }
}

/**
 * GitHub OAuth client IDs are public identifiers, not client secrets. Keep the
 * accepted alphabet deliberately narrow so a configured value can safely be
 * placed in an application/x-www-form-urlencoded request.
 */
export function normalizeGitHubOAuthClientId(value) {
  const clientId = typeof value === 'string' ? value.trim() : ''
  if (clientId.length < 10 || clientId.length > MAX_CLIENT_ID_LENGTH || !CLIENT_ID_PATTERN.test(clientId)) {
    throw new GitHubAuthError('invalid_client', 'GitHub OAuth 클라이언트 설정이 올바르지 않습니다.')
  }
  return clientId
}

/** Accepts current classic/fine-grained PATs and the legacy 40-hex format. */
export function normalizeGitHubPat(value) {
  const token = typeof value === 'string' ? value.trim() : ''
  if (token.length > MAX_PAT_LENGTH
    || hasUnsafeSecretCharacters(token)
    || !(CLASSIC_PAT_PATTERN.test(token)
      || FINE_GRAINED_PAT_PATTERN.test(token)
      || LEGACY_PAT_PATTERN.test(token))) {
    throw new GitHubAuthError('invalid_token', 'GitHub 개인 액세스 토큰 형식이 올바르지 않습니다.')
  }
  return token
}

/**
 * Starts a least-privilege GitHub Device Flow. No scope field is sent, so the
 * resulting OAuth token must have an empty scope set.
 */
export async function requestGitHubDeviceCode(clientId, options = {}) {
  const normalizedClientId = normalizeGitHubOAuthClientId(clientId)
  const fetchImpl = requireFetch(options.fetchImpl)
  throwIfAborted(options.signal)

  const body = new URLSearchParams({ client_id: normalizedClientId })
  const response = await fetchAuthEndpoint(fetchImpl, GITHUB_DEVICE_CODE_URL, {
    method: 'POST',
    headers: formHeaders(),
    body: body.toString(),
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: options.signal,
  }, options.signal)

  assertEndpointResponse(response, GITHUB_DEVICE_CODE_URL)
  if (!response.ok) throw httpError(response.status)
  const payload = await readBoundedJson(response, options.signal)

  const deviceCode = requireSecret(payload?.device_code, MAX_DEVICE_CODE_LENGTH, 'invalid_device_response')
  const userCode = normalizeUserCode(payload?.user_code)
  const verificationUri = normalizeVerificationUri(payload?.verification_uri)
  const expiresIn = requireBoundedInteger(payload?.expires_in, 1, MAX_DEVICE_LIFETIME_SECONDS, 'invalid_device_response')
  const interval = requireBoundedInteger(payload?.interval ?? 5, 1, MAX_POLL_INTERVAL_SECONDS, 'invalid_device_response')

  return { deviceCode, userCode, verificationUri, expiresIn, interval }
}

/**
 * Polls GitHub according to RFC 8628. The first request waits for `interval`,
 * `slow_down` permanently adds five seconds, and no request begins at or after
 * the local expiry deadline.
 */
export async function pollGitHubAccessToken(clientId, deviceAuthorization, options = {}) {
  const normalizedClientId = normalizeGitHubOAuthClientId(clientId)
  const device = normalizeDeviceAuthorization(deviceAuthorization)
  const fetchImpl = requireFetch(options.fetchImpl)
  const now = typeof options.now === 'function' ? options.now : Date.now
  const sleep = typeof options.sleep === 'function' ? options.sleep : abortableSleep
  const startedAt = requireFiniteTime(now())
  const deadline = startedAt + device.expiresIn * 1_000
  let intervalMs = device.interval * 1_000

  while (true) {
    throwIfAborted(options.signal)
    const remaining = deadline - requireFiniteTime(now())
    if (remaining <= 0) throw expiredError()

    try {
      await sleep(Math.min(intervalMs, remaining), options.signal)
    } catch (error) {
      if (options.signal?.aborted || error?.name === 'AbortError' || error?.code === 'cancelled') {
        throw cancelledError()
      }
      throw error
    }
    throwIfAborted(options.signal)
    if (requireFiniteTime(now()) >= deadline) throw expiredError()

    const result = await exchangeGitHubDeviceToken(normalizedClientId, device, {
      fetchImpl,
      signal: options.signal,
    })
    if (result.status === 'pending') continue
    if (result.status === 'slow_down') {
        intervalMs += SLOW_DOWN_SECONDS * 1_000
        continue
    }
    return { token: result.token, tokenType: result.tokenType }
  }
}

/** Performs exactly one token exchange so an MV3 side panel can drive polling. */
export async function exchangeGitHubDeviceToken(clientId, deviceAuthorization, options = {}) {
  const normalizedClientId = normalizeGitHubOAuthClientId(clientId)
  const device = normalizeDeviceAuthorization(deviceAuthorization)
  const fetchImpl = requireFetch(options.fetchImpl)
  throwIfAborted(options.signal)

  const body = new URLSearchParams({
    client_id: normalizedClientId,
    device_code: device.deviceCode,
    grant_type: DEVICE_GRANT_TYPE,
  })
  const response = await fetchAuthEndpoint(fetchImpl, GITHUB_ACCESS_TOKEN_URL, {
    method: 'POST',
    headers: formHeaders(),
    body: body.toString(),
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: options.signal,
  }, options.signal)

  assertEndpointResponse(response, GITHUB_ACCESS_TOKEN_URL)
  if (!response.ok) throw httpError(response.status)
  const payload = await readBoundedJson(response, options.signal)
  if (typeof payload?.error === 'string') {
    if (payload.error === 'authorization_pending') return { status: 'pending' }
    if (payload.error === 'slow_down') return { status: 'slow_down' }
    if (payload.error === 'expired_token') throw expiredError()
    if (payload.error === 'access_denied') {
      throw new GitHubAuthError('access_denied', 'GitHub 연결 요청이 승인되지 않았습니다.')
    }
    throw new GitHubAuthError('oauth_error', 'GitHub 인증을 완료하지 못했습니다. 다시 연결해 주세요.')
  }

  assertEmptyScope(payload?.scope)
  const token = requireSecret(payload?.access_token, MAX_TOKEN_LENGTH, 'invalid_token_response')
  const tokenType = typeof payload?.token_type === 'string' ? payload.token_type.toLowerCase() : ''
  if (tokenType !== 'bearer') {
    throw new GitHubAuthError('invalid_token_response', 'GitHub 인증 응답 형식이 올바르지 않습니다.')
  }
  return { status: 'connected', token, tokenType }
}

/**
 * Confirms credentials against a fixed GitHub API origin and returns only the
 * public account login. The Authorization value is never copied into errors.
 */
export async function verifyGitHubToken(credentials, options = {}) {
  const normalized = normalizeVerificationCredentials(credentials)
  const fetchImpl = requireFetch(options.fetchImpl)
  throwIfAborted(options.signal)

  const response = await fetchAuthEndpoint(fetchImpl, GITHUB_USER_URL, {
    method: 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `${normalized.tokenType === 'bearer' ? 'Bearer' : 'token'} ${normalized.token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
    credentials: 'omit',
    redirect: 'error',
    cache: 'no-store',
    signal: options.signal,
  }, options.signal)

  assertEndpointResponse(response, GITHUB_USER_URL)
  if (!response.ok) {
    if (response.status === 401) {
      throw new GitHubAuthError('invalid_token', 'GitHub 인증 정보를 확인하지 못했습니다.', { status: 401 })
    }
    throw httpError(response.status)
  }
  assertEmptyScope(response.headers?.get?.('x-oauth-scopes'))
  const payload = await readBoundedJson(response, options.signal)
  return { login: normalizeLogin(payload?.login) }
}

/** Strict validator for the encrypted/stored GitHub authorization record. */
export function validateGitHubAuthRecord(value) {
  if (!isPlainObject(value) || !hasOnlyKeys(value, ['method', 'token', 'tokenType', 'login', 'createdAt'])) {
    throw new GitHubAuthError('invalid_auth_record', '저장된 GitHub 인증 정보 형식이 올바르지 않습니다.')
  }

  const method = value.method
  if (method !== 'oauth' && method !== 'pat') throw invalidAuthRecord()
  const tokenType = value.tokenType
  if (tokenType !== 'bearer' && tokenType !== 'token') throw invalidAuthRecord()
  if (method === 'oauth' && tokenType !== 'bearer') throw invalidAuthRecord()

  let token
  if (method === 'pat') {
    try {
      token = normalizeGitHubPat(value.token)
    } catch {
      throw invalidAuthRecord()
    }
    if (token !== value.token) throw invalidAuthRecord()
  } else {
    token = requireSecret(value.token, MAX_TOKEN_LENGTH, 'invalid_auth_record')
  }

  const login = normalizeLogin(value.login)
  if (login !== value.login) throw invalidAuthRecord()
  const createdAt = normalizeCreatedAt(value.createdAt)
  return { method, token, tokenType, login, createdAt }
}

/** Returns a fail-closed, token-free state suitable for UI and RPC payloads. */
export function sanitizeGitHubAuthState(value) {
  try {
    const record = validateGitHubAuthRecord(value)
    return {
      connected: true,
      method: record.method,
      login: record.login,
      createdAt: record.createdAt,
    }
  } catch {
    return { connected: false, method: null, login: null, createdAt: null }
  }
}

function normalizeVerificationCredentials(value) {
  if (!isPlainObject(value)) throw new GitHubAuthError('invalid_token', 'GitHub 인증 정보 형식이 올바르지 않습니다.')
  const tokenType = value.tokenType
  if (tokenType !== 'bearer' && tokenType !== 'token') {
    throw new GitHubAuthError('invalid_token', 'GitHub 인증 정보 형식이 올바르지 않습니다.')
  }
  if (value.method !== undefined && value.method !== 'oauth' && value.method !== 'pat') {
    throw new GitHubAuthError('invalid_token', 'GitHub 인증 정보 형식이 올바르지 않습니다.')
  }
  if (value.method === 'oauth' && tokenType !== 'bearer') {
    throw new GitHubAuthError('invalid_token', 'GitHub 인증 정보 형식이 올바르지 않습니다.')
  }
  const token = value.method === 'pat'
    ? normalizeGitHubPat(value.token)
    : requireSecret(value.token, MAX_TOKEN_LENGTH, 'invalid_token')
  return { token, tokenType }
}

function normalizeDeviceAuthorization(value) {
  if (!isPlainObject(value)) throw invalidDeviceResponse()
  return {
    deviceCode: requireSecret(value.deviceCode, MAX_DEVICE_CODE_LENGTH, 'invalid_device_response'),
    expiresIn: requireBoundedInteger(value.expiresIn, 1, MAX_DEVICE_LIFETIME_SECONDS, 'invalid_device_response'),
    interval: requireBoundedInteger(value.interval, 1, MAX_POLL_INTERVAL_SECONDS, 'invalid_device_response'),
  }
}

function normalizeUserCode(value) {
  if (typeof value !== 'string' || value.length < 4 || value.length > 32 || !/^[A-Za-z0-9-]+$/.test(value)) {
    throw invalidDeviceResponse()
  }
  return value
}

function normalizeVerificationUri(value) {
  let url
  try {
    url = new URL(value)
  } catch {
    throw invalidDeviceResponse()
  }
  if (url.protocol !== 'https:' || url.origin !== 'https://github.com'
    || url.pathname !== '/login/device' || url.username || url.password || url.search || url.hash) {
    throw invalidDeviceResponse()
  }
  return url.href
}

function normalizeLogin(value) {
  if (typeof value !== 'string' || value.length > 39 || !LOGIN_PATTERN.test(value)) throw invalidAuthRecord()
  return value
}

function normalizeCreatedAt(value) {
  if (typeof value !== 'string' || value.length > 50) throw invalidAuthRecord()
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw invalidAuthRecord()
  const canonical = new Date(timestamp).toISOString()
  if (canonical !== value) throw invalidAuthRecord()
  return canonical
}

function requireSecret(value, maxLength, code) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength || hasUnsafeSecretCharacters(value)) {
    throw new GitHubAuthError(code, 'GitHub 인증 응답 형식이 올바르지 않습니다.')
  }
  return value
}

function hasUnsafeSecretCharacters(value) {
  return typeof value !== 'string' || /[\s\u0000-\u001f\u007f]/.test(value)
}

function assertEmptyScope(value) {
  if (value === undefined || value === null) return
  if (typeof value === 'string' && value.trim() === '') return
  throw new GitHubAuthError('unexpected_scope', 'RepoLens는 권한 범위가 없는 GitHub 연결만 허용합니다.')
}

async function fetchAuthEndpoint(fetchImpl, url, init, signal) {
  try {
    const response = await fetchImpl(url, init)
    throwIfAborted(signal)
    return response
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw cancelledError()
    throw new GitHubAuthError('network', 'GitHub 인증 서버에 연결하지 못했습니다.')
  }
}

function assertEndpointResponse(response, expectedUrl) {
  if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status)) {
    throw new GitHubAuthError('invalid_response', 'GitHub 인증 서버 응답 형식이 올바르지 않습니다.')
  }
  if (typeof response.url !== 'string' || response.url === '') return
  let actual
  try {
    actual = new URL(response.url)
  } catch {
    throw new GitHubAuthError('redirect', 'GitHub 인증 응답 주소가 올바르지 않습니다.')
  }
  const expected = new URL(expectedUrl)
  if (actual.origin !== expected.origin || actual.pathname !== expected.pathname
    || actual.username || actual.password || actual.search || actual.hash) {
    throw new GitHubAuthError('redirect', 'GitHub 인증 응답 주소가 올바르지 않습니다.')
  }
}

async function readBoundedJson(response, signal) {
  let text
  try {
    text = await response.text()
  } catch (error) {
    if (signal?.aborted || error?.name === 'AbortError') throw cancelledError()
    throw new GitHubAuthError('parse', 'GitHub 인증 서버 응답을 읽지 못했습니다.')
  }
  throwIfAborted(signal)
  if (typeof text !== 'string' || text.length > MAX_AUTH_RESPONSE_BYTES) {
    throw new GitHubAuthError('parse', 'GitHub 인증 서버 응답을 읽지 못했습니다.')
  }
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('not an object')
    return parsed
  } catch {
    throw new GitHubAuthError('parse', 'GitHub 인증 서버 응답을 읽지 못했습니다.')
  }
}

function formHeaders() {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/x-www-form-urlencoded',
  }
}

function requireFetch(value) {
  const fetchImpl = value ?? globalThis.fetch
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required.')
  return (...args) => fetchImpl(...args)
}

function requireBoundedInteger(value, minimum, maximum, code) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new GitHubAuthError(code, 'GitHub 인증 응답 형식이 올바르지 않습니다.')
  }
  return value
}

function requireFiniteTime(value) {
  if (!Number.isFinite(value)) throw new TypeError('The clock must return a finite timestamp.')
  return value
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw cancelledError()
}

function abortableSleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError())
      return
    }
    const timer = setTimeout(finish, milliseconds)
    signal?.addEventListener('abort', cancel, { once: true })

    function finish() {
      signal?.removeEventListener('abort', cancel)
      resolve()
    }

    function cancel() {
      clearTimeout(timer)
      signal?.removeEventListener('abort', cancel)
      reject(cancelledError())
    }
  })
}

function hasOnlyKeys(value, expected) {
  const actual = Object.keys(value).sort()
  const keys = [...expected].sort()
  return actual.length === keys.length && actual.every((key, index) => key === keys[index])
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function invalidDeviceResponse() {
  return new GitHubAuthError('invalid_device_response', 'GitHub 인증 응답 형식이 올바르지 않습니다.')
}

function invalidAuthRecord() {
  return new GitHubAuthError('invalid_auth_record', '저장된 GitHub 인증 정보 형식이 올바르지 않습니다.')
}

function cancelledError() {
  return new GitHubAuthError('cancelled', 'GitHub 연결을 중지했습니다.')
}

function expiredError() {
  return new GitHubAuthError('expired', 'GitHub 연결 코드가 만료되었습니다. 다시 시도해 주세요.')
}

function httpError(status) {
  return new GitHubAuthError('github', 'GitHub 인증 서버가 요청을 처리하지 못했습니다.', {
    status: Number.isInteger(status) ? status : undefined,
  })
}
