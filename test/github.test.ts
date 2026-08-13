import test from 'node:test'
import assert from 'node:assert/strict'
import {
  GitHubClient,
  GitHubError,
  assertGitHubApiResponse,
  githubApiUrl,
  parseGitHubRepoUrl,
  selectCandidateFiles,
  validateRepositoryIdentity,
} from '../src/lib/github.js'

const sha = 'a'.repeat(40)

test('detects repository URLs while excluding GitHub application paths', () => {
  assert.deepEqual(parseGitHubRepoUrl('https://github.com/PocketRisu/PocketRisu/tree/main'), {
    owner: 'PocketRisu',
    repo: 'PocketRisu',
  })
  assert.equal(parseGitHubRepoUrl('https://github.com/explore'), null)
  assert.equal(parseGitHubRepoUrl('https://github.com/search?q=test'), null)
  assert.equal(parseGitHubRepoUrl('https://evil.example/owner/repo'), null)
})

test('prioritizes repository entry points and excludes binary, generated, and symlink entries', () => {
  const files = selectCandidateFiles([
    { type: 'blob', mode: '100644', path: 'src/deep/feature.ts', sha, size: 50 },
    { type: 'blob', mode: '100644', path: 'README.md', sha, size: 50 },
    { type: 'blob', mode: '100644', path: 'package.json', sha, size: 50 },
    { type: 'blob', mode: '100644', path: 'assets/logo.png', sha, size: 50 },
    { type: 'blob', mode: '100644', path: 'node_modules/x/index.js', sha, size: 50 },
    { type: 'blob', mode: '120000', path: 'src/link.ts', sha, size: 10 },
  ])
  assert.deepEqual(files.map((file) => file.path), ['README.md', 'package.json', 'src/deep/feature.ts'])
})

test('keeps large high-value files that will be truncated to the per-file limit', () => {
  const files = selectCandidateFiles([
    { type: 'blob', mode: '100644', path: 'README.md', sha, size: 80_000 },
    { type: 'blob', mode: '100644', path: 'package.json', sha, size: 1_000 },
  ])
  assert.deepEqual(files.map((file) => file.path), ['README.md', 'package.json'])
})

test('uses 16 files by default and honors a bounded requested file limit', () => {
  const entries = Array.from({ length: 40 }, (_, index) => ({
    type: 'blob',
    mode: '100644',
    path: `src/file-${String(index).padStart(2, '0')}.ts`,
    sha,
    size: 100,
  }))
  assert.equal(selectCandidateFiles(entries).length, 16)
  assert.equal(selectCandidateFiles(entries, { maxFiles: 5 }).length, 5)
  assert.equal(selectCandidateFiles(entries, { maxFiles: 32 }).length, 32)
  for (const value of [0, 33, 1.5, '16']) {
    assert.throws(() => selectCandidateFiles(entries, { maxFiles: value }), RangeError)
  }
})

test('rejects unsafe API paths and off-origin redirects', () => {
  assert.equal(githubApiUrl('/repos/example/project'), 'https://api.github.com/repos/example/project')
  assert.throws(() => githubApiUrl('//evil.example/path'), GitHubError)
  assert.throws(() => assertGitHubApiResponse({ url: 'https://evil.example/data', status: 200 }), /허용되지 않은 주소/)
})

test('validates only bounded repository identities for repository RPCs', () => {
  assert.deepEqual(validateRepositoryIdentity({ owner: 'example', repo: 'project' }), { owner: 'example', repo: 'project' })
  assert.throws(() => validateRepositoryIdentity({ owner: 'example/evil', repo: 'project' }), /식별자/)
})

test('preserves permission and blocker diagnostics for failed GitHub fetches', async () => {
  for (const [code, expected] of [
    ['permission', /사이트 액세스 권한/],
    ['blocked', /요청을 차단/],
  ]) {
    const client = new GitHubClient(async () => {
      throw Object.assign(new Error('failure'), { code })
    })
    await assert.rejects(() => client.request('/repos/example/project'), expected)
  }
})

