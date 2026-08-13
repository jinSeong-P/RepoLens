import { parseGitHubRepoUrl } from './lib/github.js'
import {
  PROMPT_VERSION,
  buildAnalysisMessages,
  buildQuestionMessages,
  parseAnalysisOutput,
  parseQuestionOutput,
} from './lib/analysis.js'
import {
  clearReports,
  deleteReport,
  getReport,
  listLegacyProviderIdentities,
  listReports,
  makeReportKey,
  migrateReportProviderReferences,
  putReport,
} from './lib/cache.js'
import {
  buildArchitectureFallbackData,
  buildMermaidDefinition,
} from './lib/architecture-graph.js'
import { normalizeProviderConfig } from './lib/provider-url.js'
import {
  ANALYSIS_FILE_LIMIT,
  ANALYSIS_SETTINGS_STORAGE_KEY,
  ANALYSIS_SETTINGS_VERSION,
  normalizeAnalysisSettings,
  parseAnalysisFileLimit,
} from './lib/analysis-settings.js'
import { CONNECTION_STORAGE_KEY, connectionMatchesSnapshot } from './lib/connection.js'
import { requestChat } from './lib/ai-client.js'
import {
  ANALYSIS_DEPTH,
  createAnalysisPlan,
  resolveEffectiveAnalysisFileLimit,
} from './lib/analysis-plan.js'
import {
  githubConnectionRecoveryAvailable,
  runSingleFlight,
} from './lib/github-auth-ui.js'
import { hasMessageKey, translate, type MessageKey } from './i18n/catalog.js'
import {
  UI_PREFERENCES_STORAGE_KEY,
  normalizeUiPreferences,
  type UiPreferences,
} from './i18n/types.js'

function requiredQuery(selector: string): any {
  const element = document.querySelector(selector)
  if (!element) throw new Error(`Required interface element is missing: ${selector}`)
  return element
}

const views = [...document.querySelectorAll('.view')]
const contextContent = requiredQuery('#context-content')
const reportContent = requiredQuery('#report-content')
const historyContent = requiredQuery('#history-content')
const providerForm = requiredQuery('#provider-form')
const providerError = requiredQuery('#provider-error')
const providerStatus = requiredQuery('#provider-status')
const keyState = requiredQuery('#key-state')
const toast = requiredQuery('#toast')
const vaultStatus = requiredQuery('#vault-status')
const vaultStateBadge = requiredQuery('#vault-state-badge')
const vaultLoadingState = requiredQuery('#vault-loading-state')
const vaultEmptyState = requiredQuery('#vault-empty-state')
const vaultLockedState = requiredQuery('#vault-locked-state')
const vaultUnlockedState = requiredQuery('#vault-unlocked-state')
const vaultSetupForm = requiredQuery('#vault-setup-form')
const vaultUnlockForm = requiredQuery('#vault-unlock-form')
const presetSelect = requiredQuery('#preset-select')
const presetName = requiredQuery('#preset-name')
const presetError = requiredQuery('#preset-error')
const clearKeyButton = requiredQuery('#clear-key')
const githubStateBadge = requiredQuery('#github-state-badge')
const githubStatus = requiredQuery('#github-status')
const githubError = requiredQuery('#github-error')
const githubDisconnectedState = requiredQuery('#github-disconnected-state')
const githubConnectedState = requiredQuery('#github-connected-state')
const githubDeviceFlow = requiredQuery('#github-device-flow')
const githubPatForm = requiredQuery('#github-pat-form')
const vaultOverviewState = requiredQuery('#vault-overview-state')
const githubOverviewState = requiredQuery('#github-overview-state')
const providerOverviewState = requiredQuery('#provider-overview-state')
const providerStateBadge = requiredQuery('#provider-state-badge')
const githubConnectHint = requiredQuery('#github-connect-hint')
const analysisSettingsForm = requiredQuery('#analysis-settings-form')
const analysisSettingsError = requiredQuery('#analysis-settings-error')
const analysisSettingsStatus = requiredQuery('#analysis-settings-status')
const homeButton = requiredQuery('#home-button')
const historyButton = requiredQuery('#history-button')
const settingsButton = requiredQuery('#settings-button')
const languageSettingsForm = requiredQuery('#language-settings-form')
const uiLocaleSelect = requiredQuery('#ui-locale')
const aiOutputLocaleSelect = requiredQuery('#ai-output-locale')
const languageSettingsStatus = requiredQuery('#language-settings-status')

const MERMAID_SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
let mermaidInitialized = false
let mermaidLoadPromise: Promise<void> | null = null
let architectureRenderSequence = 0
let reconcileTimer: number | undefined
let toastTimer: number | undefined

const state: any = {
  view: 'context',
  provider: null,
  activeProviderRef: null,
  hasApiKey: false,
  connectionRevision: null,
  vaultStatus: 'loading',
  presets: [],
  activePresetId: null,
  selectedPresetId: null,
  migrationPending: false,
  migrationProviders: [],
  githubAuth: { connected: false },
  githubOAuthAvailable: false,
  githubReconnectRequired: false,
  githubFlow: null,
  githubPollTimer: null,
  githubPollInFlight: null,
  tab: null,
  repository: null,
  bundle: null,
  currentRecord: null,
  recordsByDepth: { overview: null, deep: null },
  job: null,
  contextToken: 0,
  contextController: null,
  pendingContextRefresh: false,
  analysisSettings: normalizeAnalysisSettings(),
  uiPreferences: normalizeUiPreferences(),
}

homeButton.addEventListener('click', () => state.job ? showView('context') : refreshContext())
historyButton.addEventListener('click', openHistory)
settingsButton.addEventListener('click', openSettings)
requiredQuery('#toggle-key').addEventListener('click', toggleKeyVisibility)
requiredQuery('#test-provider').addEventListener('click', testProvider)
clearKeyButton.addEventListener('click', clearApiKey)
requiredQuery('#clear-history').addEventListener('click', clearAllHistory)
providerForm.addEventListener('submit', saveProvider)
vaultSetupForm.addEventListener('submit', createVault)
vaultUnlockForm.addEventListener('submit', unlockVault)
requiredQuery('#lock-vault').addEventListener('click', lockVault)
requiredQuery('#reset-vault').addEventListener('click', resetVault)
requiredQuery('#delete-preset').addEventListener('click', deleteCurrentPreset)
presetSelect.addEventListener('change', selectPreset)
for (const overviewButton of document.querySelectorAll<HTMLElement>('[data-settings-target]')) {
  overviewButton.addEventListener('click', () => focusSettingsTarget(overviewButton.dataset.settingsTarget))
}
requiredQuery('#connect-github').addEventListener('click', connectGitHub)
requiredQuery('#copy-github-code').addEventListener('click', copyGitHubCode)
requiredQuery('#open-github-device').addEventListener('click', openGitHubDevicePage)
requiredQuery('#cancel-github-flow').addEventListener('click', cancelGitHubFlow)
requiredQuery('#disconnect-github').addEventListener('click', disconnectGitHub)
githubPatForm.addEventListener('submit', saveGitHubPat)
analysisSettingsForm.addEventListener('submit', saveAnalysisSettings)
analysisSettingsForm.addEventListener('change', handleAnalysisScopeChange)
analysisSettingsForm.elements.maxFiles.addEventListener('input', syncAnalysisScopePreset)
languageSettingsForm?.addEventListener('change', saveLanguageSettings)

chrome.tabs.onActivated.addListener(() => {
  if (!state.githubFlow) refreshContext({ preserveView: state.view !== 'context' })
})
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab.active && changeInfo.url && !state.githubFlow) {
    refreshContext({ preserveView: state.view !== 'context' })
  }
})
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (!['local', 'session'].includes(areaName)) return
  if (areaName === 'local' && changes[ANALYSIS_SETTINGS_STORAGE_KEY]) {
    state.analysisSettings = normalizeAnalysisSettings(changes[ANALYSIS_SETTINGS_STORAGE_KEY].newValue)
    hydrateAnalysisSettings(state.analysisSettings)
    void refreshCurrentReportForAnalysisSettings()
  }
  if (areaName === 'local' && changes[UI_PREFERENCES_STORAGE_KEY]) {
    applyUiPreferences(normalizeUiPreferences(changes[UI_PREFERENCES_STORAGE_KEY].newValue), { rerender: true })
  }
  scheduleRemoteStateReconcile()
})
window.addEventListener('focus', scheduleRemoteStateReconcile)

await initialize()

async function initialize() {
  await loadUiPreferences()
  await loadAnalysisSettings()
  let response = await sendMessage({ type: 'GET_STATE' })
  applyRemoteState(response)
  if (response.unlocked && response.migrationPending) {
    try {
      response = await completePendingMigration(response)
      applyRemoteState(response)
    } catch {
      showVaultStatus(t('vault.migrationFailed'), 'error')
    }
  }
  await refreshContext()
  if (state.githubFlow) scheduleGitHubPoll(state.githubFlow.retryAfterMs)
}

function applyRemoteState(response, { selectedPresetId, hydrateProvider = true }: any = {}) {
  const previousProviderRef = state.activeProviderRef
  state.provider = response.provider ?? null
  state.activeProviderRef = response.activeProviderRef ?? null
  state.hasApiKey = response.hasApiKey === true
  state.connectionRevision = response.connectionRevision ?? null
  state.vaultStatus = response.vaultStatus ?? 'missing'
  state.presets = Array.isArray(response.presets) ? response.presets : []
  state.activePresetId = response.activePresetId ?? null
  state.migrationPending = response.migrationPending === true
  state.migrationProviders = Array.isArray(response.migrationProviders) ? response.migrationProviders : []
  state.githubAuth = response.githubAuth?.connected === true
    ? response.githubAuth
    : { connected: false, method: null, login: null, createdAt: null }
  state.githubOAuthAvailable = response.githubOAuthAvailable === true
  state.githubReconnectRequired = response.githubReconnectRequired === true
  if (Object.hasOwn(response, 'githubFlow')) state.githubFlow = response.githubFlow ?? null
  if (previousProviderRef !== state.activeProviderRef) {
    state.currentRecord = null
    state.recordsByDepth = { overview: null, deep: null }
  }

  const requestedSelection = selectedPresetId === undefined ? state.selectedPresetId : selectedPresetId
  state.selectedPresetId = state.presets.some((preset) => preset.id === requestedSelection)
    ? requestedSelection
    : state.activePresetId
  presetSelect.value = state.selectedPresetId ?? ''
  renderVaultState()
  renderGitHubState()
  if (hydrateProvider) hydrateProviderForm(selectedPreset())
}

function scheduleRemoteStateReconcile() {
  clearTimeout(reconcileTimer)
  reconcileTimer = window.setTimeout(reconcileRemoteState, 100)
}

