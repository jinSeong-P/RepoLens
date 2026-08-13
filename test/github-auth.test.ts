import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GitHubAuthError,
  normalizeGitHubOAuthClientId,
  normalizeGitHubPat,
  pollGitHubAccessToken,
  requestGitHubDeviceCode,
  sanitizeGitHubAuthState,
  validateGitHubAuthRecord,
  verifyGitHubToken,
} from '../src/lib/github-auth.js'

const CLIENT_ID = 'Ov23li1234567890ABCD'
const CLASSIC_PAT = `ghp_${'a'.repeat(36)}`
const OAUTH_TOKEN = `gho_${'b'.repeat(36)}`

test('normalizes configured OAuth client IDs and PAT input without accepting header text', () => {
  assert.equal(normalizeGitHubOAuthClientId(`  ${CLIENT_ID}  `), CLIENT_ID)
  assert.equal(normalizeGitHubPat(`  ${CLASSIC_PAT}\n`), CLASSIC_PAT)
  assert.equal(normalizeGitHubPat(`github_pat_${'A1_'.repeat(20)}`), `github_pat_${'A1_'.repeat(20)}`)
  assert.equal(normalizeGitHubPat('a'.repeat(40)), 'a'.repeat(40))

  for (const value of ['', 'short', 'client id', 'x'.repeat(101), 'abc\nheader']) {
    assert.throws(() => normalizeGitHubOAuthClientId(value), GitHubAuthError)
  }
  for (const value of [
    `Bearer ${CLASSIC_PAT}`,
    `gho_${'a'.repeat(36)}`,
    `ghp_${'a'.repeat(35)}`,
    `${CLASSIC_PAT}\nsecond-value`,
    `github_pat_${'a'.repeat(245)}`,
  ]) {
    assert.throws(() => normalizeGitHubPat(value), GitHubAuthError)
  }
})

test('requests a no-scope device code using fixed form POST transport', async () => {
  let observed
  const fetchImpl = async (url, init) => {
    observed = { url, init }
    return jsonResponse({
      device_code: 'device-code-secret',
      user_code: 'ABCD-EFGH',
      verification_uri: 'https://github.com/login/device',
      expires_in: 900,
      interval: 5,
    })
  }

  const result = await requestGitHubDeviceCode(CLIENT_ID, { fetchImpl })
  assert.deepEqual(result, {
    deviceCode: 'device-code-secret',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://github.com/login/device',
    expiresIn: 900,
    interval: 5,
  })
  assert.equal(observed.url, 'https://github.com/login/device/code')
  assert.equal(observed.init.method, 'POST')
  assert.equal(observed.init.credentials, 'omit')
  assert.equal(observed.init.redirect, 'error')
  assert.equal(observed.init.cache, 'no-store')
  assert.equal(observed.init.headers.Accept, 'application/json')
  const form = new URLSearchParams(observed.init.body)
  assert.equal(form.get('client_id'), CLIENT_ID)
  assert.equal(form.has('scope'), false)
})

test('polls at the required interval, honors slow_down, and accepts only an empty scope', async () => {
  let now = 0
  const waits = []
  const requests = []
  const replies = [
    { error: 'authorization_pending', error_description: `ignore ${OAUTH_TOKEN}` },
    { error: 'slow_down' },
    { access_token: OAUTH_TOKEN, token_type: 'bearer', scope: '' },
  ]
  const fetchImpl = async (url, init) => {
    requests.push({ url, init })
    return jsonResponse(replies.shift())
  }
  const sleep = async (milliseconds) => {
    waits.push(milliseconds)
    now += milliseconds
  }

  const result = await pollGitHubAccessToken(CLIENT_ID, {
    deviceCode: 'device-code-secret',
    expiresIn: 60,
    interval: 2,
  }, { fetchImpl, sleep, now: () => now })

  assert.deepEqual(result, { token: OAUTH_TOKEN, tokenType: 'bearer' })
  assert.deepEqual(waits, [2_000, 2_000, 7_000])
  assert.equal(requests.length, 3)
  for (const request of requests) {
    assert.equal(request.url, 'https://github.com/login/oauth/access_token')
    assert.equal(request.init.credentials, 'omit')
    assert.equal(request.init.redirect, 'error')
    const form = new URLSearchParams(request.init.body)
    assert.equal(form.get('client_id'), CLIENT_ID)
    assert.equal(form.get('device_code'), 'device-code-secret')
    assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:device_code')
  }
})

test('stops at local device-code expiry without starting another token request', async () => {
  let now = 0
  let calls = 0
  const waits = []
  const fetchImpl = async () => {
    calls += 1
    return jsonResponse({ error: 'authorization_pending' })
  }
  const sleep = async (milliseconds) => {
    waits.push(milliseconds)
    now += milliseconds
  }

  await assert.rejects(() => pollGitHubAccessToken(CLIENT_ID, {
    deviceCode: 'device-code-secret',
    expiresIn: 5,
    interval: 3,
  }, { fetchImpl, sleep, now: () => now }), { code: 'expired' })
  assert.equal(calls, 1)
  assert.deepEqual(waits, [3_000, 2_000])
})

