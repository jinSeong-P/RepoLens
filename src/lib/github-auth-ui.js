const GITHUB_CONNECTION_RECOVERY_CODES = new Set([
  'rate_limit',
  'secondary_rate_limit',
  'github_auth_expired',
  'github_auth_changed',
])

/**
 * Shares one promise through a mutable state slot and always releases the slot
 * after the operation settles.
 */
export function runSingleFlight(holder, key, operation) {
  if (!holder || (typeof holder !== 'object' && typeof holder !== 'function')) {
    throw new TypeError('Single-flight holder is required.')
  }
  if (typeof key !== 'string' || key.length === 0) throw new TypeError('Single-flight key is required.')
  if (typeof operation !== 'function') throw new TypeError('Single-flight operation is required.')
  if (holder[key]) return holder[key]

  const tracked = Promise.resolve()
    .then(operation)
    .finally(() => {
      if (holder[key] === tracked) holder[key] = null
    })
  holder[key] = tracked
  return tracked
}

export function githubConnectionStatusMessage(state) {
  // An active flow is the most current user action, so stale reconnect state
  // (or a transient remote-state race) must never replace its instructions.
  if (state?.githubFlow) return 'GitHub 승인을 기다리는 중…'
  if (state?.vaultStatus !== 'unlocked') {
    return 'GitHub 연결을 사용하려면 먼저 암호화 프리셋 저장소의 잠금을 해제하세요.'
  }
  if (state.githubAuth?.connected === true) {
    return 'GitHub API 요청에 이 연결을 자동으로 사용합니다.'
  }
  if (state.githubReconnectRequired === true) {
    return '저장된 GitHub 연결이 만료되었습니다. 다시 연결해 주세요.'
  }
  return '선택 사항입니다. 연결하지 않으면 GitHub의 낮은 익명 요청 한도가 적용됩니다.'
}

export function githubConnectionRecoveryAvailable(error, state) {
  const code = error?.code
  if (!GITHUB_CONNECTION_RECOVERY_CODES.has(code)) return false

  // `rate_limit` is also used by OpenAI-compatible providers. Only offer a
  // GitHub connection when that shared code came from the GitHub RPC boundary.
  if (['rate_limit', 'secondary_rate_limit'].includes(code)
    && error?.source !== 'github' && error?.name !== 'GitHubError') return false

  return state?.vaultStatus === 'unlocked'
    && state.githubAuth?.connected !== true
    && state.job == null
}