async function reconcileRemoteState({ refreshRepository = true } = {}) {
  try {
    const response = await sendMessage({ type: 'GET_STATE' })
    const previousProviderRef = state.activeProviderRef
    const providerStateChanged = response.activeProviderRef !== state.activeProviderRef
      || response.connectionRevision !== state.connectionRevision
      || response.vaultStatus !== state.vaultStatus
    const previousGitHubIdentity = githubStateIdentity(state.githubAuth)
    applyRemoteState(response, { hydrateProvider: providerStateChanged })
    if (previousProviderRef !== state.activeProviderRef && state.job) state.job.controller.abort()
    if (refreshRepository && previousGitHubIdentity !== githubStateIdentity(state.githubAuth)
      && state.repository && !state.job) {
      await refreshContext()
    }
    if (state.githubFlow) scheduleGitHubPoll(state.githubFlow.retryAfterMs)
    else clearGitHubPollTimer()
  } catch {
    // A service-worker restart or panel teardown can race this best-effort refresh.
  }
}

function githubStateIdentity(auth) {
  return auth?.connected ? `${auth.method}:${auth.login}:${auth.createdAt}` : 'disconnected'
}

async function completePendingMigration(remoteState) {
  if (!remoteState?.unlocked || !remoteState.migrationPending) return remoteState
  const mappings = Array.isArray(remoteState.migrationProviders) ? remoteState.migrationProviders : []
  const stats = await migrateReportProviderReferences(mappings)
  const response = await sendMessage({ type: 'VAULT_MIGRATION_COMPLETE' })
  const removed = stats.unmapped + stats.conflicts
  if (removed > 0) showToast(t('vault.legacyReportsRemoved', { count: removed }))
  return response
}

function renderVaultState() {
  const status = state.vaultStatus
  const busy = state.job !== null
  const focusedElement = document.activeElement
  const focusedState = focusedElement?.closest?.('.vault-state') as HTMLElement | null
  vaultLoadingState.hidden = status !== 'loading'
  vaultEmptyState.hidden = status !== 'missing'
  vaultUnlockedState.hidden = status !== 'unlocked'
  vaultLockedState.hidden = status !== 'locked' && status !== 'corrupt'
  vaultUnlockForm.hidden = status === 'corrupt'
  for (const control of vaultUnlockForm.elements) control.disabled = status !== 'locked'
  vaultStateBadge.textContent = status === 'unlocked'
    ? t('vault.unlocked')
    : status === 'locked' ? t('vault.locked') : status === 'corrupt' ? t('vault.corrupt') : status === 'missing' ? t('common.required') : t('common.checking')
  vaultStateBadge.dataset.tone = status === 'unlocked' ? 'success' : status === 'corrupt' ? 'danger' : 'neutral'
  vaultOverviewState.textContent = status === 'unlocked'
    ? t('vault.open') : status === 'locked' ? t('vault.locked') : status === 'missing' ? t('common.required') : status === 'corrupt' ? t('vault.needsAttention') : t('common.checking')

  presetSelect.replaceChildren(el('option', { value: '' }, [t('provider.newPreset')]))
  for (const preset of state.presets) {
    const suffix = preset.id === state.activePresetId ? t('provider.activeSuffix') : ''
    presetSelect.append(el('option', { value: preset.id }, [`${preset.name}${suffix}`]))
  }
  presetSelect.value = state.selectedPresetId ?? ''
  requiredQuery('#delete-preset').disabled = busy || !state.selectedPresetId

  const editorEnabled = status === 'unlocked' && !busy
  for (const control of providerForm.elements) control.disabled = !editorEnabled
  presetSelect.disabled = !editorEnabled
  presetName.disabled = !editorEnabled
  requiredQuery('#lock-vault').disabled = !editorEnabled
  clearKeyButton.hidden = status !== 'unlocked'
  clearKeyButton.textContent = t('vault.lockAction')
  if (!editorEnabled) clearSecretInputs()

  if (focusedState?.hidden || (vaultUnlockForm.hidden && vaultUnlockForm.contains(focusedElement))) {
    requiredQuery('#provider-vault')?.focus?.()
  }

  if (status === 'unlocked') {
    showVaultStatus(state.migrationPending ? t('vault.migrating') : '')
  } else if (status === 'corrupt') {
    showVaultStatus(t('vault.corruptHelp'), 'error')
  } else if (status === 'locked') {
    showVaultStatus(t('vault.lockedHelp'))
  } else if (status === 'missing') {
    showVaultStatus(t('vault.missingHelp'))
  }
}

function clearSecretInputs() {
  providerForm.elements.apiKey.value = ''
  providerForm.elements.apiKey.type = 'password'
  const toggle = requiredQuery('#toggle-key')
  toggle.textContent = t('common.show')
  toggle.setAttribute('aria-label', t('provider.apiKeyShowAria'))
  toggle.setAttribute('aria-pressed', 'false')
  githubPatForm.reset()
}

function selectedPreset() {
  return state.presets.find((preset) => preset.id === state.selectedPresetId) ?? null
}

function activePreset() {
  return state.presets.find((preset) => preset.id === state.activePresetId) ?? null
}

function showVaultStatus(message, tone = 'info') {
  setStatus(vaultStatus, message, tone)
}

function renderGitHubState() {
  const unlocked = state.vaultStatus === 'unlocked'
  const busy = state.job !== null
  const connected = unlocked && state.githubAuth.connected === true
  githubConnectedState.hidden = !connected
  githubDisconnectedState.hidden = connected
  githubStateBadge.textContent = connected ? t('github.connected') : unlocked ? t('github.disconnected') : t('github.vaultLocked')
  githubStateBadge.dataset.tone = connected ? 'success' : 'neutral'
  githubOverviewState.textContent = connected ? `@${state.githubAuth.login}` : unlocked ? t('github.optional') : t('github.pending')
  requiredQuery('#github-account').textContent = connected ? `@${state.githubAuth.login}` : ''
  requiredQuery('#github-auth-method').textContent = connected
    ? t('github.authMethod', { method: state.githubAuth.method === 'oauth' ? t('github.oauthMethod') : t('github.patMethod') })
    : ''
  const connectButton = requiredQuery('#connect-github')
  connectButton.textContent = !unlocked
    ? t('github.unlockFirst')
    : state.githubFlow ? t('github.waiting')
      : busy ? t('github.connectAfterAnalysis') : t('github.connect')
  connectButton.disabled = !unlocked || busy || !state.githubOAuthAvailable || Boolean(state.githubFlow)
  requiredQuery('#github-oauth-actions').hidden = !state.githubOAuthAvailable
  requiredQuery('#github-oauth-unavailable').hidden = state.githubOAuthAvailable
  for (const control of githubPatForm.elements) control.disabled = !unlocked || busy
  requiredQuery('#disconnect-github').disabled = !unlocked || busy
  githubDeviceFlow.hidden = !state.githubFlow || connected
  requiredQuery('#github-user-code').textContent = state.githubFlow?.userCode ?? ''
  if (!githubError.hidden) setStatus(githubStatus, '')
  else {
    const githubTone = connected ? 'success' : state.githubReconnectRequired ? 'warning' : 'info'
    setStatus(githubStatus, githubConnectionStatus(), githubTone)
  }
  githubConnectHint.textContent = githubConnectButtonHint({ unlocked, busy, connected })

  const providerConnected = unlocked && Boolean(state.provider && state.hasApiKey && state.activeProviderRef)
  providerStateBadge.textContent = providerConnected ? t('provider.inUse') : unlocked ? t('common.required') : t('github.vaultLocked')
  providerStateBadge.dataset.tone = providerConnected ? 'success' : 'neutral'
  providerOverviewState.textContent = providerConnected
    ? (activePreset()?.name ?? state.provider?.model ?? t('provider.connected'))
    : unlocked ? t('common.required') : t('github.pending')
}

function githubConnectButtonHint({ unlocked, busy, connected }) {
  if (connected) return ''
  if (!unlocked) return t('github.hintUnlock')
  if (busy) return t('github.hintBusy')
  if (!state.githubOAuthAvailable) return t('github.hintPatFallback')
  if (state.githubFlow) return t('github.hintApproval')
  return t('github.hintAutomatic')
}

function githubConnectionStatus() {
  if (state.githubFlow) return t('github.statusWaiting')
  if (state.vaultStatus !== 'unlocked') return t('github.statusUnlock')
  if (state.githubAuth?.connected === true) return t('github.statusConnected')
  if (state.githubReconnectRequired === true) return t('github.statusExpired')
  return t('github.statusOptional')
}

async function connectGitHub() {
  clearGitHubError()
  if (state.githubFlow) {
    renderGitHubState()
    scheduleGitHubPoll(state.githubFlow.retryAfterMs)
    await openGitHubDevicePage()
    return
  }
  if (state.githubPollInFlight) {
    try { await state.githubPollInFlight } catch { /* A prior flow reports its own failure. */ }
  }
  if (state.githubAuth.connected || state.vaultStatus !== 'unlocked'
    || state.job || !state.githubOAuthAvailable) return
  const buttonElement = requiredQuery('#connect-github')
  buttonElement.disabled = true
  setStatus(githubStatus, t('github.creatingCode'), 'info')
  try {
    const response = await sendMessage({ type: 'GITHUB_AUTH_START' })
    state.githubFlow = response.flow
    renderGitHubState()
    await openGitHubDevicePage()
    scheduleGitHubPoll(response.flow?.retryAfterMs ?? 5_000)
  } catch (error) {
    showGitHubError(error)
  } finally {
    buttonElement.disabled = state.vaultStatus !== 'unlocked' || state.job !== null
      || !state.githubOAuthAvailable || Boolean(state.githubFlow)
  }
}

function scheduleGitHubPoll(delay) {
  clearGitHubPollTimer()
  if (!state.githubFlow) return
  state.githubPollTimer = setTimeout(() => {
    state.githubPollTimer = null
    void pollGitHubConnection()
  }, Math.max(750, Number(delay) || 5_000))
}

function clearGitHubPollTimer() {
  clearTimeout(state.githubPollTimer)
  state.githubPollTimer = null
}

function pollGitHubConnection() {
  const flight = runSingleFlight(state, 'githubPollInFlight', async () => {
    const requestedFlowId = state.githubFlow?.flowId
    if (!requestedFlowId) return
    try {
      const response = await sendMessage({
        type: 'GITHUB_AUTH_POLL',
        payload: { flowId: requestedFlowId },
      })
      if (state.githubFlow?.flowId !== requestedFlowId) return
      if (response.status === 'connected') {
        state.githubFlow = null
        const remote = await sendMessage({ type: 'GET_STATE' })
        applyRemoteState(remote)
        showToast(t('github.connectedToast'))
        if (state.repository) await refreshContext()
        return
      }
      state.githubFlow = response.flow ?? state.githubFlow
      renderGitHubState()
      scheduleGitHubPoll(response.retryAfterMs)
    } catch (error) {
      if (state.githubFlow?.flowId !== requestedFlowId) return
      state.githubFlow = null
      await reconcileRemoteState()
      if (error?.code !== 'cancelled') showGitHubError(error)
    }
  })
  // A different panel can replace the flow while this RPC is in flight. If
  // its timer fired while sharing this flight, restore polling for the current
  // flow after the old operation releases the slot.
  flight.then(() => {
    if (state.githubFlow && !state.githubPollTimer) {
      scheduleGitHubPoll(state.githubFlow.retryAfterMs)
    }
  })
  return flight
}

