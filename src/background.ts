import { normalizeProviderConfig } from './lib/provider-url.js'
import {
  createProviderVault,
  unlockProviderVault,
  unlockProviderVaultWithKeyMaterial,
  updateProviderVaultWithKeyMaterial,
  validateProviderVaultEnvelope,
} from './lib/provider-vault.js'
import {
  LEGACY_PROVIDER_CONFIG_KEY,
  PROVIDER_VAULT_MIGRATION_KEY,
  PROVIDER_VAULT_SESSION_KEY,
  PROVIDER_VAULT_STORAGE_KEY,
  createInitialVaultContents,
  findHistoricalProvider,
  isMigrationPending,
  isUuid,
  isVaultSessionForEnvelope,
  legacyProviderIdentities,
  makeMigrationMarker,
  makeVaultSession,
  mergeHistoricalProviders,
  resolvePresetApiKey,
  sanitizeProvider,
  sanitizeVaultPreset,
} from './lib/provider-vault-authority.js'
import {
  GitHubClient,
  GitHubError,
  validateRepositoryIdentity,
} from './lib/github.js'
import {
  exchangeGitHubDeviceToken,
  normalizeGitHubOAuthClientId,
  normalizeGitHubPat,
  requestGitHubDeviceCode,
  sanitizeGitHubAuthState,
  validateGitHubAuthRecord,
  verifyGitHubToken,
} from './lib/github-auth.js'
import {
  GITHUB_FLOW_ATTEMPT_STALE_MS,
  canInvalidateGitHubSession,
  claimGitHubFlowAttempt,
  findGitHubAuthRejectedMarker,
  makeGitHubAuthRejectedMarker,
  matchGitHubFlowAttempt,
  shouldRejectGitHubAuth,
} from './lib/github-auth-state.js'
import { GITHUB_OAUTH_CLIENT_ID } from './github-oauth-config.js'
import {
  GITHUB_API_PERMISSION,
  isTrustedSidePanelSender,
  serializeExtensionError,
  validateRepositoryCollectionOptions,
} from './lib/github-rpc.js'
import {
  GitHubAuthDenyList,
  GitHubRequestRegistry,
  makeGitHubRequestKey,
} from './lib/github-request-state.js'
import {
  CONNECTION_STORAGE_KEY,
  canReuseConnectionKey,
  connectionMatchesSnapshot,
  isConnectionRecord,
  providerIdentity,
} from './lib/connection.js'
import type { ConnectionRecord } from './lib/connection.js'

const GITHUB_AUTH_SESSION_KEY = 'githubAuthSession'
const GITHUB_AUTH_REJECTED_KEY = 'githubAuthRejected'
const GITHUB_FLOW_SESSION_KEY = 'githubAuthFlow'
const GITHUB_DEVICE_VERIFICATION_URL = 'https://github.com/login/device'

/** Untrusted messages/storage records are validated by the existing guards. */
type WireRecord = Record<string, any>
type WireValue = any

interface ActiveJob {
  port: chrome.runtime.Port
  requestId: string
}

interface ActiveRepositoryRequest {
  requestId: string
  requestKey: string
  controller: AbortController
}

interface GitHubFlowController {
  attemptId: string
  controller: AbortController
}

interface PublicExtensionError extends Error {
  code: string
}

interface GitHubAuthExpectations {
  expectedVaultId?: string
  expectedRevision?: string
  expectedMutationRevision?: string
}

const github = new GitHubClient(fetch, { authProvider: getGitHubCredentialSnapshot })
let activeJob: ActiveJob | null = null
let vaultOperation: Promise<unknown> = Promise.resolve()
let vaultResetInProgress = false
let githubAuthMutationRevision = crypto.randomUUID()
const githubAuthControllers = new Map<string, GitHubFlowController>()
const githubRepositoryRequests = new GitHubRequestRegistry()
const deniedGitHubAuth = new GitHubAuthDenyList()

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {})
  lockSessionStorage()
})

chrome.runtime.onStartup.addListener(lockSessionStorage)
lockSessionStorage()

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'repolens-github') {
    if (!isSidePanelSender(port.sender)) {
      postSafe(port, { type: 'error', error: serializeExtensionError(publicError('forbidden', '허용되지 않은 GitHub 요청 발신자입니다.')) })
      port.disconnect()
      return
    }
    attachGitHubPort(port)
    return
  }
  if (port.name !== 'repolens-panel') return
  if (!isSidePanelSender(port.sender)) {
    postSafe(port, { type: 'error', error: serializeExtensionError(publicError('forbidden', '허용되지 않은 AI 요청 발신자입니다.')) })
    port.disconnect()
    return
  }

  port.onMessage.addListener((message) => {
    handlePortMessage(port, message).catch((error) => {
      postSafe(port, { type: 'error', requestId: message?.requestId, error: serializeError(error) })
    })
  })

  port.onDisconnect.addListener(() => {
    if (activeJob?.port === port) {
      activeJob = null
    }
  })
})

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) {
    sendResponse({ ok: false, error: { code: 'forbidden', message: '허용되지 않은 메시지 발신자입니다.' } })
    return false
  }

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((error) => sendResponse({ ok: false, error: serializeError(error) }))
  return true
})

async function handleMessage(message: WireRecord, sender: chrome.runtime.MessageSender): Promise<WireRecord> {
  const vaultRequest = typeof message?.type === 'string' && message.type.startsWith('VAULT_')
  const githubAuthRequest = typeof message?.type === 'string' && message.type.startsWith('GITHUB_AUTH_')
  const sensitiveRequest = vaultRequest || githubAuthRequest || ['GET_STATE', 'SAVE_PROVIDER', 'CLEAR_API_KEY'].includes(message?.type)
  if (sensitiveRequest && !isSidePanelSender(sender)) {
    throw publicError('forbidden', '허용되지 않은 보안 설정 요청 발신자입니다.')
  }
  switch (message?.type) {
    case 'GET_STATE':
      return getState()
    case 'GET_ACTIVE_TAB':
      return { tab: await getActiveTab() }
    case 'GITHUB_AUTH_START':
      return startGitHubAuth()
    case 'GITHUB_AUTH_POLL':
      return pollGitHubAuth(message.payload)
    case 'GITHUB_AUTH_CANCEL':
      return cancelGitHubAuth(message.payload)
    case 'GITHUB_AUTH_SAVE_PAT':
      return saveGitHubPat(message.payload)
    case 'GITHUB_AUTH_DISCONNECT':
      return disconnectGitHubAuth()
    case 'SAVE_PROVIDER':
      return saveProvider(message.payload)
    case 'CLEAR_API_KEY':
      if ((await chrome.storage.local.get(PROVIDER_VAULT_STORAGE_KEY))[PROVIDER_VAULT_STORAGE_KEY] !== undefined) {
        throw publicError('vault_required', '암호화 볼트에서는 프리셋 저장소를 잠가 연결을 지워 주세요.')
      }
      await chrome.storage.session.remove(CONNECTION_STORAGE_KEY)
      return getState()
    case 'VAULT_CREATE':
      return serializeVaultOperation(() => createVault(message.payload))
    case 'VAULT_UNLOCK':
      return serializeVaultOperation(() => unlockVault(message.payload))
    case 'VAULT_LOCK':
      return serializeVaultOperation(lockVault)
    case 'VAULT_SAVE_PRESET':
      return serializeVaultOperation(() => saveVaultPreset(message.payload))
    case 'VAULT_ACTIVATE_PRESET':
      return serializeVaultOperation(() => activateVaultPreset(message.payload))
    case 'VAULT_DELETE_PRESET':
      return serializeVaultOperation(() => deleteVaultPreset(message.payload))
    case 'VAULT_MIGRATION_COMPLETE':
      return serializeVaultOperation(completeVaultMigration)
    case 'VAULT_RESET':
      return serializeVaultOperation(resetVault)
    default:
      throw publicError('request', '알 수 없는 확장 프로그램 요청입니다.')
  }
}

