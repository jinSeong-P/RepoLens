import {
  GITHUB_CACHE_POLICY,
  GitHubResourceCache,
  githubCacheKey,
} from './github-cache.js'
import { resolveAnalysisFileLimit } from './analysis-settings.js'
import {
  materializeSelection,
  quickFileLimit,
  selectAnchorCandidates,
  selectExpansionCandidates,
} from './repository-selector.js'

const RESERVED_OWNER_PATHS = new Set([
  'about', 'apps', 'collections', 'customer-stories', 'enterprise', 'events',
  'explore', 'features', 'issues', 'login', 'marketplace', 'new', 'notifications',
  'organizations', 'orgs', 'pricing', 'pulls', 'readme', 'search', 'security',
  'settings', 'signup', 'site', 'sponsors', 'team', 'topics', 'trending',
])

const BINARY_EXTENSIONS = new Set([
  '7z', 'a', 'avi', 'bin', 'bmp', 'class', 'dll', 'dmg', 'doc', 'docx', 'eot',
  'exe', 'gif', 'gz', 'ico', 'jar', 'jpeg', 'jpg', 'lib', 'lockb', 'mov', 'mp3',
  'mp4', 'o', 'obj', 'otf', 'pdf', 'png', 'pyc', 'rar', 'so', 'tar', 'ttf',
  'wav', 'webm', 'webp', 'woff', 'woff2', 'xls', 'xlsx', 'zip',
])

const EXCLUDED_SEGMENTS = new Set([
  '.git', '.next', '.nuxt', '.svelte-kit', 'build', 'coverage', 'dist', 'generated',
  'node_modules', 'target', 'vendor',
])

export const REPOSITORY_LIMITS = Object.freeze({
  maxTreeEntries: 20_000,
  maxFiles: 32,
  maxBlobBytes: 100_000,
  maxFileChars: 24_000,
  maxTotalChars: 48_000,
})

export class GitHubError extends Error {
  constructor(code, message, options = {}) {
    super(message)
    this.name = 'GitHubError'
    this.source = 'github'
    this.code = code
    this.status = options.status
    this.retryAt = options.retryAt
    this.reason = options.reason
    // Internal concurrency token. Extension error serialization deliberately
    // omits it, so credential revisions never cross the background boundary.
    this.authRevision = options.authRevision
  }
}

export function parseGitHubRepoUrl(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.hostname.toLowerCase() !== 'github.com') return null

  const segments = url.pathname.split('/').filter(Boolean)
  if (segments.length < 2 || RESERVED_OWNER_PATHS.has(segments[0].toLowerCase())) return null
  const owner = segments[0]
  const repo = segments[1].replace(/\.git$/i, '')
  const valid = /^[A-Za-z0-9_.-]{1,100}$/
  if (!valid.test(owner) || !valid.test(repo) || repo === '.' || repo === '..') return null
  return { owner, repo }
}

export class GitHubClient {
  constructor(fetchImpl = fetch, options = {}) {
    if (typeof fetchImpl !== 'function') throw new TypeError('GitHub fetch implementation is required.')
    this.fetchImpl = (...args) => fetchImpl(...args)
    this.cache = options.cache ?? new GitHubResourceCache()
    this.authProvider = typeof options.authProvider === 'function' ? options.authProvider : () => null
    if (!this.cache || typeof this.cache.getOrLoad !== 'function') {
      throw new TypeError('GitHub cache implementation is required.')
    }
  }