async function cancelGitHubFlow() {
  if (!state.githubFlow) return
  const flowId = state.githubFlow.flowId
  state.githubFlow = null
  clearGitHubPollTimer()
  renderGitHubState()
  try {
    await sendMessage({ type: 'GITHUB_AUTH_CANCEL', payload: { flowId } })
    setStatus(githubStatus, t('github.cancelled'), 'info')
  } catch (error) {
    showGitHubError(error)
  }
}

async function openGitHubDevicePage() {
  const url = state.githubFlow?.verificationUri
  if (url !== 'https://github.com/login/device') return
  await chrome.tabs.create({ url })
}

async function copyGitHubCode() {
  if (!state.githubFlow?.userCode) return
  try {
    await navigator.clipboard.writeText(state.githubFlow.userCode)
    showToast(t('github.codeCopied'))
  } catch {
    showGitHubError(Object.assign(new Error(), { code: 'clipboard' }))
  }
}

async function saveGitHubPat(event) {
  event.preventDefault()
  clearGitHubError()
  const submit = requiredQuery('#save-github-pat')
  submit.disabled = true
  setStatus(githubStatus, t('github.savingPat'), 'info')
  try {
    const response = await sendMessage({
      type: 'GITHUB_AUTH_SAVE_PAT',
      payload: { token: githubPatForm.elements.token.value },
    })
    githubPatForm.reset()
    clearGitHubPollTimer()
    state.githubFlow = null
    applyRemoteState(response)
    showToast(t('github.connectedToast'))
    if (state.repository) await refreshContext()
  } catch (error) {
    showGitHubError(error)
  } finally {
    submit.disabled = state.vaultStatus !== 'unlocked' || state.job !== null
  }
}

async function disconnectGitHub() {
  if (!confirm(t('github.disconnectConfirm'))) return
  clearGitHubError()
  try {
    const response = await sendMessage({ type: 'GITHUB_AUTH_DISCONNECT' })
    state.githubFlow = null
    applyRemoteState(response)
    showToast(t('github.disconnectedToast'))
    if (state.repository) await refreshContext()
  } catch (error) {
    showGitHubError(error)
  }
}

function showGitHubError(error) {
  githubError.hidden = false
  githubError.textContent = friendlyGitHubAuthError(error)
  setStatus(githubStatus, '')
  if (state.githubFlow) renderGitHubState()
}

function clearGitHubError() {
  githubError.hidden = true
  githubError.textContent = ''
}

function friendlyGitHubAuthError(error) {
  const keyByCode: Partial<Record<string, MessageKey>> = {
    oauth_unconfigured: 'github.error.oauthUnconfigured',
    invalid_token: 'github.error.invalidToken',
    unexpected_scope: 'github.error.unexpectedScope',
    expired: 'github.error.expired',
    access_denied: 'github.error.accessDenied',
    vault_locked: 'github.error.vaultLocked',
    clipboard: 'github.error.clipboard',
    busy: 'github.error.busy',
    conflict: 'github.error.conflict',
    request: 'github.error.request',
    timeout: 'github.error.timeout',
  }
  return t(keyByCode[error?.code] ?? 'github.error.generic')
}

function showVaultFormError(element, error) {
  element.hidden = false
  element.setAttribute('tabindex', '-1')
  element.textContent = friendlyVaultError(error)
  element.focus?.()
}

function clearVaultFormError(element) {
  element.hidden = true
  element.textContent = ''
}

async function createVault(event) {
  event.preventDefault()
  const errorElement = requiredQuery('#vault-setup-error')
  clearVaultFormError(errorElement)
  const password = vaultSetupForm.elements.password.value
  const confirmation = vaultSetupForm.elements.passwordConfirm.value
  if (password !== confirmation) {
    showVaultFormError(errorElement, Object.assign(new Error(), { code: 'password_mismatch' }))
    return
  }

  const submit = requiredQuery('#create-vault')
  submit.disabled = true
  showVaultStatus(t('vault.creating'))
  try {
    const historicalProviders = await listLegacyProviderIdentities()
    let response = await sendMessage({
      type: 'VAULT_CREATE',
      payload: { password, historicalProviders },
    })
    applyRemoteState(response)
    if (response.migrationPending) {
      try {
        response = await completePendingMigration(response)
        applyRemoteState(response)
      } catch {
        showVaultStatus(t('vault.createdMigrationFailed'), 'error')
        vaultSetupForm.reset()
        showToast(t('vault.createdToast'))
        return
      }
    }
    vaultSetupForm.reset()
    showVaultStatus(t('vault.createdStatus'), 'success')
    showToast(t('vault.createdToast'))
  } catch (error) {
    showVaultFormError(errorElement, error)
    showVaultStatus(t('vault.createFailed'), 'error')
  } finally {
    submit.disabled = false
  }
}

async function unlockVault(event) {
  event.preventDefault()
  const errorElement = requiredQuery('#vault-unlock-error')
  clearVaultFormError(errorElement)
  const passwordInput = vaultUnlockForm.elements.password
  const submit = requiredQuery('#unlock-vault')
  submit.disabled = true
  showVaultStatus(t('vault.unlocking'))
  try {
    let response = await sendMessage({ type: 'VAULT_UNLOCK', payload: { password: passwordInput.value } })
    applyRemoteState(response)
    passwordInput.value = ''
    if (response.migrationPending) {
      try {
        response = await completePendingMigration(response)
        applyRemoteState(response)
      } catch {
        showVaultStatus(t('vault.unlockedMigrationFailed'), 'error')
        showToast(t('vault.unlockedToast'))
        return
      }
    }
    showVaultStatus(t('vault.loaded'), 'success')
    showToast(t('vault.unlockedToast'))
  } catch (error) {
    passwordInput.value = ''
    showVaultFormError(errorElement, error)
    showVaultStatus(t('vault.unlockFailed'), 'error')
  } finally {
    submit.disabled = false
  }
}

async function lockVault() {
  if (state.job) {
    showVaultStatus(t('vault.lockBusy'), 'warning')
    return
  }
  try {
    const response = await sendMessage({ type: 'VAULT_LOCK' })
    clearGitHubPollTimer()
    state.githubFlow = null
    applyRemoteState(response, { selectedPresetId: null })
    showToast(t('vault.lockedToast'))
    if (state.repository) renderReady()
  } catch (error) {
    showVaultStatus(friendlyVaultError(error), 'error')
  }
}

async function resetVault() {
  if (!confirm(t('vault.resetConfirm'))) return
  try {
    const response = await sendMessage({ type: 'VAULT_RESET' })
    clearGitHubPollTimer()
    state.githubFlow = null
    await clearReports()
    applyRemoteState(response, { selectedPresetId: null })
    state.currentRecord = null
    state.recordsByDepth = { overview: null, deep: null }
    vaultUnlockForm.reset()
    showToast(t('vault.resetToast'))
    if (state.repository) renderReady()
  } catch (error) {
    showVaultStatus(friendlyVaultError(error), 'error')
  }
}

async function saveCurrentPreset(event) {
  event?.preventDefault?.()
  if (state.vaultStatus !== 'unlocked') return
  clearProviderFeedback()
  clearVaultFormError(presetError)
  const payload = { ...providerPayload(), name: presetName.value, id: state.selectedPresetId, activate: true }
  const saveButton = requiredQuery('#apply-provider')
  saveButton.disabled = true
  try {
    await requestProviderPermission(payload.baseUrl)
    const previousIds = new Set(state.presets.map((preset) => preset.id))
    const response = await sendMessage({ type: 'VAULT_SAVE_PRESET', payload })
    let savedId = state.selectedPresetId
    if (!savedId) {
      const candidates = response.presets.filter((preset) => !previousIds.has(preset.id))
      savedId = candidates.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.id ?? response.activePresetId
    }
    applyRemoteState(response, { selectedPresetId: savedId })
    providerForm.elements.apiKey.value = ''
    hydrateProviderForm(selectedPreset())
    setStatus(providerStatus, t('provider.savedStatus'), 'success')
    showToast(t('provider.savedToast'))
    if (state.repository) renderReady()
  } catch (error) {
    showVaultFormError(presetError, error)
    showProviderError(error)
  } finally {
    saveButton.disabled = false
  }
}

function selectPreset() {
  clearProviderFeedback()
  clearVaultFormError(presetError)
  const presetId = presetSelect.value || null
  state.selectedPresetId = state.presets.some((preset) => preset.id === presetId) ? presetId : null
  hydrateProviderForm(selectedPreset())
  requiredQuery('#delete-preset').disabled = !state.selectedPresetId
  if (state.selectedPresetId === state.activePresetId) {
    setStatus(providerStatus, t('provider.selectedActive'), 'info')
  } else if (state.selectedPresetId) {
    setStatus(providerStatus, t('provider.selectedInactive'), 'info')
  } else {
    setStatus(providerStatus, t('provider.selectedNew'), 'info')
  }
}

async function deleteCurrentPreset() {
  const preset = selectedPreset()
  if (!preset || !confirm(t('provider.deleteConfirm', { name: preset.name }))) return
  const deleteButton = requiredQuery('#delete-preset')
  deleteButton.disabled = true
  try {
    const response = await sendMessage({ type: 'VAULT_DELETE_PRESET', payload: { presetId: preset.id } })
    applyRemoteState(response, { selectedPresetId: response.activePresetId })
    showToast(t('provider.deletedToast'))
    if (state.repository) renderReady()
  } catch (error) {
    showVaultFormError(presetError, error)
  } finally {
    deleteButton.disabled = !state.selectedPresetId
  }
}

async function refreshContext({ preserveView = false } = {}) {
  if (state.job) {
    state.pendingContextRefresh = true
    return
  }
  if (preserveView) {
    state.pendingContextRefresh = true
    return
  }
  state.pendingContextRefresh = false
  const token = ++state.contextToken
  state.contextController?.abort()
  const contextController = new AbortController()
  state.contextController = contextController
  state.repository = null
  state.bundle = null
  state.currentRecord = null
  state.recordsByDepth = { overview: null, deep: null }
  showView('context')
  renderLoading(t('repo.checkingPage'))

  try {
    const { tab } = await sendMessage({ type: 'GET_ACTIVE_TAB' })
    if (token !== state.contextToken) return
    state.tab = tab
    const parsed = parseGitHubRepoUrl(tab?.url ?? '')
    if (!parsed) {
      renderEmpty()
      return
    }

    renderLoading(t('repo.checkingRepository'))
    const repository = await resolveRepository(parsed, contextController.signal)
    if (token !== state.contextToken) return
    state.repository = repository

    if (state.activeProviderRef) {
      const providerRefSnapshot = state.activeProviderRef
      const settingsSnapshot = { ...state.analysisSettings }
      const records = await findCurrentAnalysisRecords(repository, providerRefSnapshot, settingsSnapshot)
      if (token !== state.contextToken
        || state.repository?.sha !== repository.sha
        || state.activeProviderRef !== providerRefSnapshot
        || state.analysisSettings.maxFiles !== settingsSnapshot.maxFiles) return
      applyCurrentAnalysisRecords(records)
    }
    if (token !== state.contextToken) return
    renderReady()
  } catch (error) {
    if (token !== state.contextToken) return
    if (error?.code === 'cancelled') return
    if (['github_auth_expired', 'github_auth_changed'].includes(error?.code)) {
      await reconcileRemoteState({ refreshRepository: false })
    }
    renderContextError(error, refreshContext, t('common.retry'))
  } finally {
    if (state.contextController === contextController) state.contextController = null
  }
}