async function assertGitHubPermission() {
  const hasPermission = await chrome.permissions.contains(GITHUB_API_PERMISSION)
  if (!hasPermission) {
    throw new GitHubError('permission', 'RepoLens에 api.github.com 사이트 액세스 권한이 없습니다. Chrome 확장 프로그램 세부정보에서 사이트 액세스를 허용해 주세요.')
  }
}

function isSidePanelSender(sender: chrome.runtime.MessageSender | undefined): boolean {
  return isTrustedSidePanelSender(sender, chrome.runtime.id, chrome.runtime.getURL('sidepanel.html'))
}

function attachGitHubPort(port: chrome.runtime.Port): void {
  let request: ActiveRepositoryRequest | null = null
  const portId = crypto.randomUUID()

  port.onMessage.addListener((message: WireRecord) => {
    if (message?.type === 'CANCEL') {
      if (request?.requestId === message.requestId) request.controller.abort()
      return
    }
    if (!['COLLECT_REPOSITORY', 'RESOLVE_REPOSITORY'].includes(message?.type)) {
      postSafe(port, { type: 'error', requestId: message?.requestId, error: serializeExtensionError(publicError('request', '알 수 없는 GitHub 요청입니다.')) })
      return
    }
    if (request) {
      postSafe(port, { type: 'error', requestId: message.requestId, error: serializeExtensionError(publicError('busy', '이미 저장소 파일을 읽는 중입니다.')) })
      return
    }

    const requestId = typeof message.requestId === 'string' && message.requestId.length <= 200
      ? message.requestId
      : crypto.randomUUID()
    const controller = new AbortController()
    const requestKey = makeGitHubRequestKey(portId, requestId)
    githubRepositoryRequests.register(requestKey, controller)
    request = { requestId, requestKey, controller }

    ;(async () => {
      await assertGitHubPermission()
      let authRevision
      const captureAuthRevision = (revision: string | undefined) => {
        if (!isUuid(revision)) return
        authRevision = revision
        githubRepositoryRequests.captureAuthRevision(requestKey, revision)
      }
      if (message.type === 'RESOLVE_REPOSITORY') {
        const { owner, repo } = validateRepositoryIdentity(message.repository)
        const repository = await github.resolveRepository(owner, repo, controller.signal, {
          onAuthSnapshot: captureAuthRevision,
        })
        await requireCurrentGitHubAuthRevision(authRevision)
        if (controller.signal.aborted) throw new GitHubError('cancelled', '요청을 중지했습니다.')
        postSafe(port, { type: 'result', requestId, repository })
      } else {
        const { owner, repo } = validateRepositoryIdentity(message.repository)
        const collectionOptions = validateRepositoryCollectionOptions(message.options)
        const collected = await github.collectCurrentRepository(
          owner,
          repo,
          controller.signal,
          (stage, progressMessage) => postSafe(port, { type: 'progress', requestId, stage, message: progressMessage }),
          {
            onAuthSnapshot: captureAuthRevision,
            maxFiles: collectionOptions.maxFiles,
            depth: collectionOptions.depth,
            expectedSha: collectionOptions.expectedSha,
          },
        )
        await requireCurrentGitHubAuthRevision(authRevision)
        if (controller.signal.aborted) throw new GitHubError('cancelled', '요청을 중지했습니다.')
        postSafe(port, { type: 'result', requestId, ...collected })
      }
    })().catch(async (error) => {
      // Finish credential invalidation before notifying the panel. The panel
      // disconnects its port as soon as it receives the error; posting first
      // could let an MV3 worker stop before the rejection marker or encrypted
      // deletion becomes durable.
      try { await invalidateExpiredGitHubSession(error) } catch { /* Keep the original GitHub error. */ }
      postSafe(port, { type: 'error', requestId, error: serializeExtensionError(error) })
    }).finally(() => {
      githubRepositoryRequests.remove(requestKey, controller)
      if (request?.requestId === requestId) request = null
    })
  })

  port.onDisconnect.addListener(() => {
    if (!request) return
    githubRepositoryRequests.remove(request.requestKey, request.controller)
    request.controller.abort()
  })
}

async function handlePortMessage(port: chrome.runtime.Port, message: WireRecord): Promise<void> {
  if (message?.type === 'KEEPALIVE') {
    if (activeJob?.port === port && activeJob.requestId === message.requestId) {
      postSafe(port, { type: 'keepalive', requestId: message.requestId })
    }
    return
  }
  if (message?.type === 'COMPLETE_JOB') {
    if (activeJob?.port === port && activeJob.requestId === message.requestId) activeJob = null
    return
  }
  if (message?.type !== 'START_JOB') throw publicError('request', '알 수 없는 스트리밍 요청입니다.')
  if (vaultResetInProgress) throw publicError('busy', 'AI 프리셋 볼트를 초기화하는 중입니다.')
  if (activeJob) throw publicError('busy', '이미 AI 작업이 진행 중입니다.')

  const requestId = typeof message.requestId === 'string' ? message.requestId : crypto.randomUUID()
  const job = { port, requestId }
  activeJob = job

  try {
    const { [CONNECTION_STORAGE_KEY]: connection } = await chrome.storage.session.get(CONNECTION_STORAGE_KEY)
    if (activeJob !== job) throw publicError('cancelled', 'AI 요청이 중지되었습니다.')
    const expectedProvider = normalizeProviderConfig(message.provider)
    if (!connectionMatchesSnapshot(connection, expectedProvider, message.connectionRevision)) {
      throw publicError('provider_changed', 'AI 연결 자격 증명이 작업 중 변경되었습니다. 저장소 파일은 전송하지 않았습니다.')
    }
    postSafe(port, { type: 'authorized', requestId })
  } catch (error) {
    postSafe(port, { type: 'error', requestId, error: serializeError(error) })
    if (activeJob === job) activeJob = null
  }
}

