import { normalizeProviderConfig } from './provider-url.js'
import type { ProviderConfigInput } from './provider-url.js'

export const CONNECTION_STORAGE_KEY = 'providerConnection'

export interface ConnectionRecord {
  provider: ProviderConfigInput
  apiKey: string
  revision: string
}

type UnknownRecord = Record<string, unknown>

export function providerIdentity(provider: ProviderConfigInput | null | undefined): string {
  const normalized = normalizeProviderConfig(provider)
  return `${normalized.baseUrl}|${normalized.model}|${normalized.streaming}`
}

export function isConnectionRecord(value: unknown): value is ConnectionRecord {
  if (!isRecord(value)) return false
  if (typeof value.apiKey !== 'string' || value.apiKey.length === 0) return false
  if (typeof value.revision !== 'string' || value.revision.length === 0) return false
  try {
    normalizeProviderConfig(value.provider)
    return true
  } catch {
    return false
  }
}

export function connectionMatchesSnapshot(
  connection: unknown,
  provider: ProviderConfigInput | null | undefined,
  revision: unknown,
): boolean {
  if (!isConnectionRecord(connection) || typeof revision !== 'string') return false
  try {
    return connection.revision === revision
      && providerIdentity(connection.provider) === providerIdentity(provider)
  } catch {
    return false
  }
}

export function canReuseConnectionKey(
  connection: unknown,
  provider: ProviderConfigInput | null | undefined,
): boolean {
  if (!isConnectionRecord(connection)) return false
  try {
    return normalizeProviderConfig(connection.provider).baseUrl === normalizeProviderConfig(provider).baseUrl
  } catch {
    return false
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
