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
  githubConnectionStatusMessage,
  runSingleFlight,
} from './lib/github-auth-ui.js'

const views = [...document.querySelectorAll('.view')]
const contextContent = document.querySelector('#context-content')
const reportContent = document.querySelector('#report-content')
const historyContent = document.querySelector('#history-content')
const providerForm = document.querySelector('#provider-form')
const providerError = document.querySelector('#provider-error')
const providerStatus = document.querySelector('#provider-status')
const keyState = document.querySelector('#key-state')
const toast = document.querySelector('#toast')
const vaultStatus = document.querySelector('#vault-status')
const vaultStateBadge = document.querySelector('#vault-state-badge')
const vaultLoadingState = document.querySelector('#vault-loading-state')
const vaultEmptyState = document.querySelector('#vault-empty-state')
const vaultLockedState = document.querySelector('#vault-locked-state')
const vaultUnlockedState = document.querySelector('#vault-unlocked-state')
const vaultSetupForm = document.querySelector('#vault-setup-form')
const vaultUnlockForm = document.querySelector('#vault-unlock-form')
const presetSelect = document.querySelector('#preset-select')
const presetName = document.querySelector('#preset-name')
const presetError = document.querySelector('#preset-error')
const clearKeyButton = document.querySelector('#clear-key')
const githubStateBadge = document.querySelector('#github-state-badge')
const githubStatus = document.querySelector('#github-status')
const githubError = document.querySelector('#github-error')
const githubDisconnectedState = document.querySelector('#github-disconnected-state')
const githubConnectedState = document.querySelector('#github-connected-state')
const githubDeviceFlow = document.querySelector('#github-device-flow')
const githubPatForm = document.querySelector('#github-pat-form')
const vaultOverviewState = document.querySelector('#vault-overview-state')
const githubOverviewState = document.querySelector('#github-overview-state')
const providerOverviewState = document.querySelector('#provider-overview-state')
const providerStateBadge = document.querySelector('#provider-state-badge')
const githubConnectHint = document.querySelector('#github-connect-hint')
const analysisSettingsForm = document.querySelector('#analysis-settings-form')
const analysisSettingsError = document.querySelector('#analysis-settings-error')
const analysisSettingsStatus = document.querySelector('#analysis-settings-status')
const homeButton = document.querySelector('#home-button')
const historyButton = document.querySelector('#history-button')
const settingsButton = document.querySelector('#settings-button')

const MERMAID_SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
let mermaidInitialized = false
let mermaidLoadPromise = null
let architectureRenderSequence = 0

const state = {
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
}

homeButton.addEventListener('click', () => state.job ? showView('context') : refreshContext())
historyButton.addEventListener('click', openHistory)
settingsButton.addEventListener('click', openSettings)
document.querySelector('#toggle-key').addEventListener('click', toggleKeyVisibility)
document.querySelector('#test-provider').addEventListener('click', testProvider)
clearKeyButton.addEventListener('click', clearApiKey)
document.querySelector('#clear-history').addEventListener('click', clearAllHistory)
providerForm.addEventListener('submit', saveProvider)
vaultSetupForm.addEventListener('submit', createVault)
vaultUnlockForm.addEventListener('submit', unlockVault)
document.querySelector('#lock-vault').addEventListener('click', lockVault)
document.querySelector('#reset-vault').addEventListener('click', resetVault)
document.querySelector('#delete-preset').addEventListener('click', deleteCurrentPreset)
presetSelect.addEventListener('change', selectPreset)
for (const overviewButton of document.querySelectorAll('[data-settings-target]')) {
  overviewButton.addEventListener('click', () => focusSettingsTarget(overviewButton.dataset.settingsTarget))
}
document.querySelector('#connect-github').addEventListener('click', connectGitHub)
document.querySelector('#copy-github-code').addEventListener('click', copyGitHubCode)
document.querySelector('#open-github-device').addEventListener('click', openGitHubDevicePage)
document.querySelector('#cancel-github-flow').addEventListener('click', cancelGitHubFlow)
document.querySelector('#disconnect-github').addEventListener('click', disconnectGitHub)
githubPatForm.addEventListener('submit', saveGitHubPat)
analysisSettingsForm.addEventListener('submit', saveAnalysisSettings)
analysisSettingsForm.addEventListener('change', handleAnalysisScopeChange)
analysisSettingsForm.elements.maxFiles.addEventListener('input', syncAnalysisScopePreset)

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
  scheduleRemoteStateReconcile()
})
window.addEventListener('focus', scheduleRemoteStateReconcile)

await initialize()

async function initialize() {
  await loadAnalysisSettings()
  let response = await sendMessage({ type: 'GET_STATE' })
  applyRemoteState(response)
  if (response.unlocked && response.migrationPending) {
    try {
      response = await completePendingMigration(response)
      applyRemoteState(response)
    } catch (error) {
      showVaultStatus(`기존 분석 기록을 아직 이전하지 못했습니다. ${error.message}`, 'error')
    }
  }
  await refreshContext()
  if (state.githubFlow) scheduleGitHubPoll(state.githubFlow.retryAfterMs)
}

function applyRemoteState(response, { selectedPresetId, hydrateProvider = true } = {}) {
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
  clearTimeout(scheduleRemoteStateReconcile.timer)
  scheduleRemoteStateReconcile.timer = setTimeout(reconcileRemoteState, 100)
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
  if (removed > 0) showToast(`연결 정보를 안전하게 지울 수 없는 기존 기록 ${removed}개를 삭제했습니다.`)
  return response
}

