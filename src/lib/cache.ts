import { normalizeProviderConfig } from './provider-url.js'
import { resolveAnalysisFileLimit } from './analysis-settings.js'
import {
  createAnalysisPlan,
  parseAnalysisPlan,
} from './analysis-plan.js'

const DATABASE_NAME = 'repolens'
const DATABASE_VERSION = 1
const REPORT_STORE = 'reports'
const CACHE_KEY_VERSION = 'v5'
const MAX_PROVIDER_REF_LENGTH = 200
const MAX_BASE_URL_LENGTH = 2_048
const MAX_MODEL_LENGTH = 200
const PROVIDER_REF_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

type UnknownRecord = Record<string, unknown>
type ProviderIdentity = { baseUrl: string, model: string }
type ProviderMapping = ProviderIdentity & { providerRef: string }

export interface StoredReport extends UnknownRecord {
  key: string
  updatedAt?: string
}

export interface ReportKeyOptions {
  repository?: { fullName?: unknown, sha?: unknown } | null
  providerRef?: unknown
  promptVersion?: unknown
  analysisPlan?: unknown
  analysisSettings?: { maxFiles?: unknown } | null
  outputLocale?: unknown
}

export interface ProviderReferenceMigrationStats {
  scanned: number
  migrated: number
  unmapped: number
  conflicts: number
  unchanged: number
}

interface MigrationOperation { oldKey: IDBValidKey, record: UnknownRecord & { key: string } }
interface MigrationPlan {
  operations: MigrationOperation[]
  removals: IDBValidKey[]
  stats: ProviderReferenceMigrationStats
}

export function makeReportKey({
  repository,
  providerRef,
  promptVersion,
  analysisPlan,
  analysisSettings,
  outputLocale = 'ko',
}: ReportKeyOptions): string {
  const fullName = requireKeyPart(repository?.fullName, 'repository.fullName', 300).toLowerCase()
  const sha = requireKeyPart(repository?.sha, 'repository.sha', 100)
  const reference = requireProviderRef(providerRef)
  const prompt = requireKeyPart(promptVersion, 'promptVersion', 200)
  const locale = outputLocale === 'en' ? 'en' : 'ko'
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
    `output-${locale}`,
  ]
    .map((part) => encodeURIComponent(part))
    .join('|')
}

function requireAnalysisFileLimit(value: unknown): number {
  try {
    return resolveAnalysisFileLimit(value)
  } catch {
    throw new TypeError('analysisSettings.maxFiles must be an integer from 1 through 32.')
  }
}

export async function getReport<T = StoredReport>(key: IDBValidKey): Promise<T | undefined> {
  const database = await openDatabase()
  return requestToPromise(database.transaction(REPORT_STORE, 'readonly').objectStore(REPORT_STORE).get(key))
}

export async function putReport(record: StoredReport): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(REPORT_STORE, 'readwrite')
  transaction.objectStore(REPORT_STORE).put(record)
  await transactionDone(transaction)
}

export async function listReports<T extends StoredReport = StoredReport>(): Promise<T[]> {
  const database = await openDatabase()
  const records = await requestToPromise<T[]>(database.transaction(REPORT_STORE, 'readonly').objectStore(REPORT_STORE).getAll())
  return records.sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
}

/** Returns the URL/model identities still present in pre-vault report records. */
export async function listLegacyProviderIdentities(): Promise<ProviderIdentity[]> {
  const database = await openDatabase()
  const records = await requestToPromise<unknown[]>(database.transaction(REPORT_STORE, 'readonly').objectStore(REPORT_STORE).getAll())
  return enumerateLegacyProviderIdentities(records)
}

/**
 * Replaces legacy provider identities with opaque references in one IndexedDB
 * transaction. Unsafe/unmappable records are removed so legacy URL/model
 * identities do not survive a completed migration.
 */