function renderEmpty() {
  contextContent.replaceChildren(el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-icon lens-empty-icon', 'aria-hidden': 'true' }),
    el('p', { class: 'eyebrow' }, [t('repo.browseEyebrow')]),
    el('h1', { id: 'context-title' }, [t('repo.browseTitle')]),
    el('p', {}, [t('repo.emptyDescription')]),
    el('div', { class: 'empty-steps', 'aria-label': t('repo.howToAria') }, [
      el('span', {}, ['1', el('small', {}, [t('repo.stepDiscover')])]),
      el('span', {}, ['2', el('small', {}, [t('repo.stepCollect')])]),
      el('span', {}, ['3', el('small', {}, [t('repo.stepAnalyze')])]),
    ]),
  ]))
}

function renderLoading(message) {
  contextContent.replaceChildren(el('div', { class: 'progress-card' }, [
    el('div', { class: 'progress-line', role: 'status', 'aria-live': 'polite' }, [
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      el('strong', { id: 'context-title' }, [message]),
    ]),
  ]))
}

function renderReady() {
  const repository = state.repository
  const host = state.provider ? new URL(state.provider.baseUrl).host : t('repo.configuredAiHost')
  const overviewRecord = state.recordsByDepth.overview
  const deepRecord = state.recordsByDepth.deep
  const overviewPlan = createAnalysisPlan({ depth: ANALYSIS_DEPTH.overview, maxFiles: state.analysisSettings.maxFiles })
  const quickLimit = resolveEffectiveAnalysisFileLimit(overviewPlan)
  const children = [
    el('div', { class: 'repo-kicker' }, [
      el('p', { class: 'eyebrow' }, [t('repo.public')]),
      el('span', { class: 'status-badge success' }, [t('repo.verified')]),
    ]),
    el('h1', { id: 'context-title', class: 'repo-name' }, [repository.fullName]),
    el('p', { class: 'repo-description' }, [repository.description || t('repo.noDescription')]),
    el('div', { class: 'meta-row' }, [
      el('span', {}, [`★ ${formatNumber(repository.stars)}`]),
      repository.language ? el('span', {}, [repository.language]) : null,
      repository.licenseSpdx ? el('span', {}, [repository.licenseSpdx]) : null,
      el('span', {}, [`${repository.defaultBranch} · ${repository.sha.slice(0, 7)}`]),
    ].filter(Boolean)),
    el('p', { class: 'context-intro' }, [t('repo.fastestWay')]),
  ]

  if (deepRecord || overviewRecord) {
    const preferredRecord = deepRecord ?? overviewRecord
    children.push(
      el('div', { class: 'notice' }, [deepRecord
        ? t('repo.savedDeep')
        : t('repo.savedQuick')]),
      actionRow([
        button(deepRecord ? t('repo.viewDeep') : t('repo.viewQuick'), 'primary-button', () => openReport(preferredRecord)),
        overviewRecord && !deepRecord
          ? button(t('repo.expandDeep'), 'secondary-button', () => startAnalysis('deep', { sourceRecord: overviewRecord }))
          : button(t('repo.rerunDeep'), 'secondary-button', () => startAnalysis('deep')),
      ]),
    )
  } else if (state.vaultStatus !== 'unlocked' || !state.provider || !state.hasApiKey || !state.activeProviderRef) {
    children.push(
      el('div', { class: 'notice' }, [
        state.vaultStatus === 'locked'
          ? t('repo.unlockForAnalysis')
          : t('repo.connectForAnalysis'),
      ]),
      actionRow([button(t('analysis.connectAi'), 'primary-button', openSettings)]),
    )
  } else {
    children.push(
      el('section', { class: 'analysis-paths', 'aria-label': t('repo.analysisPathsAria') }, [
        el('article', { class: 'analysis-path-card recommended' }, [
          el('span', { class: 'path-stage' }, [t('analysis.quickStage')]),
          el('h2', {}, [t('repo.quickCardTitle')]),
          el('p', {}, [t('repo.quickCardDescription')]),
          el('p', { class: 'path-meta' }, [t('repo.pathMeta', { count: quickLimit })]),
          button(t('analysis.startQuick'), 'primary-button', () => startAnalysis('overview')),
        ]),
        el('article', { class: 'analysis-path-card deep' }, [
          el('span', { class: 'path-stage' }, [t('repo.deepCombinedStage')]),
          el('h2', {}, [t('repo.deepCardTitle')]),
          el('p', {}, [t('repo.deepCardDescription')]),
          el('div', { class: 'path-flow', 'aria-label': t('repo.relationshipFlowAria') }, [
            el('span', {}, [t('repo.selectCore')]), el('span', {}, [t('repo.expandRelations')]),
          ]),
          el('p', { class: 'path-meta' }, [t('repo.pathMeta', { count: state.analysisSettings.maxFiles })]),
          button(t('analysis.startDeep'), 'secondary-button', () => startAnalysis('deep')),
        ]),
      ]),
      el('div', { class: 'notice privacy-notice' }, [
        t('repo.privacy', { host }),
      ]),
    )
  }

  contextContent.replaceChildren(el('div', { class: 'hero' }, children))
}

async function startAnalysis(depth: 'overview' | 'deep' = ANALYSIS_DEPTH.deep, { sourceRecord = null }: any = {}) {
  const requestedRepository = sourceRecord?.repository ?? state.repository
  if (!requestedRepository || !state.provider || !state.activeProviderRef || state.job) return
  const analysisPlan = createAnalysisPlan({ depth, maxFiles: state.analysisSettings.maxFiles })
  const controller = new AbortController()
  const providerSnapshot = { ...state.provider }
  const providerRefSnapshot = state.activeProviderRef
  const connectionRevisionSnapshot = state.connectionRevision
  const repositorySnapshot = { ...requestedRepository }
  const analysisSettingsSnapshot = { ...state.analysisSettings }
  const outputLocaleSnapshot = state.uiPreferences.aiOutputLocale
  const previousRecord = sourceRecord ?? state.currentRecord
  state.job = { controller, raw: '', provider: providerSnapshot, analysisPlan }
  renderVaultState()
  renderGitHubState()
  let progressText
  let streamPreview

  contextContent.replaceChildren(el('div', { class: 'progress-card' }, [
    el('p', { class: 'eyebrow' }, [depth === 'overview' ? t('analysis.quickStage') : t('analysis.deepStage')]),
    el('h1', { id: 'context-title' }, [repositorySnapshot.fullName]),
    el('div', { class: 'analysis-progress-steps', 'aria-hidden': 'true' }, [
      el('span', { class: 'active' }, [t('progress.repository')]),
      el('span', {}, [depth === 'overview' ? t('progress.coreFiles') : t('progress.stageOneCore')]),
      ...(depth === 'deep' ? [el('span', {}, [t('progress.stageTwoRelations')])] : []),
      el('span', {}, [t('progress.aiExplanation')]),
      el('span', {}, [t('progress.evidence')]),
    ]),
    el('div', { class: 'progress-line', role: 'status', 'aria-live': 'polite' }, [
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      progressText = el('strong', {}, [t('progress.tree')]),
    ]),
    el('details', { class: 'stream-details' }, [
      el('summary', {}, [t('progress.viewStream')]),
      streamPreview = el('pre', { class: 'stream-preview', hidden: true }),
    ]),
    actionRow([button(t('analysis.stop'), 'secondary-button', abortCurrentJob)]),
  ]))
  showView('context')

  try {
    const collected = await collectRepository(
      repositorySnapshot,
      controller.signal,
      (stage, message) => { progressText.textContent = localizedCollectionProgress(stage, message, analysisPlan) },
      analysisSettingsSnapshot,
      analysisPlan,
      sourceRecord?.repository?.sha,
    )
    const analyzedRepository = collected.repository
    const bundle = collected.bundle
    state.repository = analyzedRepository
    state.bundle = bundle
    progressText.textContent = t('analysis.sendingFiles', { count: bundle.files.length })

    const messages = buildAnalysisMessages(analyzedRepository, bundle, { outputLocale: outputLocaleSnapshot })
    const raw = await streamChat(messages, providerSnapshot, connectionRevisionSnapshot, (delta) => {
      state.job.raw += delta
      streamPreview.hidden = false
      streamPreview.textContent = state.job.raw.slice(-8_000)
      progressText.textContent = t('progress.aiWriting')
    })
    progressText.textContent = t('progress.verifyingEvidence')
    const report = parseAnalysisOutput(raw, analyzedRepository, bundle.files)
    const record = {
      key: makeReportKey({
        repository: analyzedRepository,
        providerRef: providerRefSnapshot,
        promptVersion: PROMPT_VERSION,
        analysisPlan,
        outputLocale: outputLocaleSnapshot,
      }),
      repository: analyzedRepository,
      provider: { providerRef: providerRefSnapshot },
      analysisSettings: analysisSettingsSnapshot,
      analysisPlan,
      outputLocale: outputLocaleSnapshot,
      ...(sourceRecord ? { derivedFromKey: sourceRecord.key } : {}),
      bundle,
      report,
      questions: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await putReport(record)
    state.currentRecord = record
    state.recordsByDepth[depth] = record
    state.job = null
    renderVaultState()
    renderGitHubState()
    openReport(record)
    refreshPendingContext()
  } catch (error) {
    state.job = null
    if (['github_auth_expired', 'github_auth_changed'].includes(error?.code)) {
      await reconcileRemoteState({ refreshRepository: false })
    }
    renderVaultState()
    renderGitHubState()
    if (sourceRecord && previousRecord) {
      state.currentRecord = previousRecord
      openReport(previousRecord, { upgradeError: error })
    } else {
      renderContextError(error, () => startAnalysis(depth), t('common.retry'))
    }
    refreshPendingContext()
  }
}

function localizedCollectionProgress(stage, fallbackMessage, plan) {
  if (stage === 'tree') return t('progress.tree')
  if (stage === 'anchors') {
    return t('progress.anchors', { count: resolveEffectiveAnalysisFileLimit(plan) })
  }
  if (stage === 'relationships') return t('progress.relationships')
  return fallbackMessage
}

function collectRepository(repository, signal, onProgress, analysisSettings = state.analysisSettings, analysisPlan = createAnalysisPlan({ maxFiles: analysisSettings.maxFiles }), expectedSha) {
  return githubPortRequest('COLLECT_REPOSITORY', {
    repository: {
      owner: repository.owner,
      repo: repository.repo,
    },
    options: {
      maxFiles: analysisPlan.maxFiles,
      depth: analysisPlan.depth,
      ...(expectedSha ? { expectedSha } : {}),
    },
  }, signal, onProgress, 90_000).then((result: any) => ({
    repository: result.repository,
    bundle: result.bundle,
  }))
}

async function findCurrentAnalysisRecords(repository = state.repository, providerRef = state.activeProviderRef, analysisSettings = state.analysisSettings) {
  if (!repository || !providerRef) return { overview: null, deep: null }
  const plans = {
    overview: createAnalysisPlan({ depth: 'overview', maxFiles: analysisSettings.maxFiles }),
    deep: createAnalysisPlan({ depth: 'deep', maxFiles: analysisSettings.maxFiles }),
  }
  const [overview, deep] = await Promise.all(Object.values(plans).map((analysisPlan) => getReport(makeReportKey({
    repository,
    providerRef,
    promptVersion: PROMPT_VERSION,
    analysisPlan,
    outputLocale: state.uiPreferences.aiOutputLocale,
  }))))
  return { overview: overview ?? null, deep: deep ?? null }
}

function applyCurrentAnalysisRecords(records) {
  state.recordsByDepth = records
  state.currentRecord = state.recordsByDepth.deep ?? state.recordsByDepth.overview
}

function resolveRepository(repository, signal) {
  return githubPortRequest('RESOLVE_REPOSITORY', { repository }, signal, null, 30_000)
    .then((result: any) => result.repository)
}

function githubPortRequest(type, payload, signal, onProgress, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'repolens-github' })
    const requestId = crypto.randomUUID()
    let settled = false
    const timeout = setTimeout(() => finishReject(Object.assign(
      new Error(t('github.error.timeout')),
      { code: 'timeout', source: 'github' },
    ), true), timeoutMs)
    const abort = () => finishReject(Object.assign(
      new Error(t('github.error.cancelled')),
      { code: 'cancelled', source: 'github' },
    ), true)
    signal?.addEventListener('abort', abort, { once: true })

    port.onMessage.addListener((message) => {
      if (message?.requestId !== requestId) return
      if (message.type === 'progress') onProgress?.(message.stage, message.message)
      else if (message.type === 'result') finishResolve(message)
      else if (message.type === 'error') finishReject(extensionError(message.error))
    })
    port.onDisconnect.addListener(() => {
      if (!settled) finishReject(Object.assign(new Error(t('github.error.network')), { code: 'network', source: 'github' }))
    })
    port.postMessage({ type, requestId, ...payload })

    function cleanup() {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', abort)
      try { port.disconnect() } catch { /* Already disconnected. */ }
    }
    function finishResolve(value) {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    function finishReject(error, notify = false) {
      if (settled) return
      settled = true
      if (notify) try { port.postMessage({ type: 'CANCEL', requestId }) } catch { /* Port closed. */ }
      cleanup()
      reject(error)
    }
  })
}