async function getState() {
  const local = await chrome.storage.local.get([
    PROVIDER_VAULT_STORAGE_KEY,
    PROVIDER_VAULT_MIGRATION_KEY,
    LEGACY_PROVIDER_CONFIG_KEY,
    GITHUB_AUTH_REJECTED_KEY,
  ])
  const session = await chrome.storage.session.get([
    PROVIDER_VAULT_SESSION_KEY,
    CONNECTION_STORAGE_KEY,
    GITHUB_AUTH_SESSION_KEY,
    GITHUB_AUTH_REJECTED_KEY,
    GITHUB_FLOW_SESSION_KEY,
  ])
  const storedEnvelope = local[PROVIDER_VAULT_STORAGE_KEY]
  const envelope = validEnvelopeOrNull(storedEnvelope)
  let connection = isConnectionRecord(session[CONNECTION_STORAGE_KEY])
    ? session[CONNECTION_STORAGE_KEY]
    : null
  let contents = null
  let vaultStatus = storedEnvelope === undefined ? 'missing' : envelope ? 'locked' : 'corrupt'
  const vaultSession = session[PROVIDER_VAULT_SESSION_KEY]
  if (envelope && isVaultSessionForEnvelope(vaultSession, envelope)) {
    try {
      contents = await unlockProviderVaultWithKeyMaterial(envelope, vaultSession.keyMaterial)
      vaultStatus = 'unlocked'
    } catch {
      await chrome.storage.session.remove([PROVIDER_VAULT_SESSION_KEY, GITHUB_AUTH_SESSION_KEY, GITHUB_FLOW_SESSION_KEY])
      invalidateGitHubAuthMutations()
    }
  }
  if (storedEnvelope !== undefined && vaultStatus !== 'unlocked' && connection) {
    await chrome.storage.session.remove(CONNECTION_STORAGE_KEY)
    connection = null
  }

  let githubAuthSession = validGitHubSession(session[GITHUB_AUTH_SESSION_KEY], envelope)
  const durableGitHubAuth = contents?.githubAuth ?? null
  const rejectedMarker = await reconcileGitHubAuthRejectedMarkers({
    localMarker: local[GITHUB_AUTH_REJECTED_KEY],
    legacyMarker: session[GITHUB_AUTH_REJECTED_KEY],
    envelope,
    durableAuth: durableGitHubAuth,
    liveAuth: githubAuthSession
      ? { ...githubAuthSession.auth, revision: githubAuthSession.revision }
      : null,
  })
  const githubAuthRejected = rejectedMarker !== null
  if (githubAuthRejected && githubAuthSession) {
    deniedGitHubAuth.denySession(githubAuthSession)
    await chrome.storage.session.remove(GITHUB_AUTH_SESSION_KEY).catch(() => {})
    githubAuthSession = null
  }
  if (vaultStatus !== 'unlocked' && (session[GITHUB_AUTH_SESSION_KEY] || session[GITHUB_FLOW_SESSION_KEY])) {
    // The token and Device Flow secret are lock-scoped. The token-free
    // rejected marker intentionally survives so an expired durable credential
    // cannot be revived by the next unlock.
    await chrome.storage.session.remove([GITHUB_AUTH_SESSION_KEY, GITHUB_FLOW_SESSION_KEY])
    githubAuthSession = null
  } else if (vaultStatus === 'unlocked' && durableGitHubAuth && !githubAuthSession
    && !githubAuthRejected && !deniedGitHubAuth.rejectsDurable(durableGitHubAuth)) {
    githubAuthSession = githubSessionFromRecord(durableGitHubAuth, envelope)
    await chrome.storage.session.set({ [GITHUB_AUTH_SESSION_KEY]: githubAuthSession })
  } else if (vaultStatus === 'unlocked' && !durableGitHubAuth && githubAuthSession) {
    await chrome.storage.session.remove(GITHUB_AUTH_SESSION_KEY)
    githubAuthSession = null
  }

  const activePreset = contents?.presets.find((preset) => preset.id === contents.lastActivePresetId) ?? null
  if (contents) {
    if (activePreset && !connectionMatchesPreset(connection, activePreset)) {
      connection = connectionFromPreset(activePreset)
      await chrome.storage.session.set({ [CONNECTION_STORAGE_KEY]: connection })
    } else if (!activePreset && connection) {
      connection = null
      await chrome.storage.session.remove(CONNECTION_STORAGE_KEY)
    }
  }
  const provider = connection ? sanitizeProvider(connection.provider) : null
  return {
    vaultStatus,
    unlocked: vaultStatus === 'unlocked',
    presets: contents ? contents.presets.map(sanitizeVaultPreset) : [],
    activePresetId: activePreset?.id ?? null,
    presetId: activePreset?.id ?? null,
    activeProviderRef: activePreset?.providerRef ?? null,
    provider,
    hasApiKey: Boolean(connection),
    connectionRevision: connection?.revision ?? null,
    migrationPending: isMigrationPending(local[PROVIDER_VAULT_MIGRATION_KEY])
      || (storedEnvelope === undefined
        && legacyProviderIdentities(local[LEGACY_PROVIDER_CONFIG_KEY], connection).length > 0),
    migrationProviders: contents
      ? contents.historicalProviders
      : legacyProviderIdentities(local[LEGACY_PROVIDER_CONFIG_KEY], connection),
    busy: activeJob !== null,
    githubAuth: sanitizeGitHubAuthState(githubAuthSession?.auth),
    githubOAuthAvailable: configuredGitHubClientId() !== null,
    githubFlow: sanitizeGitHubFlow(session[GITHUB_FLOW_SESSION_KEY]),
    githubReconnectRequired: githubAuthRejected
      || deniedGitHubAuth.rejectsDurable(durableGitHubAuth),
  }
}

async function saveProvider(payload: WireRecord): Promise<WireRecord> {
  const { [PROVIDER_VAULT_STORAGE_KEY]: vault } = await chrome.storage.local.get(PROVIDER_VAULT_STORAGE_KEY)
  if (vault !== undefined) {
    throw publicError('vault_required', '암호화 볼트에서는 AI 프리셋으로 연결을 저장해 주세요.')
  }
  const provider = normalizeProviderConfig(payload)
  const apiKey = typeof payload?.apiKey === 'string' ? payload.apiKey.trim() : ''
  const { [CONNECTION_STORAGE_KEY]: existing } = await chrome.storage.session.get(CONNECTION_STORAGE_KEY)
  const canReuseKey = canReuseConnectionKey(existing, provider)
  if (!apiKey && !canReuseKey) throw publicError('auth', 'AI 서버 주소가 바뀌면 새 API 키를 입력해야 합니다.')

  const connection = {
    provider,
    apiKey: apiKey || (isConnectionRecord(existing) ? existing.apiKey : ''),
    revision: crypto.randomUUID(),
  }
  await chrome.storage.local.set({ [LEGACY_PROVIDER_CONFIG_KEY]: provider })
  await chrome.storage.session.set({ [CONNECTION_STORAGE_KEY]: connection })
  return getState()
}

async function createVault(payload: WireRecord): Promise<WireRecord> {
  const password = requirePassword(payload?.password)
  const historicalProviders = payload?.historicalProviders ?? []
  const local = await chrome.storage.local.get([
    PROVIDER_VAULT_STORAGE_KEY,
    PROVIDER_VAULT_MIGRATION_KEY,
    LEGACY_PROVIDER_CONFIG_KEY,
  ])
  if (local[PROVIDER_VAULT_STORAGE_KEY] !== undefined) {
    throw publicError('vault_exists', '이미 AI 프리셋 볼트가 있습니다.')
  }
  const { [CONNECTION_STORAGE_KEY]: connectionValue } = await chrome.storage.session.get(CONNECTION_STORAGE_KEY)
  const connection = isConnectionRecord(connectionValue) ? connectionValue : null
  const now = new Date().toISOString()
  const contents = createInitialVaultContents({
    historicalProviders,
    legacyProvider: local[LEGACY_PROVIDER_CONFIG_KEY],
    connection,
    now,
  })
  const created = await createProviderVault(contents, password)
  const importedPreset = created.contents.presets.find((preset) => preset.id === created.contents.lastActivePresetId) ?? null
  const pending = Boolean(
    local[LEGACY_PROVIDER_CONFIG_KEY]
    || connection
    || created.contents.historicalProviders.length
    || isMigrationPending(local[PROVIDER_VAULT_MIGRATION_KEY]),
  )
  await chrome.storage.local.set({
    [PROVIDER_VAULT_STORAGE_KEY]: created.envelope,
    [PROVIDER_VAULT_MIGRATION_KEY]: makeMigrationMarker(pending),
  })
  await chrome.storage.session.set({
    [PROVIDER_VAULT_SESSION_KEY]: makeVaultSession(created.envelope, created.keyMaterial),
    ...(importedPreset ? { [CONNECTION_STORAGE_KEY]: connectionFromPreset(importedPreset) } : {}),
  })
  return getState()
}