test('calls a native-style fetch implementation without rebinding this', async () => {
  function strictFetch(url) {
    assert.equal(this, undefined)
    return Promise.resolve({
      ok: true,
      status: 200,
      url,
      headers: new Headers(),
      json: async () => ({ ok: true }),
    })
  }
  const client = new GitHubClient(strictFetch)
  assert.deepEqual(await client.request('/rate_limit'), { ok: true })
})

test('sends GitHub credentials only to the fixed API origin and reports expired tokens safely', async () => {
  const secret = `gho_${'s'.repeat(36)}`
  const revision = '11111111-1111-4111-8111-111111111111'
  let observed
  const client = new GitHubClient(async (url, init) => {
    observed = { url, init }
    return {
      ok: false,
      status: 401,
      url,
      headers: new Headers(),
      json: async () => ({}),
    }
  }, {
    authProvider: async () => ({ token: secret, tokenType: 'bearer', revision }),
  })

  await assert.rejects(() => client.request('/repos/example/project'), (error) => {
    assert.equal(error.code, 'github_auth_expired')
    assert.equal(error.authRevision, revision)
    assert.doesNotMatch(error.message, new RegExp(secret))
    return true
  })
  assert.equal(observed.url, 'https://api.github.com/repos/example/project')
  assert.equal(observed.init.headers.Authorization, `Bearer ${secret}`)
  assert.equal(observed.init.redirect, 'error')
  assert.throws(() => githubApiUrl('//evil.example/steal'))
})

test('isolates in-flight repository requests when the authorization revision changes', async () => {
  const coalesceKeys = []
  const cache = {
    async getOrLoad(key, loader, options) {
      coalesceKeys.push(options.coalesceKey)
      return loader()
    },
  }
  let revision = 'first'
  const client = new GitHubClient(async () => {
    throw new Error('not reached')
  }, { cache, authProvider: async () => ({ revision }) })

  await client.cachedResource('resource', undefined, 100, async () => ({ ok: true }), () => true)
  revision = 'second'
  await client.cachedResource('resource', undefined, 100, async () => ({ ok: true }), () => true)
  assert.deepEqual(coalesceKeys, ['resource:auth:first', 'resource:auth:second'])
})

test('never trusts durable GitHub objects during an authenticated load', async () => {
  const observed = []
  const cache = {
    async getOrLoad(_key, loader, options) {
      observed.push(options.read)
      if (options.read !== false) return { forged: true }
      return loader(new AbortController().signal)
    },
  }
  const client = new GitHubClient(async () => {
    throw new Error('not reached')
  }, {
    cache,
    authProvider: async () => ({
      token: `gho_${'x'.repeat(36)}`,
      tokenType: 'bearer',
      revision: '11111111-1111-4111-8111-111111111111',
    }),
  })

  const value = await client.cachedResource(
    'head', undefined, 100, async () => ({ trusted: true }), () => true,
  )
  assert.deepEqual(value, { trusted: true })
  assert.deepEqual(observed, [false])
})

test('rejects authenticated private repositories before fetching or caching their HEAD', async () => {
  const writes = []
  const requests = []
  const cache = {
    async getOrLoad(key, loader) { return loader(new AbortController().signal) },
    async set(...args) { writes.push(args) },
  }
  const client = new GitHubClient(async (url) => {
    requests.push(url)
    return jsonResponse(url, {
      private: true,
      full_name: 'owner/repo',
      default_branch: 'main',
    })
  }, {
    cache,
    authProvider: async () => ({ token: `gho_${'x'.repeat(36)}`, tokenType: 'bearer', revision: 'auth' }),
  })

  await assert.rejects(() => client.resolveRepository('owner', 'repo'), (error) => error?.code === 'private')
  assert.equal(requests.length, 1)
  assert.deepEqual(writes, [])
})