function abortCurrentJob() {
  state.job?.controller.abort()
}

function streamChat(messages, providerSnapshot, connectionRevisionSnapshot, onDelta) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'repolens-panel' })
    const requestId = crypto.randomUUID()
    let settled = false
    let startedRequest = false
    const controller = state.job.controller
    const timeout = setTimeout(() => {
      finishReject(
        Object.assign(new Error(t('ai.error.timeout')), { code: 'timeout' }),
        true,
      )
    }, 4 * 60 * 1000)
    const keepalive = setInterval(() => {
      try { port.postMessage({ type: 'KEEPALIVE', requestId }) } catch { /* Disconnect handler reports the failure. */ }
    }, 20_000)

    const abort = () => {
      finishReject(Object.assign(new Error(t('ai.error.cancelled')), { code: 'cancelled' }))
    }
    controller.signal.addEventListener('abort', abort, { once: true })

    port.onMessage.addListener(async (message) => {
      if (message.requestId !== requestId) return
      if (message.type === 'authorized' && !startedRequest) {
        startedRequest = true
        try {
          const { [CONNECTION_STORAGE_KEY]: connection } = await chrome.storage.session.get(CONNECTION_STORAGE_KEY) as any
          if (settled || controller.signal.aborted) return
          if (!connectionMatchesSnapshot(connection, providerSnapshot, connectionRevisionSnapshot)) {
            throw Object.assign(new Error(t('ai.error.providerChanged')), { code: 'provider_changed' })
          }
          const result = await requestChat({
            config: providerSnapshot,
            apiKey: connection.apiKey,
            messages,
            signal: controller.signal,
            onDelta,
          })
          finishResolve(result.text)
        } catch (error) {
          finishReject(error)
        }
      }
      if (message.type === 'error') {
        const error = Object.assign(new Error(friendlyAiError(message.error)), message.error)
        finishReject(error)
      }
    })
    port.onDisconnect.addListener(() => {
      if (!settled && !controller.signal.aborted) {
        finishReject(
          Object.assign(new Error(t('ai.error.disconnected')), { code: 'network' }),
          true,
        )
      }
    })
    port.postMessage({
      type: 'START_JOB',
      requestId,
      provider: providerSnapshot,
      connectionRevision: connectionRevisionSnapshot,
    })

    function cleanup() {
      clearTimeout(timeout)
      clearInterval(keepalive)
      controller.signal.removeEventListener('abort', abort)
      try { port.postMessage({ type: 'COMPLETE_JOB', requestId }) } catch { /* Already disconnected. */ }
      try { port.disconnect() } catch { /* Already disconnected. */ }
    }

    function finishResolve(value) {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }

    function finishReject(error, abortRequest = false) {
      if (settled) return
      settled = true
      cleanup()
      if (abortRequest && !controller.signal.aborted) controller.abort()
      reject(error)
    }
  })
}

function openReport(record, { upgradeError = null } = {}) {
  state.currentRecord = record
  const repository = record.repository
  const providerLabel = providerDisplayName(record.provider?.providerRef)
  const children = [
    el('header', { class: 'report-header' }, [
      el('p', { class: 'eyebrow' }, [record.analysisPlan?.depth === 'overview' ? t('analysis.quickStage') : t('analysis.deepStage')]),
      el('h1', { id: 'report-title', class: 'repo-name' }, [repository.fullName]),
      el('div', { class: 'meta-row' }, [
        el('span', {}, [t('report.revision', { branch: repository.defaultBranch, sha: repository.sha.slice(0, 7) })]),
        el('span', {}, [formatDate(record.updatedAt)]),
        el('span', {}, [providerLabel]),
      ]),
      el('div', { class: 'badge-row' }, [
        el('span', { class: `analysis-depth-badge ${record.analysisPlan?.depth === 'overview' ? '' : 'deep'}` }, [
          record.analysisPlan?.depth === 'overview' ? t('report.quickBadge') : t('report.deepBadge'),
        ]),
        record.derivedFromKey ? el('span', { class: 'analysis-depth-badge expanded' }, [t('report.expandedBadge')]) : null,
      ].filter(Boolean)),
    ]),
    el('nav', { class: 'report-jump-nav', 'aria-label': t('report.jumpAria') }, [
      el('a', { href: '#report-summary' }, [t('analysis.summary')]),
      el('a', { href: '#project-map' }, [t('analysis.structure')]),
      el('a', { href: '#report-details' }, [t('analysis.details')]),
      el('a', { href: '#qa-title' }, [t('analysis.questions')]),
    ]),
    el('section', { id: 'report-summary', class: 'report-summary' }, [
      el('p', { class: 'eyebrow' }, [t('report.overview')]),
      el('p', {}, [record.report.summary]),
    ]),
  ]

  if (record.analysisPlan?.depth === ANALYSIS_DEPTH.overview) {
    const maxFiles = state.analysisSettings.maxFiles
    const checkedFiles = record.bundle?.files?.length ?? 0
    children.push(el('section', { class: 'report-upgrade-card', 'aria-labelledby': 'upgrade-title' }, [
      el('p', { class: 'eyebrow' }, [t('report.goDeeper')]),
      el('h2', { id: 'upgrade-title' }, [t('report.upgradeTitle')]),
      el('p', {}, [t('report.upgradeDescription', { checked: checkedFiles, max: maxFiles })]),
      upgradeError ? el('p', { class: 'form-error', role: 'alert' }, [friendlyAnalysisError(upgradeError)]) : null,
      el('p', { class: 'path-meta' }, [t('report.upgradeMeta')]),
      actionRow(analysisConnectionReady()
        ? [button(upgradeError ? t('report.retryUpgrade') : t('repo.expandDeep'), 'primary-button', () => startAnalysis('deep', { sourceRecord: record }))]
        : [button(t('analysis.connectAi'), 'primary-button', openSettings)]),
    ].filter(Boolean)))
  }

  if (record.report.architectureGraph) {
    children.push(renderArchitectureGraph(record.report.architectureGraph))
  }

  const detailSections = el('div', { id: 'report-details' })
  let sectionIndex = 0
  for (const section of Object.values(record.report.sections)) {
    detailSections.append(renderReportSection(section, sectionIndex === 0))
    sectionIndex += 1
  }
  children.push(detailSections)
  children.push(renderQuestionArea(record))
  reportContent.replaceChildren(...children)
  showView('report')
}

function renderReportSection(section, open = false) {
  const sectionKey = section.key ?? inferLegacySectionKey(section.title)
  const titleKey = `analysis.section.${sectionKey}`
  return el('details', { class: 'report-section', open }, [
    el('summary', {}, [hasMessageKey(titleKey) ? t(titleKey) : section.title]),
    el('div', { class: 'report-section-body' }, [
      el('div', { class: 'badge-row' }, [
        el('span', { class: `badge ${section.kind}` }, [section.kind === 'fact' ? t('analysis.fact') : t('analysis.inference')]),
      ]),
      el('p', {}, [section.text]),
      renderCitations(section.citations),
    ]),
  ])
}

function inferLegacySectionKey(title) {
  const legacyTitles = {
    '해결하는 문제': 'problem',
    '누구를 위한 프로젝트인가': 'audience',
    '핵심 구조와 주요 파일': 'architecture',
    '실행·사용 방법': 'gettingStarted',
    '주의할 점': 'caveats',
    '라이선스': 'license',
  }
  return legacyTitles[title] ?? 'problem'
}