async function unlockVault(payload: WireRecord): Promise<WireRecord> {
  const password = requirePassword(payload?.password)
  githubRepositoryRequests.abortAll()
  abortGitHubFlowControllers()
  invalidateGitHubAuthMutations()
  await cancelAnyGitHubFlow()
  const envelope = await requireVaultEnvelope()
  const unlocked = await unlockProviderVault(envelope, password)
  await chrome.storage.session.set({
    [PROVIDER_VAULT_SESSION_KEY]: makeVaultSession(envelope, unlocked.keyMaterial),
  })
  const activePreset = unlocked.contents.presets.find((preset) => preset.id === unlocked.contents.lastActivePresetId)
  if (activePreset) {
    await chrome.storage.session.set({ [CONNECTION_STORAGE_KEY]: connectionFromPreset(activePreset) })
  } else {
    await chrome.storage.session.remove(CONNECTION_STORAGE_KEY)
  }
  const markers = await readGitHubAuthRejectedMarkers()
  const rejectedMarker = await reconcileGitHubAuthRejectedMarkers({
    ...markers,
    envelope,
    durableAuth: unlocked.contents.githubAuth,
    liveAuth: null,
  })
  const rejected = rejectedMarker !== null
  if (unlocked.contents.githubAuth && !rejected
    && !deniedGitHubAuth.rejectsDurable(unlocked.contents.githubAuth)) {
    await chrome.storage.session.set({
      [GITHUB_AUTH_SESSION_KEY]: githubSessionFromRecord(unlocked.contents.githubAuth, envelope),
    })
  } else {
    await chrome.storage.session.remove(GITHUB_AUTH_SESSION_KEY)
  }
  return getState()
}

async function lockVault() {
  if (activeJob) throw publicError('busy', 'AI 작업 중에는 프리셋 저장소를 잠글 수 없습니다.')
  await requireUnlockedVault()
  abortGitHubFlowControllers()
  invalidateGitHubAuthMutations()
  await cancelAnyGitHubFlow()
  githubRepositoryRequests.abortAll()
  await chrome.storage.session.remove([
    PROVIDER_VAULT_SESSION_KEY,
    CONNECTION_STORAGE_KEY,
    GITHUB_AUTH_SESSION_KEY,
    GITHUB_FLOW_SESSION_KEY,
  ])
  return getState()
}

async function saveVaultPreset(payload: WireRecord): Promise<WireRecord> {
  if (activeJob) throw publicError('busy', 'AI 작업 중에는 프리셋을 변경할 수 없습니다.')
  const { envelope, vaultSession, contents } = await requireUnlockedVault()
  const presetId = payload?.id ?? payload?.presetId ?? null
  if (presetId !== null && !isUuid(presetId)) throw publicError('request', '프리셋 ID가 올바르지 않습니다.')
  const existing = presetId ? contents.presets.find((preset) => preset.id === presetId) : null
  if (presetId && !existing) throw publicError('not_found', '수정할 프리셋을 찾지 못했습니다.')
  const provider = normalizeProviderConfig(payload)
  const apiKey = resolvePresetApiKey(payload?.apiKey, existing, provider)
  const name = normalizePresetName(payload?.name)
  const now = new Date().toISOString()

  const updated = await updateProviderVaultWithKeyMaterial(envelope, vaultSession.keyMaterial, (draft) => {
    let historical = findHistoricalProvider(draft.historicalProviders, provider)
    if (!historical) {
      draft.historicalProviders = mergeHistoricalProviders([...draft.historicalProviders, provider])
      historical = findHistoricalProvider(draft.historicalProviders, provider)
    }
    if (!historical) throw publicError('conflict', 'AI 연결 정보를 저장하지 못했습니다.')
    const nextPreset = {
      id: existing?.id ?? crypto.randomUUID(),
      providerRef: historical.providerRef,
      name,
      baseUrl: provider.baseUrl,
      model: provider.model,
      apiKey,
      streaming: provider.streaming,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    }
    const index = draft.presets.findIndex((preset) => preset.id === nextPreset.id)
    if (index >= 0) draft.presets[index] = nextPreset
    else draft.presets.push(nextPreset)
    if (payload?.activate === true || draft.lastActivePresetId === nextPreset.id || draft.lastActivePresetId === null) {
      draft.lastActivePresetId = nextPreset.id
    }
  }, { expectedRevision: contents.revision })
  await persistVaultUpdate(updated)
  const savedPreset = updated.contents.presets.find((preset) => preset.id === (existing?.id ?? updated.contents.lastActivePresetId))
  if (updated.contents.lastActivePresetId === savedPreset?.id) {
    await chrome.storage.session.set({ [CONNECTION_STORAGE_KEY]: connectionFromPreset(savedPreset) })
  }
  return getState()
}

async function activateVaultPreset(payload: WireRecord): Promise<WireRecord> {
  if (activeJob) throw publicError('busy', 'AI 작업 중에는 프리셋을 변경할 수 없습니다.')
  const presetId = requirePresetId(payload)
  const { envelope, vaultSession, contents } = await requireUnlockedVault()
  const preset = contents.presets.find((candidate) => candidate.id === presetId)
  if (!preset) throw publicError('not_found', '활성화할 프리셋을 찾지 못했습니다.')
  const updated = await updateProviderVaultWithKeyMaterial(envelope, vaultSession.keyMaterial, (draft) => {
    draft.lastActivePresetId = presetId
  }, { expectedRevision: contents.revision })
  await persistVaultUpdate(updated)
  await chrome.storage.session.set({ [CONNECTION_STORAGE_KEY]: connectionFromPreset(preset) })
  return getState()
}

async function deleteVaultPreset(payload: WireRecord): Promise<WireRecord> {
  if (activeJob) throw publicError('busy', 'AI 작업 중에는 프리셋을 변경할 수 없습니다.')
  const presetId = requirePresetId(payload)
  const { envelope, vaultSession, contents } = await requireUnlockedVault()
  if (!contents.presets.some((preset) => preset.id === presetId)) {
    throw publicError('not_found', '삭제할 프리셋을 찾지 못했습니다.')
  }
  const updated = await updateProviderVaultWithKeyMaterial(envelope, vaultSession.keyMaterial, (draft) => {
    draft.presets = draft.presets.filter((preset) => preset.id !== presetId)
    if (draft.lastActivePresetId === presetId) draft.lastActivePresetId = null
  }, { expectedRevision: contents.revision })
  await persistVaultUpdate(updated)
  if (contents.lastActivePresetId === presetId) await chrome.storage.session.remove(CONNECTION_STORAGE_KEY)
  return getState()
}

async function startGitHubAuth() {
  if (activeJob) throw publicError('busy', 'AI 작업 중에는 GitHub 연결을 변경할 수 없습니다.')
  const clientId = configuredGitHubClientId()
  if (!clientId) {
    throw publicError('oauth_unconfigured', '이 빌드에는 GitHub OAuth Client ID가 설정되지 않았습니다. 고급 설정에서 개인 액세스 토큰을 사용할 수 있습니다.')
  }
  abortGitHubFlowControllers()
  const preparation = await serializeVaultOperation(async () => {
    const { envelope, contents } = await requireUnlockedVault()
    await cancelAnyGitHubFlow()
    rotateGitHubAuthMutationRevision()
    return {
      vaultId: envelope.vaultId,
      vaultRevision: contents.revision,
      mutationRevision: githubAuthMutationRevision,
    }
  })
  const controller = new AbortController()
  const device = await withTimeout(
    (signal) => requestGitHubDeviceCode(clientId, { signal }),
    30_000,
    controller,
  )
  const now = Date.now()
  const flow = {
    flowId: crypto.randomUUID(),
    deviceCode: device.deviceCode,
    userCode: device.userCode,
    verificationUri: GITHUB_DEVICE_VERIFICATION_URL,
    expiresAt: new Date(now + device.expiresIn * 1_000).toISOString(),
    intervalMs: device.interval * 1_000,
    nextPollAt: now + device.interval * 1_000,
  }
  await serializeVaultOperation(async () => {
    const currentVault = await requireUnlockedVault()
    if (currentVault.envelope.vaultId !== preparation.vaultId
      || currentVault.contents.revision !== preparation.vaultRevision
      || githubAuthMutationRevision !== preparation.mutationRevision) {
      throw publicError('conflict', '설정이 변경되었습니다. GitHub 연결을 다시 시작해 주세요.')
    }
    rotateGitHubAuthMutationRevision()
    await chrome.storage.session.set({ [GITHUB_FLOW_SESSION_KEY]: flow })
  })
  return { flow: sanitizeGitHubFlow(flow) }
}