test('does not persist staged objects if a public repository becomes private', async () => {
  const writes = []
  const cache = {
    async getOrLoad(_key, loader, options) {
      assert.equal(options.persist, false)
      return loader(new AbortController().signal)
    },
    async set(...args) { writes.push(args) },
  }
  let metadataCalls = 0
  const client = new GitHubClient(async (url) => {
    if (url === 'https://api.github.com/repos/owner/repo') {
      metadataCalls += 1
      return jsonResponse(url, publicMetadata({ private: metadataCalls > 1 }))
    }
    return jsonResponse(url, {
      sha: 'b'.repeat(40),
      commit: { tree: { sha: 'c'.repeat(40) } },
    })
  }, {
    cache,
    authProvider: async () => ({ token: `gho_${'x'.repeat(36)}`, tokenType: 'bearer', revision: 'auth' }),
  })

  await assert.rejects(() => client.resolveRepository('owner', 'repo'), (error) => error?.code === 'private')
  assert.equal(metadataCalls, 2)
  assert.deepEqual(writes, [])
})

test('never persists repository objects fetched with an authenticated credential', async () => {
  const writes = []
  const cache = {
    async getOrLoad(_key, loader) { return loader(new AbortController().signal) },
    async set(...args) { writes.push(args) },
  }
  const client = new GitHubClient(async (url) => {
    if (url === 'https://api.github.com/repos/owner/repo') return jsonResponse(url, publicMetadata())
    return jsonResponse(url, {
      sha: 'b'.repeat(40),
      commit: { tree: { sha: 'c'.repeat(40) } },
    })
  }, {
    cache,
    authProvider: async () => ({ token: `gho_${'x'.repeat(36)}`, tokenType: 'bearer', revision: 'auth' }),
  })

  assert.equal((await client.resolveRepository('owner', 'repo')).sha, 'b'.repeat(40))
  assert.deepEqual(writes, [])
})

