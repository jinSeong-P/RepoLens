import test from 'node:test'
import assert from 'node:assert/strict'
import {
  enumerateLegacyProviderIdentities,
  makeReportKey,
  planReportProviderReferenceMigration,
} from '../src/lib/cache.js'

const REPOSITORY = {
  fullName: 'Owner/Repo',
  sha: 'a'.repeat(40),
}
const PROVIDER_REF = '11111111-1111-4111-8111-111111111111'
const OTHER_PROVIDER_REF = '22222222-2222-4222-8222-222222222222'
const PROMPT_VERSION = 'repo-analysis-v1'
const LEGACY_PROVIDER = {
  baseUrl: 'https://api.example.com/v1',
  model: 'example-model',
}
const DEEP_PLAN = {
  version: 1,
  depth: 'deep',
  selectorVersion: 'local-two-stage-v1',
  maxFiles: 16,
}

function legacyRecord(overrides = {}) {
  return {
    key: `owner/repo|${REPOSITORY.sha}|${LEGACY_PROVIDER.baseUrl}|${LEGACY_PROVIDER.model}|${PROMPT_VERSION}`,
    repository: { ...REPOSITORY },
    provider: { ...LEGACY_PROVIDER },
    report: { promptVersion: PROMPT_VERSION, summary: 'summary' },
    questions: [{
      question: 'question',
      answer: 'answer',
      provider: { ...LEGACY_PROVIDER },
    }],
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  }
}

const MAPPINGS = [{ providerRef: PROVIDER_REF, ...LEGACY_PROVIDER }]

test('builds a v4 cache key from repository, providerRef, prompt version, and analysis plan', () => {
  const key = makeReportKey({
    repository: REPOSITORY,
    providerRef: PROVIDER_REF,
    promptVersion: PROMPT_VERSION,
    provider: { ...LEGACY_PROVIDER },
  })

  assert.match(key, /^v4\|owner%2Frepo\|/)
  assert.match(key, /\|depth-deep\|selector-local-two-stage-v1\|files-16$/)
  assert.match(key, /\|files-16$/)
  assert.match(key, new RegExp(PROVIDER_REF))
  assert.doesNotMatch(key, /api\.example\.com|example-model/)
  assert.notEqual(key, makeReportKey({
    repository: REPOSITORY,
    providerRef: OTHER_PROVIDER_REF,
    promptVersion: PROMPT_VERSION,
  }))
  assert.notEqual(key, makeReportKey({
    repository: REPOSITORY,
    providerRef: PROVIDER_REF,
    promptVersion: PROMPT_VERSION,
    analysisSettings: { maxFiles: 32 },
  }))
  assert.notEqual(key, makeReportKey({
    repository: REPOSITORY,
    providerRef: PROVIDER_REF,
    promptVersion: PROMPT_VERSION,
    analysisPlan: { ...DEEP_PLAN, depth: 'overview' },
  }))
  assert.throws(() => makeReportKey({
    repository: REPOSITORY,
    providerRef: PROVIDER_REF,
    promptVersion: PROMPT_VERSION,
    analysisPlan: { ...DEEP_PLAN, selectorVersion: 'local-two-stage-v2' },
  }), /selector version/)
  assert.throws(() => makeReportKey({
    repository: REPOSITORY,
    providerRef: LEGACY_PROVIDER.baseUrl,
    promptVersion: PROMPT_VERSION,
  }), /opaque UUID/)
})

test('enumerates and deduplicates legacy identities from reports and questions', () => {
  const records = [
    legacyRecord(),
    legacyRecord({
      provider: { providerRef: PROVIDER_REF },
      questions: [{ provider: { baseUrl: 'https://another.example/v1', model: 'model-b' } }],
    }),
  ]

  assert.deepEqual(enumerateLegacyProviderIdentities(records), [
    { baseUrl: 'https://another.example/v1', model: 'model-b' },
    LEGACY_PROVIDER,
  ])
})

test('canonicalizes legacy provider identities before mapping reports', () => {
  const noncanonicalProvider = {
    baseUrl: 'https://api.example.com/v1/chat/completions/',
    model: ' example-model ',
  }
  const source = legacyRecord({
    provider: noncanonicalProvider,
    questions: [{ provider: noncanonicalProvider }],
  })

  assert.deepEqual(enumerateLegacyProviderIdentities([source]), [LEGACY_PROVIDER])
  const plan = planReportProviderReferenceMigration([source], MAPPINGS)
  assert.equal(plan.stats.migrated, 1)
  assert.deepEqual(plan.operations[0].record.provider, { providerRef: PROVIDER_REF })
  assert.deepEqual(plan.operations[0].record.questions[0].provider, { providerRef: PROVIDER_REF })
})