async function pollGitHubAuth(payload: WireRecord): Promise<WireRecord> {
  const clientId = configuredGitHubClientId()
  if (!clientId) throw publicError('oauth_unconfigured', 'GitHub OAuth Client ID가 설정되지 않았습니다.')
  if (!isUuid(payload?.flowId)) throw publicError('request', 'GitHub 연결 요청이 일치하지 않습니다.')
  const flowId = payload.flowId
  const attemptId = crypto.randomUUID()
  const claim = await serializeVaultOperation(async () => {
    const { envelope, contents } = await requireUnlockedVault()
    const stored = (await chrome.storage.session.get(GITHUB_FLOW_SESSION_KEY))[GITHUB_FLOW_SESSION_KEY]
    const current = requireGitHubFlow(stored, flowId)
    const now = Date.now()
    if (now >= Date.parse(current.expiresAt)) {
      await chrome.storage.session.remove(GITHUB_FLOW_SESSION_KEY)
      throw publicError('expired', 'GitHub 연결 코드가 만료되었습니다. 다시 시도해 주세요.')
    }
    if (now < current.nextPollAt) {
      return {
        pending: true,
        retryAfterMs: current.nextPollAt - now,
        flow: sanitizeGitHubFlow(current),
      }
    }
    let claimed
    try {
      claimed = claimGitHubFlowAttempt(current, flowId, attemptId, now)
    } catch (error) {
      if (errorCode(error) !== 'flow_busy') throw error
      return {
        pending: true,
        retryAfterMs: Math.max(750, Math.min(
          5_000,
          current.attemptStartedAt + GITHUB_FLOW_ATTEMPT_STALE_MS - now,
        )),
        flow: sanitizeGitHubFlow(current),
      }
    }
    await chrome.storage.session.set({ [GITHUB_FLOW_SESSION_KEY]: claimed })
    return {
      pending: false,
      flow: claimed,
      vaultId: envelope.vaultId,
      vaultRevision: contents.revision,
    }
  })
  if (claim.pending) {
    return { status: 'pending', retryAfterMs: claim.retryAfterMs, flow: claim.flow }
  }

  const flow = claim.flow
  const remainingSeconds = Math.max(1, Math.ceil((Date.parse(flow.expiresAt) - Date.now()) / 1_000))
  const controller = new AbortController()
  githubAuthControllers.set(flowId, { attemptId, controller })
  try {
    // Cancellation can land after the serialized claim but before controller
    // registration. Re-check ownership after registration so that window can
    // never start a token request for a cancelled flow.
    await requireCurrentGitHubFlowAttempt(flowId, attemptId)
    const result = await withTimeout((signal) => exchangeGitHubDeviceToken(clientId, {
      deviceCode: flow.deviceCode,
      expiresIn: remainingSeconds,
      interval: Math.max(1, Math.ceil(flow.intervalMs / 1_000)),
    }, { signal }), 30_000, controller)
    if (result.status !== 'connected') {
      return commitPendingGitHubFlow(flowId, attemptId, result.status)
    }

    await requireCurrentGitHubFlowAttempt(flowId, attemptId)
    const { login } = await withTimeout(
      (signal) => verifyGitHubToken({ method: 'oauth', token: result.token, tokenType: 'bearer' }, { signal }),
      30_000,
      controller,
    )
    const auth = validateGitHubAuthRecord({
      method: 'oauth',
      token: result.token,
      tokenType: 'bearer',
      login,
      createdAt: new Date().toISOString(),
    })
    await commitGitHubFlowAuth(auth, flowId, attemptId, claim.vaultId, claim.vaultRevision)
    return { status: 'connected', githubAuth: sanitizeGitHubAuthState(auth) }
  } catch (error) {
    await settleFailedGitHubFlowAttempt(flowId, attemptId, error)
    throw error
  } finally {
    const active = githubAuthControllers.get(flowId)
    if (active?.attemptId === attemptId && active.controller === controller) {
      githubAuthControllers.delete(flowId)
    }
  }
}

async function cancelGitHubAuth(payload: WireRecord): Promise<WireRecord> {
  if (!isUuid(payload?.flowId)) throw publicError('request', 'GitHub 연결 요청이 일치하지 않습니다.')
  abortGitHubFlowControllers(payload.flowId)
  return serializeVaultOperation(async () => {
    const flow = (await chrome.storage.session.get(GITHUB_FLOW_SESSION_KEY))[GITHUB_FLOW_SESSION_KEY]
    requireGitHubFlow(flow, payload.flowId)
    rotateGitHubAuthMutationRevision()
    await chrome.storage.session.remove(GITHUB_FLOW_SESSION_KEY)
    return { cancelled: true }
  })
}

async function saveGitHubPat(payload: WireRecord): Promise<WireRecord> {
  if (activeJob) throw publicError('busy', 'AI 작업 중에는 GitHub 연결을 변경할 수 없습니다.')
  const token = normalizeGitHubPat(payload?.token)
  abortGitHubFlowControllers()
  const preparation = await serializeVaultOperation(async () => {
    const { envelope, contents } = await requireUnlockedVault()
    await cancelAnyGitHubFlow()
    invalidateGitHubAuthMutations()
    return {
      vaultId: envelope.vaultId,
      vaultRevision: contents.revision,
      mutationRevision: githubAuthMutationRevision,
    }
  })
  const { login } = await withTimeout(
    (signal) => verifyGitHubToken({ method: 'pat', token, tokenType: 'bearer' }, { signal }),
    30_000,
  )
  const auth = validateGitHubAuthRecord({
    method: 'pat',
    token,
    tokenType: 'bearer',
    login,
    createdAt: new Date().toISOString(),
  })
  await storeGitHubAuth(auth, {
    expectedVaultId: preparation.vaultId,
    expectedRevision: preparation.vaultRevision,
    expectedMutationRevision: preparation.mutationRevision,
  })
  return getState()
}

async function disconnectGitHubAuth() {
  if (activeJob) throw publicError('busy', 'AI 작업 중에는 GitHub 연결을 변경할 수 없습니다.')
  abortGitHubFlowControllers()
  await serializeVaultOperation(async () => {
    await cancelAnyGitHubFlow()
    invalidateGitHubAuthMutations()
    const { envelope, vaultSession, contents } = await requireUnlockedVault()
    if (contents.githubAuth !== null) {
      githubRepositoryRequests.abortAll()
      const updated = await updateProviderVaultWithKeyMaterial(envelope, vaultSession.keyMaterial, (draft) => {
        draft.githubAuth = null
      }, { expectedRevision: contents.revision })
      await persistVaultUpdate(updated)
    } else {
      githubRepositoryRequests.abortAll()
    }
    await chrome.storage.session.remove([GITHUB_AUTH_SESSION_KEY, GITHUB_FLOW_SESSION_KEY])
    await clearGitHubAuthRejectedMarker()
  })
  return getState()
}