function renderArchitectureGraph(graph) {
  const labels = localizedArchitectureLabels()
  const fallback = buildArchitectureFallbackData(graph, labels)
  const sectionId = `architecture-${++architectureRenderSequence}`
  const diagram = el('div', {
    class: 'architecture-diagram',
    tabindex: '0',
    role: 'region',
    'aria-label': t('report.diagramRegionAria'),
    'aria-describedby': `${sectionId}-scroll-hint`,
  }, [el('div', { class: 'progress-line architecture-loading', role: 'status' }, [
    el('span', { class: 'spinner', 'aria-hidden': 'true' }),
    el('span', {}, [t('report.mapLoading')]),
  ])])
  const fallbackDetails = renderArchitectureFallback(fallback)
  const section = el('section', { id: 'project-map', class: 'architecture-card', 'aria-labelledby': `${sectionId}-title` }, [
    el('div', { class: 'architecture-heading' }, [
      el('div', {}, [
        el('p', { class: 'eyebrow' }, [t('report.conceptMap')]),
        el('h2', { id: `${sectionId}-title` }, [t('report.projectMap')]),
      ]),
      el('span', { class: 'badge inference' }, [t('analysis.inference')]),
    ]),
    el('p', { class: 'architecture-caption' }, [fallback.caption || t('report.mapFallbackCaption')]),
    diagram,
    el('p', { id: `${sectionId}-scroll-hint`, class: 'architecture-scroll-hint' }, [t('report.mapScrollHint')]),
    fallbackDetails,
  ])

  void renderMermaidInto(diagram, graph, fallbackDetails)
  return section
}

function renderArchitectureFallback(fallback) {
  const details = el('details', { class: 'architecture-fallback' }, [
    el('summary', {}, [t('report.mapText')]),
  ])
  const body = el('div', { class: 'architecture-fallback-body' })
  const nodeList = el('ul', { class: 'architecture-node-list' })
  for (const node of fallback.nodes) {
    nodeList.append(el('li', {}, [
      el('div', { class: 'architecture-node-title' }, [
        el('strong', {}, [node.label]),
        el('span', { class: 'badge' }, [node.kindLabel]),
      ]),
      node.description ? el('p', {}, [node.description]) : null,
      renderCitations(node.citations),
    ].filter(Boolean)))
  }
  body.append(el('h3', {}, [t('report.components')]), nodeList)

  if (fallback.relationships.length > 0) {
    const relationshipList = el('ul', { class: 'architecture-edge-list' })
    for (const relationship of fallback.relationships) {
      relationshipList.append(el('li', {}, [
        el('p', {}, [`${relationship.fromLabel} → ${relationship.relationLabel} → ${relationship.toLabel}`]),
        renderCitations(relationship.citations),
      ]))
    }
    body.append(el('h3', {}, [t('report.relationships')]), relationshipList)
  }
  details.append(body)
  return details
}

async function renderMermaidInto(container, graph, fallbackDetails) {
  try {
    const definition = buildMermaidDefinition(graph, localizedArchitectureLabels())
    if (!definition) throw new Error('Mermaid definition unavailable.')
    await ensureMermaidRenderer()
    if (!mermaidInitialized) {
      globalThis.mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        htmlLabels: false,
        flowchart: { htmlLabels: false, useMaxWidth: false, nodeSpacing: 20, rankSpacing: 32, padding: 8 },
        suppressErrorRendering: true,
        theme: 'base',
        themeVariables: buildMermaidThemeVariables(),
      })
      mermaidInitialized = true
    }
    const renderId = `repolens-architecture-${crypto.randomUUID().replaceAll('-', '')}`
    const result = await globalThis.mermaid.render(renderId, definition)
    const svg = parseSafeMermaidSvg(result.svg)
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', t('report.mapImageAria'))
    container.replaceChildren(svg)
    fallbackDetails.open = false
  } catch {
    container.replaceChildren(el('p', { class: 'architecture-render-warning', role: 'status' }, [
      t('report.mapRenderFailed'),
    ]))
    fallbackDetails.open = true
  }
}

function localizedArchitectureLabels() {
  const nodeKinds = Object.fromEntries(
    ['entry', 'ui', 'service', 'library', 'data', 'config', 'external']
      .map((kind) => [kind, t(`graph.kind.${kind}` as MessageKey)]),
  )
  const relations = Object.fromEntries(
    ['calls', 'imports', 'reads', 'writes', 'configures', 'contains', 'sends', 'returns', 'depends_on']
      .map((relation) => [relation, t(`graph.relation.${relation}` as MessageKey)]),
  )
  return { nodeKinds, relations }
}

function buildMermaidThemeVariables() {
  const styles = getComputedStyle(document.documentElement)
  const token = (name) => styles.getPropertyValue(name).trim()
  return {
    background: token('--surface'),
    primaryColor: token('--surface-brand'),
    primaryTextColor: token('--text'),
    primaryBorderColor: token('--accent'),
    secondaryColor: token('--surface'),
    secondaryTextColor: token('--text'),
    secondaryBorderColor: token('--border-strong'),
    tertiaryColor: token('--surface-subtle'),
    tertiaryTextColor: token('--muted'),
    tertiaryBorderColor: token('--border'),
    lineColor: token('--muted'),
    textColor: token('--text'),
    edgeLabelBackground: token('--surface-raised'),
    clusterBkg: token('--surface-subtle'),
    clusterBorder: token('--border-strong'),
    fontFamily: getComputedStyle(document.body).fontFamily,
    fontSize: '12px',
  }
}

function ensureMermaidRenderer() {
  if (globalThis.mermaid?.render) return Promise.resolve()
  if (mermaidLoadPromise) return mermaidLoadPromise

  mermaidLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = chrome.runtime.getURL('src/vendor/mermaid-11.16.1.min.js')
    script.onload = () => globalThis.mermaid?.render
      ? resolve()
      : reject(new Error('Mermaid renderer unavailable.'))
    script.onerror = () => reject(new Error('Mermaid renderer unavailable.'))
    document.head.append(script)
  })
  return mermaidLoadPromise
}

function parseSafeMermaidSvg(markup) {
  if (typeof markup !== 'string' || markup.length > 1_000_000) throw new Error('Unsafe Mermaid output.')
  const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml')
  if (parsed.querySelector('parsererror')) throw new Error('Invalid Mermaid SVG.')
  const root = parsed.documentElement
  if (root.localName !== 'svg' || root.namespaceURI !== MERMAID_SVG_NAMESPACE) throw new Error('Invalid Mermaid root.')

  for (const element of [root, ...root.querySelectorAll('*')]) {
    if (element.namespaceURI !== MERMAID_SVG_NAMESPACE) throw new Error('Unsafe Mermaid namespace.')
    if (element.localName === 'script' || element.localName === 'foreignObject') throw new Error('Unsafe Mermaid element.')
    if (element.localName === 'style' && containsUnsafeSvgCss(element.textContent ?? '')) {
      throw new Error('External Mermaid style resource rejected.')
    }
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      const localName = attribute.localName.toLowerCase()
      const value = attribute.value.trim()
      if (localName.startsWith('on') || name === 'xml:base') throw new Error('Unsafe Mermaid attribute.')
      if (localName === 'href') {
        if (!value.startsWith('#')) throw new Error('External Mermaid link rejected.')
      }
      if ((name === 'style' || name === 'fill' || name === 'stroke' || name === 'filter' || name === 'clip-path'
        || name === 'mask' || name === 'marker-start' || name === 'marker-mid' || name === 'marker-end')
        && containsUnsafeSvgUrl(value)) {
        throw new Error('External Mermaid resource rejected.')
      }
    }
  }

  return document.importNode(root, true)
}

function containsUnsafeSvgUrl(value) {
  const references = [...value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)]
  return references.some((match) => !match[2].trim().startsWith('#'))
}

function containsUnsafeSvgCss(value) {
  return /@import\b/i.test(value) || containsUnsafeSvgUrl(value)
}

function renderQuestionArea(record) {
  const container = el('section', { class: 'qa-area', 'aria-labelledby': 'qa-title' })
  container.append(
    el('h2', { id: 'qa-title' }, [t('question.title')]),
    el('p', { class: 'help' }, [t('question.help', {
      sha: record.repository.sha.slice(0, 7),
      model: state.provider?.model ?? 'AI',
    })]),
  )

  const list = el('div')
  for (const item of record.questions ?? []) {
    list.append(renderQuestionItem(item))
  }
  container.append(list)

  const providerMatchesRecord = state.activeProviderRef
    && state.activeProviderRef === record.provider?.providerRef

  if (!state.hasApiKey) {
    container.append(el('div', { class: 'notice warning' }, [t('question.reconnectKey')]))
    container.append(actionRow([button(t('analysis.connectAi'), 'secondary-button', openSettings)]))
    return container
  }

  if (!providerMatchesRecord) {
    container.append(el('div', { class: 'notice warning' }, [
      t('question.providerMismatch', { provider: providerDisplayName(record.provider?.providerRef) }),
    ]))
    container.append(actionRow([button(t('analysis.connectAi'), 'secondary-button', openSettings)]))
    return container
  }

  const label = el('label', { for: 'qa-input' }, [t('question.label')])
  const input = el('textarea', { id: 'qa-input', maxlength: '2000', placeholder: t('question.placeholder') })
  const status = el('p', { class: 'form-status', role: 'status', 'aria-live': 'polite' })
  const submit = button(t('question.send'), 'primary-button', () => askQuestion(input, status, submit, list))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit.click()
    }
  })
  container.append(label, input, status, actionRow([submit]))
  return container
}

function renderQuestionItem(item) {
  return el('article', { class: 'qa-item' }, [
    el('p', { class: 'qa-question' }, [`Q. ${item.question}`]),
    el('p', { class: 'qa-answer' }, [item.answer]),
    item.provider?.providerRef ? el('p', { class: 'help' }, [t('question.answerProvider', { provider: providerDisplayName(item.provider.providerRef) })]) : null,
    renderCitations(item.citations),
  ].filter(Boolean))
}

async function askQuestion(input, status, submit, list) {
  const question = input.value.trim()
  if (!question || state.job) return
  const record = state.currentRecord
  if (!record) {
    setStatus(status, t('question.reportChanged'), 'error')
    return
  }
  const providerSnapshot = { ...state.provider }
  const providerRefSnapshot = state.activeProviderRef
  const connectionRevisionSnapshot = state.connectionRevision
  state.job = { controller: new AbortController(), raw: '', provider: providerSnapshot }
  renderVaultState()
  renderGitHubState()
  input.disabled = true
  submit.disabled = true
  setStatus(status, t('question.writing'), 'info')

  try {
    const outputLocale = record.outputLocale === 'en' ? 'en' : 'ko'
    const messages = buildQuestionMessages(record.repository, record.bundle, record.report, question, { outputLocale })
    const raw = await streamChat(messages, providerSnapshot, connectionRevisionSnapshot, () => {})
    const answer = parseQuestionOutput(raw, record.repository, record.bundle.files)
    record.questions = [...(record.questions ?? []), {
      question,
      ...answer,
      provider: { providerRef: providerRefSnapshot },
      createdAt: new Date().toISOString(),
    }]
    record.updatedAt = new Date().toISOString()
    await putReport(record)
    state.job = null
    renderVaultState()
    renderGitHubState()
    input.value = ''
    const item = record.questions.at(-1)
    const rendered = renderQuestionItem(item)
    list.append(rendered)
    input.disabled = false
    submit.disabled = false
    setStatus(status, t('question.saved'), 'success')
    rendered.setAttribute('tabindex', '-1')
    rendered.focus()
    refreshPendingContext()
  } catch (error) {
    state.job = null
    renderVaultState()
    renderGitHubState()
    input.disabled = false
    submit.disabled = false
    setStatus(status, friendlyAiError(error), 'error')
    refreshPendingContext()
  }
}