  async resolveRepository(owner, repo, signal, options = {}) {
    assertRepoPart(owner)
    assertRepoPart(repo)
    const securityContext = { persistenceAllowed: true, usedAuthRevisions: new Set() }
    // Never decide visibility from durable state. An authenticated credential
    // may be able to read private repositories, while RepoLens is public-only.
    const metadata = await this.fetchPublicRepositoryMetadata(owner, repo, signal, securityContext)
    reportAuthRevision(options.onAuthSnapshot, securityContext)

    const headKey = githubCacheKey.head(owner, repo, metadata.default_branch)
    const commit = await this.cachedResource(
      headKey,
      signal,
      GITHUB_CACHE_POLICY.headTtlMs,
      (sharedSignal, auth) => this.request(
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(metadata.default_branch)}`,
        sharedSignal,
        auth,
      ).then((value) => normalizeHeadCommit(value)),
      isHeadCommit,
      { persist: false, securityContext },
    )
    reportAuthRevision(options.onAuthSnapshot, securityContext)
    const sha = commit.sha
    const treeSha = commit.treeSha
    if (!isSha(sha) || !isSha(treeSha)) throw new GitHubError('parse', '기본 브랜치의 커밋 정보를 읽지 못했습니다.')

    // Object endpoints do not state repository visibility. Re-check after the
    // object response, then and only then make the staged result durable.
    const confirmed = await this.fetchPublicRepositoryMetadata(owner, repo, signal, securityContext, {
      fresh: true,
    })
    reportAuthRevision(options.onAuthSnapshot, securityContext)
    if (confirmed.default_branch !== metadata.default_branch) {
      throw new GitHubError('repository_changed', '분석 중 기본 브랜치가 변경되었습니다. 다시 시도해 주세요.')
    }
    await this.persistConfirmedPublicResources([
      [githubCacheKey.repository(owner, repo), confirmed, GITHUB_CACHE_POLICY.metadataTtlMs],
      [headKey, commit, GITHUB_CACHE_POLICY.headTtlMs],
    ], securityContext, signal)
    throwIfRepositoryCancelled(signal)

    return repositorySnapshot(confirmed, { sha, treeSha }, owner, repo)
  }

  /**
   * Resolves the repository's current default-branch snapshot inside the
   * trusted GitHub client, then collects only that derived tree. Callers never
   * supply an object SHA, which keeps authenticated credentials from acting as
   * a deputy for arbitrary Git object lookups.
   */
  async collectCurrentRepository(owner, repo, signal, onProgress = () => {}, options = {}) {
    assertRepoPart(owner)
    assertRepoPart(repo)
    const securityContext = { persistenceAllowed: true, usedAuthRevisions: new Set() }
    const metadata = await this.fetchPublicRepositoryMetadata(owner, repo, signal, securityContext)
    reportAuthRevision(options.onAuthSnapshot, securityContext)

    const headKey = githubCacheKey.head(owner, repo, metadata.default_branch)
    const commit = options.expectedSha === undefined
      ? await this.cachedResource(
        headKey,
        signal,
        GITHUB_CACHE_POLICY.headTtlMs,
        (sharedSignal, auth) => this.request(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(metadata.default_branch)}`,
          sharedSignal,
          auth,
        ).then((value) => normalizeHeadCommit(value)),
        isHeadCommit,
        { persist: false, securityContext },
      )
      : await this.#fetchFreshHead(owner, repo, metadata.default_branch, signal, securityContext)
    reportAuthRevision(options.onAuthSnapshot, securityContext)