async function cancelAnyGitHubFlow() {
  const { [GITHUB_FLOW_SESSION_KEY]: flow } = await chrome.storage.session.get(GITHUB_FLOW_SESSION_KEY)
  if (isRecord(flow) && typeof flow.flowId === 'string') abortGitHubFlowControllers(flow.flowId)
  await chrome.storage.session.remove(GITHUB_FLOW_SESSION_KEY)
}

async function withTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  existingController = new AbortController(),
): Promise<T> {
  let timedOut = false
  const timeout = setTimeout(() => {
    timedOut = true
    existingController.abort()
  }, milliseconds)
  try {
    const result = await operation(existingController.signal)
    if (timedOut) throw publicError('timeout', 'GitHub 요청 시간이 초과되었습니다. 다시 시도해 주세요.')
    return result
  } catch (error) {
    if (timedOut) throw publicError('timeout', 'GitHub 요청 시간이 초과되었습니다. 다시 시도해 주세요.')
    throw error
  } finally {
    clearTimeout(timeout)
  }
}

async function storeGitHubAuth(auth: WireValue, expectations: GitHubAuthExpectations = {}): Promise<void> {
  return serializeVaultOperation(async () => {
    if (vaultResetInProgress) throw publicError('busy', '암호화 저장소를 초기화하는 중입니다.')
    const { envelope, vaultSession, contents } = await requireUnlockedVault()
    if ((expectations.expectedVaultId && envelope.vaultId !== expectations.expectedVaultId)
      || (expectations.expectedRevision && contents.revision !== expectations.expectedRevision)
      || (expectations.expectedMutationRevision
        && githubAuthMutationRevision !== expectations.expectedMutationRevision)) {
      throw publicError('conflict', '설정이 변경되었습니다. GitHub 연결을 다시 시도해 주세요.')
    }
    githubRepositoryRequests.abortAll()
    const updated = await updateProviderVaultWithKeyMaterial(envelope, vaultSession.keyMaterial, (draft) => {
      draft.githubAuth = auth
    }, { expectedRevision: contents.revision })
    // Durable encrypted write must succeed before a usable session token exists.
    await persistVaultUpdate(updated)
    await chrome.storage.session.set({
      [GITHUB_AUTH_SESSION_KEY]: githubSessionFromRecord(auth, updated.envelope),
    })
    await clearGitHubAuthRejectedMarker()
    deniedGitHubAuth.clear()
    invalidateGitHubAuthMutations()
  })
}

async function commitGitHubFlowAuth(
  auth: WireValue,
  flowId: string,
  attemptId: string,
  expectedVaultId: string,
  expectedRevision: string,
): Promise<void> {
  return serializeVaultOperation(async () => {
    const stored = (await chrome.storage.session.get(GITHUB_FLOW_SESSION_KEY))[GITHUB_FLOW_SESSION_KEY]
    if (!matchGitHubFlowAttempt(stored, { flowId, attemptId })) {
      throw publicError('cancelled', 'GitHub 연결 요청이 취소되었거나 교체되었습니다.')
    }
    requireGitHubFlow(stored, flowId)
    const { envelope, vaultSession, contents } = await requireUnlockedVault()
    if (envelope.vaultId !== expectedVaultId || contents.revision !== expectedRevision) {
      throw publicError('conflict', '설정이 변경되었습니다. GitHub 연결을 다시 시도해 주세요.')
    }
    githubRepositoryRequests.abortAll()
    const updated = await updateProviderVaultWithKeyMaterial(envelope, vaultSession.keyMaterial, (draft) => {
      draft.githubAuth = auth
    }, { expectedRevision: contents.revision })
    await persistVaultUpdate(updated)
    await chrome.storage.session.set({
      [GITHUB_AUTH_SESSION_KEY]: githubSessionFromRecord(auth, updated.envelope),
    })
    await chrome.storage.session.remove(GITHUB_FLOW_SESSION_KEY)
    await clearGitHubAuthRejectedMarker()
    deniedGitHubAuth.clear()
    invalidateGitHubAuthMutations()
  })
}

async function commitPendingGitHubFlow(flowId: string, attemptId: string, status: string) {
  return serializeVaultOperation(async () => {
    const stored = (await chrome.storage.session.get(GITHUB_FLOW_SESSION_KEY))[GITHUB_FLOW_SESSION_KEY]
    if (!matchGitHubFlowAttempt(stored, { flowId, attemptId })) {
      throw publicError('cancelled', 'GitHub 연결 요청이 취소되었거나 교체되었습니다.')
    }
    const flow = requireGitHubFlow(stored, flowId)
    const intervalMs = status === 'slow_down'
      ? Math.min(60_000, flow.intervalMs + 5_000)
      : flow.intervalMs
    const pending: WireRecord = {
      ...flow,
      intervalMs,
      nextPollAt: Date.now() + intervalMs,
    }
    delete pending.activeAttemptId
    delete pending.attemptStartedAt
    await chrome.storage.session.set({ [GITHUB_FLOW_SESSION_KEY]: pending })
    return { status: 'pending', retryAfterMs: intervalMs, flow: sanitizeGitHubFlow(pending) }
  })
}

async function requireCurrentGitHubFlowAttempt(flowId: string, attemptId: string) {
  return serializeVaultOperation(async () => {
    const stored = (await chrome.storage.session.get(GITHUB_FLOW_SESSION_KEY))[GITHUB_FLOW_SESSION_KEY]
    if (!matchGitHubFlowAttempt(stored, { flowId, attemptId })) {
      throw publicError('cancelled', 'GitHub 연결 요청이 취소되었거나 교체되었습니다.')
    }
    return requireGitHubFlow(stored, flowId)
  })
}

async function settleFailedGitHubFlowAttempt(flowId: string, attemptId: string, error: unknown) {
  return serializeVaultOperation(async () => {
    const stored = (await chrome.storage.session.get(GITHUB_FLOW_SESSION_KEY))[GITHUB_FLOW_SESSION_KEY]
    if (!matchGitHubFlowAttempt(stored, { flowId, attemptId })) return
    const terminal = new Set([
      'access_denied', 'expired', 'invalid_device_response', 'invalid_token',
      'invalid_token_response', 'oauth_error', 'unexpected_scope',
    ])
    if (terminal.has(errorCode(error) ?? '')) {
      await chrome.storage.session.remove(GITHUB_FLOW_SESSION_KEY)
      return
    }
    const flow = requireGitHubFlow(stored, flowId)
    const retryable: WireRecord = { ...flow, nextPollAt: Date.now() + flow.intervalMs }
    delete retryable.activeAttemptId
    delete retryable.attemptStartedAt
    await chrome.storage.session.set({ [GITHUB_FLOW_SESSION_KEY]: retryable })
  })
}

function abortGitHubFlowControllers(flowId?: string): void {
  for (const [candidateFlowId, active] of githubAuthControllers) {
    if (flowId === undefined || candidateFlowId === flowId) active.controller.abort()
  }
}

function invalidateGitHubAuthMutations() {
  // Authenticated repository responses are keyed by the live credential
  // revision, but clearing them eagerly avoids retaining source snapshots
  // after lock, disconnect, replacement, or a rejected credential.
  github.cache?.clearVolatile?.()
  githubAuthMutationRevision = crypto.randomUUID()
  return githubAuthMutationRevision
}

function rotateGitHubAuthMutationRevision() {
  githubAuthMutationRevision = crypto.randomUUID()
  return githubAuthMutationRevision
}