function renderCitations(citations) {
  const list = el('ul', { class: 'citation-list', 'aria-label': t('report.citationsAria') })
  if (!citations?.length) {
    list.append(el('li', {}, [el('span', { class: 'unverified' }, [t('report.unverified')])]))
    return list
  }
  for (const citation of citations) {
    list.append(el('li', {}, [el('a', { href: citation.url, target: '_blank', rel: 'noreferrer' }, [citation.label])]))
  }
  return list
}

async function openHistory() {
  showView('history')
  historyContent.replaceChildren(el('p', { role: 'status' }, [t('history.loading')]))
  try {
    const records: any[] = await listReports() as any[]
    if (records.length === 0) {
      historyContent.replaceChildren(el('p', { class: 'help' }, [t('history.empty')]))
      return
    }
    historyContent.replaceChildren(...records.map((record) => el('article', { class: 'history-card' }, [
      el('h2', {}, [record.repository.fullName]),
      el('div', { class: 'meta-row' }, [
        el('span', {}, [record.repository.sha.slice(0, 7)]),
        el('span', { class: `analysis-depth-badge ${record.analysisPlan?.depth === 'deep' ? 'deep' : ''}` }, [
          record.analysisPlan?.depth === 'overview' ? t('analysis.quick') : t('analysis.deep'),
        ]),
        el('span', {}, [t('analysis.fileCount', { count: record.bundle?.files?.length ?? 0 })]),
        el('span', {}, [providerDisplayName(record.provider?.providerRef)]),
        el('span', {}, [formatDate(record.updatedAt)]),
      ]),
      el('div', { class: 'history-actions' }, [
        button(t('common.open'), 'text-button', () => openReport(record), { 'aria-label': t('history.openAria', { repo: record.repository.fullName }) }),
        record.analysisPlan?.depth === 'overview'
          ? analysisConnectionReady()
            ? button(t('history.expand'), 'text-button', () => {
              state.repository = record.repository
              startAnalysis('deep', { sourceRecord: record })
            }, { 'aria-label': t('history.expandAria', { repo: record.repository.fullName }) })
            : button(t('history.connectAi'), 'text-button', openSettings, { 'aria-label': t('history.connectAiAria', { repo: record.repository.fullName }) })
          : null,
        button(t('common.delete'), 'text-button danger', async () => {
          if (!confirm(t('history.deleteConfirm', { repo: record.repository.fullName }))) return
          await deleteReport(record.key)
          await openHistory()
        }, { 'aria-label': t('history.deleteAria', { repo: record.repository.fullName }) }),
      ].filter(Boolean)),
    ])))
  } catch (error) {
    historyContent.replaceChildren(el('p', { class: 'form-error', role: 'alert' }, [error.message]))
  }
}

async function openSettings() {
  await reconcileRemoteState({ refreshRepository: false })
  await loadAnalysisSettings()
  hydrateProviderForm(selectedPreset())
  clearProviderFeedback()
  showView('settings')
}

function t(key: MessageKey, params: Record<string, string | number> = {}) {
  return translate(state.uiPreferences.uiLocale, key, params)
}

async function loadUiPreferences() {
  const stored = await chrome.storage.local.get(UI_PREFERENCES_STORAGE_KEY)
  applyUiPreferences(normalizeUiPreferences(stored[UI_PREFERENCES_STORAGE_KEY]))
}

async function saveLanguageSettings() {
  const nextPreferences = normalizeUiPreferences({
    uiLocale: uiLocaleSelect?.value,
    aiOutputLocale: aiOutputLocaleSelect?.value,
  })
  applyUiPreferences(nextPreferences, { rerender: true })
  await chrome.storage.local.set({ [UI_PREFERENCES_STORAGE_KEY]: nextPreferences })
  if (languageSettingsStatus) setStatus(languageSettingsStatus, t('locale.saved'), 'success')
}

function applyUiPreferences(preferences: UiPreferences, { rerender = false } = {}) {
  state.uiPreferences = preferences
  document.documentElement.lang = preferences.uiLocale
  if (uiLocaleSelect) uiLocaleSelect.value = preferences.uiLocale
  if (aiOutputLocaleSelect) aiOutputLocaleSelect.value = preferences.aiOutputLocale
  localizeStaticInterface()
  hydrateAnalysisSettings(state.analysisSettings)
  if (rerender) rerenderLocalizedView()
}

function localizeStaticInterface() {
  for (const element of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    const key = element.dataset.i18n
    if (key && hasMessageKey(key)) element.textContent = t(key)
  }
  for (const attribute of ['aria-label', 'title', 'placeholder'] as const) {
    const dataName = `i18n${attribute.split('-').map((part) => `${part[0]?.toUpperCase()}${part.slice(1)}`).join('')}`
    for (const element of document.querySelectorAll<HTMLElement>(`[data-i18n-${attribute}]`)) {
      const key = element.dataset[dataName]
      if (key && hasMessageKey(key)) element.setAttribute(attribute, t(key))
    }
  }
}

function rerenderLocalizedView() {
  renderVaultState()
  renderGitHubState()
  if (state.view === 'report' && state.currentRecord) openReport(state.currentRecord)
  else if (state.view === 'history') void openHistory()
  else if (state.view === 'context' && !state.job) {
    if (state.repository) renderReady()
    else renderEmpty()
  }
}

async function loadAnalysisSettings() {
  try {
    const stored = await chrome.storage.local.get(ANALYSIS_SETTINGS_STORAGE_KEY)
    state.analysisSettings = normalizeAnalysisSettings(stored[ANALYSIS_SETTINGS_STORAGE_KEY])
  } catch {
    state.analysisSettings = normalizeAnalysisSettings()
    setStatus(analysisSettingsStatus, t('settings.analysisLoadFailed', { count: 16 }), 'warning')
  }
  hydrateAnalysisSettings(state.analysisSettings)
}

function hydrateAnalysisSettings(settings) {
  const maxFiles = settings.maxFiles
  const quickLimit = resolveEffectiveAnalysisFileLimit(createAnalysisPlan({
    depth: ANALYSIS_DEPTH.overview,
    maxFiles,
  }))
  analysisSettingsForm.elements.maxFiles.value = String(maxFiles)
  requiredQuery('#file-limit-summary').textContent = t('analysis.fileLimits', { quick: quickLimit, deep: maxFiles })
  syncAnalysisScopePreset()
}

async function refreshCurrentReportForAnalysisSettings() {
  if (state.job || !state.repository || !state.activeProviderRef) return
  const repositorySnapshot = state.repository
  const providerRefSnapshot = state.activeProviderRef
  const settingsSnapshot = { ...state.analysisSettings }
  try {
    const records = await findCurrentAnalysisRecords(repositorySnapshot, providerRefSnapshot, settingsSnapshot)
    if (state.job
      || state.repository?.sha !== repositorySnapshot.sha
      || state.activeProviderRef !== providerRefSnapshot
      || state.analysisSettings.maxFiles !== settingsSnapshot.maxFiles) return
    applyCurrentAnalysisRecords(records)
    if (state.view === 'context') renderReady()
  } catch {
    // The preference itself remains usable if IndexedDB is temporarily unavailable.
  }
}

function handleAnalysisScopeChange(event) {
  if (event.target?.name !== 'maxFilesPreset') return
  analysisSettingsForm.elements.maxFiles.value = event.target.value
  setStatus(analysisSettingsStatus, t('settings.analysisPending'), 'info')
}

function syncAnalysisScopePreset() {
  const value = analysisSettingsForm.elements.maxFiles.value
  const matchingPreset = analysisSettingsForm.querySelector(`input[name="maxFilesPreset"][value="${CSS.escape(value)}"]`)
  for (const preset of analysisSettingsForm.elements.maxFilesPreset) preset.checked = preset === matchingPreset
}

async function saveAnalysisSettings(event) {
  event.preventDefault()
  analysisSettingsError.hidden = true
  analysisSettingsError.textContent = ''
  setStatus(analysisSettingsStatus, '')
  const submit = requiredQuery('#save-analysis-settings')
  submit.disabled = true
  try {
    const maxFiles = parseAnalysisFileLimit(analysisSettingsForm.elements.maxFiles.valueAsNumber)
    const settings = { version: ANALYSIS_SETTINGS_VERSION, maxFiles }
    await chrome.storage.local.set({ [ANALYSIS_SETTINGS_STORAGE_KEY]: settings })
    state.analysisSettings = settings
    hydrateAnalysisSettings(settings)
    const quickLimit = resolveEffectiveAnalysisFileLimit(createAnalysisPlan({
      depth: ANALYSIS_DEPTH.overview,
      maxFiles,
    }))
    setStatus(analysisSettingsStatus, t('settings.analysisSaved', { quick: quickLimit, deep: maxFiles }), 'success')
  } catch (error) {
    analysisSettingsError.hidden = false
    analysisSettingsError.textContent = t('settings.analysisInvalid', {
      min: ANALYSIS_FILE_LIMIT.min,
      max: ANALYSIS_FILE_LIMIT.max,
    })
    analysisSettingsError.focus?.()
  } finally {
    submit.disabled = false
  }
}

function hydrateProviderForm(preset = selectedPreset()) {
  const provider = preset ?? (state.vaultStatus === 'missing' ? state.provider : null)
  providerForm.elements.baseUrl.value = provider?.baseUrl ?? 'https://api.openai.com/v1'
  providerForm.elements.model.value = provider?.model ?? ''
  providerForm.elements.streaming.checked = provider?.streaming !== false
  providerForm.elements.apiKey.value = ''
  providerForm.elements.apiKey.type = 'password'
  const toggle = requiredQuery('#toggle-key')
  toggle.textContent = t('common.show')
  toggle.setAttribute('aria-label', t('provider.apiKeyShowAria'))
  toggle.setAttribute('aria-pressed', 'false')
  presetName.value = preset?.name ?? ''
  const hasStoredKey = preset?.hasApiKey === true
  keyState.hidden = !hasStoredKey
  keyState.textContent = hasStoredKey ? t('provider.savedKeyHelp') : ''
  requiredQuery('#delete-preset').disabled = !preset
}

async function saveProvider(event) {
  event.preventDefault()
  await saveCurrentPreset(event)
}