    const repository = repositorySnapshot(metadata, commit, owner, repo)
    if (options.expectedSha !== undefined && options.expectedSha !== repository.sha) {
      throw new GitHubError('repository_changed', '빠른 분석 이후 저장소 커밋이 변경되었습니다. 현재 커밋에서 다시 분석해 주세요.')
    }
    const bundle = await this.#collectRepositorySnapshot(
      repository,
      signal,
      onProgress,
      options,
      securityContext,
      { initialVisibilityConfirmed: true, stagedResources: [[headKey, commit, GITHUB_CACHE_POLICY.headTtlMs]] },
    )
    return { repository, bundle }
  }

  async #collectRepositorySnapshot(repository, signal, onProgress, options, securityContext, internal = {}) {
    if (internal.initialVisibilityConfirmed !== true) {
      await this.fetchPublicRepositoryMetadata(repository.owner, repository.repo, signal, securityContext, {
        fresh: true,
      })
      reportAuthRevision(options.onAuthSnapshot, securityContext)
    }
    onProgress('tree', '저장소 구조를 읽는 중…')
    const stagedResources = Array.isArray(internal.stagedResources) ? [...internal.stagedResources] : []
    const treeKey = githubCacheKey.tree(repository.owner, repository.repo, repository.treeSha)
    const treeResult = await this.cachedResource(
      treeKey,
      signal,
      GITHUB_CACHE_POLICY.immutableTtlMs,
      (sharedSignal, auth) => this.request(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/trees/${repository.treeSha}?recursive=1`,
        sharedSignal,
        auth,
      ).then((value) => normalizeTree(value, repository.treeSha)),
      (value) => isNormalizedTree(value, repository.treeSha),
      { persist: false, securityContext },
    )
    reportAuthRevision(options.onAuthSnapshot, securityContext)
    stagedResources.push([treeKey, treeResult, GITHUB_CACHE_POLICY.immutableTtlMs])
    if (!Array.isArray(treeResult.tree)) throw new GitHubError('parse', '저장소 파일 트리를 읽지 못했습니다.')

    const entries = treeResult.tree.slice(0, REPOSITORY_LIMITS.maxTreeEntries)
    const maxFiles = resolveAnalysisFileLimit(options.maxFiles)
    const depth = options.depth === 'overview' ? 'overview' : 'deep'
    const anchorLimit = quickFileLimit(maxFiles)
    // Keep a bounded reserve so an empty or undecodable high-ranked blob does
    // not unnecessarily shrink the first-pass evidence set.
    const anchorCandidates = selectAnchorCandidates(entries, { maxFiles })
    onProgress('anchors', `1단계 핵심 파일을 고르는 중… (최대 ${anchorLimit}개)`)

    const decodedRecords = []
    const attemptedAnchorPaths = []
    for (const candidate of anchorCandidates) {
      if (signal?.aborted) throw new GitHubError('cancelled', '분석을 중지했습니다.')
      attemptedAnchorPaths.push(candidate.path)
      const record = await this.#readSelectionCandidate(repository, candidate, signal, securityContext, stagedResources, options)
      if (record) decodedRecords.push(record)
      if (decodedRecords.length >= anchorLimit) break
    }

    if (depth === 'deep' && decodedRecords.length < maxFiles) {
      onProgress('relationships', '2단계 내부 참조와 설정 관계를 따라가는 중…')
      const expansion = selectExpansionCandidates(entries, decodedRecords, {
        maxFiles: maxFiles - decodedRecords.length,
        excludePaths: attemptedAnchorPaths,
      })
      for (const candidate of expansion) {
        if (signal?.aborted) throw new GitHubError('cancelled', '분석을 중지했습니다.')
        const record = await this.#readSelectionCandidate(repository, candidate, signal, securityContext, stagedResources, options)
        if (record) decodedRecords.push(record)
        if (decodedRecords.length >= maxFiles) break
      }
    }

    const materialized = materializeSelection(decodedRecords, {
      maxFiles: depth === 'overview' ? anchorLimit : maxFiles,
      maxFileChars: REPOSITORY_LIMITS.maxFileChars,
      maxTotalChars: REPOSITORY_LIMITS.maxTotalChars,
    })
    const files = materialized.files
    const totalChars = materialized.totalChars
    const effectiveMaxFiles = materialized.selectionMetadata.maxFiles
    const { maxFiles: _materializedMaxFiles, ...selectionMetadata } = materialized.selectionMetadata
    if (files.length === 0) throw new GitHubError('empty', '분석할 수 있는 텍스트 파일을 찾지 못했습니다.')
    const confirmed = await this.fetchPublicRepositoryMetadata(
      repository.owner,
      repository.repo,
      signal,
      securityContext,
      { fresh: true },
    )
    reportAuthRevision(options.onAuthSnapshot, securityContext)
    if (typeof repository.defaultBranch === 'string'
      && confirmed.default_branch !== repository.defaultBranch) {
      throw new GitHubError('repository_changed', '분석 중 기본 브랜치가 변경되었습니다. 다시 시도해 주세요.')
    }
    stagedResources.push([
      githubCacheKey.repository(repository.owner, repository.repo),
      confirmed,
      GITHUB_CACHE_POLICY.metadataTtlMs,
    ])
    await this.persistConfirmedPublicResources(stagedResources, securityContext, signal)
    throwIfRepositoryCancelled(signal)
    return {
      files,
      totalChars,
      treeTruncated: treeResult.truncated === true || treeResult.tree.length > REPOSITORY_LIMITS.maxTreeEntries,
      selection: {
        depth,
        selectorVersion: 'local-two-stage-v1',
        configuredMaxFiles: maxFiles,
        effectiveMaxFiles,
        ...selectionMetadata,
      },
    }
  }

  async #readSelectionCandidate(repository, candidate, signal, securityContext, stagedResources, options) {
    const blobKey = githubCacheKey.blob(repository.owner, repository.repo, candidate.sha)
    const decoded = await this.cachedResource(
      blobKey,
      signal,
      GITHUB_CACHE_POLICY.immutableTtlMs,
      (sharedSignal, auth) => this.request(
        `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/git/blobs/${candidate.sha}`,
        sharedSignal,
        auth,
      ).then((value) => normalizeBlob(value, candidate.sha)),
      (value) => value === null || typeof value === 'string',
      { persist: false, securityContext },
    )
    reportAuthRevision(options.onAuthSnapshot, securityContext)
    stagedResources.push([blobKey, decoded, GITHUB_CACHE_POLICY.immutableTtlMs])
    if (decoded === null || !decoded.trim()) return null
    return {
      ...candidate,
      text: decoded,
      selectionKind: candidate.selectionKind ?? 'anchor',
    }
  }

  async cachedResource(key, signal, ttlMs, loader, validate, options = {}) {
    try {
      const auth = await this.authProvider()
      markPersistenceCapability(options.securityContext, auth)
      const authRevision = typeof auth?.revision === 'string' ? auth.revision : 'anonymous'
      return await this.cache.getOrLoad(key, (sharedSignal) => loader(sharedSignal, auth), {
        signal,
        ttlMs,
        validate,
        coalesceKey: `${key}:auth:${authRevision}`,
        // Extension pages share this IndexedDB origin. Once credentials are
        // involved, a durable entry must not be able to choose an arbitrary
        // Git object for the privileged request. Authenticated loads still
        // coalesce and reuse bounded worker-memory results.
        read: !auth?.token,
        persist: options.persist !== false,
      }).then((value) => {
        recordAuthRevision(options.securityContext, auth)
        return value
      })
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') {
        throw new GitHubError('cancelled', '요청을 중지했습니다.')
      }
      throw error
    }
  }

  async fetchPublicRepositoryMetadata(owner, repo, signal, securityContext, options = {}) {
    if (options.fresh !== true) {
      return this.cachedResource(
        githubCacheKey.repository(owner, repo),
        signal,
        GITHUB_CACHE_POLICY.metadataTtlMs,
        (sharedSignal, auth) => this.request(
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
          sharedSignal,
          auth,
        ).then((value) => normalizeRepositoryMetadata(value, owner, repo)),
        (value) => isRepositoryMetadata(value, owner, repo),
        { persist: false, securityContext },
      )
    }

    // A final visibility check must bypass every cache. It is the trust gate
    // before staged HEAD/tree/blob responses may become durable, so a recently
    // public repository that turned private cannot leak authenticated data into
    // the anonymous IndexedDB cache.
    const auth = await this.authProvider()
    markPersistenceCapability(securityContext, auth)
    recordAuthRevision(securityContext, auth)
    const value = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
      signal,
      auth,
    )
    return normalizeRepositoryMetadata(value, owner, repo)
  }

  async #fetchFreshHead(owner, repo, branch, signal, securityContext) {
    const auth = await this.authProvider()
    markPersistenceCapability(securityContext, auth)
    recordAuthRevision(securityContext, auth)
    const value = await this.request(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`,
      signal,
      auth,
    )
    return normalizeHeadCommit(value)
  }

  async persistConfirmedPublicResources(resources, securityContext, signal) {
    throwIfRepositoryCancelled(signal)
    if (securityContext?.persistenceAllowed !== true || typeof this.cache.set !== 'function') return
    await Promise.all(resources.map(async ([key, value, ttlMs]) => {
      try { await this.cache.set(key, value, { ttlMs }) } catch { /* Cache writes are best-effort. */ }
    }))
    throwIfRepositoryCancelled(signal)
  }

  async request(path, signal, authSnapshot) {
    const url = githubApiUrl(path)
    const auth = authSnapshot === undefined ? await this.authProvider() : authSnapshot
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }
    if (auth?.token) {
      if (!['bearer', 'token'].includes(auth.tokenType)
        || typeof auth.token !== 'string' || auth.token.length > 512
        || /[\s\u0000-\u001f\u007f]/.test(auth.token)) {
        throw new GitHubError('auth', '저장된 GitHub 연결 정보가 올바르지 않습니다.')
      }
      headers.Authorization = `${auth.tokenType === 'bearer' ? 'Bearer' : 'token'} ${auth.token}`
    }
    let response
    try {
      response = await this.fetchImpl(url, {
        headers,
        credentials: 'omit',
        redirect: auth?.token ? 'error' : 'follow',
        signal,
      })
    } catch (error) {
      if (signal?.aborted || error?.name === 'AbortError') throw new GitHubError('cancelled', '요청을 중지했습니다.')
      throw new GitHubError('network', networkErrorMessage(error), { reason: normalizeNetworkReason(error) })
    }

    assertGitHubApiResponse(response)

    if (!response.ok) {
      const remaining = response.headers.get('x-ratelimit-remaining')
      const reset = Number(response.headers.get('x-ratelimit-reset'))
      if (response.status === 403 && remaining === '0') {
        throw new GitHubError('rate_limit', 'GitHub 요청 한도에 도달했습니다.', {
          status: 403,
          retryAt: Number.isFinite(reset) ? new Date(reset * 1000).toISOString() : undefined,
        })
      }
      if (response.status === 401 && auth?.token) {
        throw new GitHubError('github_auth_expired', 'GitHub 연결이 만료되었습니다. 다시 연결해 주세요.', {
          status: 401,
          authRevision: auth.revision,
        })
      }
      if (response.status === 429 || (response.status === 403 && response.headers.get('retry-after'))) {
        const retryAfter = Number(response.headers.get('retry-after'))
        throw new GitHubError('secondary_rate_limit', 'GitHub의 일시적인 요청 제한에 도달했습니다.', {
          status: response.status,
          retryAt: Number.isFinite(retryAfter) ? new Date(Date.now() + retryAfter * 1000).toISOString() : undefined,
        })
      }
      if (response.status === 404) throw new GitHubError('not_found', '공개 저장소를 찾지 못했습니다.', { status: 404 })
      throw new GitHubError('github', `GitHub API가 HTTP ${response.status}로 응답했습니다.`, { status: response.status })
    }

    try {
      return await response.json()
    } catch {
      throw new GitHubError('parse', 'GitHub API 응답을 읽지 못했습니다.')
    }
  }
}

