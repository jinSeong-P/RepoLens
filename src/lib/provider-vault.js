import { normalizeProviderConfig } from './provider-url.js'
import { validateGitHubAuthRecord } from './github-auth.js'

export const PROVIDER_VAULT_FORMAT_VERSION = 1
export const PROVIDER_VAULT_CONTENTS_VERSION = 2
export const PROVIDER_VAULT_DEFAULT_ITERATIONS = 600_000
export const PROVIDER_VAULT_MIN_ITERATIONS = 600_000

const MAX_ITERATIONS = 2_000_000
const AES_KEY_BYTES = 32
const SALT_BYTES = 16
const IV_BYTES = 12
const TAG_LENGTH_BITS = 128
const MAX_PASSWORD_BYTES = 1_024
const MIN_NEW_PASSWORD_CODE_POINTS = 12
const MAX_CONTENT_BYTES = 512 * 1_024
const MAX_PRESETS = 50
const MAX_HISTORICAL_PROVIDERS = 200
const MAX_NAME_LENGTH = 100
const MAX_API_KEY_LENGTH = 8_192
const MAX_BASE_URL_LENGTH = 2_048
const MAX_MODEL_LENGTH = 200
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/
const ENVELOPE_KEYS = ['cipher', 'ciphertext', 'formatVersion', 'kdf', 'keyVersion', 'vaultId']
const KDF_KEYS = ['hash', 'iterations', 'name', 'salt']
const CIPHER_KEYS = ['iv', 'keyLength', 'name', 'tagLength']
const LEGACY_CONTENT_KEYS = [
  'createdAt',
  'historicalProviders',
  'lastActivePresetId',
  'preferences',
  'presets',
  'revision',
  'updatedAt',
  'version',
]
const CONTENT_KEYS = [...LEGACY_CONTENT_KEYS, 'githubAuth'].sort()
const PRESET_KEYS = [
  'apiKey',
  'baseUrl',
  'createdAt',
  'id',
  'model',
  'name',
  'providerRef',
  'streaming',
  'updatedAt',
]
const HISTORICAL_PROVIDER_KEYS = ['baseUrl', 'model', 'providerRef']
const GITHUB_AUTH_KEYS = ['createdAt', 'login', 'method', 'token', 'tokenType']
const PREFERENCES_KEYS = ['autoLockMinutes']
const TEST_POLICY_BRAND = Symbol('RepoLensProviderVaultTestPolicy')
const PRODUCTION_POLICY = Object.freeze({
  defaultIterations: PROVIDER_VAULT_DEFAULT_ITERATIONS,
  minIterations: PROVIDER_VAULT_MIN_ITERATIONS,
  maxIterations: MAX_ITERATIONS,
})

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

export class ProviderVaultError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProviderVaultError'
    this.code = code
  }
}

/**
 * Creates a deliberately weak policy for fast unit tests. Never use the
 * returned policy for real vaults. Production APIs reject envelopes below
 * PROVIDER_VAULT_MIN_ITERATIONS unless this exact branded policy is supplied.
 */
export function unsafeCreateProviderVaultTestPolicy(iterations = 1_000) {
  if (!Number.isSafeInteger(iterations) || iterations < 1 || iterations > 100_000) {
    throw new ProviderVaultError('invalid_policy', '테스트 반복 횟수는 1~100,000 사이여야 합니다.')
  }
  return Object.freeze({
    [TEST_POLICY_BRAND]: true,
    defaultIterations: iterations,
    minIterations: 1,
    maxIterations: 100_000,
  })
}

/**
 * Encrypts a fully formed provider-vault contents record with a new salt and
 * key version. The returned keyMaterial is an opaque, session-only capability.
 */
export async function createProviderVault(contents, password, options = {}) {
  const policy = resolvePolicy(options.policy)
  const cryptoImpl = resolveCrypto(options.crypto)
  const iterations = resolveIterations(options.iterations, policy)
  const normalizedContents = validateProviderVaultContents(contents)
  const passwordBytes = encodePassword(password, true)
  const salt = randomBytes(cryptoImpl, SALT_BYTES)
  let rawKey

  try {
    rawKey = await deriveKeyMaterial(cryptoImpl, passwordBytes, salt, iterations)
    const metadata = makeMetadata({
      cryptoImpl,
      iterations,
      salt,
      vaultId: randomUuid(cryptoImpl),
      keyVersion: randomUuid(cryptoImpl),
    })
    const envelope = await encryptContents(cryptoImpl, metadata, normalizedContents, rawKey)
    return {
      envelope,
      contents: normalizedContents,
      keyMaterial: encodeBase64Url(rawKey),
    }
  } finally {
    passwordBytes.fill(0)
    rawKey?.fill(0)
    salt.fill(0)
  }
}