async function completeVaultMigration() {
  await requireUnlockedVault()
  const local = await chrome.storage.local.get([PROVIDER_VAULT_STORAGE_KEY, PROVIDER_VAULT_MIGRATION_KEY])
  if (!local[PROVIDER_VAULT_STORAGE_KEY]) throw publicError('vault_missing', '완료할 AI 프리셋 볼트가 없습니다.')
  if (isMigrationPending(local[PROVIDER_VAULT_MIGRATION_KEY])) {
    await chrome.storage.local.remove(LEGACY_PROVIDER_CONFIG_KEY)
    await chrome.storage.local.set({ [PROVIDER_VAULT_MIGRATION_KEY]: makeMigrationMarker(false) })
  }
  return getState()
}

async function resetVault() {
  if (activeJob) throw publicError('busy', 'AI 작업 중에는 프리셋 볼트를 초기화할 수 없습니다.')
  vaultResetInProgress = true
  try {
    githubRepositoryRequests.abortAll()
    abortGitHubFlowControllers()
    invalidateGitHubAuthMutations()
    await cancelAnyGitHubFlow()
    // Fail closed: clear usable credentials before removing the durable vault.
    // If the following local write fails, the remaining encrypted vault can
    // still be unlocked normally; the inverse order could strand a live key.
    await chrome.storage.session.remove([
      PROVIDER_VAULT_SESSION_KEY,
      CONNECTION_STORAGE_KEY,
      GITHUB_AUTH_SESSION_KEY,
      GITHUB_AUTH_REJECTED_KEY,
      GITHUB_FLOW_SESSION_KEY,
    ])
    await chrome.storage.local.remove([
      PROVIDER_VAULT_STORAGE_KEY,
      PROVIDER_VAULT_MIGRATION_KEY,
      LEGACY_PROVIDER_CONFIG_KEY,
      GITHUB_AUTH_REJECTED_KEY,
    ])
    return getState()
  } finally {
    vaultResetInProgress = false
  }
}

async function persistVaultUpdate(updated: WireRecord): Promise<void> {
  await chrome.storage.local.set({ [PROVIDER_VAULT_STORAGE_KEY]: updated.envelope })
  await chrome.storage.session.set({
    [PROVIDER_VAULT_SESSION_KEY]: makeVaultSession(updated.envelope, updated.keyMaterial),
  })
}

async function requireVaultEnvelope() {
  const { [PROVIDER_VAULT_STORAGE_KEY]: value } = await chrome.storage.local.get(PROVIDER_VAULT_STORAGE_KEY)
  if (value === undefined) throw publicError('vault_missing', 'AI 프리셋 볼트가 없습니다.')
  return validateProviderVaultEnvelope(value)
}

async function requireUnlockedVault() {
  const envelope = await requireVaultEnvelope()
  const { [PROVIDER_VAULT_SESSION_KEY]: vaultSession } = await chrome.storage.session.get(PROVIDER_VAULT_SESSION_KEY)
  if (!isVaultSessionForEnvelope(vaultSession, envelope)) {
    throw publicError('vault_locked', 'AI 프리셋 볼트가 잠겨 있습니다.')
  }
  try {
    const contents = await unlockProviderVaultWithKeyMaterial(envelope, vaultSession.keyMaterial)
    return { envelope, vaultSession, contents }
  } catch (error) {
    await chrome.storage.session.remove([
      PROVIDER_VAULT_SESSION_KEY,
      CONNECTION_STORAGE_KEY,
      GITHUB_AUTH_SESSION_KEY,
      GITHUB_FLOW_SESSION_KEY,
    ])
    abortGitHubFlowControllers()
    invalidateGitHubAuthMutations()
    throw error
  }
}

function validEnvelopeOrNull(value: unknown): WireValue | null {
  if (value === undefined) return null
  try { return validateProviderVaultEnvelope(value) } catch { return null }
}

function connectionFromPreset(preset: WireRecord): ConnectionRecord {
  return {
    provider: normalizeProviderConfig(preset),
    apiKey: preset.apiKey,
    revision: crypto.randomUUID(),
  }
}

function connectionMatchesPreset(connection: unknown, preset: WireRecord): boolean {
  if (!isConnectionRecord(connection)) return false
  try {
    return connection.apiKey === preset.apiKey
      && providerIdentity(connection.provider) === providerIdentity(preset)
  } catch {
    return false
  }
}

async function getGitHubCredentialSnapshot() {
  const [session, local] = await Promise.all([
    chrome.storage.session.get([
      GITHUB_AUTH_SESSION_KEY,
      GITHUB_AUTH_REJECTED_KEY,
      PROVIDER_VAULT_SESSION_KEY,
    ]),
    chrome.storage.local.get(GITHUB_AUTH_REJECTED_KEY),
  ])
  const authSession = session[GITHUB_AUTH_SESSION_KEY]
  if (!isRecord(authSession)) return null
  try {
    const auth = validateGitHubAuthRecord(authSession.auth)
    if (typeof authSession.revision !== 'string' || !isUuid(authSession.vaultId)
      || !isUuid(authSession.keyVersion)
      || !isVaultSessionForEnvelope(session[PROVIDER_VAULT_SESSION_KEY], {
        vaultId: authSession.vaultId,
        keyVersion: authSession.keyVersion,
      })) {
      await chrome.storage.session.remove(GITHUB_AUTH_SESSION_KEY)
      return null
    }
    const envelope = { vaultId: authSession.vaultId, keyVersion: authSession.keyVersion }
    const rejected = findGitHubAuthRejectedMarker([
      local[GITHUB_AUTH_REJECTED_KEY],
      session[GITHUB_AUTH_REJECTED_KEY],
    ], envelope, { ...auth, revision: authSession.revision })
    if (rejected) {
      if (!shouldRejectGitHubAuth(local[GITHUB_AUTH_REJECTED_KEY], envelope, {
        ...auth,
        revision: authSession.revision,
      })) {
        try {
          await chrome.storage.local.set({ [GITHUB_AUTH_REJECTED_KEY]: rejected })
          await chrome.storage.session.remove(GITHUB_AUTH_REJECTED_KEY).catch(() => {})
        } catch { /* Keep both sources fail-closed until migration succeeds. */ }
      }
      await chrome.storage.session.remove(GITHUB_AUTH_SESSION_KEY)
      return null
    }
    if (deniedGitHubAuth.rejectsSession(authSession)) {
      await chrome.storage.session.remove(GITHUB_AUTH_SESSION_KEY).catch(() => {})
      return null
    }
    return { token: auth.token, tokenType: auth.tokenType, revision: authSession.revision }
  } catch {
    await chrome.storage.session.remove(GITHUB_AUTH_SESSION_KEY)
    return null
  }
}

async function requireCurrentGitHubAuthRevision(expectedRevision?: string): Promise<void> {
  if (!expectedRevision) return
  const session = (await chrome.storage.session.get(GITHUB_AUTH_SESSION_KEY))[GITHUB_AUTH_SESSION_KEY]
  const revision = isRecord(session) ? session.revision : undefined
  if (!canInvalidateGitHubSession(expectedRevision, revision)) {
    throw publicError('github_auth_changed', 'GitHub 연결이 요청 중 변경되었습니다. 다시 시도해 주세요.')
  }
}

function githubSessionFromRecord(auth: WireValue, envelope: WireRecord): WireRecord {
  return {
    auth: validateGitHubAuthRecord(auth),
    vaultId: envelope.vaultId,
    keyVersion: envelope.keyVersion,
    revision: crypto.randomUUID(),
  }
}

function validGitHubSession(value: unknown, envelope: WireRecord | null): WireRecord | null {
  if (!isRecord(value) || !envelope) return null
  if (!isUuid(value.revision) || value.vaultId !== envelope.vaultId || value.keyVersion !== envelope.keyVersion) return null
  try {
    return { ...value, auth: validateGitHubAuthRecord(value.auth) }
  } catch {
    return null
  }
}