function recordAuthRevision(context, auth) {
  if (!context || typeof auth?.revision !== 'string') return
  context.authRevision = auth.revision
  context.usedAuthRevisions?.add(auth.revision)
}

function throwIfRepositoryCancelled(signal) {
  if (signal?.aborted) throw new GitHubError('cancelled', '요청을 중지했습니다.')
}

function reportAuthRevision(callback, context) {
  if (typeof callback !== 'function') return
  if (context?.usedAuthRevisions?.size > 1) {
    throw new GitHubError('github_auth_changed', 'GitHub 연결이 요청 중 변경되었습니다. 다시 시도해 주세요.')
  }
  callback(context?.authRevision)
}

function normalizeRepositoryMetadata(value, owner, repo) {
  if (!value || typeof value !== 'object') throw new GitHubError('parse', 'GitHub 저장소 정보를 읽지 못했습니다.')
  const expectedName = `${owner}/${repo}`.toLowerCase()
  if (value.private === true) throw new GitHubError('private', 'MVP는 공개 저장소만 분석합니다.', { status: 403 })
  if (value.private !== false) throw new GitHubError('parse', 'GitHub 저장소의 공개 여부를 확인하지 못했습니다.')
  if (typeof value.full_name !== 'string' || value.full_name.toLowerCase() !== expectedName) {
    throw new GitHubError('not_found', 'GitHub 저장소를 확인하지 못했습니다.', { status: 404 })
  }
  if (typeof value.default_branch !== 'string' || value.default_branch.length < 1 || value.default_branch.length > 500) {
    throw new GitHubError('empty', '기본 브랜치가 없는 빈 저장소입니다.')
  }
  return {
    private: false,
    owner: { login: boundedString(value.owner?.login, 100) || owner },
    name: boundedString(value.name, 100) || repo,
    full_name: value.full_name.slice(0, 300),
    description: boundedString(value.description, 2_000),
    default_branch: value.default_branch,
    html_url: safeRepositoryUrl(value.html_url, owner, repo),
    stargazers_count: Number.isSafeInteger(value.stargazers_count) && value.stargazers_count >= 0
      ? value.stargazers_count
      : 0,
    language: boundedString(value.language, 100),
    license: { spdx_id: boundedString(value.license?.spdx_id, 100) },
  }
}

