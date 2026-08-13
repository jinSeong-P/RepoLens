import test from 'node:test'
import assert from 'node:assert/strict'
import {
  createInitialVaultContents,
  isMigrationPending,
  isVaultSessionForEnvelope,
  legacyProviderIdentities,
  makeMigrationMarker,
  makeVaultSession,
  resolvePresetApiKey,
  sanitizeVaultPreset,
} from '../src/lib/provider-vault-authority.js'

const UUIDS = [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
  '33333333-3333-4333-8333-333333333333',
]
const provider = { baseUrl: 'https://api.example.com/v1', model: 'model-a', streaming: false }

test('initial vault imports a valid legacy connection without exposing it in sanitized state', () => {
  let index = 0
  const contents = createInitialVaultContents({
    historicalProviders: [{ baseUrl: provider.baseUrl, model: provider.model }],
    legacyProvider: provider,
    connection: { provider, apiKey: 'legacy-secret', revision: 'legacy-revision' },
    now: '2026-08-13T00:00:00.000Z',
    randomUuid: () => UUIDS[index++],
  })

  assert.equal(contents.version, 2)
  assert.equal(contents.githubAuth, null)
  assert.equal(contents.preferences.autoLockMinutes, 0)
  assert.equal(contents.presets.length, 1)
  assert.equal(contents.presets[0].name, '기존 연결')
  assert.equal(contents.presets[0].apiKey, 'legacy-secret')
  assert.equal(contents.presets[0].providerRef, contents.historicalProviders[0].providerRef)
  assert.equal(contents.lastActivePresetId, contents.presets[0].id)
  assert.equal('apiKey' in sanitizeVaultPreset(contents.presets[0]), false)
  assert.equal(JSON.stringify(sanitizeVaultPreset(contents.presets[0])).includes('legacy-secret'), false)
})

test('vault session is bound to exact vault and key versions', () => {
  const envelope = { vaultId: UUIDS[0], keyVersion: UUIDS[1] }
  const keyMaterial = 'A'.repeat(43)
  const session = makeVaultSession(envelope, keyMaterial)
  assert.equal(isVaultSessionForEnvelope(session, envelope), true)
  assert.equal(isVaultSessionForEnvelope(session, { ...envelope, keyVersion: UUIDS[2] }), false)
  assert.equal(isVaultSessionForEnvelope({ ...session, leaked: true }, envelope), false)
})

test('migration state returns only deduplicated non-secret legacy identities', () => {
  const connection = { provider, apiKey: 'secret', revision: 'revision' }
  assert.deepEqual(legacyProviderIdentities(provider, connection), [{
    baseUrl: provider.baseUrl,
    model: provider.model,
  }])
  assert.equal(isMigrationPending(makeMigrationMarker(true)), true)
  assert.equal(isMigrationPending(makeMigrationMarker(false)), false)
  assert.equal(JSON.stringify(legacyProviderIdentities(provider, connection)).includes('secret'), false)
})

test('blank preset keys are reused only for the exact normalized base URL', () => {
  const existing = { ...provider, apiKey: 'existing-secret' }
  assert.equal(resolvePresetApiKey('', existing, { ...provider, model: 'model-b' }), 'existing-secret')
  assert.equal(resolvePresetApiKey(' new-secret ', existing, {
    ...provider,
    baseUrl: 'https://other.example/v1',
  }), 'new-secret')
  assert.throws(
    () => resolvePresetApiKey('', existing, { ...provider, baseUrl: 'https://api.example.com/other' }),
    (error) => error.code === 'auth',
  )
  assert.throws(
    () => resolvePresetApiKey('', existing, { ...provider, baseUrl: 'https://other.example/v1' }),
    (error) => error.code === 'auth',
  )
  assert.throws(
    () => resolvePresetApiKey('', null, provider),
    (error) => error.code === 'auth',
  )
})