test('cancels polling during a wait and never sends a token request', async () => {
  const controller = new AbortController()
  let calls = 0
  const sleep = async () => { controller.abort() }

  await assert.rejects(() => pollGitHubAccessToken(CLIENT_ID, {
    deviceCode: 'device-code-secret',
    expiresIn: 60,
    interval: 5,
  }, {
    signal: controller.signal,
    fetchImpl: async () => { calls += 1 },
    sleep,
    now: () => 0,
  }), { code: 'cancelled' })
  assert.equal(calls, 0)
})

test('rejects granted scopes and never copies a returned token into the error', async () => {
  let now = 0
  const secret = `gho_${'S'.repeat(36)}`
  const operation = pollGitHubAccessToken(CLIENT_ID, {
    deviceCode: 'device-code-secret',
    expiresIn: 60,
    interval: 1,
  }, {
    fetchImpl: async () => jsonResponse({ access_token: secret, token_type: 'bearer', scope: 'repo' }),
    sleep: async (milliseconds) => { now += milliseconds },
    now: () => now,
  })

  await assert.rejects(operation, (error) => {
    assert.equal(error.code, 'unexpected_scope')
    assert.doesNotMatch(error.message, new RegExp(secret))
    assert.doesNotMatch(JSON.stringify(error), new RegExp(secret))
    return true
  })
})

test('strictly validates stored authorization records and sanitizes public state', () => {
  const oauth = {
    method: 'oauth',
    token: OAUTH_TOKEN,
    tokenType: 'bearer',
    login: 'octocat',
    createdAt: '2026-08-13T01:02:03.000Z',
  }
  assert.deepEqual(validateGitHubAuthRecord(oauth), oauth)
  assert.deepEqual(sanitizeGitHubAuthState(oauth), {
    connected: true,
    method: 'oauth',
    login: 'octocat',
    createdAt: oauth.createdAt,
  })
  assert.doesNotMatch(JSON.stringify(sanitizeGitHubAuthState(oauth)), /gho_/)

  const pat = {
    method: 'pat',
    token: CLASSIC_PAT,
    tokenType: 'bearer',
    login: 'user-name',
    createdAt: '2026-08-13T01:02:03.000Z',
  }
  assert.deepEqual(validateGitHubAuthRecord(pat), pat)

  for (const invalid of [
    { ...oauth, tokenType: 'basic' },
    { ...pat, tokenType: '' },
    { ...oauth, token: `${OAUTH_TOKEN}\nheader` },
    { ...oauth, login: '-invalid' },
    { ...oauth, createdAt: '2026-08-13' },
    { ...oauth, extra: true },
  ]) {
    assert.throws(() => validateGitHubAuthRecord(invalid), GitHubAuthError)
    assert.deepEqual(sanitizeGitHubAuthState(invalid), {
      connected: false, method: null, login: null, createdAt: null,
    })
  }
})

test('verifies a token only against the fixed GitHub user endpoint with empty scopes', async () => {
  let observed
  const result = await verifyGitHubToken({
    method: 'pat', token: CLASSIC_PAT, tokenType: 'bearer',
  }, {
    fetchImpl: async (url, init) => {
      observed = { url, init }
      return jsonResponse({ login: 'octocat' }, {
        headers: { 'x-oauth-scopes': '' },
        url: 'https://api.github.com/user',
      })
    },
  })

  assert.deepEqual(result, { login: 'octocat' })
  assert.equal(observed.url, 'https://api.github.com/user')
  assert.equal(observed.init.headers.Authorization, `Bearer ${CLASSIC_PAT}`)
  assert.equal(observed.init.credentials, 'omit')
  assert.equal(observed.init.redirect, 'error')

  await assert.rejects(() => verifyGitHubToken({ token: OAUTH_TOKEN, tokenType: 'bearer' }, {
    fetchImpl: async () => jsonResponse({ login: 'octocat' }, {
      headers: { 'x-oauth-scopes': 'repo' },
    }),
  }), { code: 'unexpected_scope' })
})

test('rejects an off-origin verification response without exposing credentials', async () => {
  await assert.rejects(() => verifyGitHubToken({ token: OAUTH_TOKEN, tokenType: 'bearer' }, {
    fetchImpl: async () => jsonResponse({ login: 'attacker' }, { url: 'https://evil.example/user' }),
  }), (error) => {
    assert.equal(error.code, 'redirect')
    assert.doesNotMatch(error.message, new RegExp(OAUTH_TOKEN))
    return true
  })
})

function jsonResponse(value, options = {}) {
  const response = new Response(JSON.stringify(value), {
    status: options.status ?? 200,
    headers: options.headers,
  })
  if (options.url !== undefined) Object.defineProperty(response, 'url', { value: options.url })
  return response
}