/**
 * Unlocks an envelope with a password and returns validated contents plus an
 * opaque keyMaterial string suitable only for trusted session storage.
 */
export async function unlockProviderVault(envelope, password, options = {}) {
  const policy = resolvePolicy(options.policy)
  const cryptoImpl = resolveCrypto(options.crypto)
  const metadata = validateProviderVaultEnvelope(envelope, { policy })
  const passwordBytes = encodePassword(password, false)
  const salt = decodeBase64Url(metadata.kdf.salt, SALT_BYTES, 'invalid_envelope')
  let rawKey

  try {
    rawKey = await deriveKeyMaterial(cryptoImpl, passwordBytes, salt, metadata.kdf.iterations)
    const contents = await decryptContents(cryptoImpl, metadata, rawKey)
    return { contents, keyMaterial: encodeBase64Url(rawKey) }
  } finally {
    passwordBytes.fill(0)
    rawKey?.fill(0)
    salt.fill(0)
  }
}

/** Unlocks without PBKDF2 by using the session capability returned at unlock. */
export async function unlockProviderVaultWithKeyMaterial(envelope, keyMaterial, options = {}) {
  const policy = resolvePolicy(options.policy)
  const cryptoImpl = resolveCrypto(options.crypto)
  const metadata = validateProviderVaultEnvelope(envelope, { policy })
  const rawKey = decodeKeyMaterial(keyMaterial)
  try {
    return await decryptContents(cryptoImpl, metadata, rawKey)
  } finally {
    rawKey.fill(0)
  }
}

/**
 * Updates contents using a password. The updater may mutate its draft and
 * return undefined, or return a replacement record. Salt/keyVersion stay the
 * same while AES-GCM always receives a fresh IV.
 */
export async function updateProviderVault(envelope, password, updater, options = {}) {
  const unlocked = await unlockProviderVault(envelope, password, options)
  return updateProviderVaultWithKeyMaterial(envelope, unlocked.keyMaterial, updater, options)
}

/** Session-optimized counterpart of updateProviderVault. */
export async function updateProviderVaultWithKeyMaterial(envelope, keyMaterial, updater, options = {}) {
  if (typeof updater !== 'function') {
    throw new ProviderVaultError('invalid_update', '볼트 업데이트 함수가 필요합니다.')
  }

  const policy = resolvePolicy(options.policy)
  const cryptoImpl = resolveCrypto(options.crypto)
  const metadata = validateProviderVaultEnvelope(envelope, { policy })
  const rawKey = decodeKeyMaterial(keyMaterial)

  try {
    const current = await decryptContents(cryptoImpl, metadata, rawKey)
    if (options.expectedRevision !== undefined && options.expectedRevision !== current.revision) {
      throw new ProviderVaultError('conflict', '볼트가 다른 화면에서 변경되었습니다. 다시 열고 시도해 주세요.')
    }

    const draft = structuredClone(current)
    const replacement = await updater(draft)
    const candidate = replacement === undefined ? draft : replacement
    if (!isPlainObject(candidate)) {
      throw new ProviderVaultError('invalid_update', '볼트 업데이트 결과가 올바르지 않습니다.')
    }

    const now = currentTimestamp(options.now)
    const next = validateProviderVaultContents({
      ...candidate,
      version: PROVIDER_VAULT_CONTENTS_VERSION,
      revision: randomUuid(cryptoImpl),
      createdAt: current.createdAt,
      updatedAt: now,
    })
    const nextEnvelope = await encryptContents(cryptoImpl, metadata, next, rawKey)
    return { envelope: nextEnvelope, contents: next, keyMaterial }
  } finally {
    rawKey.fill(0)
  }
}

/**
 * Changes the master password. A new salt, key version, IV, and derived key
 * are created; the vault ID and decrypted contents are preserved.
 */
