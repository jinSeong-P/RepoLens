import { normalizeProviderConfig } from './provider-url.js'
import { resolveAnalysisFileLimit } from './analysis-settings.js'
import {
  createAnalysisPlan,
  parseAnalysisPlan,
} from './analysis-plan.js'

const DATABASE_NAME = 'repolens'
const DATABASE_VERSION = 1
const REPORT_STORE = 'reports'
const CACHE_KEY_VERSION = 'v4'
const MAX_PROVIDER_REF_LENGTH = 200
const MAX_BASE_URL_LENGTH = 2_048
const MAX_MODEL_LENGTH = 200
const PROVIDER_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export function makeReportKey({
  repository,
  providerRef,
  promptVersion,
  analysisPlan,
  analysisSettings,
}) {
  const fullName = requireKeyPart(repository?.fullName, 'repository.fullName', 300).toLowerCase()
  const sha = requireKeyPart(repository?.sha, 'repository.sha', 100)
  const reference = requireProviderRef(providerRef)
  const prompt = requireKeyPart(promptVersion, 'promptVersion', 200)
  const plan = analysisPlan === undefined
    ? createAnalysisPlan({ maxFiles: requireAnalysisFileLimit(analysisSettings?.maxFiles) })
    : parseAnalysisPlan(analysisPlan)
  return [
    CACHE_KEY_VERSION,
    fullName,
    sha,
    reference,
    prompt,
    `depth-${plan.depth}`,
    `selector-${plan.selectorVersion}`,
    `files-${plan.maxFiles}`,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|')
}

function requireAnalysisFileLimit(value) {
  try {
    return resolveAnalysisFileLimit(value)
  } catch {
    throw new TypeError('analysisSettings.maxFiles must be an integer from 1 through 32.')
  }
}

export async function getReport(key) {
  const database = await openDatabase()
  return requestToPromise(database.transaction(REPORT_STORE, 'readonly').objectStore(REPORT_STORE).get(key))
}

export async function putReport(record) {
  const database = await openDatabase()
  const transaction = database.transaction(REPORT_STORE, 'readwrite')
  transaction.objectStore(REPORT_STORE).put(record)
  await transactionDone(transaction)
}

export async function listReports() {
  const database = await openDatabase()
  const records = await requestToPromise(database.transaction(REPORT_STORE, 'readonly').objectStore(REPORT_STORE).getAll())
  return records.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
}

/** Returns the URL/model identities still present in pre-vault report records. */
export async function listLegacyProviderIdentities() {
  const database = await openDatabase()
  const records = await requestToPromise(database.transaction(REPORT_STORE, 'readonly').objectStore(REPORT_STORE).getAll())
  return enumerateLegacyProviderIdentities(records)
}

/**
 * Replaces legacy provider identities with opaque references in one IndexedDB
 * transaction. Unsafe/unmappable records are removed so legacy URL/model
 * identities do not survive a completed migration.
 */
export async function migrateReportProviderReferences(mappings) {
  const database = await openDatabase()
  const transaction = database.transaction(REPORT_STORE, 'readwrite')
  const store = transaction.objectStore(REPORT_STORE)
  let plan

  try {
    const recordsRequest = store.getAll()
    const primaryKeysRequest = store.getAllKeys()
    const [records, primaryKeys] = await Promise.all([
      requestToPromise(recordsRequest),
      requestToPromise(primaryKeysRequest),
    ])
    plan = planReportProviderReferenceMigration(records, mappings, primaryKeys)
    for (const operation of plan.operations) {
      if (operation.oldKey === operation.record.key) {
        store.put(operation.record)
      } else {
        // add() is intentional: an unexpected collision aborts the whole
        // transaction instead of overwriting an existing report.
        store.add(operation.record)
        store.delete(operation.oldKey)
      }
    }
    for (const key of plan.removals) store.delete(key)
    await transactionDone(transaction)
    return plan.stats
  } catch (error) {
    try { transaction.abort() } catch { /* The transaction already ended. */ }
    throw error
  }
}

/** Pure counterpart of listLegacyProviderIdentities for tests and previews. */
export function enumerateLegacyProviderIdentities(records) {
  if (!Array.isArray(records)) throw new TypeError('Report records must be an array.')
  const identities = new Map()

  for (const record of records) {
    collectLegacyIdentity(identities, record?.provider)
    if (!Array.isArray(record?.questions)) continue
    for (const question of record.questions) collectLegacyIdentity(identities, question?.provider)
  }

  return [...identities.values()].sort((left, right) => (
    left.baseUrl.localeCompare(right.baseUrl) || left.model.localeCompare(right.model)
  ))
}

/**
 * Builds an atomic migration plan without touching IndexedDB. Every scanned
 * record falls into exactly one stats bucket.
 */
export function planReportProviderReferenceMigration(records, mappings, primaryKeys = null) {
  if (!Array.isArray(records)) throw new TypeError('Report records must be an array.')
  if (primaryKeys !== null && (!Array.isArray(primaryKeys) || primaryKeys.length !== records.length)) {
    throw new TypeError('Report primary keys must match the records being migrated.')
  }
  const mappingByIdentity = buildProviderMapping(mappings)
  const storedKeys = primaryKeys ?? records.map((record) => record?.key)
  const occupiedKeys = new Set(storedKeys)
  const reservedTargets = new Set()
  const operations = []
  const removals = []
  const stats = {
    scanned: records.length,
    migrated: 0,
    unmapped: 0,
    conflicts: 0,
    unchanged: 0,
  }

  for (const [index, record] of records.entries()) {
    const oldKey = storedKeys[index]
    const transformed = transformReportProviderReferences(record, mappingByIdentity)
    if (!transformed.ok) {
      stats.unmapped += 1
      if (oldKey !== undefined) removals.push(oldKey)
      continue
    }

    const nextRecord = transformed.record
    let nextKey
    try {
      nextKey = makeReportKey({
        repository: nextRecord.repository,
        providerRef: nextRecord.provider.providerRef,
        promptVersion: nextRecord.report?.promptVersion,
        analysisPlan: nextRecord.analysisPlan,
        analysisSettings: nextRecord.analysisSettings,
      })
    } catch {
      stats.unmapped += 1
      if (oldKey !== undefined) removals.push(oldKey)
      continue
    }

    nextRecord.key = nextKey
    const changed = transformed.changed || oldKey !== nextKey
    if (!changed) {
      stats.unchanged += 1
      continue
    }

    const collidesWithStoredRecord = nextKey !== oldKey && occupiedKeys.has(nextKey)
    const collidesWithPlannedRecord = reservedTargets.has(nextKey)
    if (collidesWithStoredRecord || collidesWithPlannedRecord) {
      stats.conflicts += 1
      if (oldKey !== undefined) removals.push(oldKey)
      continue
    }

    reservedTargets.add(nextKey)
    operations.push({ oldKey, record: nextRecord })
    stats.migrated += 1
  }

  return { operations, removals, stats }
}

export async function deleteReport(key) {
  const database = await openDatabase()
  const transaction = database.transaction(REPORT_STORE, 'readwrite')
  transaction.objectStore(REPORT_STORE).delete(key)
  await transactionDone(transaction)
}

export async function clearReports() {
  const database = await openDatabase()
  const transaction = database.transaction(REPORT_STORE, 'readwrite')
  transaction.objectStore(REPORT_STORE).clear()
  await transactionDone(transaction)
}

function transformReportProviderReferences(record, mappingByIdentity) {
  if (!isPlainObject(record) || typeof record.key !== 'string') return { ok: false }
  const reportProvider = resolveProviderReference(record.provider, mappingByIdentity)
  if (!reportProvider) return { ok: false }

  let changed = reportProvider.changed
  let questions = record.questions
  if (Array.isArray(record.questions)) {
    questions = []
    for (const question of record.questions) {
      if (!isPlainObject(question)) {
        questions.push(question)
        continue
      }
      if (question.provider === undefined) {
        questions.push({ ...question })
        continue
      }
      const questionProvider = resolveProviderReference(question.provider, mappingByIdentity)
      if (!questionProvider) return { ok: false }
      changed ||= questionProvider.changed
      questions.push({ ...question, provider: { providerRef: questionProvider.providerRef } })
    }
  }

  return {
    ok: true,
    changed,
    record: {
      ...record,
      provider: { providerRef: reportProvider.providerRef },
      ...(Array.isArray(record.questions) ? { questions } : {}),
    },
  }
}

function resolveProviderReference(provider, mappingByIdentity) {
  if (!isPlainObject(provider)) return null
  const existingRef = validProviderRef(provider.providerRef) ? provider.providerRef : null
  const identity = legacyProviderIdentity(provider)

  if (identity) {
    const mappedRef = mappingByIdentity.get(identityKey(identity))
    if (!mappedRef || (existingRef && existingRef !== mappedRef)) return null
    return { providerRef: mappedRef, changed: true }
  }
  if (!existingRef) return null
  const isCanonical = Object.keys(provider).length === 1 && Object.hasOwn(provider, 'providerRef')
  return { providerRef: existingRef, changed: !isCanonical }
}

function buildProviderMapping(mappings) {
  if (!Array.isArray(mappings)) throw new TypeError('Provider mappings must be an array.')
  const byIdentity = new Map()
  const identityByReference = new Map()

  for (const mapping of mappings) {
    const identity = legacyProviderIdentity(mapping)
    if (!identity) throw new TypeError('Each provider mapping needs a valid baseUrl and model.')
    const providerRef = requireProviderRef(mapping?.providerRef)
    const key = identityKey(identity)
    const previousRef = byIdentity.get(key)
    const previousIdentity = identityByReference.get(providerRef)
    if ((previousRef && previousRef !== providerRef) || (previousIdentity && previousIdentity !== key)) {
      throw new TypeError('Provider mappings must be one-to-one.')
    }
    byIdentity.set(key, providerRef)
    identityByReference.set(providerRef, key)
  }
  return byIdentity
}

function collectLegacyIdentity(target, provider) {
  const identity = legacyProviderIdentity(provider)
  if (identity) target.set(identityKey(identity), identity)
}

function legacyProviderIdentity(provider) {
  if (!isPlainObject(provider)) return null
  try {
    const normalized = normalizeProviderConfig({
      baseUrl: provider.baseUrl,
      model: provider.model,
      streaming: true,
    })
    if (!validIdentityPart(normalized.baseUrl, MAX_BASE_URL_LENGTH)
      || !validIdentityPart(normalized.model, MAX_MODEL_LENGTH)) return null
    return { baseUrl: normalized.baseUrl, model: normalized.model }
  } catch {
    return null
  }
}

function identityKey({ baseUrl, model }) {
  return JSON.stringify([baseUrl, model])
}

function requireProviderRef(value) {
  if (!validProviderRef(value)) throw new TypeError('providerRef must be an opaque UUID.')
  return value
}

function validProviderRef(value) {
  return validIdentityPart(value, MAX_PROVIDER_REF_LENGTH) && PROVIDER_REF_PATTERN.test(value)
}

function validIdentityPart(value, maxLength) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function requireKeyPart(value, label, maxLength) {
  if (!validIdentityPart(value, maxLength)) throw new TypeError(`${label} must be a non-empty string.`)
  return value
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(REPORT_STORE)) {
        const store = database.createObjectStore(REPORT_STORE, { keyPath: 'key' })
        store.createIndex('updatedAt', 'updatedAt')
        store.createIndex('repository', 'repository.fullName')
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('분석 기록 저장소를 열지 못했습니다.'))
  })
}

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('분석 기록 요청에 실패했습니다.'))
  })
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('분석 기록 저장에 실패했습니다.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('분석 기록 저장이 중단되었습니다.'))
  })
}