test('plans an atomic provider migration without retaining URL or model identity', () => {
  const source = legacyRecord()
  const plan = planReportProviderReferenceMigration([source], MAPPINGS)

  assert.deepEqual(plan.stats, {
    scanned: 1,
    migrated: 1,
    unmapped: 0,
    conflicts: 0,
    unchanged: 0,
  })
  assert.equal(plan.operations.length, 1)
  assert.deepEqual(plan.removals, [])
  assert.equal(plan.operations[0].oldKey, source.key)
  assert.deepEqual(plan.operations[0].record.provider, { providerRef: PROVIDER_REF })
  assert.deepEqual(plan.operations[0].record.questions[0].provider, { providerRef: PROVIDER_REF })
  assert.equal(plan.operations[0].record.key, makeReportKey({
    repository: REPOSITORY,
    providerRef: PROVIDER_REF,
    promptVersion: PROMPT_VERSION,
  }))
  assert.doesNotMatch(JSON.stringify(plan.operations[0].record.provider), /baseUrl|model|api\.example/)
  assert.deepEqual(source.provider, LEGACY_PROVIDER, 'pure migration must not mutate the source record')
})

test('removes a whole legacy record when any provider identity is unmapped', () => {
  const source = legacyRecord({
    questions: [{
      provider: { baseUrl: 'https://unmapped.example/v1', model: 'unknown' },
    }],
  })
  const plan = planReportProviderReferenceMigration([source], MAPPINGS)

  assert.equal(plan.operations.length, 0)
  assert.deepEqual(plan.removals, [source.key])
  assert.deepEqual(plan.stats, {
    scanned: 1,
    migrated: 0,
    unmapped: 1,
    conflicts: 0,
    unchanged: 0,
  })
  assert.deepEqual(source.provider, LEGACY_PROVIDER)
})

test('removes unmappable records by their actual non-string IndexedDB primary key', () => {
  const source = legacyRecord({ key: 42 })
  const plan = planReportProviderReferenceMigration([source], MAPPINGS, [42])

  assert.equal(plan.operations.length, 0)
  assert.deepEqual(plan.removals, [42])
  assert.deepEqual(plan.stats, {
    scanned: 1,
    migrated: 0,
    unmapped: 1,
    conflicts: 0,
    unchanged: 0,
  })
})

test('uses actual IndexedDB primary keys instead of trusting the stored key field', () => {
  const source = legacyRecord({ key: 'tampered-inline-key' })
  const plan = planReportProviderReferenceMigration([source], [], [new Date('2026-08-13T00:00:00.000Z')])

  assert.equal(plan.removals.length, 1)
  assert.ok(plan.removals[0] instanceof Date)
  assert.equal(plan.removals[0].toISOString(), '2026-08-13T00:00:00.000Z')
})

test('requires supplied IndexedDB primary keys to correspond to every record', () => {
  assert.throws(
    () => planReportProviderReferenceMigration([legacyRecord()], MAPPINGS, []),
    /primary keys must match/,
  )
})

test('does not overwrite an existing v4 report when a migrated key collides', () => {
  const source = legacyRecord()
  const targetKey = makeReportKey({
    repository: REPOSITORY,
    providerRef: PROVIDER_REF,
    promptVersion: PROMPT_VERSION,
  })
  const existing = legacyRecord({
    key: targetKey,
    provider: { providerRef: PROVIDER_REF },
    questions: [{ provider: { providerRef: PROVIDER_REF } }],
  })
  const plan = planReportProviderReferenceMigration([source, existing], MAPPINGS)

  assert.equal(plan.operations.length, 0)
  assert.deepEqual(plan.removals, [source.key])
  assert.deepEqual(plan.stats, {
    scanned: 2,
    migrated: 0,
    unmapped: 0,
    conflicts: 1,
    unchanged: 1,
  })
})

test('updates a noncanonical providerRef-only record key while preserving its data', () => {
  const source = legacyRecord({
    key: 'legacy-key-without-provider-url',
    provider: { providerRef: PROVIDER_REF },
    questions: [{ provider: { providerRef: PROVIDER_REF }, answer: 'kept' }],
  })
  const plan = planReportProviderReferenceMigration([source], [])

  assert.equal(plan.stats.migrated, 1)
  assert.equal(plan.operations[0].record.questions[0].answer, 'kept')
  assert.deepEqual(plan.operations[0].record.provider, { providerRef: PROVIDER_REF })
})

test('rejects ambiguous provider mappings before planning writes', () => {
  assert.throws(() => planReportProviderReferenceMigration([legacyRecord()], [
    ...MAPPINGS,
    { providerRef: OTHER_PROVIDER_REF, ...LEGACY_PROVIDER },
  ]), /one-to-one/)

  assert.throws(() => planReportProviderReferenceMigration([legacyRecord()], [
    ...MAPPINGS,
    { providerRef: PROVIDER_REF, baseUrl: 'https://other.example/v1', model: 'other' },
  ]), /one-to-one/)
})