export async function reencryptProviderVault(envelope, currentPassword, nextPassword, options = {}) {
  const policy = resolvePolicy(options.policy)
  const cryptoImpl = resolveCrypto(options.crypto)
  const currentMetadata = validateProviderVaultEnvelope(envelope, { policy })
  const unlocked = await unlockProviderVault(currentMetadata, currentPassword, { ...options, policy })
  const passwordBytes = encodePassword(nextPassword, true)
  const iterations = resolveIterations(options.iterations, policy)
  const salt = randomBytes(cryptoImpl, SALT_BYTES)
  let rawKey

  try {
    rawKey = await deriveKeyMaterial(cryptoImpl, passwordBytes, salt, iterations)
    const metadata = makeMetadata({
      cryptoImpl,
      iterations,
      salt,
      vaultId: currentMetadata.vaultId,
      keyVersion: randomUuid(cryptoImpl),
    })
    const nextEnvelope = await encryptContents(cryptoImpl, metadata, unlocked.contents, rawKey)
    return {
      envelope: nextEnvelope,
      contents: unlocked.contents,
      keyMaterial: encodeBase64Url(rawKey),
    }
  } finally {
    passwordBytes.fill(0)
    rawKey?.fill(0)
    salt.fill(0)
  }
}

/** Strictly validates and clones the public envelope metadata. */
export function validateProviderVaultEnvelope(value, options = {}) {
  const policy = resolvePolicy(options.policy)
  if (!isPlainObject(value) || !hasExactKeys(value, ENVELOPE_KEYS)) {
    throw new ProviderVaultError('invalid_envelope', '암호화 볼트 형식이 올바르지 않습니다.')
  }
  if (value.formatVersion !== PROVIDER_VAULT_FORMAT_VERSION) {
    throw new ProviderVaultError('unsupported_version', '지원하지 않는 암호화 볼트 버전입니다.')
  }
  assertUuid(value.vaultId, 'vaultId', 'invalid_envelope')
  assertUuid(value.keyVersion, 'keyVersion', 'invalid_envelope')

  if (!isPlainObject(value.kdf) || !hasExactKeys(value.kdf, KDF_KEYS)) {
    throw new ProviderVaultError('invalid_envelope', '볼트 키 파생 설정이 올바르지 않습니다.')
  }
  if (value.kdf.name !== 'PBKDF2' || value.kdf.hash !== 'SHA-256') {
    throw new ProviderVaultError('unsupported_algorithm', '지원하지 않는 볼트 키 파생 방식입니다.')
  }
  if (!Number.isSafeInteger(value.kdf.iterations)
    || value.kdf.iterations < policy.minIterations
    || value.kdf.iterations > policy.maxIterations) {
    throw new ProviderVaultError('unsafe_parameters', '볼트 키 파생 반복 횟수가 허용 범위를 벗어났습니다.')
  }
  decodeBase64Url(value.kdf.salt, SALT_BYTES, 'invalid_envelope')

  if (!isPlainObject(value.cipher) || !hasExactKeys(value.cipher, CIPHER_KEYS)) {
    throw new ProviderVaultError('invalid_envelope', '볼트 암호 설정이 올바르지 않습니다.')
  }
  if (value.cipher.name !== 'AES-GCM'
    || value.cipher.keyLength !== AES_KEY_BYTES * 8
    || value.cipher.tagLength !== TAG_LENGTH_BITS) {
    throw new ProviderVaultError('unsupported_algorithm', '지원하지 않는 볼트 암호 방식입니다.')
  }
  decodeBase64Url(value.cipher.iv, IV_BYTES, 'invalid_envelope')
  const ciphertext = decodeBase64Url(value.ciphertext, null, 'invalid_envelope', MAX_CONTENT_BYTES + TAG_LENGTH_BITS / 8)
  if (ciphertext.length <= TAG_LENGTH_BITS / 8) {
    throw new ProviderVaultError('invalid_envelope', '볼트 암호문이 비어 있거나 너무 짧습니다.')
  }

  return structuredClone(value)
}