function renderVaultState() {
  const status = state.vaultStatus
  const busy = state.job !== null
  const focusedElement = document.activeElement
  const focusedState = focusedElement?.closest?.('.vault-state')
  vaultLoadingState.hidden = status !== 'loading'
  vaultEmptyState.hidden = status !== 'missing'
  vaultUnlockedState.hidden = status !== 'unlocked'
  vaultLockedState.hidden = status !== 'locked' && status !== 'corrupt'
  vaultUnlockForm.hidden = status === 'corrupt'
  for (const control of vaultUnlockForm.elements) control.disabled = status !== 'locked'
  vaultStateBadge.textContent = status === 'unlocked'
    ? '잠금 해제됨'
    : status === 'locked' ? '잠김' : status === 'corrupt' ? '손상됨' : status === 'missing' ? '설정 필요' : '확인 중'
  vaultStateBadge.dataset.tone = status === 'unlocked' ? 'success' : status === 'corrupt' ? 'danger' : 'neutral'
  vaultOverviewState.textContent = status === 'unlocked'
    ? '열림' : status === 'locked' ? '잠김' : status === 'missing' ? '설정 필요' : status === 'corrupt' ? '확인 필요' : '확인 중'

  presetSelect.replaceChildren(el('option', { value: '' }, ['새 프리셋']))
  for (const preset of state.presets) {
    const suffix = preset.id === state.activePresetId ? ' · 사용 중' : ''
    presetSelect.append(el('option', { value: preset.id }, [`${preset.name}${suffix}`]))
  }
  presetSelect.value = state.selectedPresetId ?? ''
  document.querySelector('#delete-preset').disabled = busy || !state.selectedPresetId

  const editorEnabled = status === 'unlocked' && !busy
  for (const control of providerForm.elements) control.disabled = !editorEnabled
  presetSelect.disabled = !editorEnabled
  presetName.disabled = !editorEnabled
  document.querySelector('#lock-vault').disabled = !editorEnabled
  clearKeyButton.hidden = status !== 'unlocked'
  clearKeyButton.textContent = '프리셋 저장소 잠그기'
  if (!editorEnabled) clearSecretInputs()

  if (focusedState?.hidden || (vaultUnlockForm.hidden && vaultUnlockForm.contains(focusedElement))) {
    document.querySelector('#provider-vault')?.focus?.()
  }

  if (status === 'unlocked') {
    showVaultStatus(state.migrationPending ? '기존 분석 기록의 연결 정보를 안전하게 이전하는 중입니다.' : '')
  } else if (status === 'corrupt') {
    showVaultStatus('암호화 프리셋 저장소가 손상되었거나 지원하지 않는 형식입니다. 잠금 해제할 수 없으므로 초기화가 필요합니다.', 'error')
  } else if (status === 'locked') {
    showVaultStatus('프리셋 이름과 연결 정보는 잠금을 해제한 뒤에만 표시됩니다.')
  } else if (status === 'missing') {
    showVaultStatus('먼저 마스터 비밀번호로 암호화 프리셋 저장소를 만드세요.')
  }
}

function clearSecretInputs() {
  providerForm.elements.apiKey.value = ''
  providerForm.elements.apiKey.type = 'password'
  const toggle = document.querySelector('#toggle-key')
  toggle.textContent = '표시'
  toggle.setAttribute('aria-label', 'API 키 표시')
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
  githubStateBadge.textContent = connected ? '연결됨' : unlocked ? '연결 안 됨' : '볼트 잠김'
  githubStateBadge.dataset.tone = connected ? 'success' : 'neutral'
  githubOverviewState.textContent = connected ? `@${state.githubAuth.login}` : unlocked ? '선택 사항' : '대기 중'
  document.querySelector('#github-account').textContent = connected ? `@${state.githubAuth.login}` : ''
  document.querySelector('#github-auth-method').textContent = connected
    ? `${state.githubAuth.method === 'oauth' ? 'GitHub 자동 연결' : '개인 액세스 토큰'} · 암호화 저장됨`
    : ''
  const connectButton = document.querySelector('#connect-github')
  connectButton.textContent = !unlocked
    ? '먼저 볼트 잠금 해제'
    : state.githubFlow ? 'GitHub 승인 기다리는 중'
      : busy ? '분석이 끝난 뒤 연결' : 'GitHub 자동 연결'
  connectButton.disabled = !unlocked || busy || !state.githubOAuthAvailable || Boolean(state.githubFlow)
  document.querySelector('#github-oauth-actions').hidden = !state.githubOAuthAvailable
  document.querySelector('#github-oauth-unavailable').hidden = state.githubOAuthAvailable
  for (const control of githubPatForm.elements) control.disabled = !unlocked || busy
  document.querySelector('#disconnect-github').disabled = !unlocked || busy
  githubDeviceFlow.hidden = !state.githubFlow || connected
  document.querySelector('#github-user-code').textContent = state.githubFlow?.userCode ?? ''
  if (!githubError.hidden) setStatus(githubStatus, '')
  else {
    const githubTone = connected ? 'success' : state.githubReconnectRequired ? 'warning' : 'info'
    setStatus(githubStatus, githubConnectionStatusMessage(state), githubTone)
  }
  githubConnectHint.textContent = githubConnectButtonHint({ unlocked, busy, connected })

  const providerConnected = unlocked && Boolean(state.provider && state.hasApiKey && state.activeProviderRef)
  providerStateBadge.textContent = providerConnected ? '사용 중' : unlocked ? '설정 필요' : '볼트 잠김'
  providerStateBadge.dataset.tone = providerConnected ? 'success' : 'neutral'
  providerOverviewState.textContent = providerConnected
    ? (activePreset()?.name ?? state.provider?.model ?? '연결됨')
    : unlocked ? '설정 필요' : '대기 중'
}

function githubConnectButtonHint({ unlocked, busy, connected }) {
  if (connected) return ''
  if (!unlocked) return '먼저 1단계에서 암호화 보관함의 잠금을 해제하세요.'
  if (busy) return '분석이 끝나면 GitHub 연결을 변경할 수 있습니다.'
  if (!state.githubOAuthAvailable) return '자동 연결을 사용할 수 없어 아래 고급 설정에서 PAT를 사용할 수 있습니다.'
  if (state.githubFlow) return '승인 코드를 발급했습니다. 아래 승인 페이지 열기를 이용하세요.'
  return '한 번 승인하면 다음부터 보관함 잠금 해제와 함께 자동으로 연결됩니다.'
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
  const buttonElement = document.querySelector('#connect-github')
  buttonElement.disabled = true
  setStatus(githubStatus, 'GitHub 승인 코드를 만드는 중…', 'info')
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
        showToast('GitHub가 연결되었습니다.')
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
    setStatus(githubStatus, 'GitHub 연결을 취소했습니다.', 'info')
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
    showToast('GitHub 승인 코드를 복사했습니다.')
  } catch {
    showGitHubError(new Error('승인 코드를 복사하지 못했습니다. 코드를 직접 선택해 복사해 주세요.'))
  }
}

async function saveGitHubPat(event) {
  event.preventDefault()
  clearGitHubError()
  const submit = document.querySelector('#save-github-pat')
  submit.disabled = true
  setStatus(githubStatus, 'GitHub 토큰을 확인하고 암호화하는 중…', 'info')
  try {
    const response = await sendMessage({
      type: 'GITHUB_AUTH_SAVE_PAT',
      payload: { token: githubPatForm.elements.token.value },
    })
    githubPatForm.reset()
    clearGitHubPollTimer()
    state.githubFlow = null
    applyRemoteState(response)
    showToast('GitHub가 연결되었습니다.')
    if (state.repository) await refreshContext()
  } catch (error) {
    showGitHubError(error)
  } finally {
    submit.disabled = state.vaultStatus !== 'unlocked' || state.job !== null
  }
}