export async function migrateReportProviderReferences(mappings: unknown): Promise<ProviderReferenceMigrationStats> {
  const database = await openDatabase()
  const transaction = database.transaction(REPORT_STORE, 'readwrite')
  const store = transaction.objectStore(REPORT_STORE)
  let plan: MigrationPlan

  try {
    const recordsRequest = store.getAll()
    const primaryKeysRequest = store.getAllKeys()
    const [records, primaryKeys] = await Promise.all([
      requestToPromise<unknown[]>(recordsRequest),
      requestToPromise<IDBValidKey[]>(primaryKeysRequest),
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
export function enumerateLegacyProviderIdentities(records: unknown): ProviderIdentity[] {
  if (!Array.isArray(records)) throw new TypeError('Report records must be an array.')
  const identities = new Map<string, ProviderIdentity>()

  for (const record of records) {
    if (!isPlainObject(record)) continue
    collectLegacyIdentity(identities, record.provider)
    if (!Array.isArray(record.questions)) continue
    for (const question of record.questions) {
      collectLegacyIdentity(identities, isPlainObject(question) ? question.provider : undefined)
    }
  }

  return [...identities.values()].sort((left, right) => (
    left.baseUrl.localeCompare(right.baseUrl) || left.model.localeCompare(right.model)
  ))
}

/**
 * Builds an atomic migration plan without touching IndexedDB. Every scanned
 * record falls into exactly one stats bucket.
 */
export function planReportProviderReferenceMigration(
  records: unknown,
  mappings: unknown,
  primaryKeys: unknown = null,
): MigrationPlan {
  if (!Array.isArray(records)) throw new TypeError('Report records must be an array.')
  if (primaryKeys !== null && (!Array.isArray(primaryKeys) || primaryKeys.length !== records.length)) {
    throw new TypeError('Report primary keys must match the records being migrated.')
  }
  const mappingByIdentity = buildProviderMapping(mappings)
  const storedKeys: Array<IDBValidKey | undefined> = primaryKeys === null
    ? records.map((record) => isPlainObject(record) && typeof record.key === 'string' ? record.key : undefined)
    : primaryKeys as IDBValidKey[]
  const occupiedKeys = new Set(storedKeys)
  const reservedTargets = new Set<string>()
  const operations: MigrationOperation[] = []
  const removals: IDBValidKey[] = []
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
      const repository = isPlainObject(nextRecord.repository) ? nextRecord.repository : undefined
      const report = isPlainObject(nextRecord.report) ? nextRecord.report : undefined
      const analysisSettings = isPlainObject(nextRecord.analysisSettings) ? nextRecord.analysisSettings : undefined
      nextKey = makeReportKey({
        repository,
        providerRef: nextRecord.provider.providerRef,
        promptVersion: report?.promptVersion,
        analysisPlan: nextRecord.analysisPlan,
        analysisSettings,
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
    if (oldKey !== undefined) operations.push({ oldKey, record: nextRecord })
    stats.migrated += 1
  }

  return { operations, removals, stats }
}

export async function deleteReport(key: IDBValidKey): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(REPORT_STORE, 'readwrite')
  transaction.objectStore(REPORT_STORE).delete(key)
  await transactionDone(transaction)
}

export async function clearReports(): Promise<void> {
  const database = await openDatabase()
  const transaction = database.transaction(REPORT_STORE, 'readwrite')
  transaction.objectStore(REPORT_STORE).clear()
  await transactionDone(transaction)
}

function transformReportProviderReferences(
  record: unknown,
  mappingByIdentity: Map<string, string>,
): { ok: false } | { ok: true, changed: boolean, record: UnknownRecord & { key: string, provider: { providerRef: string } } } {
  if (!isPlainObject(record) || typeof record.key !== 'string') return { ok: false }
  const reportProvider = resolveProviderReference(record.provider, mappingByIdentity)
  if (!reportProvider) return { ok: false }

  let changed = reportProvider.changed
  let questions: unknown[] = []
  if (Array.isArray(record.questions)) {
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
      key: record.key,
      provider: { providerRef: reportProvider.providerRef },
      ...(Array.isArray(record.questions) ? { questions } : {}),
    },
  }
}

function resolveProviderReference(
  provider: unknown,
  mappingByIdentity: Map<string, string>,
): { providerRef: string, changed: boolean } | null {
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

function buildProviderMapping(mappings: unknown): Map<string, string> {
  if (!Array.isArray(mappings)) throw new TypeError('Provider mappings must be an array.')
  const byIdentity = new Map<string, string>()
  const identityByReference = new Map<string, string>()

  for (const mapping of mappings) {
    const identity = legacyProviderIdentity(mapping)
    if (!identity) throw new TypeError('Each provider mapping needs a valid baseUrl and model.')
    const providerRef = requireProviderRef(isPlainObject(mapping) ? mapping.providerRef : undefined)
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

function collectLegacyIdentity(target: Map<string, ProviderIdentity>, provider: unknown): void {
  const identity = legacyProviderIdentity(provider)
  if (identity) target.set(identityKey(identity), identity)
}

function legacyProviderIdentity(provider: unknown): ProviderIdentity | null {
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

function identityKey({ baseUrl, model }: ProviderIdentity): string {
  return JSON.stringify([baseUrl, model])
}

function requireProviderRef(value: unknown): string {
  if (!validProviderRef(value)) throw new TypeError('providerRef must be an opaque UUID.')
  return value
}

function validProviderRef(value: unknown): value is string {
  return validIdentityPart(value, MAX_PROVIDER_REF_LENGTH) && PROVIDER_REF_PATTERN.test(value)
}

function validIdentityPart(value: unknown, maxLength: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= maxLength
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value)
}

function requireKeyPart(value: unknown, label: string, maxLength: number): string {
  if (!validIdentityPart(value, maxLength)) throw new TypeError(`${label} must be a non-empty string.`)
  return value
}

function isPlainObject(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
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

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('분석 기록 요청에 실패했습니다.'))
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error ?? new Error('분석 기록 저장에 실패했습니다.'))
    transaction.onabort = () => reject(transaction.error ?? new Error('분석 기록 저장이 중단되었습니다.'))
  })
}

function timestamp(value: unknown): number {
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}