/** Strictly validates, normalizes, and clones decrypted provider data. */
export function validateProviderVaultContents(value) {
  if (!isPlainObject(value)) {
    throw new ProviderVaultError('invalid_contents', '암호화 볼트 내용 형식이 올바르지 않습니다.')
  }
  const legacy = value.version === 1 && hasExactKeys(value, LEGACY_CONTENT_KEYS)
  const current = value.version === PROVIDER_VAULT_CONTENTS_VERSION && hasExactKeys(value, CONTENT_KEYS)
  if (!legacy && !current && ![1, PROVIDER_VAULT_CONTENTS_VERSION].includes(value.version)) {
    throw new ProviderVaultError('unsupported_contents_version', '지원하지 않는 볼트 내용 버전입니다.')
  }
  if (!legacy && !current) {
    throw new ProviderVaultError('invalid_contents', '암호화 볼트 내용 형식이 올바르지 않습니다.')
  }
  assertUuid(value.revision, 'revision', 'invalid_contents')
  assertTimestamp(value.createdAt, 'createdAt')
  assertTimestamp(value.updatedAt, 'updatedAt')
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new ProviderVaultError('invalid_contents', '볼트 수정 시각이 생성 시각보다 빠릅니다.')
  }

  if (!isPlainObject(value.preferences) || !hasExactKeys(value.preferences, PREFERENCES_KEYS)) {
    throw new ProviderVaultError('invalid_contents', '볼트 잠금 설정이 올바르지 않습니다.')
  }
  const autoLockMinutes = value.preferences.autoLockMinutes
  if (!Number.isSafeInteger(autoLockMinutes) || autoLockMinutes < 0 || autoLockMinutes > 1_440) {
    throw new ProviderVaultError('invalid_contents', '자동 잠금 시간은 0~1,440분 사이여야 합니다.')
  }

  if (!Array.isArray(value.presets) || value.presets.length > MAX_PRESETS) {
    throw new ProviderVaultError('invalid_contents', `AI 프리셋은 최대 ${MAX_PRESETS}개까지 저장할 수 있습니다.`)
  }
  if (!Array.isArray(value.historicalProviders)
    || value.historicalProviders.length > MAX_HISTORICAL_PROVIDERS) {
    throw new ProviderVaultError('invalid_contents', `Provider 기록은 최대 ${MAX_HISTORICAL_PROVIDERS}개까지 저장할 수 있습니다.`)
  }

  const historicalProviders = value.historicalProviders.map(validateHistoricalProvider)
  const referenceMap = new Map()
  const identityMap = new Map()
  for (const provider of historicalProviders) {
    if (referenceMap.has(provider.providerRef)) {
      throw new ProviderVaultError('invalid_contents', '중복된 providerRef가 있습니다.')
    }
    const identity = providerIdentity(provider)
    if (identityMap.has(identity)) {
      throw new ProviderVaultError('invalid_contents', '동일한 AI 제공자에 서로 다른 providerRef가 있습니다.')
    }
    referenceMap.set(provider.providerRef, provider)
    identityMap.set(identity, provider.providerRef)
  }

  const presetIds = new Set()
  const presets = value.presets.map((preset) => {
    const normalized = validatePreset(preset)
    if (presetIds.has(normalized.id)) {
      throw new ProviderVaultError('invalid_contents', '중복된 프리셋 ID가 있습니다.')
    }
    presetIds.add(normalized.id)
    const provider = referenceMap.get(normalized.providerRef)
    if (!provider || providerIdentity(provider) !== providerIdentity(normalized)) {
      throw new ProviderVaultError('invalid_contents', '프리셋의 providerRef와 제공자 기록이 일치하지 않습니다.')
    }
    return normalized
  })

  const lastActivePresetId = value.lastActivePresetId
  if (lastActivePresetId !== null
    && (typeof lastActivePresetId !== 'string' || !presetIds.has(lastActivePresetId))) {
    throw new ProviderVaultError('invalid_contents', '활성 프리셋 ID가 저장된 프리셋과 일치하지 않습니다.')
  }

  return {
    version: PROVIDER_VAULT_CONTENTS_VERSION,
    revision: value.revision,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    lastActivePresetId,
    preferences: { autoLockMinutes },
    presets,
    historicalProviders,
    githubAuth: legacy ? null : validateGitHubAuth(value.githubAuth),
  }
}

