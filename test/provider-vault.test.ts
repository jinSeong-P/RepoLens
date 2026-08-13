import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PROVIDER_VAULT_DEFAULT_ITERATIONS,
  ProviderVaultError,
  createProviderVault,
  reencryptProviderVault,
  unlockProviderVault,
  unlockProviderVaultWithKeyMaterial,
  unsafeCreateProviderVaultTestPolicy,
  updateProviderVault,
  updateProviderVaultWithKeyMaterial,
  validateProviderVaultContents,
  validateProviderVaultEnvelope,
} from '../src/lib/provider-vault.js'

const TEST_POLICY = unsafeCreateProviderVaultTestPolicy(800)
const PASSWORD = 'correct horse 배터리 staple'
const NEXT_PASSWORD = '새로운 master password 2026'
const PRESET_ID = '11111111-1111-4111-8111-111111111111'
const PROVIDER_REF = '22222222-2222-4222-8222-222222222222'
const REVISION = '33333333-3333-4333-8333-333333333333'
const CREATED_AT = '2026-08-13T00:00:00.000Z'
const GITHUB_TOKEN = 'gho_repolens_test_token_0123456789'
const GITHUB_PAT = `ghp_${'A'.repeat(36)}`

function contents(overrides = {}) {
  return {
    version: 2,
    revision: REVISION,
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    lastActivePresetId: PRESET_ID,
    preferences: { autoLockMinutes: 30 },
    presets: [{
      id: PRESET_ID,
      providerRef: PROVIDER_REF,
      name: '기본 OpenAI',
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
      apiKey: '비밀-api-key',
      streaming: true,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    }],
    historicalProviders: [{
      providerRef: PROVIDER_REF,
      baseUrl: 'https://api.example.com/v1',
      model: 'example-model',
    }],
    githubAuth: null,
    ...overrides,
  }
}

function githubAuth(method = 'oauth') {
  return {
    method,
    token: method === 'pat' ? GITHUB_PAT : GITHUB_TOKEN,
    tokenType: method === 'pat' ? 'token' : 'bearer',
    login: 'repolens-user',
    createdAt: CREATED_AT,
  }
}

function legacyContents() {
  const current = contents()
  const { githubAuth: _githubAuth, ...legacy } = current
  return { ...legacy, version: 1 }
}

async function encryptLegacyContents(value, password) {
  const salt = Uint8Array.from({ length: 16 }, (_, index) => index + 1)
  const iv = Uint8Array.from({ length: 12 }, (_, index) => index + 17)
  const envelope = {
    formatVersion: 1,
    vaultId: '44444444-4444-4444-8444-444444444444',
    keyVersion: '55555555-5555-4555-8555-555555555555',
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations: 800,
      salt: toBase64Url(salt),
    },
    cipher: {
      name: 'AES-GCM',
      keyLength: 256,
      tagLength: 128,
      iv: toBase64Url(iv),
    },
    ciphertext: '',
  }
  const encoder = new TextEncoder()
  const passwordKey = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password.normalize('NFC')),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const rawKey = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations: envelope.kdf.iterations,
  }, passwordKey, 256)
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt'])
  const aad = encoder.encode(JSON.stringify({
    context: 'RepoLens provider vault',
    formatVersion: envelope.formatVersion,
    vaultId: envelope.vaultId,
    keyVersion: envelope.keyVersion,
    kdf: envelope.kdf,
    cipher: envelope.cipher,
  }))
  const ciphertext = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: aad,
    tagLength: 128,
  }, key, encoder.encode(JSON.stringify(value)))
  envelope.ciphertext = toBase64Url(new Uint8Array(ciphertext))
  return envelope
}

function toBase64Url(bytes) {
  return Buffer.from(bytes).toString('base64url')
}

function flipBase64UrlCharacter(value, index = 0) {
  const replacement = value[index] === 'A' ? 'B' : 'A'
  return `${value.slice(0, index)}${replacement}${value.slice(index + 1)}`
}

function flipUuidCharacter(value) {
  const replacement = value[0] === 'a' ? 'b' : 'a'
  return `${replacement}${value.slice(1)}`
}

async function assertUnlockFailure(envelope, password = PASSWORD) {
  await assert.rejects(
    unlockProviderVault(envelope, password, { policy: TEST_POLICY }),
    (error) => error instanceof ProviderVaultError
      && error.code === 'unlock_failed'
      && error.message === '비밀번호가 다르거나 암호화된 볼트가 손상되었습니다.',
  )
}