function markPersistenceCapability(context, auth) {
  if (!context) return
  // If any network step used credentials, GitHub may have returned content
  // unavailable to an anonymous caller (fine-grained grants are not fully
  // represented by OAuth scope headers). Keep that data memory-only.
  if (auth?.token) context.persistenceAllowed = false
}

function isRepositoryMetadata(value, owner, repo) {
  const expectedName = `${owner}/${repo}`.toLowerCase()
  return Boolean(value && value.private === false
    && typeof value.full_name === 'string'
    && value.full_name.toLowerCase() === expectedName
    && typeof value.default_branch === 'string'
    && value.default_branch.length > 0
    && value.default_branch.length <= 500)
}

function normalizeHeadCommit(value) {
  const sha = value?.sha
  const treeSha = value?.commit?.tree?.sha
  if (!isSha(sha) || !isSha(treeSha)) {
    throw new GitHubError('parse', '기본 브랜치의 커밋 정보를 읽지 못했습니다.')
  }
  return { sha: sha.toLowerCase(), treeSha: treeSha.toLowerCase() }
}

function repositorySnapshot(metadata, commit, owner, repo) {
  if (!isHeadCommit(commit)) throw new GitHubError('parse', '기본 브랜치의 커밋 정보를 읽지 못했습니다.')
  return {
    owner: metadata.owner?.login ?? owner,
    repo: metadata.name ?? repo,
    fullName: metadata.full_name,
    description: typeof metadata.description === 'string' ? metadata.description : '',
    defaultBranch: metadata.default_branch,
    sha: commit.sha,
    treeSha: commit.treeSha,
    htmlUrl: metadata.html_url,
    stars: Number.isFinite(metadata.stargazers_count) ? metadata.stargazers_count : 0,
    language: typeof metadata.language === 'string' ? metadata.language : '',
    licenseSpdx: typeof metadata.license?.spdx_id === 'string' ? metadata.license.spdx_id : '',
  }
}