async function encryptContents(cryptoImpl, metadata, contents, rawKey) {
  const normalized = validateProviderVaultContents(contents)
  const plaintext = encoder.encode(JSON.stringify(normalized))
  if (plaintext.length > MAX_CONTENT_BYTES) {
    plaintext.fill(0)
    throw new ProviderVaultError('limit', '암호화할 프리셋 데이터가 안전한 크기 제한을 초과했습니다.')
  }

  const iv = randomBytes(cryptoImpl, IV_BYTES)
  const envelope = {
    ...metadata,
    cipher: {
      name: 'AES-GCM',
      keyLength: AES_KEY_BYTES * 8,
      tagLength: TAG_LENGTH_BITS,
      iv: encodeBase64Url(iv),
    },
    ciphertext: '',
  }
  const aad = canonicalAad(envelope)

  try {
    const key = await importAesKey(cryptoImpl, rawKey)
    const encrypted = await cryptoImpl.subtle.encrypt({
      name: 'AES-GCM',
      iv,
      additionalData: aad,
      tagLength: TAG_LENGTH_BITS,
    }, key, plaintext)
    envelope.ciphertext = encodeBase64Url(new Uint8Array(encrypted))
    return validateProviderVaultEnvelope(envelope, {
      policy: metadata.kdf.iterations < PROVIDER_VAULT_MIN_ITERATIONS
        ? unsafeCreateProviderVaultTestPolicy(metadata.kdf.iterations)
        : undefined,
    })
  } catch (error) {
    if (error instanceof ProviderVaultError) throw error
    throw new ProviderVaultError('encrypt_failed', 'AI 프리셋을 암호화하지 못했습니다.')
  } finally {
    plaintext.fill(0)
    iv.fill(0)
  }
}

async function decryptContents(cryptoImpl, envelope, rawKey) {
  const iv = decodeBase64Url(envelope.cipher.iv, IV_BYTES, 'invalid_envelope')
  const ciphertext = decodeBase64Url(envelope.ciphertext, null, 'invalid_envelope', MAX_CONTENT_BYTES + TAG_LENGTH_BITS / 8)
  const aad = canonicalAad(envelope)
  let plaintext

  try {
    const key = await importAesKey(cryptoImpl, rawKey)
    const decrypted = await cryptoImpl.subtle.decrypt({
      name: 'AES-GCM',
      iv,
      additionalData: aad,
      tagLength: TAG_LENGTH_BITS,
    }, key, ciphertext)
    plaintext = new Uint8Array(decrypted)
  } catch {
    throw new ProviderVaultError('unlock_failed', '비밀번호가 다르거나 암호화된 볼트가 손상되었습니다.')
  } finally {
    iv.fill(0)
    ciphertext.fill(0)
  }

  try {
    if (plaintext.length > MAX_CONTENT_BYTES) throw new Error('limit')
    return validateProviderVaultContents(JSON.parse(decoder.decode(plaintext)))
  } catch (error) {
    if (error instanceof ProviderVaultError && error.code === 'unsupported_contents_version') throw error
    throw new ProviderVaultError('unlock_failed', '비밀번호가 다르거나 암호화된 볼트가 손상되었습니다.')
  } finally {
    plaintext.fill(0)
  }
}

async function deriveKeyMaterial(cryptoImpl, passwordBytes, salt, iterations) {
  try {
    const passwordKey = await cryptoImpl.subtle.importKey('raw', passwordBytes, 'PBKDF2', false, ['deriveBits'])
    const bits = await cryptoImpl.subtle.deriveBits({
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt,
      iterations,
    }, passwordKey, AES_KEY_BYTES * 8)
    return new Uint8Array(bits)
  } catch {
    throw new ProviderVaultError('crypto_failed', '브라우저에서 볼트 암호 키를 만들지 못했습니다.')
  }
}