async function testProvider() {
  clearProviderFeedback()
  const buttonElement = requiredQuery('#test-provider')
  buttonElement.disabled = true
  setStatus(providerStatus, t('provider.testing'), 'info')
  try {
    const payload = providerPayload()
    const permissionGranted = await requestProviderPermission(payload.baseUrl)
    if (!permissionGranted) {
      setStatus(providerStatus, t('provider.permissionRequired', {
        host: new URL(normalizeProviderConfig(payload).baseUrl).host,
      }), 'warning')
      return
    }
    const config = normalizeProviderConfig(payload)
    if (state.vaultStatus !== 'unlocked') throw Object.assign(new Error(), { code: 'vault_locked' })
    const { [CONNECTION_STORAGE_KEY]: savedConnection } = await chrome.storage.session.get(CONNECTION_STORAGE_KEY) as any
    const savedConfig = savedConnection?.provider ? normalizeProviderConfig(savedConnection.provider) : null
    const apiKey = typeof payload.apiKey === 'string' && payload.apiKey.trim()
      ? payload.apiKey.trim()
      : savedConfig?.baseUrl === config.baseUrl ? savedConnection.apiKey : ''
    if (!apiKey) throw Object.assign(new Error(), { code: 'auth' })
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 30_000)
    try {
      await requestChat({
        config: { ...config, streaming: false },
        apiKey,
        signal: controller.signal,
        messages: [
          { role: 'system', content: 'Reply with exactly: OK' },
          { role: 'user', content: 'Connection test. Do not include any other text.' },
        ],
      })
    } finally {
      clearTimeout(timeout)
    }
    setStatus(providerStatus, t('provider.testSucceeded'), 'success')
  } catch (error) {
    showProviderError(error)
  } finally {
    buttonElement.disabled = false
  }
}

async function requestProviderPermission(baseUrl, model = providerForm.elements.model.value) {
  const config = normalizeProviderConfig({ baseUrl, model, streaming: true })
  const origins = [permissionPattern(config.baseUrl)]
  if (await chrome.permissions.contains({ origins })) return true
  const host = new URL(config.baseUrl).host
  const granted = await chrome.permissions.request({ origins })
  if (!granted) throw Object.assign(new Error(), { code: 'permission', host })
  return true
}

function permissionPattern(baseUrl) {
  const url = new URL(baseUrl)
  return `${url.protocol}//${url.hostname === '[::1]' ? '[::1]' : url.hostname}/*`
}

async function clearApiKey() {
  try {
    if (state.vaultStatus === 'unlocked') {
      await lockVault()
      return
    }
    if (state.vaultStatus !== 'missing') return
    const response = await sendMessage({ type: 'CLEAR_API_KEY' })
    applyRemoteState(response)
    setStatus(providerStatus, t('provider.sessionCleared'), 'success')
  } catch (error) {
    showProviderError(error)
  }
}

async function clearAllHistory() {
  if (!confirm(t('history.clearConfirm'))) return
  await clearReports()
  state.currentRecord = null
  state.recordsByDepth = { overview: null, deep: null }
  setStatus(providerStatus, t('history.cleared'), 'success')
}

function providerPayload() {
  return {
    baseUrl: providerForm.elements.baseUrl.value,
    model: providerForm.elements.model.value,
    apiKey: providerForm.elements.apiKey.value,
    streaming: providerForm.elements.streaming.checked,
  }
}

function toggleKeyVisibility() {
  const input = providerForm.elements.apiKey
  const showing = input.type === 'text'
  input.type = showing ? 'password' : 'text'
  const buttonElement = requiredQuery('#toggle-key')
  buttonElement.textContent = showing ? t('common.show') : t('common.hide')
  buttonElement.setAttribute('aria-label', showing ? t('provider.apiKeyShowAria') : t('provider.apiKeyHideAria'))
  buttonElement.setAttribute('aria-pressed', String(!showing))
}

function renderContextError(error, retryAction = null, retryLabel = t('common.retry')) {
  const message = ['rate_limit', 'secondary_rate_limit'].includes(error?.code) && error.retryAt
    ? t('error.retryAfter', { message: friendlyGeneralError(error), date: formatDate(error.retryAt) })
    : friendlyGeneralError(error)
  const children = [
    el('h2', { id: 'context-title', tabindex: '-1' }, [error?.code === 'cancelled' ? t('error.cancelledHeading') : t('error.heading')]),
    el('p', {}, [message]),
  ]
  const actions = []
  if (retryAction && error?.code !== 'cancelled') {
    actions.push(button(retryLabel, 'secondary-button', retryAction))
  }
  if (githubConnectionRecoveryAvailable(error, state)) {
    actions.push(button(t('github.recover'), 'primary-button', recoverWithGitHubConnection))
  }
  if (actions.length > 0) children.push(actionRow(actions))
  contextContent.replaceChildren(el('div', { class: 'error-card', role: 'alert' }, children))
  contextContent.querySelector('h2')?.focus()
}

async function recoverWithGitHubConnection() {
  await openSettings()
  const connectionSection = requiredQuery('#github-connection')
  connectionSection?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  connectionSection?.focus?.()

  if (state.vaultStatus !== 'unlocked' || state.githubAuth.connected || state.job) return
  if (state.githubFlow) {
    renderGitHubState()
    scheduleGitHubPoll(state.githubFlow.retryAfterMs)
    await openGitHubDevicePage()
    return
  }
  if (state.githubOAuthAvailable) {
    await connectGitHub()
    return
  }

  const patSettings = connectionSection?.querySelector('.pat-settings')
  if (patSettings) patSettings.open = true
  requiredQuery('#github-pat')?.focus?.()
  setStatus(githubStatus, t('github.patAvailable'), 'info')
}

function showProviderError(error) {
  setStatus(providerStatus, '')
  providerError.hidden = false
  providerError.textContent = friendlyAiError(error)
  providerError.focus?.()
}

function clearProviderFeedback() {
  providerError.hidden = true
  providerError.textContent = ''
  setStatus(providerStatus, '')
}

function friendlyAiError(error) {
  const code = error?.code
  const keyByCode: Partial<Record<string, MessageKey>> = {
    auth: 'ai.error.auth',
    not_found: 'ai.error.notFound',
    rate_limit: 'ai.error.rateLimit',
    network: 'ai.error.network',
    parse: 'ai.error.parse',
    provider_changed: 'ai.error.providerChanged',
    timeout: 'ai.error.timeout',
    cancelled: 'ai.error.cancelled',
    vault_locked: 'ai.error.vaultLocked',
    vault_required: 'ai.error.vaultRequired',
    permission: 'ai.error.permission',
  }
  return t(keyByCode[code] ?? 'ai.error.generic', { host: error?.host ?? '' })
}

function friendlyAnalysisError(error) {
  if (error?.source !== 'github') return friendlyAiError(error)
  if (['rate_limit', 'secondary_rate_limit'].includes(error.code) && error.retryAt) {
    return t('error.retryAfter', { message: friendlyGeneralError(error), date: formatDate(error.retryAt) })
  }
  return friendlyGeneralError(error)
}

function analysisConnectionReady() {
  return state.vaultStatus === 'unlocked'
    && Boolean(state.provider && state.hasApiKey && state.activeProviderRef)
}

function friendlyVaultError(error) {
  const code = error?.code
  if (code === 'password_policy') return t('vault.error.passwordPolicy')
  if (code === 'password_mismatch') return t('vault.error.passwordMismatch')
  if (code === 'unlock_failed' || code === 'invalid_password' || code === 'crypto_failed') return t('vault.error.unlockFailed')
  if (code === 'vault_locked') return t('vault.error.locked')
  if (code === 'busy') return t('vault.error.busy')
  if (code === 'auth') return t('vault.error.apiKeyRequired')
  if (code === 'not_found') return t('vault.error.notFound')
  if (code === 'conflict') return t('vault.error.conflict')
  return t('vault.error.generic')
}

function providerDisplayName(providerRef) {
  const preset = state.presets.find((candidate) => candidate.providerRef === providerRef)
  return preset?.name ?? (providerRef ? t('provider.savedFallback') : t('provider.unknownFallback'))
}

function friendlyGeneralError(error) {
  const code = error?.code
  const githubKeyByCode: Partial<Record<string, MessageKey>> = {
    private: 'github.error.private',
    not_found: 'github.error.notFound',
    empty: 'github.error.empty',
    cancelled: 'github.error.cancelled',
    parse: 'github.error.parse',
    network: 'github.error.network',
    permission: 'github.error.permission',
    rate_limit: 'github.error.rateLimit',
    secondary_rate_limit: 'github.error.secondaryRateLimit',
    github_auth_expired: 'github.error.authExpired',
    github_auth_changed: 'github.error.authChanged',
    repository_changed: 'github.error.repositoryChanged',
    github: 'github.error.api',
  }
  if (error?.source === 'github' || error?.name === 'GitHubError') {
    return t(githubKeyByCode[code] ?? 'github.error.generic', { status: error?.status ?? '' })
  }
  if (code === 'parse') return t('ai.error.parse')
  return t('common.unknownError')
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response?.ok) throw extensionError(response?.error)
  return response
}

function extensionError(value) {
  const error = Object.assign(new Error(value?.message ?? t('error.extensionRequest')), value)
  if (value?.name === 'GitHubError') error.name = 'GitHubError'
  return error
}

function showView(name) {
  state.view = name
  for (const view of views as HTMLElement[]) view.hidden = view.id !== `${name}-view`
  const activeNavigation = name === 'history' ? historyButton : name === 'settings' ? settingsButton : homeButton
  for (const control of [homeButton, historyButton, settingsButton]) {
    if (control === activeNavigation) control.setAttribute('aria-current', 'page')
    else control.removeAttribute('aria-current')
  }
  requiredQuery(`#${name}-view`)?.focus?.()
}

function refreshPendingContext() {
  if (!state.pendingContextRefresh) return
  if (state.view !== 'context') return
  state.pendingContextRefresh = false
  refreshContext()
}

function focusSettingsTarget(targetId) {
  const target = document.getElementById(targetId)
  target?.scrollIntoView?.({ block: 'start', behavior: 'smooth' })
  target?.focus?.()
}

function setStatus(element, message = '', tone = 'info') {
  const normalizedTone = ['info', 'success', 'warning', 'error'].includes(tone) ? tone : 'info'
  element.dataset.tone = message ? normalizedTone : ''
  element.setAttribute('role', normalizedTone === 'error' ? 'alert' : 'status')
  element.setAttribute('aria-live', normalizedTone === 'error' ? 'assertive' : 'polite')
  element.textContent = message
}

function showToast(message) {
  toast.textContent = message
  toast.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => { toast.hidden = true }, 3_000)
}

function actionRow(children) {
  return el('div', { class: 'button-row' }, children)
}

function button(label, className, handler, attributes = {}) {
  const element = el('button', { type: 'button', class: className, ...attributes }, [label])
  element.addEventListener('click', handler)
  return element
}

function el(tag: string, attributes: Record<string, any> = {}, children: any[] = []): any {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) element.setAttribute(name, '')
    else if (value !== false && value != null) element.setAttribute(name, String(value))
  }
  for (const child of children) element.append(child instanceof Node ? child : document.createTextNode(String(child)))
  return element
}

function formatNumber(value) {
  const locale = state.uiPreferences.uiLocale === 'en' ? 'en-US' : 'ko-KR'
  return new Intl.NumberFormat(locale, { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value)
}

function formatDate(value) {
  const locale = state.uiPreferences.uiLocale === 'en' ? 'en-US' : 'ko-KR'
  try { return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) } catch { return value }
}