function isHeadCommit(value) {
  return isSha(value?.sha) && isSha(value?.treeSha)
}

function normalizeTree(value, expectedSha) {
  if (!isSha(value?.sha) || value.sha.toLowerCase() !== expectedSha.toLowerCase() || !Array.isArray(value.tree)) {
    throw new GitHubError('parse', '저장소 파일 트리를 읽지 못했습니다.')
  }
  const sourceLength = value.tree.length
  const tree = value.tree.slice(0, REPOSITORY_LIMITS.maxTreeEntries).map(normalizeTreeEntry).filter(Boolean)
  return {
    sha: expectedSha.toLowerCase(),
    tree,
    truncated: value.truncated === true || sourceLength > REPOSITORY_LIMITS.maxTreeEntries,
  }
}

function normalizeTreeEntry(value) {
  if (!value || typeof value !== 'object' || typeof value.path !== 'string' || value.path.length > 500
    || !['blob', 'tree', 'commit'].includes(value.type) || !isSha(value.sha)) return null
  return {
    path: value.path,
    mode: boundedString(value.mode, 10),
    type: value.type,
    sha: value.sha.toLowerCase(),
    ...(Number.isSafeInteger(value.size) && value.size >= 0 ? { size: value.size } : {}),
  }
}

function isNormalizedTree(value, expectedSha) {
  return Boolean(value && value.sha === expectedSha.toLowerCase()
    && Array.isArray(value.tree) && value.tree.length <= REPOSITORY_LIMITS.maxTreeEntries
    && typeof value.truncated === 'boolean')
}