async function importAesKey(cryptoImpl, rawKey) {
  return cryptoImpl.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

function makeMetadata({ iterations, salt, vaultId, keyVersion }) {
  return {
    formatVersion: PROVIDER_VAULT_FORMAT_VERSION,
    vaultId,
    keyVersion,
    kdf: {
      name: 'PBKDF2',
      hash: 'SHA-256',
      iterations,
      salt: encodeBase64Url(salt),
    },
  }
}

function canonicalAad(envelope) {
  return encoder.encode(JSON.stringify({
    context: 'RepoLens provider vault',
    formatVersion: envelope.formatVersion,
    vaultId: envelope.vaultId,
    keyVersion: envelope.keyVersion,
    kdf: {
      name: envelope.kdf.name,
      hash: envelope.kdf.hash,
      iterations: envelope.kdf.iterations,
      salt: envelope.kdf.salt,
    },
    cipher: {
      name: envelope.cipher.name,
      keyLength: envelope.cipher.keyLength,
      tagLength: envelope.cipher.tagLength,
      iv: envelope.cipher.iv,
    },
  }))
}

function validatePreset(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, PRESET_KEYS)) {
    throw new ProviderVaultError('invalid_contents', 'AI 프리셋 형식이 올바르지 않습니다.')
  }
  assertUuid(value.id, 'preset.id', 'invalid_contents')
  assertUuid(value.providerRef, 'preset.providerRef', 'invalid_contents')
  assertBoundedString(value.name, '프리셋 이름', 1, MAX_NAME_LENGTH, { trimmed: true, controls: true })
  assertBoundedString(value.apiKey, 'API 키', 1, MAX_API_KEY_LENGTH, { controls: true })
  assertTimestamp(value.createdAt, 'preset.createdAt')
  assertTimestamp(value.updatedAt, 'preset.updatedAt')
  if (Date.parse(value.updatedAt) < Date.parse(value.createdAt)) {
    throw new ProviderVaultError('invalid_contents', '프리셋 수정 시각이 생성 시각보다 빠릅니다.')
  }
  if (typeof value.streaming !== 'boolean') {
    throw new ProviderVaultError('invalid_contents', '프리셋 streaming 값이 올바르지 않습니다.')
  }
  const provider = validateCanonicalProvider(value)
  return {
    id: value.id,
    providerRef: value.providerRef,
    name: value.name,
    baseUrl: provider.baseUrl,
    model: provider.model,
    apiKey: value.apiKey,
    streaming: value.streaming,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  }
}

function validateHistoricalProvider(value) {
  if (!isPlainObject(value) || !hasExactKeys(value, HISTORICAL_PROVIDER_KEYS)) {
    throw new ProviderVaultError('invalid_contents', 'Provider 기록 형식이 올바르지 않습니다.')
  }
  assertUuid(value.providerRef, 'providerRef', 'invalid_contents')
  const provider = validateCanonicalProvider({ ...value, streaming: true })
  return { providerRef: value.providerRef, baseUrl: provider.baseUrl, model: provider.model }
}

function validateGitHubAuth(value) {
  if (value === null) return null
  if (!isPlainObject(value) || !hasExactKeys(value, GITHUB_AUTH_KEYS)) {
    throw new ProviderVaultError('invalid_contents', 'GitHub 연결 정보 형식이 올바르지 않습니다.')
  }
  try {
    return validateGitHubAuthRecord(value)
  } catch {
    throw new ProviderVaultError('invalid_contents', 'GitHub 연결 정보 형식이 올바르지 않습니다.')
  }
}

function validateCanonicalProvider(value) {
  assertBoundedString(value.baseUrl, 'API 기준 URL', 1, MAX_BASE_URL_LENGTH)
  assertBoundedString(value.model, 'Model ID', 1, MAX_MODEL_LENGTH)
  let normalized
  try {
    normalized = normalizeProviderConfig(value)
  } catch {
    throw new ProviderVaultError('invalid_contents', 'AI 제공자 URL 또는 Model ID가 올바르지 않습니다.')
  }
  if (normalized.baseUrl !== value.baseUrl || normalized.model !== value.model) {
    throw new ProviderVaultError('invalid_contents', 'AI 제공자 설정이 정규화된 형식이 아닙니다.')
  }
  return normalized
}

function providerIdentity(provider) {
  return `${provider.baseUrl}\u0000${provider.model}`
}

function resolveCrypto(candidate) {
  const cryptoImpl = candidate ?? globalThis.crypto
  if (!cryptoImpl?.subtle || typeof cryptoImpl.getRandomValues !== 'function') {
    throw new ProviderVaultError('crypto_unavailable', '이 환경은 Web Crypto를 지원하지 않습니다.')
  }
  return cryptoImpl
}

function resolvePolicy(candidate) {
  if (candidate === undefined || candidate === PRODUCTION_POLICY) return PRODUCTION_POLICY
  if (isPlainObject(candidate) && candidate[TEST_POLICY_BRAND] === true) return candidate
  throw new ProviderVaultError('invalid_policy', '볼트 암호 정책이 올바르지 않습니다.')
}