async function disconnectGitHub() {
  if (!confirm('이 브라우저에서 GitHub 연결 정보를 삭제할까요? GitHub 계정의 앱 승인은 별도로 철회해야 합니다.')) return
  clearGitHubError()
  try {
    const response = await sendMessage({ type: 'GITHUB_AUTH_DISCONNECT' })
    state.githubFlow = null
    applyRemoteState(response)
    showToast('GitHub 연결 정보를 삭제했습니다.')
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
  if (error?.code === 'oauth_unconfigured') return '이 빌드에는 GitHub OAuth Client ID가 없습니다. 개인 액세스 토큰을 사용하거나 빌드 설정에 Client ID를 추가해 주세요.'
  if (error?.code === 'invalid_token') return 'GitHub 토큰이 올바르지 않거나 사용할 수 없습니다.'
  if (error?.code === 'unexpected_scope') return '추가 권한이 부여된 토큰은 MVP에서 허용하지 않습니다. 공개 읽기 전용 토큰을 사용해 주세요.'
  if (error?.code === 'expired') return '승인 코드가 만료되었습니다. 자동 연결을 다시 시작해 주세요.'
  if (error?.code === 'access_denied') return 'GitHub에서 연결 승인이 취소되었습니다.'
  if (error?.code === 'vault_locked') return '먼저 암호화 프리셋 저장소의 잠금을 해제해 주세요.'
  return error?.message ?? 'GitHub 연결에 실패했습니다.'
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
  const errorElement = document.querySelector('#vault-setup-error')
  clearVaultFormError(errorElement)
  const password = vaultSetupForm.elements.password.value
  const confirmation = vaultSetupForm.elements.passwordConfirm.value
  if (password !== confirmation) {
    showVaultFormError(errorElement, new Error('마스터 비밀번호 확인이 일치하지 않습니다.'))
    return
  }

  const submit = document.querySelector('#create-vault')
  submit.disabled = true
  showVaultStatus('기존 연결과 분석 기록을 확인한 뒤 암호화하는 중…')
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
      } catch (migrationError) {
        showVaultStatus(`저장소는 만들었지만 기존 분석 기록을 아직 이전하지 못했습니다. ${migrationError.message}`, 'error')
        vaultSetupForm.reset()
        showToast('AI 프리셋 저장소를 만들었습니다.')
        return
      }
    }
    vaultSetupForm.reset()
    showVaultStatus('암호화 프리셋 저장소를 만들었습니다.', 'success')
    showToast('AI 프리셋 저장소를 만들었습니다.')
  } catch (error) {
    showVaultFormError(errorElement, error)
    showVaultStatus('암호화 프리셋 저장소를 만들지 못했습니다.', 'error')
  } finally {
    submit.disabled = false
  }
}

async function unlockVault(event) {
  event.preventDefault()
  const errorElement = document.querySelector('#vault-unlock-error')
  clearVaultFormError(errorElement)
  const passwordInput = vaultUnlockForm.elements.password
  const submit = document.querySelector('#unlock-vault')
  submit.disabled = true
  showVaultStatus('프리셋 저장소의 잠금을 해제하는 중…')
  try {
    let response = await sendMessage({ type: 'VAULT_UNLOCK', payload: { password: passwordInput.value } })
    applyRemoteState(response)
    passwordInput.value = ''
    if (response.migrationPending) {
      try {
        response = await completePendingMigration(response)
        applyRemoteState(response)
      } catch (migrationError) {
        showVaultStatus(`잠금은 해제했지만 기존 분석 기록을 아직 이전하지 못했습니다. ${migrationError.message}`, 'error')
        showToast('AI 프리셋 저장소의 잠금을 해제했습니다.')
        return
      }
    }
    showVaultStatus('저장된 프리셋을 불러왔습니다.', 'success')
    showToast('AI 프리셋 저장소의 잠금을 해제했습니다.')
  } catch (error) {
    passwordInput.value = ''
    showVaultFormError(errorElement, error)
    showVaultStatus('잠금을 해제하지 못했습니다.', 'error')
  } finally {
    submit.disabled = false
  }
}

async function lockVault() {
  if (state.job) {
    showVaultStatus('AI 작업이 끝난 뒤 프리셋 저장소를 잠글 수 있습니다.', 'warning')
    return
  }
  try {
    const response = await sendMessage({ type: 'VAULT_LOCK' })
    clearGitHubPollTimer()
    state.githubFlow = null
    applyRemoteState(response, { selectedPresetId: null })
    showToast('AI 프리셋 저장소를 잠갔습니다.')
    if (state.repository) renderReady()
  } catch (error) {
    showVaultStatus(friendlyVaultError(error), 'error')
  }
}

