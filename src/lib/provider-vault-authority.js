import { normalizeProviderConfig } from './provider-url.js'
import { ProviderVaultError } from './provider-vault.js'

export const PROVIDER_VAULT_STORAGE_KEY = 'providerVault'
export const PROVIDER_VAULT_MIGRATION_KEY = 'providerVaultMigration'
export const PROVIDER_VAULT_SESSION_KEY = 'providerVaultSession'
export const LEGACY_PROVIDER_CONFIG_KEY = 'providerConfig'
export const PROVIDER_VAULT_MIGRATION_VERSION = 1

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const KEY_MATERIAL_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_HISTORICAL_PROVIDERS = 200

export function createInitialVaultContents({
  historicalProviders = [],
  legacyProvider = null,
  connection = null,
  now = new Date().toISOString(),
  randomUuid = () => crypto.randomUUID(),
} = {}) {
  if (!Array.isArray(historicalProviders) || historicalProviders.length > MAX_HISTORICAL_PROVIDERS) {
    throw new ProviderVaultError('limit', `Provider 기록은 최대 ${MAX_HISTORICAL_PROVIDERS}개까지 가져올 수 있습니다.`)
  }
  assertTimestamp(now)

  const merged = mergeHistoricalProviders([
    ...historicalProviders,
    connection?.provider,
    legacyProvider,
  ], randomUuid)
  const importedProvider = connection?.provider ? findHistoricalProvider(merged, connection.provider) : null
  const canImportConnection = importedProvider
    && typeof connection?.apiKey === 'string'
    && connection.apiKey.length > 0
  const importedPresetId = canImportConnection ? checkedUuid(randomUuid()) : null
  const presets = canImportConnection ? [{
    id: importedPresetId,
    providerRef: importedProvider.providerRef,
    name: '기존 연결',
    baseUrl: normalizeProviderConfig(connection.provider).baseUrl,
    model: normalizeProviderConfig(connection.provider).model,
    apiKey: connection.apiKey,
    streaming: normalizeProviderConfig(connection.provider).streaming,
    createdAt: now,
    updatedAt: now,
  }] : []

  return {
    version: 2,
    revision: checkedUuid(randomUuid()),
    createdAt: now,
    updatedAt: now,
    lastActivePresetId: importedPresetId,
    preferences: { autoLockMinutes: 0 },
    presets,
    historicalProviders: merged,
    githubAuth: null,
  }
}

export function mergeHistoricalProviders(values, randomUuid = () => crypto.randomUUID()) {
  if (!Array.isArray(values)) throw new ProviderVaultError('request', 'Provider 기록 형식이 올바르지 않습니다.')
  const result = []
  const byIdentity = new Map()
  const usedRefs = new Set()

  for (const value of values) {
    if (!value) continue
    let provider
    try {
      provider = normalizeProviderConfig({ ...value, streaming: true })
    } catch {
      throw new ProviderVaultError('request', '가져올 Provider 주소 또는 Model ID가 올바르지 않습니다.')
    }
    const identity = historicalProviderIdentity(provider)
    if (byIdentity.has(identity)) continue
    if (result.length >= MAX_HISTORICAL_PROVIDERS) {
      throw new ProviderVaultError('limit', `Provider 기록은 최대 ${MAX_HISTORICAL_PROVIDERS}개까지 저장할 수 있습니다.`)
    }

    let providerRef = isUuid(value.providerRef) && !usedRefs.has(value.providerRef)
      ? value.providerRef
      : checkedUuid(randomUuid())
    while (usedRefs.has(providerRef)) providerRef = checkedUuid(randomUuid())
    const historical = { providerRef, baseUrl: provider.baseUrl, model: provider.model }
    result.push(historical)
    byIdentity.set(identity, historical)
    usedRefs.add(providerRef)
  }
  return result
}

export function findHistoricalProvider(historicalProviders, provider) {
  let normalized
  try {
    normalized = normalizeProviderConfig({ ...provider, streaming: true })
  } catch {
    return null
  }
  const identity = historicalProviderIdentity(normalized)
  return historicalProviders.find((candidate) => historicalProviderIdentity(candidate) === identity) ?? null
}

export function sanitizeVaultPreset(preset) {
  return {
    id: preset.id,
    providerRef: preset.providerRef,
    name: preset.name,
    baseUrl: preset.baseUrl,
    model: preset.model,
    streaming: preset.streaming,
    createdAt: preset.createdAt,
    updatedAt: preset.updatedAt,
    hasApiKey: typeof preset.apiKey === 'string' && preset.apiKey.length > 0,
  }
}

export function sanitizeProvider(provider) {
  if (!provider) return null
  const normalized = normalizeProviderConfig(provider)
  return {
    baseUrl: normalized.baseUrl,
    origin: normalized.origin,
    permissionPattern: normalized.permissionPattern,
    model: normalized.model,
    streaming: normalized.streaming,
  }
}

export function resolvePresetApiKey(value, existingPreset, nextProvider) {
  const entered = typeof value === 'string' ? value.trim() : ''
  if (entered) return entered
  if (!existingPreset?.apiKey) {
    throw new ProviderVaultError('auth', '새 프리셋에는 API 키가 필요합니다.')
  }
  const existing = normalizeProviderConfig(existingPreset)
  const next = normalizeProviderConfig(nextProvider)
  if (existing.baseUrl !== next.baseUrl) {
    throw new ProviderVaultError('auth', 'AI 서버 주소가 바뀌면 새 API 키를 입력해야 합니다.')
  }
  return existingPreset.apiKey
}

export function legacyProviderIdentities(legacyProvider, connection) {
  const candidates = [legacyProvider, connection?.provider]
  const result = []
  const seen = new Set()
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const provider = normalizeProviderConfig({ ...candidate, streaming: true })
      const identity = historicalProviderIdentity(provider)
      if (seen.has(identity)) continue
      seen.add(identity)
      result.push({ baseUrl: provider.baseUrl, model: provider.model })
    } catch { /* Invalid legacy state is ignored, never echoed. */ }
  }
  return result
}

export function makeVaultSession(envelope, keyMaterial) {
  if (!isUuid(envelope?.vaultId) || !isUuid(envelope?.keyVersion) || !KEY_MATERIAL_PATTERN.test(keyMaterial ?? '')) {
    throw new ProviderVaultError('invalid_key_material', '볼트 세션 형식이 올바르지 않습니다.')
  }
  return { keyMaterial, vaultId: envelope.vaultId, keyVersion: envelope.keyVersion }
}

export function isVaultSessionForEnvelope(session, envelope) {
  return Boolean(session
    && typeof session === 'object'
    && !Array.isArray(session)
    && Object.keys(session).length === 3
    && KEY_MATERIAL_PATTERN.test(session.keyMaterial ?? '')
    && session.vaultId === envelope?.vaultId
    && session.keyVersion === envelope?.keyVersion)
}

export function makeMigrationMarker(pending) {
  return { version: PROVIDER_VAULT_MIGRATION_VERSION, pending: pending === true }
}

export function isMigrationPending(marker) {
  return marker?.version === PROVIDER_VAULT_MIGRATION_VERSION && marker?.pending === true
}

export function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function historicalProviderIdentity(provider) {
  return `${provider.baseUrl}\u0000${provider.model}`
}

function checkedUuid(value) {
  if (!isUuid(value)) throw new ProviderVaultError('crypto_failed', '브라우저에서 안전한 식별자를 만들지 못했습니다.')
  return value
}

function assertTimestamp(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ProviderVaultError('request', '볼트 생성 시각이 올바르지 않습니다.')
  }
}