function normalizeBlob(value, expectedSha) {
  if (!isSha(value?.sha) || value.sha.toLowerCase() !== expectedSha.toLowerCase()
    || value.encoding !== 'base64' || typeof value.content !== 'string') {
    throw new GitHubError('parse', 'GitHub 파일 내용을 읽지 못했습니다.')
  }
  return decodeGitHubBlob(value)
}

function boundedString(value, maxLength) {
  return typeof value === 'string' ? value.slice(0, maxLength) : ''
}

function safeRepositoryUrl(value, owner, repo) {
  try {
    const url = new URL(value)
    if (url.origin === 'https://github.com') return url.href.slice(0, 2_048)
  } catch { /* Use the canonical public repository URL below. */ }
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`
}

export function githubApiUrl(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.startsWith('//')) {
    throw new GitHubError('request', 'GitHub API 요청 경로가 올바르지 않습니다.')
  }
  const url = new URL(path, 'https://api.github.com')
  if (url.origin !== 'https://api.github.com' || url.username || url.password || url.hash) {
    throw new GitHubError('request', '허용되지 않은 GitHub API 주소입니다.')
  }
  return url.href
}

export function assertGitHubApiResponse(response) {
  let responseUrl = null
  try {
    responseUrl = typeof response?.url === 'string' && response.url ? new URL(response.url) : null
  } catch {
    throw new GitHubError('redirect', 'GitHub API 응답 주소가 올바르지 않습니다.', { status: response?.status })
  }
  if (responseUrl && responseUrl.origin !== 'https://api.github.com') {
    throw new GitHubError('redirect', 'GitHub API가 허용되지 않은 주소로 이동했습니다.', { status: response.status })
  }
}

export function validateRepositoryIdentity(value) {
  const owner = value?.owner
  const repo = value?.repo
  assertRepoPart(owner)
  assertRepoPart(repo)
  return { owner, repo }
}

function networkErrorMessage(error) {
  if (error?.code === 'permission') return 'RepoLens에 api.github.com 사이트 액세스 권한이 없습니다. 확장 프로그램을 다시 로드해 주세요.'
  if (error?.code === 'blocked') return 'Chrome 또는 다른 확장 프로그램이 api.github.com 요청을 차단했습니다.'
  return 'GitHub API에 연결할 수 없습니다. Chrome의 RepoLens 사이트 액세스와 차단 확장 설정을 확인해 주세요.'
}

function normalizeNetworkReason(error) {
  const name = typeof error?.name === 'string' ? error.name.slice(0, 80) : 'Error'
  const message = typeof error?.message === 'string' ? error.message.slice(0, 180) : 'unknown'
  return `${name}: ${message}`
}

export function selectCandidateFiles(entries, options = {}) {
  const maxFiles = resolveAnalysisFileLimit(options.maxFiles)
  return entries
    .filter((entry) => isCandidate(entry))
    .map((entry) => ({ ...entry, score: scorePath(entry.path) }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .reduce((selected, entry) => {
      if (selected.length >= maxFiles) return selected
      const estimatedChars = (item) => Math.min(item.size ?? 0, REPOSITORY_LIMITS.maxFileChars)
      const usedChars = selected.reduce((sum, item) => sum + estimatedChars(item), 0)
      if (usedChars + estimatedChars(entry) <= REPOSITORY_LIMITS.maxTotalChars) selected.push(entry)
      return selected
    }, [])
}

function isCandidate(entry) {
  if (!entry || entry.type !== 'blob' || entry.mode === '120000' || entry.mode === '160000') return false
  if (!isSha(entry.sha) || typeof entry.path !== 'string' || !isSafePath(entry.path)) return false
  if (!Number.isFinite(entry.size) || entry.size <= 0 || entry.size > REPOSITORY_LIMITS.maxBlobBytes) return false
  const segments = entry.path.toLowerCase().split('/')
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false
  const extension = segments.at(-1).includes('.') ? segments.at(-1).split('.').at(-1) : ''
  return !BINARY_EXTENSIONS.has(extension)
}

function scorePath(path) {
  const lower = path.toLowerCase()
  const name = lower.split('/').at(-1)
  const depth = lower.split('/').length - 1
  let score = Math.max(0, 100 - depth * 10)
  if (/^readme(?:\.|$)/.test(name)) score += 1_200
  if (/^(license|copying|notice)(?:\.|$)/.test(name)) score += 1_100
  if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json|gemfile|requirements\.txt)$/.test(name)) score += 1_000
  if (/^(manifest\.json|dockerfile|compose\.ya?ml|makefile|justfile)$/.test(name)) score += 850
  if (/^(index|main|app|server|cli)\.(?:js|jsx|ts|tsx|py|go|rs|java|kt|rb|php|cs|cpp|c)$/.test(name)) score += 750
  if (lower.startsWith('docs/') || lower.includes('/docs/')) score += 550
  if (lower.startsWith('src/') || lower.startsWith('app/') || lower.startsWith('lib/')) score += 400
  if (/(?:^|\/)(?:architecture|contributing|security)\.md$/.test(lower)) score += 500
  if (/(?:test|spec)\./.test(name)) score -= 180
  if (/\.(?:lock|sum)$/.test(name) || name === 'package-lock.json') score -= 900
  return score
}

function decodeGitHubBlob(blob) {
  if (!blob || blob.encoding !== 'base64' || typeof blob.content !== 'string') return null
  try {
    const binary = atob(blob.content.replace(/\s/g, ''))
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
    const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
    if (text.includes('\u0000')) return null
    const replacements = (text.match(/\uFFFD/g) ?? []).length
    if (text.length > 0 && replacements / text.length > 0.02) return null
    return text.replace(/\r\n?/g, '\n')
  } catch {
    return null
  }
}

function truncateTextFile(text, maxChars) {
  if (text.length <= maxChars) return { text, lineCount: text.split('\n').length, truncated: false }
  const cut = text.lastIndexOf('\n', maxChars)
  const safeCut = cut > maxChars * 0.75 ? cut : maxChars
  const result = text.slice(0, safeCut)
  return { text: result, lineCount: result.split('\n').length, truncated: true }
}

function isSafePath(path) {
  return path.length <= 500
    && !path.includes('\\')
    && !path.includes('\u0000')
    && !path.split('/').some((segment) => segment === '..' || segment === '')
}

function assertRepoPart(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) {
    throw new GitHubError('request', '저장소 식별자가 올바르지 않습니다.')
  }
}

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
}
