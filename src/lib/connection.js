import { normalizeProviderConfig } from './provider-url.js'

export const CONNECTION_STORAGE_KEY = 'providerConnection'

export function providerIdentity(provider) {
  const normalized = normalizeProviderConfig(provider)
  return `${normalized.baseUrl}|${normalized.model}|${normalized.streaming}`
}

export function isConnectionRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  if (typeof value.apiKey !== 'string' || value.apiKey.length === 0) return false
  if (typeof value.revision !== 'string' || value.revision.length === 0) return false
  try {
    normalizeProviderConfig(value.provider)
    return true
  } catch {
    return false
  }
}

export function connectionMatchesSnapshot(connection, provider, revision) {
  if (!isConnectionRecord(connection) || typeof revision !== 'string') return false
  try {
    return connection.revision === revision
      && providerIdentity(connection.provider) === providerIdentity(provider)
  } catch {
    return false
  }
}

export function canReuseConnectionKey(connection, provider) {
  if (!isConnectionRecord(connection)) return false
  try {
    return normalizeProviderConfig(connection.provider).baseUrl === normalizeProviderConfig(provider).baseUrl
  } catch {
    return false
  }
}