function resolveIterations(candidate, policy) {
  const iterations = candidate ?? policy.defaultIterations
  if (!Number.isSafeInteger(iterations)
    || iterations < policy.minIterations
    || iterations > policy.maxIterations) {
    throw new ProviderVaultError('unsafe_parameters', '볼트 키 파생 반복 횟수가 허용 범위를 벗어났습니다.')
  }
  return iterations
}

function encodePassword(password, creating) {
  if (typeof password !== 'string') {
    throw new ProviderVaultError('password_policy', '마스터 비밀번호를 입력해 주세요.')
  }
  const normalized = password.normalize('NFC')
  const bytes = encoder.encode(normalized)
  const codePoints = Array.from(normalized).length
  if (bytes.length === 0 || bytes.length > MAX_PASSWORD_BYTES
    || (creating && codePoints < MIN_NEW_PASSWORD_CODE_POINTS)) {
    bytes.fill(0)
    throw new ProviderVaultError(
      'password_policy',
      creating
        ? '마스터 비밀번호는 12자 이상, UTF-8 기준 1,024바이트 이하여야 합니다.'
        : '마스터 비밀번호 형식이 올바르지 않습니다.',
    )
  }
  return bytes
}

function decodeKeyMaterial(value) {
  return decodeBase64Url(value, AES_KEY_BYTES, 'invalid_key_material')
}

function randomBytes(cryptoImpl, length) {
  const bytes = new Uint8Array(length)
  cryptoImpl.getRandomValues(bytes)
  return bytes
}

function randomUuid(cryptoImpl) {
  const bytes = randomBytes(cryptoImpl, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  bytes.fill(0)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function encodeBase64Url(bytes) {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

function decodeBase64Url(value, expectedLength, code, maxLength = expectedLength) {
  if (typeof value !== 'string' || !value || !BASE64URL_PATTERN.test(value)) {
    throw new ProviderVaultError(code, '볼트의 Base64URL 값이 올바르지 않습니다.')
  }
  if (maxLength !== null && value.length > Math.ceil(maxLength * 4 / 3) + 2) {
    throw new ProviderVaultError(code, '볼트 데이터가 안전한 크기 제한을 초과했습니다.')
  }
  const padded = value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4)
  let binary
  try {
    binary = atob(padded)
  } catch {
    throw new ProviderVaultError(code, '볼트의 Base64URL 값을 읽지 못했습니다.')
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
  if ((expectedLength !== null && bytes.length !== expectedLength) || encodeBase64Url(bytes) !== value) {
    bytes.fill(0)
    throw new ProviderVaultError(code, '볼트의 Base64URL 길이나 표현이 올바르지 않습니다.')
  }
  if (maxLength !== null && bytes.length > maxLength) {
    bytes.fill(0)
    throw new ProviderVaultError(code, '볼트 데이터가 안전한 크기 제한을 초과했습니다.')
  }
  return bytes
}

function assertUuid(value, field, code) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    throw new ProviderVaultError(code, `${field} 형식이 올바르지 않습니다.`)
  }
}

function assertTimestamp(value, field) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ProviderVaultError('invalid_contents', `${field} 시각 형식이 올바르지 않습니다.`)
  }
}

function assertBoundedString(value, label, min, max, options = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ProviderVaultError('invalid_contents', `${label} 길이가 올바르지 않습니다.`)
  }
  if (options.trimmed && value.trim() !== value) {
    throw new ProviderVaultError('invalid_contents', `${label} 앞뒤에 공백을 둘 수 없습니다.`)
  }
  if (options.controls && /[\u0000-\u001f\u007f]/.test(value)) {
    throw new ProviderVaultError('invalid_contents', `${label}에 제어 문자를 사용할 수 없습니다.`)
  }
}

function currentTimestamp(now) {
  const value = now === undefined
    ? new Date()
    : typeof now === 'function'
      ? new Date(now())
      : new Date(now)
  if (!Number.isFinite(value.getTime())) {
    throw new ProviderVaultError('invalid_update', '볼트 수정 시각이 올바르지 않습니다.')
  }
  return value.toISOString()
}

function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort()
  return actual.length === expected.length && actual.every((key, index) => key === expected[index])
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