test('creates and unlocks a versioned PBKDF2/AES-GCM provider vault', async () => {
  const created = await createProviderVault(contents(), PASSWORD, { policy: TEST_POLICY })

  assert.equal(created.envelope.formatVersion, 1)
  assert.deepEqual(created.envelope.kdf, {
    name: 'PBKDF2',
    hash: 'SHA-256',
    iterations: 800,
    salt: created.envelope.kdf.salt,
  })
  assert.equal(created.envelope.cipher.name, 'AES-GCM')
  assert.equal(created.envelope.cipher.keyLength, 256)
  assert.equal(created.envelope.cipher.tagLength, 128)
  assert.doesNotMatch(JSON.stringify(created.envelope), /비밀-api-key|api\.example\.com|example-model/)

  const unlocked = await unlockProviderVault(created.envelope, PASSWORD, { policy: TEST_POLICY })
  assert.deepEqual(unlocked.contents, contents())
  assert.equal(unlocked.keyMaterial, created.keyMaterial)
  assert.deepEqual(
    await unlockProviderVaultWithKeyMaterial(created.envelope, created.keyMaterial, { policy: TEST_POLICY }),
    contents(),
  )
})

test('decrypting an encrypted legacy v1 payload migrates it to v2 with no GitHub credential', async () => {
  const envelope = await encryptLegacyContents(legacyContents(), PASSWORD)
  const unlocked = await unlockProviderVault(envelope, PASSWORD, { policy: TEST_POLICY })

  assert.deepEqual(unlocked.contents, contents())
  assert.equal(unlocked.contents.version, 2)
  assert.equal(unlocked.contents.githubAuth, null)
})

test('accepts canonical OAuth and PAT GitHub credentials', () => {
  for (const method of ['oauth', 'pat']) {
    const auth = githubAuth(method)
    const validated = validateProviderVaultContents(contents({ githubAuth: auth }))
    assert.deepEqual(validated.githubAuth, auth)
    assert.notEqual(validated.githubAuth, auth)
  }
})

test('rejects extra and malformed GitHub credential fields', () => {
  const invalid = [
    { ...githubAuth(), extra: true },
    { ...githubAuth(), method: 'device' },
    { ...githubAuth(), tokenType: 'token' },
    { ...githubAuth(), token: '' },
    { ...githubAuth(), token: 'gho_token with-space' },
    { ...githubAuth(), login: '-invalid-login' },
    { ...githubAuth(), createdAt: 'not-a-timestamp' },
  ]

  for (const githubCredential of invalid) {
    assert.throws(
      () => validateProviderVaultContents(contents({ githubAuth: githubCredential })),
      (error) => error instanceof ProviderVaultError && error.code === 'invalid_contents',
    )
  }
})

test('encrypted vault envelope never exposes the GitHub token', async () => {
  const created = await createProviderVault(
    contents({ githubAuth: githubAuth('oauth') }),
    PASSWORD,
    { policy: TEST_POLICY },
  )

  assert.equal(JSON.stringify(created.envelope).includes(GITHUB_TOKEN), false)
  assert.deepEqual(
    (await unlockProviderVault(created.envelope, PASSWORD, { policy: TEST_POLICY })).contents.githubAuth,
    githubAuth('oauth'),
  )
})

test('normalizes canonically equivalent Unicode passwords without trimming them', async () => {
  const composed = 'mot-de-passe-Caf\u00e9'
  const decomposed = 'mot-de-passe-Cafe\u0301'
  const created = await createProviderVault(contents(), composed, { policy: TEST_POLICY })
  assert.deepEqual(
    (await unlockProviderVault(created.envelope, decomposed, { policy: TEST_POLICY })).contents,
    contents(),
  )
  await assertUnlockFailure(created.envelope, ` ${composed}`)
})

test('production validation rejects deliberately weak test envelopes', async () => {
  assert.equal(PROVIDER_VAULT_DEFAULT_ITERATIONS, 600_000)
  const created = await createProviderVault(contents(), PASSWORD, { policy: TEST_POLICY })
  assert.throws(
    () => validateProviderVaultEnvelope(created.envelope),
    (error) => error.code === 'unsafe_parameters',
  )
  await assert.rejects(
    unlockProviderVault(created.envelope, PASSWORD),
    (error) => error.code === 'unsafe_parameters',
  )
  assert.throws(
    () => unsafeCreateProviderVaultTestPolicy(0),
    (error) => error.code === 'invalid_policy',
  )
})