test('reuses confirmed anonymous metadata while keeping the final visibility check fresh', async () => {
  const stored = new Map()
  const cache = {
    async getOrLoad(key, loader, options) {
      if (options.read !== false && stored.has(key)) return structuredClone(stored.get(key))
      return loader(new AbortController().signal)
    },
    async set(key, value) { stored.set(key, structuredClone(value)) },
  }
  let metadataCalls = 0
  let headCalls = 0
  const client = new GitHubClient(async (url) => {
    if (url === 'https://api.github.com/repos/owner/repo') {
      metadataCalls += 1
      return jsonResponse(url, publicMetadata())
    }
    if (url === 'https://api.github.com/repos/owner/repo/commits/main') {
      headCalls += 1
      return jsonResponse(url, {
        sha: 'b'.repeat(40),
        commit: { tree: { sha: 'c'.repeat(40) } },
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }, { cache })

  await client.resolveRepository('owner', 'repo')
  await client.resolveRepository('owner', 'repo')

  // First resolve: staged metadata + fresh confirmation. Second resolve:
  // cached metadata + another fresh confirmation. The immutable HEAD is reused.
  assert.equal(metadataCalls, 3)
  assert.equal(headCalls, 1)
})

test('does not return a repository result when cancellation lands during cache publication', async () => {
  const controller = new AbortController()
  let writes = 0
  const cache = {
    async getOrLoad(_key, loader) { return loader(new AbortController().signal) },
    async set() {
      writes += 1
      controller.abort()
    },
  }
  const client = new GitHubClient(async (url) => {
    if (url === 'https://api.github.com/repos/owner/repo') {
      return jsonResponse(url, publicMetadata())
    }
    return jsonResponse(url, {
      sha: 'b'.repeat(40),
      commit: { tree: { sha: 'c'.repeat(40) } },
    })
  }, { cache })

  await assert.rejects(
    () => client.resolveRepository('owner', 'repo', controller.signal),
    (error) => error?.code === 'cancelled',
  )
  assert.ok(writes > 0)
})

test('fails closed when one repository operation observes different auth revisions', async () => {
  const revisions = [
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  ]
  let providerCalls = 0
  const cache = {
    async getOrLoad(_key, loader) { return loader(new AbortController().signal) },
    async set() {},
  }
  const client = new GitHubClient(async (url) => {
    if (url === 'https://api.github.com/repos/owner/repo') return jsonResponse(url, publicMetadata())
    return jsonResponse(url, {
      sha: 'b'.repeat(40),
      commit: { tree: { sha: 'c'.repeat(40) } },
    })
  }, {
    cache,
    authProvider: async () => ({
      token: `gho_${'x'.repeat(36)}`,
      tokenType: 'bearer',
      revision: revisions[Math.min(providerCalls++, revisions.length - 1)],
    }),
  })

  await assert.rejects(
    () => client.resolveRepository('owner', 'repo', undefined, { onAuthSnapshot() {} }),
    (error) => error?.code === 'github_auth_changed',
  )
})

test('collects only the default-head tree resolved by the trusted GitHub client', async () => {
  const headSha = 'b'.repeat(40)
  const resolvedTreeSha = 'c'.repeat(40)
  const blobSha = 'd'.repeat(40)
  const attackerTreeSha = 'e'.repeat(40)
  const requests = []
  const cache = {
    async getOrLoad(_key, loader) { return loader(new AbortController().signal) },
    async set() {},
  }
  const client = new GitHubClient(async (url) => {
    requests.push(url)
    if (url === 'https://api.github.com/repos/owner/repo') {
      return jsonResponse(url, publicMetadata())
    }
    if (url === 'https://api.github.com/repos/owner/repo/commits/main') {
      return jsonResponse(url, { sha: headSha, commit: { tree: { sha: resolvedTreeSha } } })
    }
    if (url === `https://api.github.com/repos/owner/repo/git/trees/${resolvedTreeSha}?recursive=1`) {
      return jsonResponse(url, {
        sha: resolvedTreeSha,
        truncated: false,
        tree: [{ path: 'README.md', mode: '100644', type: 'blob', sha: blobSha, size: 5 }],
      })
    }
    if (url === `https://api.github.com/repos/owner/repo/git/blobs/${blobSha}`) {
      return jsonResponse(url, { sha: blobSha, encoding: 'base64', content: btoa('hello') })
    }
    throw new Error(`unexpected request: ${url}`)
  }, { cache })

  // Extra caller data models a compromised side panel trying to smuggle an
  // arbitrary Git object SHA through the owner/repo-only collection contract.
  const result = await client.collectCurrentRepository('owner', 'repo', undefined, () => {}, {
    treeSha: attackerTreeSha,
  })

  assert.equal(result.repository.sha, headSha)
  assert.equal(result.repository.treeSha, resolvedTreeSha)
  assert.equal(result.bundle.files[0].text, 'hello')
  assert.equal(requests.some((url) => url.includes(attackerTreeSha)), false)
  assert.equal(requests.filter((url) => url === 'https://api.github.com/repos/owner/repo').length, 2)
})

test('stops before tree or blob requests when the expected commit no longer matches HEAD', async () => {
  const currentHeadSha = 'b'.repeat(40)
  const previousHeadSha = 'a'.repeat(40)
  const resolvedTreeSha = 'c'.repeat(40)
  const requests = []
  const cache = {
    async getOrLoad(_key, loader) { return loader(new AbortController().signal) },
    async set() {},
  }
  const client = new GitHubClient(async (url) => {
    requests.push(url)
    if (url === 'https://api.github.com/repos/owner/repo') {
      return jsonResponse(url, publicMetadata())
    }
    if (url === 'https://api.github.com/repos/owner/repo/commits/main') {
      return jsonResponse(url, {
        sha: currentHeadSha,
        commit: { tree: { sha: resolvedTreeSha } },
      })
    }
    throw new Error(`unexpected request after HEAD mismatch: ${url}`)
  }, { cache })

  await assert.rejects(
    () => client.collectCurrentRepository('owner', 'repo', undefined, () => {}, {
      expectedSha: previousHeadSha,
      depth: 'deep',
    }),
    (error) => error?.code === 'repository_changed',
  )

  assert.deepEqual(requests, [
    'https://api.github.com/repos/owner/repo',
    'https://api.github.com/repos/owner/repo/commits/main',
  ])
  assert.equal(requests.some((url) => url.includes('/git/trees/')), false)
  assert.equal(requests.some((url) => url.includes('/git/blobs/')), false)
})

test('bypasses a cached HEAD when checking the commit for deep expansion', async () => {
  const previousHeadSha = 'a'.repeat(40)
  const currentHeadSha = 'b'.repeat(40)
  const treeSha = 'c'.repeat(40)
  const headKey = `head:v2:owner/repo:main`
  const requests = []
  const cache = {
    async getOrLoad(key, loader) {
      if (key === headKey) return { sha: previousHeadSha, treeSha }
      return loader(new AbortController().signal)
    },
    async set() {},
  }
  const client = new GitHubClient(async (url) => {
    requests.push(url)
    if (url === 'https://api.github.com/repos/owner/repo') {
      return jsonResponse(url, publicMetadata())
    }
    if (url === 'https://api.github.com/repos/owner/repo/commits/main') {
      return jsonResponse(url, {
        sha: currentHeadSha,
        commit: { tree: { sha: treeSha } },
      })
    }
    throw new Error(`unexpected request after fresh HEAD mismatch: ${url}`)
  }, { cache })

  await assert.rejects(
    () => client.collectCurrentRepository('owner', 'repo', undefined, () => {}, {
      expectedSha: previousHeadSha,
      depth: 'deep',
    }),
    (error) => error?.code === 'repository_changed',
  )

  assert.equal(requests.filter((url) => url.endsWith('/commits/main')).length, 1)
  assert.equal(requests.some((url) => url.includes('/git/trees/')), false)
  assert.equal(requests.some((url) => url.includes('/git/blobs/')), false)
})

test('fills the quick-pass quota from later anchors when an earlier blob is undecodable', async () => {
  const headSha = 'b'.repeat(40)
  const treeSha = 'c'.repeat(40)
  const readmeSha = 'd'.repeat(40)
  const packageSha = 'e'.repeat(40)
  const entrySha = 'f'.repeat(40)
  const cache = {
    async getOrLoad(_key, loader) { return loader(new AbortController().signal) },
    async set() {},
  }
  const client = new GitHubClient(async (url) => {
    if (url === 'https://api.github.com/repos/owner/repo') {
      return jsonResponse(url, publicMetadata())
    }
    if (url === 'https://api.github.com/repos/owner/repo/commits/main') {
      return jsonResponse(url, { sha: headSha, commit: { tree: { sha: treeSha } } })
    }
    if (url === `https://api.github.com/repos/owner/repo/git/trees/${treeSha}?recursive=1`) {
      return jsonResponse(url, {
        sha: treeSha,
        truncated: false,
        tree: [
          { path: 'README.md', mode: '100644', type: 'blob', sha: readmeSha, size: 8 },
          { path: 'package.json', mode: '100644', type: 'blob', sha: packageSha, size: 16 },
          { path: 'src/index.js', mode: '100644', type: 'blob', sha: entrySha, size: 14 },
        ],
      })
    }
    if (url === `https://api.github.com/repos/owner/repo/git/blobs/${readmeSha}`) {
      return jsonResponse(url, { sha: readmeSha, encoding: 'base64', content: btoa('\u0000binary') })
    }
    if (url === `https://api.github.com/repos/owner/repo/git/blobs/${packageSha}`) {
      return jsonResponse(url, { sha: packageSha, encoding: 'base64', content: btoa('{"name":"repo"}') })
    }
    if (url === `https://api.github.com/repos/owner/repo/git/blobs/${entrySha}`) {
      return jsonResponse(url, { sha: entrySha, encoding: 'base64', content: btoa('export default 1') })
    }
    throw new Error(`unexpected request: ${url}`)
  }, { cache })

  const result = await client.collectCurrentRepository('owner', 'repo', undefined, () => {}, {
    maxFiles: 4,
    depth: 'overview',
  })

  assert.deepEqual(new Set(result.bundle.files.map((file) => file.path)), new Set(['package.json', 'src/index.js']))
  assert.equal(result.bundle.selection.configuredMaxFiles, 4)
  assert.equal(result.bundle.selection.effectiveMaxFiles, 2)
  assert.equal(Object.hasOwn(result.bundle.selection, 'maxFiles'), false)
})

function publicMetadata(overrides = {}) {
  return {
    private: false,
    full_name: 'owner/repo',
    default_branch: 'main',
    owner: { login: 'owner' },
    name: 'repo',
    html_url: 'https://github.com/owner/repo',
    ...overrides,
  }
}

function jsonResponse(url, value, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    headers: new Headers(),
    json: async () => structuredClone(value),
  }
}