async function readGitHubAuthRejectedMarkers() {
  const [local, session] = await Promise.all([
    chrome.storage.local.get(GITHUB_AUTH_REJECTED_KEY),
    chrome.storage.session.get(GITHUB_AUTH_REJECTED_KEY),
  ])
  return {
    localMarker: local[GITHUB_AUTH_REJECTED_KEY],
    legacyMarker: session[GITHUB_AUTH_REJECTED_KEY],
  }
}

async function reconcileGitHubAuthRejectedMarkers(options: WireRecord): Promise<WireValue | null> {
  const durableMatch = findGitHubAuthRejectedMarker(
    [options.localMarker, options.legacyMarker],
    options.envelope,
    options.durableAuth,
  )
  const liveMatch = findGitHubAuthRejectedMarker(
    [options.localMarker, options.legacyMarker],
    options.envelope,
    options.liveAuth,
  )
  const matched = durableMatch ?? liveMatch
  if (!matched) return null
  const localMatches = findGitHubAuthRejectedMarker(
    [options.localMarker],
    options.envelope,
    options.durableAuth,
  ) ?? findGitHubAuthRejectedMarker(
    [options.localMarker],
    options.envelope,
    options.liveAuth,
  )
  if (!localMatches) {
    try {
      await chrome.storage.local.set({ [GITHUB_AUTH_REJECTED_KEY]: matched })
      await chrome.storage.session.remove(GITHUB_AUTH_REJECTED_KEY).catch(() => {})
    } catch { /* Preserve the legacy marker until canonical migration succeeds. */ }
  } else if (options.legacyMarker) {
    await chrome.storage.session.remove(GITHUB_AUTH_REJECTED_KEY).catch(() => {})
  }
  return matched
}

async function clearGitHubAuthRejectedMarker() {
  await Promise.all([
    chrome.storage.local.remove(GITHUB_AUTH_REJECTED_KEY),
    chrome.storage.session.remove(GITHUB_AUTH_REJECTED_KEY),
  ])
}

function configuredGitHubClientId(): string | null {
  try {
    return normalizeGitHubOAuthClientId(GITHUB_OAUTH_CLIENT_ID)
  } catch {
    return null
  }
}

function sanitizeGitHubFlow(value: unknown): WireRecord | null {
  if (!isRecord(value) || !isUuid(value.flowId)
    || typeof value.userCode !== 'string' || !/^[A-Za-z0-9-]{4,32}$/.test(value.userCode)
    || value.verificationUri !== GITHUB_DEVICE_VERIFICATION_URL
    || !Number.isFinite(Date.parse(value.expiresAt))) return null
  return {
    flowId: value.flowId,
    userCode: value.userCode,
    verificationUri: GITHUB_DEVICE_VERIFICATION_URL,
    expiresAt: value.expiresAt,
    retryAfterMs: Math.max(0, Number(value.nextPollAt) - Date.now()),
  }
}

function requireGitHubFlow(value: unknown, flowId: unknown): WireRecord {
  if (!isRecord(value) || !isUuid(flowId) || value.flowId !== flowId
    || typeof value.deviceCode !== 'string' || value.deviceCode.length > 512
    || /[\s\u0000-\u001f\u007f]/.test(value.deviceCode)
    || !sanitizeGitHubFlow(value)
    || !Number.isSafeInteger(value.intervalMs) || value.intervalMs < 1_000 || value.intervalMs > 60_000
    || !Number.isFinite(value.nextPollAt)) {
    throw publicError('request', 'GitHub 연결 요청이 없거나 일치하지 않습니다.')
  }
  return value
}

async function invalidateExpiredGitHubSession(error: unknown): Promise<void> {
  if (errorCode(error) !== 'github_auth_expired') return
  const authRevision = recordValue(error, 'authRevision')
  if (!isUuid(authRevision)) return
  // Deny in worker memory before any asynchronous storage operation. Even if
  // both the tombstone and encrypted deletion fail, no later request in this
  // worker can reuse the rejected revision.
  deniedGitHubAuth.denyRevision(authRevision)
  githubRepositoryRequests.abortAll()
  return serializeVaultOperation(async () => {
    const session = (await chrome.storage.session.get(GITHUB_AUTH_SESSION_KEY))[GITHUB_AUTH_SESSION_KEY]
    const sessionRevision = isRecord(session) ? session.revision : undefined
    if (!canInvalidateGitHubSession(authRevision, sessionRevision)) return
    if (!isRecord(session)) return
    deniedGitHubAuth.denySession(session)
    let marker
    try { marker = makeGitHubAuthRejectedMarker(session) } catch { return }
    // Stop using the rejected token before any fallible durable cleanup. A
    // token-free local tombstone then survives both MV3 worker and browser
    // restarts if deleting the encrypted credential cannot complete.
    await chrome.storage.session.remove(GITHUB_AUTH_SESSION_KEY).catch(() => {})
    invalidateGitHubAuthMutations()
    try {
      await chrome.storage.local.set({ [GITHUB_AUTH_REJECTED_KEY]: marker })
      await chrome.storage.session.remove(GITHUB_AUTH_REJECTED_KEY).catch(() => {})
    } catch {
      // Preserve a migration-era session tombstone when the canonical local
      // write fails. It survives service-worker restarts and is migrated later.
      await chrome.storage.session.set({ [GITHUB_AUTH_REJECTED_KEY]: marker }).catch(() => {})
    }
    try {
      const { envelope, vaultSession, contents } = await requireUnlockedVault()
      const sessionAuth = isRecord(session.auth) ? session.auth : null
      if (contents.githubAuth && sessionAuth
        && contents.githubAuth.createdAt === sessionAuth.createdAt
        && contents.githubAuth.token === sessionAuth.token) {
        const updated = await updateProviderVaultWithKeyMaterial(envelope, vaultSession.keyMaterial, (draft) => {
          draft.githubAuth = null
        }, { expectedRevision: contents.revision })
        await persistVaultUpdate(updated)
      }
    } catch { /* The local tombstone blocks restoration of the durable token. */ }
  })
}

function requirePassword(value: unknown): string {
  if (typeof value !== 'string') throw publicError('password_policy', '마스터 비밀번호를 입력해 주세요.')
  return value
}

function requirePresetId(payload: WireRecord): string {
  const value = payload?.presetId ?? payload?.id
  if (!isUuid(value)) throw publicError('request', '프리셋 ID가 올바르지 않습니다.')
  return value
}

function normalizePresetName(value: unknown): string {
  if (typeof value !== 'string' || value.trim() !== value || value.length < 1 || value.length > 100
    || /[\u0000-\u001f\u007f]/.test(value)) {
    throw publicError('request', '프리셋 이름 형식이 올바르지 않습니다.')
  }
  return value
}

function serializeVaultOperation<T>(operation: () => T | PromiseLike<T>): Promise<T> {
  const result = vaultOperation.then(operation, operation)
  vaultOperation = result.catch(() => {})
  return result
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true })
  return tab ? { id: tab.id, url: tab.url ?? '', title: tab.title ?? '' } : null
}

function lockSessionStorage() {
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {})
}

function postSafe(port: chrome.runtime.Port, message: WireRecord): void {
  try { port.postMessage(message) } catch { /* Panel already closed. */ }
}

function publicError(code: string, message: string): PublicExtensionError {
  const error = new Error(message) as PublicExtensionError
  error.code = code
  return error
}

function serializeError(error: unknown): WireRecord {
  return serializeExtensionError(error)
}

function isRecord(value: unknown): value is WireRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function recordValue(value: unknown, key: string): unknown {
  return isRecord(value) ? value[key] : undefined
}

function errorCode(error: unknown): string | undefined {
  const code = recordValue(error, 'code')
  return typeof code === 'string' ? code : undefined
}