test('wrong password and authenticated-field tampering have one safe failure', async () => {
  const { envelope } = await createProviderVault(contents(), PASSWORD, { policy: TEST_POLICY })
  await assertUnlockFailure(envelope, 'incorrect password value')

  const variants = [
    { ...envelope, ciphertext: flipBase64UrlCharacter(envelope.ciphertext) },
    { ...envelope, vaultId: flipUuidCharacter(envelope.vaultId) },
    { ...envelope, keyVersion: flipUuidCharacter(envelope.keyVersion) },
    { ...envelope, kdf: { ...envelope.kdf, salt: flipBase64UrlCharacter(envelope.kdf.salt) } },
    { ...envelope, cipher: { ...envelope.cipher, iv: flipBase64UrlCharacter(envelope.cipher.iv) } },
    { ...envelope, kdf: { ...envelope.kdf, iterations: envelope.kdf.iterations + 1 } },
  ]
  for (const variant of variants) await assertUnlockFailure(variant)
})

test('updates with a fresh IV, bumps revision, and checks optimistic concurrency', async () => {
  const created = await createProviderVault(contents(), PASSWORD, { policy: TEST_POLICY })
  const updated = await updateProviderVault(created.envelope, PASSWORD, (draft) => {
    draft.presets[0].name = '업무용 프리셋'
    draft.presets[0].updatedAt = '2026-08-13T01:00:00.000Z'
  }, {
    policy: TEST_POLICY,
    expectedRevision: REVISION,
    now: '2026-08-13T01:00:00.000Z',
  })

  assert.equal(updated.contents.presets[0].name, '업무용 프리셋')
  assert.notEqual(updated.contents.revision, REVISION)
  assert.equal(updated.contents.createdAt, CREATED_AT)
  assert.equal(updated.contents.updatedAt, '2026-08-13T01:00:00.000Z')
  assert.equal(updated.envelope.kdf.salt, created.envelope.kdf.salt)
  assert.equal(updated.envelope.keyVersion, created.envelope.keyVersion)
  assert.notEqual(updated.envelope.cipher.iv, created.envelope.cipher.iv)
  assert.notEqual(updated.envelope.ciphertext, created.envelope.ciphertext)

  await assert.rejects(
    updateProviderVaultWithKeyMaterial(updated.envelope, updated.keyMaterial, () => {}, {
      policy: TEST_POLICY,
      expectedRevision: REVISION,
    }),
    (error) => error.code === 'conflict',
  )
})

test('re-encryption preserves contents and vault ID but rotates all key metadata', async () => {
  const created = await createProviderVault(contents(), PASSWORD, { policy: TEST_POLICY })
  const changed = await reencryptProviderVault(created.envelope, PASSWORD, NEXT_PASSWORD, { policy: TEST_POLICY })

  assert.deepEqual(changed.contents, contents())
  assert.equal(changed.envelope.vaultId, created.envelope.vaultId)
  assert.notEqual(changed.envelope.keyVersion, created.envelope.keyVersion)
  assert.notEqual(changed.envelope.kdf.salt, created.envelope.kdf.salt)
  assert.notEqual(changed.envelope.cipher.iv, created.envelope.cipher.iv)
  assert.notEqual(changed.keyMaterial, created.keyMaterial)
  await assertUnlockFailure(changed.envelope, PASSWORD)
  assert.deepEqual(
    (await unlockProviderVault(changed.envelope, NEXT_PASSWORD, { policy: TEST_POLICY })).contents,
    contents(),
  )
})

test('strict schemas reject extra fields, dangling references, and noncanonical providers', async () => {
  assert.throws(
    () => validateProviderVaultContents({ ...contents(), leaked: 'secret' }),
    (error) => error.code === 'invalid_contents',
  )
  assert.throws(
    () => validateProviderVaultContents({ ...contents(), lastActivePresetId: '44444444-4444-4444-8444-444444444444' }),
    (error) => error.code === 'invalid_contents',
  )
  assert.throws(
    () => validateProviderVaultContents({
      ...contents(),
      presets: [{ ...contents().presets[0], baseUrl: 'https://api.example.com/v1/' }],
    }),
    (error) => error.code === 'invalid_contents',
  )

  const { envelope } = await createProviderVault(contents(), PASSWORD, { policy: TEST_POLICY })
  assert.throws(
    () => validateProviderVaultEnvelope({ ...envelope, unexpected: true }, { policy: TEST_POLICY }),
    (error) => error.code === 'invalid_envelope',
  )
})

test('new passwords enforce the production-independent length policy', async () => {
  await assert.rejects(
    createProviderVault(contents(), 'short', { policy: TEST_POLICY }),
    (error) => error.code === 'password_policy',
  )
  const created = await createProviderVault(contents(), PASSWORD, { policy: TEST_POLICY })
  await assert.rejects(
    reencryptProviderVault(created.envelope, PASSWORD, 'too-short', { policy: TEST_POLICY }),
    (error) => error.code === 'password_policy',
  )
})
