import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const sidepanelSource = readFileSync(
  fileURLToPath(new URL('../src/sidepanel.js', import.meta.url)),
  'utf8',
)
const sidepanelHtml = readFileSync(
  fileURLToPath(new URL('../sidepanel.html', import.meta.url)),
  'utf8',
)
const sidepanelCss = readFileSync(
  fileURLToPath(new URL('../src/sidepanel.css', import.meta.url)),
  'utf8',
)

function sourceBetween(startMarker, endMarker) {
  const start = sidepanelSource.indexOf(startMarker)
  const end = sidepanelSource.indexOf(endMarker, start + startMarker.length)
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`)
  assert.notEqual(end, -1, `missing source marker: ${endMarker}`)
  return sidepanelSource.slice(start, end)
}

test('selecting a provider preset only hydrates the editor', () => {
  const source = sourceBetween('function selectPreset()', 'async function deleteCurrentPreset')

  assert.match(source, /state\.selectedPresetId\s*=/)
  assert.match(source, /hydrateProviderForm\(selectedPreset\(\)\)/)
  assert.doesNotMatch(source, /requestProviderPermission\s*\(/)
  assert.doesNotMatch(source, /VAULT_ACTIVATE_PRESET/)
  assert.doesNotMatch(source, /sendMessage\s*\(/)
})

test('preserving the current view defers context refresh before clearing its record', () => {
  const source = sourceBetween('async function refreshContext', 'function renderEmpty')
  const preserveBranch = source.match(/if \(preserveView\) \{([\s\S]*?)\n\s*\}/)?.[1] ?? ''
  const preserveIndex = source.indexOf('if (preserveView)')
  const recordResetIndex = source.indexOf('state.currentRecord = null')

  assert.notEqual(preserveIndex, -1)
  assert.notEqual(recordResetIndex, -1)
  assert.ok(preserveIndex < recordResetIndex, 'preserveView must be handled before currentRecord is reset')
  assert.match(preserveBranch, /state\.pendingContextRefresh\s*=\s*true/)
  assert.match(preserveBranch, /\breturn\b/)
  assert.doesNotMatch(preserveBranch, /state\.currentRecord\s*=/)
})

test('status messages retain their tone and live-region accessibility contract', () => {
  const source = sourceBetween('function setStatus', 'function showToast')

  for (const tone of ['info', 'success', 'warning', 'error']) {
    assert.match(source, new RegExp(`['"]${tone}['"]`))
    assert.match(sidepanelCss, new RegExp(`\\.form-status\\[data-tone=["']${tone}["']\\]`))
  }
  assert.match(source, /element\.dataset\.tone\s*=/)
  assert.match(source, /setAttribute\(['"]role['"],\s*normalizedTone === ['"]error['"] \? ['"]alert['"] : ['"]status['"]\)/)
  assert.match(source, /setAttribute\(['"]aria-live['"],\s*normalizedTone === ['"]error['"] \? ['"]assertive['"] : ['"]polite['"]\)/)

  for (const id of ['vault-status', 'provider-status', 'github-status']) {
    const tag = sidepanelHtml.match(new RegExp(`<[^>]+id=["']${id}["'][^>]*>`))?.[0] ?? ''
    assert.match(tag, /role=["']status["']/)
    assert.match(tag, /aria-live=["']polite["']/)
  }
})

test('the current view marks exactly one corresponding navigation control', () => {
  const source = sourceBetween('function showView', 'function refreshPendingContext')

  assert.match(
    source,
    /const activeNavigation = name === ['"]history['"] \? historyButton : name === ['"]settings['"] \? settingsButton : homeButton/,
  )
  assert.match(source, /for \(const control of \[homeButton, historyButton, settingsButton\]\)/)
  assert.match(
    source,
    /if \(control === activeNavigation\) control\.setAttribute\(['"]aria-current['"], ['"]page['"]\)/,
  )
  assert.match(source, /else control\.removeAttribute\(['"]aria-current['"]\)/)
  assert.equal(source.match(/setAttribute\(['"]aria-current['"], ['"]page['"]\)/g)?.length, 1)
  assert.equal(source.match(/removeAttribute\(['"]aria-current['"]\)/g)?.length, 1)
})

test('API key visibility starts hidden and stays synchronized with its toggle', () => {
  const apiKeyTag = sidepanelHtml.match(/<input\b[^>]*\bid=["']api-key["'][^>]*>/)?.[0] ?? ''
  const toggleTag = sidepanelHtml.match(/<button\b[^>]*\bid=["']toggle-key["'][^>]*>/)?.[0] ?? ''
  const clearSource = sourceBetween('function clearSecretInputs', 'function selectedPreset')
  const hydrateSource = sourceBetween('function hydrateProviderForm', 'async function saveProvider')
  const toggleSource = sourceBetween('function toggleKeyVisibility', 'function renderContextError')

  assert.match(apiKeyTag, /type=["']password["']/)
  assert.match(toggleTag, /aria-label=["']API 키 표시["']/)
  assert.match(toggleTag, /aria-pressed=["']false["']/)

  for (const source of [clearSource, hydrateSource]) {
    assert.match(source, /providerForm\.elements\.apiKey\.type\s*=\s*['"]password['"]/)
    assert.match(source, /toggle\.setAttribute\(['"]aria-label['"], ['"]API 키 표시['"]\)/)
    assert.match(source, /toggle\.setAttribute\(['"]aria-pressed['"], ['"]false['"]\)/)
  }

  assert.match(toggleSource, /const showing = input\.type === ['"]text['"]/)
  assert.match(toggleSource, /input\.type = showing \? ['"]password['"] : ['"]text['"]/)
  assert.match(
    toggleSource,
    /buttonElement\.setAttribute\(['"]aria-label['"], showing \? ['"]API 키 표시['"] : ['"]API 키 숨기기['"]\)/,
  )
  assert.match(toggleSource, /buttonElement\.setAttribute\(['"]aria-pressed['"], String\(!showing\)\)/)
})

test('history actions identify their repository and confirm before deletion', () => {
  const source = sourceBetween('async function openHistory', 'async function openSettings')
  const confirmationIndex = source.indexOf('confirm(`${record.repository.fullName} 분석 기록을 삭제할까요?`)')
  const deletionIndex = source.indexOf('deleteReport(record.key)')

  assert.match(
    source,
    /button\(['"]열기['"][\s\S]*?['"]aria-label['"]:\s*`\$\{record\.repository\.fullName\} 분석 열기`/,
  )
  assert.match(
    source,
    /button\(['"]삭제['"][\s\S]*?['"]aria-label['"]:\s*`\$\{record\.repository\.fullName\} 분석 삭제`/,
  )
  assert.notEqual(confirmationIndex, -1)
  assert.notEqual(deletionIndex, -1)
  assert.ok(confirmationIndex < deletionIndex, 'history deletion must be confirmed before deleting the record')
})

test('analysis scope exposes the shared default, safe range, and fixed character budget', () => {
  const input = sidepanelHtml.match(/<input\b[^>]*\bid=["']analysis-max-files["'][^>]*>/)?.[0] ?? ''
  const help = sidepanelHtml.match(/<p\b[^>]*\bid=["']analysis-max-files-help["'][^>]*>([\s\S]*?)<\/p>/)?.[1] ?? ''
  const presetValues = [...sidepanelHtml.matchAll(/<input\b[^>]*\bname=["']maxFilesPreset["'][^>]*\bvalue=["'](\d+)["'][^>]*>/g)]
    .map((match) => match[1])
  const collectSource = sourceBetween('function collectRepository', 'function resolveRepository')
  const settingsSource = sourceBetween('async function loadAnalysisSettings', 'function hydrateProviderForm')
  const storageListenerSource = sourceBetween('chrome.storage.onChanged.addListener', 'window.addEventListener')

  assert.match(input, /type=["']number["']/)
  assert.match(input, /value=["']16["']/)
  assert.match(input, /min=["']1["']/)
  assert.match(input, /max=["']32["']/)
  assert.match(input, /step=["']1["']/)
  assert.deepEqual(presetValues, ['8', '16', '24', '32'])
  assert.match(help, /48,000자/)
  assert.match(collectSource, /maxFiles:\s*analysisPlan\.maxFiles/)
  assert.match(collectSource, /depth:\s*analysisPlan\.depth/)
  assert.match(settingsSource, /chrome\.storage\.local\.get\(ANALYSIS_SETTINGS_STORAGE_KEY\)/)
  assert.match(settingsSource, /chrome\.storage\.local\.set\(\{ \[ANALYSIS_SETTINGS_STORAGE_KEY\]: settings \}\)/)
  assert.match(settingsSource, /event\.target\?\.name !== ['"]maxFilesPreset['"]/)
  assert.match(settingsSource, /analysisSettingsForm\.elements\.maxFiles\.value = event\.target\.value/)
  assert.match(storageListenerSource, /changes\[ANALYSIS_SETTINGS_STORAGE_KEY\]/)
  assert.match(storageListenerSource, /hydrateAnalysisSettings\(state\.analysisSettings\)/)
  assert.match(storageListenerSource, /refreshCurrentReportForAnalysisSettings\(\)/)
  assert.match(settingsSource, /findCurrentAnalysisRecords\(repositorySnapshot, providerRefSnapshot, settingsSnapshot\)/)
})

test('the ready view offers quick analysis and direct deep analysis as distinct paths', () => {
  const source = sourceBetween('function renderReady()', 'async function startAnalysis')

  assert.match(source, /class:\s*['"]analysis-paths['"],\s*['"]aria-label['"]:\s*['"]분석 경로 선택['"]/)
  assert.match(
    source,
    /button\(['"]빠른 분석 시작['"],\s*['"]primary-button['"],\s*\(\) => startAnalysis\(['"]overview['"]\)\)/,
  )
  assert.match(
    source,
    /button\(['"]바로 심층 분석['"],\s*['"]secondary-button['"],\s*\(\) => startAnalysis\(['"]deep['"]\)\)/,
  )
  assert.equal(source.match(/AI 요청 1회/g)?.length, 2)
  assert.doesNotMatch(source, /aria-hidden['"]:\s*['"]true['"][\s\S]*?['"]→['"]/)
})

test('quick reports can be upgraded and deep reports retain their source lineage', () => {
  const startSource = sourceBetween('async function startAnalysis', 'function collectRepository')
  const reportSource = sourceBetween('function openReport', 'function renderReportSection')

  assert.match(reportSource, /if \(record\.analysisPlan\?\.depth === ANALYSIS_DEPTH\.overview\)/)
  assert.match(
    reportSource,
    /button\(upgradeError \? ['"]다시 확장['"] : ['"]심층 분석으로 확장['"],[\s\S]*?startAnalysis\(['"]deep['"],\s*\{ sourceRecord: record \}\)\)/,
  )
  assert.match(reportSource, /기존 빠른 결과는 유지 · AI 요청 1회 추가/)
  assert.match(startSource, /\.\.\.\(sourceRecord \? \{ derivedFromKey: sourceRecord\.key \} : \{\}\)/)
})

test('cached quick and deep reports are looked up with separate analysis plans', () => {
  const source = sourceBetween('async function findCurrentAnalysisRecords', 'function resolveRepository')

  assert.match(source, /overview:\s*createAnalysisPlan\(\{ depth:\s*['"]overview['"],\s*maxFiles:/)
  assert.match(source, /deep:\s*createAnalysisPlan\(\{ depth:\s*['"]deep['"],\s*maxFiles:/)
  assert.match(
    source,
    /Promise\.all\(Object\.values\(plans\)\.map\(\(analysisPlan\) => getReport\(makeReportKey\(\{[\s\S]*?analysisPlan,[\s\S]*?\}\)\)\)\)/,
  )
  assert.match(source, /return \{ overview: overview \?\? null, deep: deep \?\? null \}/)
  assert.match(source, /function applyCurrentAnalysisRecords\(records\)/)
  assert.match(source, /state\.currentRecord = state\.recordsByDepth\.deep \?\? state\.recordsByDepth\.overview/)
})

test('a failed upgrade restores its quick source and retries from that same record', () => {
  const startSource = sourceBetween('async function startAnalysis', 'function collectRepository')
  const reportSource = sourceBetween('function openReport', 'function renderReportSection')
  const recoveryBranch = startSource.match(/if \(sourceRecord && previousRecord\) \{([\s\S]*?)\n\s*\} else \{/)?.[1] ?? ''

  assert.match(startSource, /const previousRecord = sourceRecord \?\? state\.currentRecord/)
  assert.match(recoveryBranch, /state\.currentRecord = previousRecord/)
  assert.match(recoveryBranch, /openReport\(previousRecord, \{ upgradeError: error \}\)/)
  assert.doesNotMatch(recoveryBranch, /renderContextError/)
  assert.match(
    reportSource,
    /upgradeError \? ['"]다시 확장['"] : ['"]심층 분석으로 확장['"][\s\S]*?startAnalysis\(['"]deep['"],\s*\{ sourceRecord: record \}\)/,
  )
})

test('upgrading a report always analyzes that report repository, including from history', () => {
  const source = sourceBetween('async function startAnalysis', 'function collectRepository')

  assert.match(source, /const requestedRepository = sourceRecord\?\.repository \?\? state\.repository/)
  assert.match(source, /const repositorySnapshot = \{ \.\.\.requestedRepository \}/)
  assert.match(source, /sourceRecord\?\.repository\?\.sha/)
  assert.doesNotMatch(source, /\[state\.repository\.fullName\]/)
})

test('analysis settings summarize quick and deep limits separately', () => {
  const source = sourceBetween('function hydrateAnalysisSettings', 'async function refreshCurrentReportForAnalysisSettings')
  const initialSummary = sidepanelHtml.match(/id=["']file-limit-summary["'][^>]*>([^<]+)</)?.[1] ?? ''

  assert.match(initialSummary, /빠른 최대 8개 · 심층 최대 16개/)
  assert.match(source, /resolveEffectiveAnalysisFileLimit\(createAnalysisPlan\(/)
  assert.match(source, /`빠른 최대 \$\{quickLimit\}개 · 심층 최대 \$\{maxFiles\}개`/)
})

test('stale analysis-scope lookups cannot overwrite the latest records', () => {
  const source = sourceBetween('async function refreshCurrentReportForAnalysisSettings', 'function handleAnalysisScopeChange')

  assert.match(source, /const records = await findCurrentAnalysisRecords\(repositorySnapshot, providerRefSnapshot, settingsSnapshot\)/)
  assert.match(source, /state\.analysisSettings\.maxFiles !== settingsSnapshot\.maxFiles\) return/)
  assert.ok(source.indexOf('state.analysisSettings.maxFiles !== settingsSnapshot.maxFiles) return')
    < source.indexOf('applyCurrentAnalysisRecords(records)'))
})

test('context record lookup commits only while repository, provider, settings, and token still match', () => {
  const source = sourceBetween('async function refreshContext', 'function renderEmpty')
  const lookupIndex = source.indexOf('const records = await findCurrentAnalysisRecords')
  const tokenCheckIndex = source.indexOf('if (token !== state.contextToken', lookupIndex)
  const commitIndex = source.indexOf('applyCurrentAnalysisRecords(records)', lookupIndex)

  assert.notEqual(lookupIndex, -1)
  assert.ok(lookupIndex < tokenCheckIndex && tokenCheckIndex < commitIndex)
  assert.match(source, /state\.repository\?\.sha !== repository\.sha/)
  assert.match(source, /state\.activeProviderRef !== providerRefSnapshot/)
  assert.match(source, /state\.analysisSettings\.maxFiles !== settingsSnapshot\.maxFiles/)
})

test('upgrade failures distinguish GitHub collection errors from AI errors', () => {
  const reportSource = sourceBetween('function openReport', 'function renderReportSection')
  const errorSource = sourceBetween('function friendlyAiError', 'function friendlyVaultError')

  assert.match(reportSource, /friendlyAnalysisError\(upgradeError\)/)
  assert.match(errorSource, /error\?\.source !== ['"]github['"]/) 
  assert.match(errorSource, /\['rate_limit', 'secondary_rate_limit'\]/)
  assert.match(errorSource, /friendlyGeneralError\(error\)/)
})

test('upgrade reports route to connection settings instead of silently ignoring a click', () => {
  const source = sourceBetween('function openReport', 'function renderReportSection')

  assert.match(source, /actionRow\(analysisConnectionReady\(\)/)
  assert.match(source, /button\(['"]AI 연결 설정['"], ['"]primary-button['"], openSettings\)/)
})

test('history upgrade actions also route to connection settings when AI is unavailable', () => {
  const source = sourceBetween('async function openHistory', 'async function openSettings')

  assert.match(source, /record\.analysisPlan\?\.depth === ['"]overview['"][\s\S]*?analysisConnectionReady\(\)/)
  assert.match(source, /button\(['"]AI 연결['"], ['"]text-button['"], openSettings/)
})
