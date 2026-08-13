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

type UnknownRecord = Record<string, unknown>

export interface HistoricalProvider {
  providerRef: string
  baseUrl: string
  model: string
}

export interface ProviderPreset extends HistoricalProvider {
  id: string
  name: string
  apiKey: string
  streaming: boolean
  createdAt: string
  updatedAt: string
}

export interface SanitizedVaultPreset extends Omit<ProviderPreset, 'apiKey'> {
  hasApiKey: boolean
}

export interface VaultSession {
  keyMaterial: string
  vaultId: string
  keyVersion: string
}

interface ConnectionLike {
  provider: UnknownRecord
  apiKey: string
}

interface InitialVaultOptions {
  historicalProviders?: unknown[]
  legacyProvider?: unknown
  connection?: unknown
  now?: string
  randomUuid?: () => string
}

export function createInitialVaultContents({
  historicalProviders = [],
  legacyProvider = null,
  connection = null,
  now = new Date().toISOString(),
  randomUuid = () => crypto.randomUUID(),
}: InitialVaultOptions = {}) {
  if (!Array.isArray(historicalProviders) || historicalProviders.length > MAX_HISTORICAL_PROVIDERS) {
    throw new ProviderVaultError('limit', `Provider 기록은 최대 ${MAX_HISTORICAL_PROVIDERS}개까지 가져올 수 있습니다.`)
  }
  assertTimestamp(now)

  const canonicalConnection = isConnectionLike(connection) ? connection : null
  const merged = mergeHistoricalProviders([
    ...historicalProviders,
    canonicalConnection?.provider,
    legacyProvider,
  ], randomUuid)
  const importedProvider = canonicalConnection?.provider
    ? findHistoricalProvider(merged, canonicalConnection.provider)
    : null
  const canImportConnection = Boolean(importedProvider
    && typeof canonicalConnection?.apiKey === 'string'
    && canonicalConnection.apiKey.length > 0)
  const importedPresetId = canImportConnection ? checkedUuid(randomUuid()) : null
  const presets = canImportConnection ? [{
    id: importedPresetId,
    providerRef: importedProvider!.providerRef,
    name: '기존 연결',
    baseUrl: normalizeProviderConfig(canonicalConnection.provider).baseUrl,
    model: normalizeProviderConfig(canonicalConnection.provider).model,
    apiKey: canonicalConnection.apiKey,
    streaming: normalizeProviderConfig(canonicalConnection.provider).streaming,
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

export function mergeHistoricalProviders(
  values: unknown,
  randomUuid: () => string = () => crypto.randomUUID(),
): HistoricalProvider[] {
  if (!Array.isArray(values)) throw new ProviderVaultError('request', 'Provider 기록 형식이 올바르지 않습니다.')
  const result: HistoricalProvider[] = []
  const byIdentity = new Map<string, HistoricalProvider>()
  const usedRefs = new Set<string>()

  for (const value of values) {
    if (!value) continue
    let provider
    try {
      provider = normalizeProviderConfig({ ...asRecord(value), streaming: true })
    } catch {
      throw new ProviderVaultError('request', '가져올 Provider 주소 또는 Model ID가 올바르지 않습니다.')
    }
    const identity = historicalProviderIdentity(provider)
    if (byIdentity.has(identity)) continue
    if (result.length >= MAX_HISTORICAL_PROVIDERS) {
      throw new ProviderVaultError('limit', `Provider 기록은 최대 ${MAX_HISTORICAL_PROVIDERS}개까지 저장할 수 있습니다.`)
    }

    const record = asRecord(value)
    let providerRef = isUuid(record.providerRef) && !usedRefs.has(record.providerRef)
      ? record.providerRef
      : checkedUuid(randomUuid())
    while (usedRefs.has(providerRef)) providerRef = checkedUuid(randomUuid())
    const historical = { providerRef, baseUrl: provider.baseUrl, model: provider.model }
    result.push(historical)
    byIdentity.set(identity, historical)
    usedRefs.add(providerRef)
  }
  return result
}

export function findHistoricalProvider(
  historicalProviders: readonly HistoricalProvider[],
  provider: unknown,
): HistoricalProvider | null {
  let normalized
  try {
    normalized = normalizeProviderConfig({ ...asRecord(provider), streaming: true })
  } catch {
    return null
  }
  const identity = historicalProviderIdentity(normalized)
  return historicalProviders.find((candidate) => historicalProviderIdentity(candidate) === identity) ?? null
}

export function sanitizeVaultPreset(preset: ProviderPreset): SanitizedVaultPreset
export function sanitizeVaultPreset(
  preset: Omit<ProviderPreset, 'id'> & { id: string | null },
): Omit<SanitizedVaultPreset, 'id'> & { id: string | null }
export function sanitizeVaultPreset(
  preset: ProviderPreset | (Omit<ProviderPreset, 'id'> & { id: string | null }),
) {
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

export function sanitizeProvider(provider: unknown) {
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

export function resolvePresetApiKey(value: unknown, existingPreset: unknown, nextProvider: unknown): string {
  const entered = typeof value === 'string' ? value.trim() : ''
  if (entered) return entered
  const existingRecord = asRecord(existingPreset)
  if (typeof existingRecord.apiKey !== 'string' || !existingRecord.apiKey) {
    throw new ProviderVaultError('auth', '새 프리셋에는 API 키가 필요합니다.')
  }
  const existing = normalizeProviderConfig(existingRecord)
  const next = normalizeProviderConfig(nextProvider)
  if (existing.baseUrl !== next.baseUrl) {
    throw new ProviderVaultError('auth', 'AI 서버 주소가 바뀌면 새 API 키를 입력해야 합니다.')
  }
  return existingRecord.apiKey
}

export function legacyProviderIdentities(legacyProvider: unknown, connection: unknown): Array<{ baseUrl: string, model: string }> {
  const candidates = [legacyProvider, isConnectionLike(connection) ? connection.provider : undefined]
  const result: Array<{ baseUrl: string, model: string }> = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate) continue
    try {
      const provider = normalizeProviderConfig({ ...asRecord(candidate), streaming: true })
      const identity = historicalProviderIdentity(provider)
      if (seen.has(identity)) continue
      seen.add(identity)
      result.push({ baseUrl: provider.baseUrl, model: provider.model })
    } catch { /* Invalid legacy state is ignored, never echoed. */ }
  }
  return result
}

export function makeVaultSession(envelope: unknown, keyMaterial: unknown): VaultSession {
  const record = asRecord(envelope)
  if (!isUuid(record.vaultId) || !isUuid(record.keyVersion)
    || typeof keyMaterial !== 'string' || !KEY_MATERIAL_PATTERN.test(keyMaterial)) {
    throw new ProviderVaultError('invalid_key_material', '볼트 세션 형식이 올바르지 않습니다.')
  }
  return { keyMaterial, vaultId: record.vaultId, keyVersion: record.keyVersion }
}

export function isVaultSessionForEnvelope(session: unknown, envelope: unknown): session is VaultSession {
  if (!isPlainObject(session)) return false
  const envelopeRecord = asRecord(envelope)
  return Object.keys(session).length === 3
    && typeof session.keyMaterial === 'string'
    && KEY_MATERIAL_PATTERN.test(session.keyMaterial)
    && session.vaultId === envelopeRecord.vaultId
    && session.keyVersion === envelopeRecord.keyVersion
}

export function makeMigrationMarker(pending: unknown): { version: 1, pending: boolean } {
  return { version: PROVIDER_VAULT_MIGRATION_VERSION, pending: pending === true }
}

export function isMigrationPending(marker: unknown): boolean {
  return isPlainObject(marker)
    && marker.version === PROVIDER_VAULT_MIGRATION_VERSION
    && marker.pending === true
}

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value)
}

function historicalProviderIdentity(provider: { baseUrl: string, model: string }): string {
  return `${provider.baseUrl}\u0000${provider.model}`
}

function checkedUuid(value: unknown): string {
  if (!isUuid(value)) throw new ProviderVaultError('crypto_failed', '브라우저에서 안전한 식별자를 만들지 못했습니다.')
  return value
}

function assertTimestamp(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    throw new ProviderVaultError('request', '볼트 생성 시각이 올바르지 않습니다.')
  }
}

function isConnectionLike(value: unknown): value is ConnectionLike {
  return isPlainObject(value)
    && isPlainObject(value.provider)
    && typeof value.apiKey === 'string'
}

function asRecord(value: unknown): UnknownRecord {
  return isPlainObject(value) ? value : {}
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