async function resetVault() {
  if (!confirm('암호화된 프리셋, 저장된 API 키, GitHub 연결, 분석 기록을 모두 삭제할까요? 이 작업은 되돌릴 수 없습니다.')) return
  try {
    const response = await sendMessage({ type: 'VAULT_RESET' })
    clearGitHubPollTimer()
    state.githubFlow = null
    await clearReports()
    applyRemoteState(response, { selectedPresetId: null })
    state.currentRecord = null
    state.recordsByDepth = { overview: null, deep: null }
    vaultUnlockForm.reset()
    showToast('AI 프리셋과 분석 기록을 초기화했습니다.')
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
  const saveButton = document.querySelector('#apply-provider')
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
    setStatus(providerStatus, '프리셋을 암호화해 저장하고 현재 AI 연결로 사용합니다.', 'success')
    showToast('AI 연결 프리셋을 저장했습니다.')
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
  document.querySelector('#delete-preset').disabled = !state.selectedPresetId
  if (state.selectedPresetId === state.activePresetId) {
    setStatus(providerStatus, '현재 사용 중인 프리셋입니다. 편집 후 저장하면 변경 사항을 적용합니다.', 'info')
  } else if (state.selectedPresetId) {
    setStatus(providerStatus, '프리셋을 편집기에 불러왔습니다. 활성 연결은 아직 바뀌지 않았습니다.', 'info')
  } else {
    setStatus(providerStatus, '새 프리셋 정보를 입력해 주세요.', 'info')
  }
}

async function deleteCurrentPreset() {
  const preset = selectedPreset()
  if (!preset || !confirm(`“${preset.name}” 프리셋과 저장된 API 키를 삭제할까요?`)) return
  const deleteButton = document.querySelector('#delete-preset')
  deleteButton.disabled = true
  try {
    const response = await sendMessage({ type: 'VAULT_DELETE_PRESET', payload: { presetId: preset.id } })
    applyRemoteState(response, { selectedPresetId: response.activePresetId })
    showToast('AI 연결 프리셋을 삭제했습니다.')
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
  renderLoading('현재 GitHub 페이지를 확인하는 중…')

  try {
    const { tab } = await sendMessage({ type: 'GET_ACTIVE_TAB' })
    if (token !== state.contextToken) return
    state.tab = tab
    const parsed = parseGitHubRepoUrl(tab?.url ?? '')
    if (!parsed) {
      renderEmpty()
      return
    }

    renderLoading('공개 저장소 정보를 확인하는 중…')
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
    renderContextError(error, refreshContext, '다시 확인')
  } finally {
    if (state.contextController === contextController) state.contextController = null
  }
}

function renderEmpty() {
  contextContent.replaceChildren(el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-icon lens-empty-icon', 'aria-hidden': 'true' }),
    el('p', { class: 'eyebrow' }, ['GitHub를 자유롭게 둘러보세요']),
    el('h1', { id: 'context-title' }, ['관심 있는 저장소에서\nRepoLens를 열어보세요']),
    el('p', {}, ['Explore·Trending·검색 중에는 AI가 동작하지 않습니다. 공개 저장소에 들어온 뒤 요청할 때만 분석을 시작합니다.']),
    el('div', { class: 'empty-steps', 'aria-label': '사용 방법' }, [
      el('span', {}, ['1', el('small', {}, ['저장소 발견'])]),
      el('span', {}, ['2', el('small', {}, ['파일 수집'])]),
      el('span', {}, ['3', el('small', {}, ['AI 분석'])]),
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
  const host = state.provider ? new URL(state.provider.baseUrl).host : '설정한 AI 서버'
  const overviewRecord = state.recordsByDepth.overview
  const deepRecord = state.recordsByDepth.deep
  const overviewPlan = createAnalysisPlan({ depth: ANALYSIS_DEPTH.overview, maxFiles: state.analysisSettings.maxFiles })
  const quickLimit = resolveEffectiveAnalysisFileLimit(overviewPlan)
  const children = [
    el('div', { class: 'repo-kicker' }, [
      el('p', { class: 'eyebrow' }, ['공개 저장소']),
      el('span', { class: 'status-badge success' }, ['확인됨']),
    ]),
    el('h1', { id: 'context-title', class: 'repo-name' }, [repository.fullName]),
    el('p', { class: 'repo-description' }, [repository.description || 'GitHub 설명이 없습니다.']),
    el('div', { class: 'meta-row' }, [
      el('span', {}, [`★ ${formatNumber(repository.stars)}`]),
      repository.language ? el('span', {}, [repository.language]) : null,
      repository.licenseSpdx ? el('span', {}, [repository.licenseSpdx]) : null,
      el('span', {}, [`${repository.defaultBranch} · ${repository.sha.slice(0, 7)}`]),
    ].filter(Boolean)),
    el('p', { class: 'context-intro' }, ['저장소를 이해하는 가장 빠른 방법']),
  ]

  if (deepRecord || overviewRecord) {
    const preferredRecord = deepRecord ?? overviewRecord
    children.push(
      el('div', { class: 'notice' }, [deepRecord
        ? '이 커밋의 2단계 심층 분석이 브라우저에 저장되어 있습니다.'
        : '1단계 빠른 분석이 저장되어 있습니다. 결과를 보거나 관계 파일까지 확장할 수 있습니다.']),
      actionRow([
        button(deepRecord ? '심층 결과 보기' : '빠른 결과 보기', 'primary-button', () => openReport(preferredRecord)),
        overviewRecord && !deepRecord
          ? button('심층 분석으로 확장', 'secondary-button', () => startAnalysis('deep', { sourceRecord: overviewRecord }))
          : button('다시 심층 분석', 'secondary-button', () => startAnalysis('deep')),
      ]),
    )
  } else if (state.vaultStatus !== 'unlocked' || !state.provider || !state.hasApiKey || !state.activeProviderRef) {
    children.push(
      el('div', { class: 'notice' }, [
        state.vaultStatus === 'locked'
          ? 'AI 프리셋 저장소의 잠금을 해제하고 분석에 사용할 프리셋을 선택해 주세요.'
          : '분석에 사용할 OpenAI 호환 AI를 암호화 프리셋으로 연결해 주세요.',
      ]),
      actionRow([button('AI 연결 설정', 'primary-button', openSettings)]),
    )
  } else {
    children.push(
      el('section', { class: 'analysis-paths', 'aria-label': '분석 경로 선택' }, [
        el('article', { class: 'analysis-path-card recommended' }, [
          el('span', { class: 'path-stage' }, ['1단계 · 빠른 분석']),
          el('h2', {}, ['먼저 핵심만 파악']),
          el('p', {}, ['README·설정·진입점 등 핵심 파일로 목적과 구조를 빠르게 설명합니다.']),
          el('p', { class: 'path-meta' }, [`최대 ${quickLimit}개 파일 · AI 요청 1회`]),
          button('빠른 분석 시작', 'primary-button', () => startAnalysis('overview')),
        ]),
        el('article', { class: 'analysis-path-card deep' }, [
          el('span', { class: 'path-stage' }, ['1→2단계 · 심층 분석']),
          el('h2', {}, ['연결된 코드까지 바로 탐색']),
          el('p', {}, ['핵심 파일을 고른 뒤 import·workspace·설정 관계를 따라 범위를 확장합니다.']),
          el('div', { class: 'path-flow', 'aria-label': '핵심 선정 후 관계 확장' }, [
            el('span', {}, ['핵심 선정']), el('span', {}, ['관계 확장']),
          ]),
          el('p', { class: 'path-meta' }, [`최대 ${state.analysisSettings.maxFiles}개 파일 · AI 요청 1회`]),
          button('바로 심층 분석', 'secondary-button', () => startAnalysis('deep')),
        ]),
      ]),
      el('div', { class: 'notice privacy-notice' }, [
        `선택한 공개 코드만 ${host}로 전송됩니다. 코드는 실행하지 않으며 API 비용은 사용자의 제공자 계정에 청구됩니다.`,
      ]),
    )
  }

  contextContent.replaceChildren(el('div', { class: 'hero' }, children))
}

async function startAnalysis(depth = ANALYSIS_DEPTH.deep, { sourceRecord = null } = {}) {
  const requestedRepository = sourceRecord?.repository ?? state.repository
  if (!requestedRepository || !state.provider || !state.activeProviderRef || state.job) return
  const analysisPlan = createAnalysisPlan({ depth, maxFiles: state.analysisSettings.maxFiles })
  const controller = new AbortController()
  const providerSnapshot = { ...state.provider }
  const providerRefSnapshot = state.activeProviderRef
  const connectionRevisionSnapshot = state.connectionRevision
  const repositorySnapshot = { ...requestedRepository }
  const analysisSettingsSnapshot = { ...state.analysisSettings }
  const previousRecord = sourceRecord ?? state.currentRecord
  state.job = { controller, raw: '', provider: providerSnapshot, analysisPlan }
  renderVaultState()
  renderGitHubState()
  let progressText
  let streamPreview

  contextContent.replaceChildren(el('div', { class: 'progress-card' }, [
    el('p', { class: 'eyebrow' }, [depth === 'overview' ? '1단계 · 빠른 분석' : '2단계 · 심층 분석']),
    el('h1', { id: 'context-title' }, [repositorySnapshot.fullName]),
    el('div', { class: 'analysis-progress-steps', 'aria-hidden': 'true' }, [
      el('span', { class: 'active' }, ['저장소 확인']),
      el('span', {}, [depth === 'overview' ? '핵심 파일 선정' : '1단계 핵심 선정']),
      ...(depth === 'deep' ? [el('span', {}, ['2단계 관계 확장'])] : []),
      el('span', {}, ['AI 설명']),
      el('span', {}, ['근거 확인']),
    ]),
    el('div', { class: 'progress-line', role: 'status', 'aria-live': 'polite' }, [
      el('span', { class: 'spinner', 'aria-hidden': 'true' }),
      progressText = el('strong', {}, ['저장소 구조를 읽는 중…']),
    ]),
    el('details', { class: 'stream-details' }, [
      el('summary', {}, ['생성 중인 내용 보기']),
      streamPreview = el('pre', { class: 'stream-preview', hidden: true }),
    ]),
    actionRow([button('분석 중지', 'secondary-button', abortCurrentJob)]),
  ]))
  showView('context')

  try {
    const collected = await collectRepository(
      repositorySnapshot,
      controller.signal,
      (_stage, message) => { progressText.textContent = message },
      analysisSettingsSnapshot,
      analysisPlan,
      sourceRecord?.repository?.sha,
    )
    const analyzedRepository = collected.repository
    const bundle = collected.bundle
    state.repository = analyzedRepository
    state.bundle = bundle
    progressText.textContent = `${bundle.files.length}개 파일을 AI 서버로 보내는 중…`

    const messages = buildAnalysisMessages(analyzedRepository, bundle)
    const raw = await streamChat(messages, providerSnapshot, connectionRevisionSnapshot, (delta) => {
      state.job.raw += delta
      streamPreview.hidden = false
      streamPreview.textContent = state.job.raw.slice(-8_000)
      progressText.textContent = 'AI가 설명을 작성하는 중…'
    })
    progressText.textContent = '근거 링크를 확인하는 중…'
    const report = parseAnalysisOutput(raw, analyzedRepository, bundle.files)
    const record = {
      key: makeReportKey({
        repository: analyzedRepository,
        providerRef: providerRefSnapshot,
        promptVersion: PROMPT_VERSION,
        analysisPlan,
      }),
      repository: analyzedRepository,
      provider: { providerRef: providerRefSnapshot },
      analysisSettings: analysisSettingsSnapshot,
      analysisPlan,
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
      renderContextError(error, () => startAnalysis(depth), '다시 시도')
    }
    refreshPendingContext()
  }
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
  }, signal, onProgress, 90_000).then((result) => ({
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
  }))))
  return { overview: overview ?? null, deep: deep ?? null }
}

function applyCurrentAnalysisRecords(records) {
  state.recordsByDepth = records
  state.currentRecord = state.recordsByDepth.deep ?? state.recordsByDepth.overview
}

function resolveRepository(repository, signal) {
  return githubPortRequest('RESOLVE_REPOSITORY', { repository }, signal, null, 30_000)
    .then((result) => result.repository)
}

function githubPortRequest(type, payload, signal, onProgress, timeoutMs) {
  return new Promise((resolve, reject) => {
    const port = chrome.runtime.connect({ name: 'repolens-github' })
    const requestId = crypto.randomUUID()
    let settled = false
    const timeout = setTimeout(() => finishReject(Object.assign(
      new Error('GitHub 요청 시간이 초과되었습니다.'),
      { code: 'timeout', source: 'github' },
    ), true), timeoutMs)
    const abort = () => finishReject(Object.assign(
      new Error('GitHub 요청을 중지했습니다.'),
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
      if (!settled) finishReject(Object.assign(new Error('GitHub 연결이 종료되었습니다.'), { code: 'network', source: 'github' }))
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
        Object.assign(new Error('AI 서버가 제한 시간 안에 응답을 완료하지 못했습니다.'), { code: 'timeout' }),
        true,
      )
    }, 4 * 60 * 1000)
    const keepalive = setInterval(() => {
      try { port.postMessage({ type: 'KEEPALIVE', requestId }) } catch { /* Disconnect handler reports the failure. */ }
    }, 20_000)

    const abort = () => {
      finishReject(Object.assign(new Error('분석을 중지했습니다. 이미 사용된 API 비용은 취소되지 않을 수 있습니다.'), { code: 'cancelled' }))
    }
    controller.signal.addEventListener('abort', abort, { once: true })

    port.onMessage.addListener(async (message) => {
      if (message.requestId !== requestId) return
      if (message.type === 'authorized' && !startedRequest) {
        startedRequest = true
        try {
          const { [CONNECTION_STORAGE_KEY]: connection } = await chrome.storage.session.get(CONNECTION_STORAGE_KEY)
          if (settled || controller.signal.aborted) return
          if (!connectionMatchesSnapshot(connection, providerSnapshot, connectionRevisionSnapshot)) {
            throw Object.assign(new Error('AI 연결 자격 증명이 작업 중 변경되었습니다.'), { code: 'provider_changed' })
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
          Object.assign(new Error('응답이 끝나기 전에 AI 연결이 끊겼습니다. 임시 결과는 저장하지 않았습니다.'), { code: 'network' }),
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
      el('p', { class: 'eyebrow' }, [record.analysisPlan?.depth === 'overview' ? '1단계 · 빠른 분석' : '2단계 · 심층 분석']),
      el('h1', { id: 'report-title', class: 'repo-name' }, [repository.fullName]),
      el('div', { class: 'meta-row' }, [
        el('span', {}, [`${repository.defaultBranch} · ${repository.sha.slice(0, 7)} 기준`]),
        el('span', {}, [formatDate(record.updatedAt)]),
        el('span', {}, [providerLabel]),
      ]),
      el('div', { class: 'badge-row' }, [
        el('span', { class: `analysis-depth-badge ${record.analysisPlan?.depth === 'overview' ? '' : 'deep'}` }, [
          record.analysisPlan?.depth === 'overview' ? '빠른 분석 · 1단계' : '심층 분석 · 2단계',
        ]),
        record.derivedFromKey ? el('span', { class: 'analysis-depth-badge expanded' }, ['빠른 분석에서 확장']) : null,
      ].filter(Boolean)),
    ]),
    el('nav', { class: 'report-jump-nav', 'aria-label': '분석 결과 바로가기' }, [
      el('a', { href: '#report-summary' }, ['요약']),
      el('a', { href: '#project-map' }, ['구조']),
      el('a', { href: '#report-details' }, ['상세']),
      el('a', { href: '#qa-title' }, ['질문']),
    ]),
    el('section', { id: 'report-summary', class: 'report-summary' }, [
      el('p', { class: 'eyebrow' }, ['한눈에 보기']),
      el('p', {}, [record.report.summary]),
    ]),
  ]

  if (record.analysisPlan?.depth === ANALYSIS_DEPTH.overview) {
    const maxFiles = state.analysisSettings.maxFiles
    const checkedFiles = record.bundle?.files?.length ?? 0
    children.push(el('section', { class: 'report-upgrade-card', 'aria-labelledby': 'upgrade-title' }, [
      el('p', { class: 'eyebrow' }, ['더 깊이 살펴보기']),
      el('h2', { id: 'upgrade-title' }, ['연결된 파일까지 따라가 볼까요?']),
      el('p', {}, [`빠른 분석은 핵심 ${checkedFiles}개 파일을 확인했습니다. 내부 참조를 따라 최대 ${maxFiles}개까지 구조와 데이터 흐름을 보강합니다.`]),
      upgradeError ? el('p', { class: 'form-error', role: 'alert' }, [friendlyAnalysisError(upgradeError)]) : null,
      el('p', { class: 'path-meta' }, ['기존 빠른 결과는 유지 · AI 요청 1회 추가']),
      actionRow(analysisConnectionReady()
        ? [button(upgradeError ? '다시 확장' : '심층 분석으로 확장', 'primary-button', () => startAnalysis('deep', { sourceRecord: record }))]
        : [button('AI 연결 설정', 'primary-button', openSettings)]),
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
  return el('details', { class: 'report-section', open }, [
    el('summary', {}, [section.title]),
    el('div', { class: 'report-section-body' }, [
      el('div', { class: 'badge-row' }, [
        el('span', { class: `badge ${section.kind}` }, [section.kind === 'fact' ? '확인된 내용' : 'AI 해석']),
      ]),
      el('p', {}, [section.text]),
      renderCitations(section.citations),
    ]),
  ])
}

function renderArchitectureGraph(graph) {
  const fallback = buildArchitectureFallbackData(graph)
  const sectionId = `architecture-${++architectureRenderSequence}`
  const diagram = el('div', {
    class: 'architecture-diagram',
    tabindex: '0',
    role: 'region',
    'aria-label': '프로젝트 구조도 탐색 영역',
    'aria-describedby': `${sectionId}-scroll-hint`,
  }, [el('div', { class: 'progress-line architecture-loading', role: 'status' }, [
    el('span', { class: 'spinner', 'aria-hidden': 'true' }),
    el('span', {}, ['구조도를 그리는 중…']),
  ])])
  const fallbackDetails = renderArchitectureFallback(fallback)
  const section = el('section', { id: 'project-map', class: 'architecture-card', 'aria-labelledby': `${sectionId}-title` }, [
    el('div', { class: 'architecture-heading' }, [
      el('div', {}, [
        el('p', { class: 'eyebrow' }, ['개념 구조도']),
        el('h2', { id: `${sectionId}-title` }, ['프로젝트 구조']),
      ]),
      el('span', { class: 'badge inference' }, ['AI 해석']),
    ]),
    el('p', { class: 'architecture-caption' }, [fallback.caption || '선택된 파일을 바탕으로 구성한 개념 구조입니다.']),
    diagram,
    el('p', { id: `${sectionId}-scroll-hint`, class: 'architecture-scroll-hint' }, ['좌우로 스크롤해 구조를 살펴보세요.']),
    fallbackDetails,
  ])

  void renderMermaidInto(diagram, graph, fallbackDetails)
  return section
}

function renderArchitectureFallback(fallback) {
  const details = el('details', { class: 'architecture-fallback' }, [
    el('summary', {}, ['구조를 텍스트로 보기']),
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
  body.append(el('h3', {}, ['구성 요소']), nodeList)

  if (fallback.relationships.length > 0) {
    const relationshipList = el('ul', { class: 'architecture-edge-list' })
    for (const relationship of fallback.relationships) {
      relationshipList.append(el('li', {}, [
        el('p', {}, [`${relationship.fromLabel} → ${relationship.relationLabel} → ${relationship.toLabel}`]),
        renderCitations(relationship.citations),
      ]))
    }
    body.append(el('h3', {}, ['관계']), relationshipList)
  }
  details.append(body)
  return details
}

async function renderMermaidInto(container, graph, fallbackDetails) {
  try {
    const definition = buildMermaidDefinition(graph)
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
    svg.setAttribute('aria-label', '선택된 대표 파일을 바탕으로 만든 프로젝트 개념 구조도')
    container.replaceChildren(svg)
    fallbackDetails.open = false
  } catch {
    container.replaceChildren(el('p', { class: 'architecture-render-warning', role: 'status' }, [
      '구조도를 표시하지 못해 아래 텍스트 구조를 제공합니다.',
    ]))
    fallbackDetails.open = true
  }
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
    el('h2', { id: 'qa-title' }, ['이 저장소에 관해 질문하기']),
    el('p', { class: 'help' }, [`이 대화는 ${record.repository.sha.slice(0, 7)} 기준이며 현재 연결된 ${state.provider?.model ?? 'AI'} 모델을 사용합니다. Enter 전송 · Shift+Enter 줄바꿈`]),
  )

  const list = el('div')
  for (const item of record.questions ?? []) {
    list.append(renderQuestionItem(item))
  }
  container.append(list)

  const providerMatchesRecord = state.activeProviderRef
    && state.activeProviderRef === record.provider?.providerRef

  if (!state.hasApiKey) {
    container.append(el('div', { class: 'notice warning' }, ['후속 질문을 보내려면 세션 API 키를 다시 연결해 주세요.']))
    container.append(actionRow([button('AI 연결 설정', 'secondary-button', openSettings)]))
    return container
  }

  if (!providerMatchesRecord) {
    container.append(el('div', { class: 'notice warning' }, [
      `이 분석은 ${providerDisplayName(record.provider?.providerRef)}으로 작성되었습니다. 후속 질문도 같은 AI 연결을 사용하려면 해당 프리셋을 선택해 주세요.`,
    ]))
    container.append(actionRow([button('AI 연결 설정', 'secondary-button', openSettings)]))
    return container
  }

  const label = el('label', { for: 'qa-input' }, ['질문'])
  const input = el('textarea', { id: 'qa-input', maxlength: '2000', placeholder: '예: 어디부터 코드를 읽으면 좋나요?' })
  const status = el('p', { class: 'form-status', role: 'status', 'aria-live': 'polite' })
  const submit = button('질문 보내기', 'primary-button', () => askQuestion(input, status, submit, list))
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
    item.provider?.providerRef ? el('p', { class: 'help' }, [`답변 연결 · ${providerDisplayName(item.provider.providerRef)}`]) : null,
    renderCitations(item.citations),
  ].filter(Boolean))
}

async function askQuestion(input, status, submit, list) {
  const question = input.value.trim()
  if (!question || state.job) return
  const record = state.currentRecord
  if (!record) {
    setStatus(status, '보고서 연결이 변경되었습니다. 분석 기록에서 보고서를 다시 열어 주세요.', 'error')
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
  setStatus(status, '답변을 작성하는 중…', 'info')

  try {
    const messages = buildQuestionMessages(record.repository, record.bundle, record.report, question)
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
    setStatus(status, '답변을 저장했습니다.', 'success')
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
  const list = el('ul', { class: 'citation-list', 'aria-label': '근거 파일' })
  if (!citations?.length) {
    list.append(el('li', {}, [el('span', { class: 'unverified' }, ['근거를 확인하지 못함'])]))
    return list
  }
  for (const citation of citations) {
    list.append(el('li', {}, [el('a', { href: citation.url, target: '_blank', rel: 'noreferrer' }, [citation.label])]))
  }
  return list
}

async function openHistory() {
  showView('history')
  historyContent.replaceChildren(el('p', { role: 'status' }, ['기록을 불러오는 중…']))
  try {
    const records = await listReports()
    if (records.length === 0) {
      historyContent.replaceChildren(el('p', { class: 'help' }, ['아직 저장된 분석이 없습니다.']))
      return
    }
    historyContent.replaceChildren(...records.map((record) => el('article', { class: 'history-card' }, [
      el('h2', {}, [record.repository.fullName]),
      el('div', { class: 'meta-row' }, [
        el('span', {}, [record.repository.sha.slice(0, 7)]),
        el('span', { class: `analysis-depth-badge ${record.analysisPlan?.depth === 'deep' ? 'deep' : ''}` }, [
          record.analysisPlan?.depth === 'overview' ? '빠른 분석' : '심층 분석',
        ]),
        el('span', {}, [`${record.bundle?.files?.length ?? 0}개 파일`]),
        el('span', {}, [providerDisplayName(record.provider?.providerRef)]),
        el('span', {}, [formatDate(record.updatedAt)]),
      ]),
      el('div', { class: 'history-actions' }, [
        button('열기', 'text-button', () => openReport(record), { 'aria-label': `${record.repository.fullName} 분석 열기` }),
        record.analysisPlan?.depth === 'overview'
          ? analysisConnectionReady()
            ? button('심층으로 확장', 'text-button', () => {
              state.repository = record.repository
              startAnalysis('deep', { sourceRecord: record })
            }, { 'aria-label': `${record.repository.fullName} 심층 분석으로 확장` })
            : button('AI 연결', 'text-button', openSettings, { 'aria-label': `${record.repository.fullName} 심층 분석을 위한 AI 연결 설정` })
          : null,
        button('삭제', 'text-button danger', async () => {
          if (!confirm(`${record.repository.fullName} 분석 기록을 삭제할까요?`)) return
          await deleteReport(record.key)
          await openHistory()
        }, { 'aria-label': `${record.repository.fullName} 분석 삭제` }),
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

async function loadAnalysisSettings() {
  try {
    const stored = await chrome.storage.local.get(ANALYSIS_SETTINGS_STORAGE_KEY)
    state.analysisSettings = normalizeAnalysisSettings(stored[ANALYSIS_SETTINGS_STORAGE_KEY])
  } catch {
    state.analysisSettings = normalizeAnalysisSettings()
    setStatus(analysisSettingsStatus, '저장된 분석 범위를 읽지 못해 기본값 16개를 사용합니다.', 'warning')
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
  document.querySelector('#file-limit-summary').textContent = `빠른 최대 ${quickLimit}개 · 심층 최대 ${maxFiles}개`
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
  setStatus(analysisSettingsStatus, `${event.target.closest('.scope-option')?.querySelector('small')?.textContent ?? '선택한'} 범위를 저장하면 다음 분석부터 적용됩니다.`, 'info')
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
  const submit = document.querySelector('#save-analysis-settings')
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
    setStatus(analysisSettingsStatus, `다음 분석부터 빠른 최대 ${quickLimit}개·심층 최대 ${maxFiles}개를 선정합니다.`, 'success')
  } catch (error) {
    analysisSettingsError.hidden = false
    analysisSettingsError.textContent = error?.message ?? `선택 파일 수는 ${ANALYSIS_FILE_LIMIT.min}~${ANALYSIS_FILE_LIMIT.max} 사이로 입력해 주세요.`
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
  const toggle = document.querySelector('#toggle-key')
  toggle.textContent = '표시'
  toggle.setAttribute('aria-label', 'API 키 표시')
  toggle.setAttribute('aria-pressed', 'false')
  presetName.value = preset?.name ?? ''
  const hasStoredKey = preset?.hasApiKey === true
  keyState.hidden = !hasStoredKey
  keyState.textContent = hasStoredKey ? '이 프리셋에 암호화된 API 키가 있습니다. 빈칸으로 저장하면 기존 키를 유지합니다.' : ''
  document.querySelector('#delete-preset').disabled = !preset
}

async function saveProvider(event) {
  event.preventDefault()
  await saveCurrentPreset(event)
}

async function testProvider() {
  clearProviderFeedback()
  const buttonElement = document.querySelector('#test-provider')
  buttonElement.disabled = true
  setStatus(providerStatus, '작은 테스트 요청을 보내는 중…', 'info')
  try {
    const payload = providerPayload()
    const permissionGranted = await requestProviderPermission(payload.baseUrl)
    if (!permissionGranted) {
      setStatus(providerStatus, `${new URL(normalizeProviderConfig(payload).baseUrl).host}에 요청을 보내려면 Chrome 네트워크 권한이 필요합니다. 같은 버튼을 다시 눌러 허용해 주세요.`, 'warning')
      return
    }
    const config = normalizeProviderConfig(payload)
    if (state.vaultStatus !== 'unlocked') throw Object.assign(new Error('프리셋 저장소의 잠금을 먼저 해제해 주세요.'), { code: 'vault_locked' })
    const { [CONNECTION_STORAGE_KEY]: savedConnection } = await chrome.storage.session.get(CONNECTION_STORAGE_KEY)
    const savedConfig = savedConnection?.provider ? normalizeProviderConfig(savedConnection.provider) : null
    const apiKey = typeof payload.apiKey === 'string' && payload.apiKey.trim()
      ? payload.apiKey.trim()
      : savedConfig?.baseUrl === config.baseUrl ? savedConnection.apiKey : ''
    if (!apiKey) throw Object.assign(new Error('AI 서버 주소가 바뀌면 테스트할 새 API 키를 입력해야 합니다.'), { code: 'auth' })
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
    setStatus(providerStatus, '연결에 성공했습니다. 설정을 적용하려면 저장 버튼을 눌러 주세요.', 'success')
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
  if (!granted) throw Object.assign(new Error(`${new URL(config.baseUrl).host} 네트워크 권한이 거부되었습니다.`), { code: 'permission' })
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
    setStatus(providerStatus, '세션 API 키를 지웠습니다. 저장된 분석 결과는 유지됩니다.', 'success')
  } catch (error) {
    showProviderError(error)
  }
}

async function clearAllHistory() {
  if (!confirm('이 브라우저의 분석 결과와 질문 기록을 모두 삭제할까요? API 키에는 영향을 주지 않습니다.')) return
  await clearReports()
  state.currentRecord = null
  state.recordsByDepth = { overview: null, deep: null }
  setStatus(providerStatus, '모든 분석 기록을 삭제했습니다.', 'success')
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
  const buttonElement = document.querySelector('#toggle-key')
  buttonElement.textContent = showing ? '표시' : '숨기기'
  buttonElement.setAttribute('aria-label', showing ? 'API 키 표시' : 'API 키 숨기기')
  buttonElement.setAttribute('aria-pressed', String(!showing))
}

function renderContextError(error, retryAction = null, retryLabel = '다시 시도') {
  const message = ['rate_limit', 'secondary_rate_limit'].includes(error?.code) && error.retryAt
    ? `${error.message} ${formatDate(error.retryAt)} 이후 다시 시도해 주세요.`
    : friendlyGeneralError(error)
  const children = [
    el('h2', { id: 'context-title', tabindex: '-1' }, [error?.code === 'cancelled' ? '분석을 중지했습니다' : '진행하지 못했습니다']),
    el('p', {}, [message]),
  ]
  const actions = []
  if (retryAction && error?.code !== 'cancelled') {
    actions.push(button(retryLabel, 'secondary-button', retryAction))
  }
  if (githubConnectionRecoveryAvailable(error, state)) {
    actions.push(button('GitHub 연결로 계속', 'primary-button', recoverWithGitHubConnection))
  }
  if (actions.length > 0) children.push(actionRow(actions))
  contextContent.replaceChildren(el('div', { class: 'error-card', role: 'alert' }, children))
  contextContent.querySelector('h2')?.focus()
}

async function recoverWithGitHubConnection() {
  await openSettings()
  const connectionSection = document.querySelector('#github-connection')
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
  document.querySelector('#github-pat')?.focus?.()
  setStatus(githubStatus, '이 빌드에서는 개인 액세스 토큰으로 연결할 수 있습니다.', 'info')
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
  if (code === 'auth') return 'API 키 또는 제공자 권한을 확인해 주세요.'
  if (code === 'not_found') return 'API 기준 URL과 Model ID를 확인해 주세요.'
  if (code === 'rate_limit') return 'AI 제공자의 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.'
  if (code === 'network') return 'AI 서버에 연결할 수 없습니다. 주소와 네트워크 상태를 확인해 주세요.'
  if (code === 'parse') return 'AI 응답을 분석 결과로 변환하지 못했습니다.'
  if (code === 'provider_changed') return 'AI 연결 설정이 작업 중 변경되었습니다. 저장소 파일은 전송되지 않았으니 다시 시작해 주세요.'
  if (code === 'timeout') return 'AI 서버가 제한 시간 안에 응답을 완료하지 못했습니다. 다시 시도해 주세요.'
  if (code === 'cancelled') return '요청을 중지했습니다. 이미 사용된 API 비용은 취소되지 않을 수 있습니다.'
  if (code === 'vault_locked') return 'AI 프리셋 저장소의 잠금을 먼저 해제해 주세요.'
  if (code === 'vault_required') return '연결 정보를 암호화 프리셋으로 저장해 주세요.'
  return typeof error?.message === 'string' ? error.message : 'AI 요청에 실패했습니다.'
}

function friendlyAnalysisError(error) {
  if (error?.source !== 'github') return friendlyAiError(error)
  if (['rate_limit', 'secondary_rate_limit'].includes(error.code) && error.retryAt) {
    return `${error.message} ${formatDate(error.retryAt)} 이후 다시 시도해 주세요.`
  }
  return friendlyGeneralError(error)
}

function analysisConnectionReady() {
  return state.vaultStatus === 'unlocked'
    && Boolean(state.provider && state.hasApiKey && state.activeProviderRef)
}

function friendlyVaultError(error) {
  const code = error?.code
  if (code === 'password_policy') return error.message || '마스터 비밀번호는 12자 이상 입력해 주세요.'
  if (code === 'unlock_failed' || code === 'invalid_password' || code === 'crypto_failed') {
    return '비밀번호가 맞지 않거나 저장된 암호문을 확인할 수 없습니다.'
  }
  if (code === 'vault_locked') return '프리셋 저장소의 잠금을 먼저 해제해 주세요.'
  if (code === 'busy') return 'AI 작업이 끝난 뒤 다시 시도해 주세요.'
  if (code === 'auth') return '새 프리셋에는 API 키가 필요합니다.'
  return typeof error?.message === 'string' ? error.message : '암호화 프리셋 작업에 실패했습니다.'
}

function providerDisplayName(providerRef) {
  const preset = state.presets.find((candidate) => candidate.providerRef === providerRef)
  return preset?.name ?? (providerRef ? '저장된 AI 프리셋' : '알 수 없는 AI 연결')
}

function friendlyGeneralError(error) {
  if (error?.code === 'private') return 'MVP는 공개 저장소만 분석합니다.'
  if (error?.code === 'not_found') return '공개 저장소를 찾지 못했습니다.'
  if (error?.code === 'empty') return error.message
  if (error?.code === 'cancelled') return error.message
  if (error?.code === 'parse' && error?.name !== 'GitHubError') return 'AI 응답을 분석 결과로 변환하지 못했습니다.'
  return error?.message ?? '알 수 없는 오류가 발생했습니다.'
}

async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response?.ok) throw extensionError(response?.error)
  return response
}

function extensionError(value) {
  const error = Object.assign(new Error(value?.message ?? '확장 프로그램 요청에 실패했습니다.'), value)
  if (value?.name === 'GitHubError') error.name = 'GitHubError'
  return error
}

function showView(name) {
  state.view = name
  for (const view of views) view.hidden = view.id !== `${name}-view`
  const activeNavigation = name === 'history' ? historyButton : name === 'settings' ? settingsButton : homeButton
  for (const control of [homeButton, historyButton, settingsButton]) {
    if (control === activeNavigation) control.setAttribute('aria-current', 'page')
    else control.removeAttribute('aria-current')
  }
  document.querySelector(`#${name}-view`)?.focus?.()
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
  clearTimeout(showToast.timer)
  showToast.timer = setTimeout(() => { toast.hidden = true }, 3_000)
}

function actionRow(children) {
  return el('div', { class: 'button-row' }, children)
}

function button(label, className, handler, attributes = {}) {
  const element = el('button', { type: 'button', class: className, ...attributes }, [label])
  element.addEventListener('click', handler)
  return element
}

function el(tag, attributes = {}, children = []) {
  const element = document.createElement(tag)
  for (const [name, value] of Object.entries(attributes)) {
    if (value === true) element.setAttribute(name, '')
    else if (value !== false && value != null) element.setAttribute(name, String(value))
  }
  for (const child of children) element.append(child instanceof Node ? child : document.createTextNode(String(child)))
  return element
}

function formatNumber(value) {
  return new Intl.NumberFormat('ko-KR', { notation: value >= 10_000 ? 'compact' : 'standard' }).format(value)
}

function formatDate(value) {
  try { return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) } catch { return value }
}
