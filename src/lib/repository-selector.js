const DEFAULT_MAX_FILES = 16
const MAX_FILES = 32
const MAX_TREE_ENTRIES = 20_000
const MAX_BLOB_BYTES = 100_000
const DEFAULT_MAX_FILE_CHARS = 24_000
const DEFAULT_MAX_TOTAL_CHARS = 48_000
const MAX_REFERENCE_SCAN_CHARS = 100_000

const BINARY_EXTENSIONS = new Set([
  '7z', 'a', 'avi', 'bin', 'bmp', 'class', 'dll', 'dmg', 'doc', 'docx', 'eot',
  'exe', 'gif', 'gz', 'ico', 'jar', 'jpeg', 'jpg', 'lib', 'lockb', 'mov', 'mp3',
  'mp4', 'o', 'obj', 'otf', 'pdf', 'png', 'pyc', 'rar', 'so', 'tar', 'ttf',
  'wav', 'webm', 'webp', 'woff', 'woff2', 'xls', 'xlsx', 'zip',
])

const EXCLUDED_SEGMENTS = new Set([
  '.git', '.next', '.nuxt', '.svelte-kit', 'build', 'coverage', 'dist',
  'generated', 'node_modules', 'target', 'vendor',
])

const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts', '.json',
  '.vue', '.svelte',
]

const JAVASCRIPT_EXTENSIONS = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'mts', 'cts',
])

export const REPOSITORY_SELECTION_LIMITS = Object.freeze({
  maxFiles: MAX_FILES,
  maxTreeEntries: MAX_TREE_ENTRIES,
  maxBlobBytes: MAX_BLOB_BYTES,
  maxFileChars: DEFAULT_MAX_FILE_CHARS,
  maxTotalChars: DEFAULT_MAX_TOTAL_CHARS,
})

/** Returns the first-pass file count for a user-selected final file limit. */
export function quickFileLimit(maxFiles) {
  return Math.min(8, Math.max(1, Math.ceil(assertMaxFiles(maxFiles) / 2)))
}

/** Normalizes, filters, scores, and deterministically orders a Git tree. */
export function buildRepositoryCandidates(entries) {
  if (!Array.isArray(entries)) return []
  const candidates = []
  for (const entry of entries) {
    if (!isCandidateEntry(entry)) continue
    const { score, category, reasons } = describePath(entry.path)
    candidates.push({
      path: entry.path,
      sha: entry.sha.toLowerCase(),
      size: entry.size,
      mode: entry.mode,
      type: 'blob',
      score,
      category,
      directory: directoryOf(entry.path),
      reasons,
      relatedFromPaths: [],
    })
  }

  // Sort before de-duplicating and applying the tree cap. The result is stable
  // even if GitHub returns the same entries in a different order.
  candidates.sort((left, right) => compareCodePoints(left.path, right.path)
    || compareCodePoints(left.sha, right.sha))
  const unique = []
  let previousPath = null
  for (const candidate of candidates) {
    if (candidate.path === previousPath) continue
    unique.push(candidate)
    previousPath = candidate.path
    if (unique.length >= MAX_TREE_ENTRIES) break
  }
  return unique
}

/** Selects high-value anchors while avoiding category and directory clumping. */
export function selectAnchorCandidates(entries, options = {}) {
  const maxFiles = resolveMaxFiles(options.maxFiles)
  return pickBalanced(buildRepositoryCandidates(entries), maxFiles, 'anchor')
}

/**
 * Extracts resolved internal dependency edges from decoded anchor files.
 * Only relative JS/TS imports and exact strings in package/tsconfig JSON are
 * considered. Package names, URLs, aliases, and paths escaping the root are
 * ignored.
 */
export function extractInternalReferences(anchorFiles, entries) {
  if (!Array.isArray(anchorFiles)) return []
  const candidates = buildRepositoryCandidates(entries)
  const paths = new Set(candidates.map((candidate) => candidate.path))
  const sortedFiles = anchorFiles
    .filter((file) => isSafePath(file?.path) && typeof file?.text === 'string')
    .slice()
    .sort((left, right) => compareCodePoints(left.path, right.path))
  const edges = []

  for (const file of sortedFiles) {
    const text = file.text.slice(0, MAX_REFERENCE_SCAN_CHARS)
    const extension = extensionOf(file.path)
    const references = []
    if (JAVASCRIPT_EXTENSIONS.has(extension)) {
      references.push(...extractJavaScriptSpecifiers(text).map((specifier) => ({
        specifier,
        kind: 'import',
        relativeOnly: true,
      })))
    }
    if (isReferenceJson(file.path)) {
      references.push(...extractJsonSpecifiers(text).map((specifier) => ({
        specifier,
        kind: 'json',
        relativeOnly: false,
      })))
    }

    for (const reference of references) {
      const toPath = resolveTreePath(
        file.path,
        reference.specifier,
        paths,
        reference.relativeOnly,
      )
      if (!toPath || toPath === file.path) continue
      edges.push({
        fromPath: file.path,
        toPath,
        specifier: reference.specifier,
        kind: reference.kind,
      })
    }
  }

  edges.sort((left, right) => compareCodePoints(left.fromPath, right.fromPath)
    || compareCodePoints(left.toPath, right.toPath)
    || compareCodePoints(left.kind, right.kind)
    || compareCodePoints(left.specifier, right.specifier))
  return edges.filter((edge, index) => index === 0
    || edge.fromPath !== edges[index - 1].fromPath
    || edge.toPath !== edges[index - 1].toPath)
}

/**
 * Selects additional files after anchors. Directly referenced files rank
 * first; unused capacity is filled with balanced high-value candidates.
 */
export function selectExpansionCandidates(entries, anchorFiles, options = {}) {
  const maxFiles = resolveMaxFiles(options.maxFiles)
  const candidates = buildRepositoryCandidates(entries)
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]))
  const excluded = new Set()
  for (const file of Array.isArray(anchorFiles) ? anchorFiles : []) {
    if (isSafePath(file?.path)) excluded.add(file.path)
  }
  for (const path of normalizeExcludedPaths(options.excludePaths)) excluded.add(path)

  const sourcesByTarget = new Map()
  for (const edge of extractInternalReferences(anchorFiles, entries)) {
    if (excluded.has(edge.toPath)) continue
    let sources = sourcesByTarget.get(edge.toPath)
    if (!sources) {
      sources = new Set()
      sourcesByTarget.set(edge.toPath, sources)
    }
    sources.add(edge.fromPath)
  }

  const related = []
  for (const [path, sources] of sourcesByTarget) {
    const candidate = candidateByPath.get(path)
    if (!candidate) continue
    const relatedFromPaths = [...sources].sort(compareCodePoints)
    related.push({
      ...candidate,
      selectionKind: 'related',
      relatedFromPaths,
      reasons: [
        `${relatedFromPaths.length}개 앵커 파일에서 직접 참조`,
        ...candidate.reasons,
      ],
      relationScore: relatedFromPaths.length * 2_000 + candidate.score,
    })
  }
  related.sort((left, right) => right.relationScore - left.relationScore
    || right.score - left.score
    || compareCodePoints(left.path, right.path))

  const selected = related.slice(0, maxFiles).map(({ relationScore, ...candidate }) => candidate)
  if (selected.length >= maxFiles) return selected

  const selectedPaths = new Set([...excluded, ...selected.map((candidate) => candidate.path)])
  const remaining = candidates.filter((candidate) => !selectedPaths.has(candidate.path))
  const initial = [
    ...candidates.filter((candidate) => excluded.has(candidate.path)),
    ...selected,
  ]
  selected.push(...pickBalanced(remaining, maxFiles - selected.length, 'fallback', initial))
  return selected
}

/** Convenience wrapper returning anchors plus their second-pass expansion. */
export function selectDeepCandidates(entries, anchorFiles, options = {}) {
  const maxFiles = resolveMaxFiles(options.maxFiles)
  const candidates = buildRepositoryCandidates(entries)
  const candidateByPath = new Map(candidates.map((candidate) => [candidate.path, candidate]))
  const anchorPaths = [...new Set((Array.isArray(anchorFiles) ? anchorFiles : [])
    .map((file) => file?.path)
    .filter((path) => candidateByPath.has(path)))]
    .sort(compareCodePoints)
  const anchors = anchorPaths.slice(0, maxFiles).map((path) => ({
    ...candidateByPath.get(path),
    selectionKind: 'anchor',
    reasons: [...candidateByPath.get(path).reasons],
    relatedFromPaths: [],
  }))
  const expansion = selectExpansionCandidates(entries, anchorFiles, {
    maxFiles: Math.max(1, maxFiles - anchors.length),
    excludePaths: anchorPaths,
  })
  return anchors.length >= maxFiles ? anchors : [...anchors, ...expansion.slice(0, maxFiles - anchors.length)]
}

/**
 * Applies the fixed content budgets fairly and assigns final F1..Fn IDs.
 * Short files surrender unused capacity to longer files; no early file can
 * consume the total budget merely because it appeared first.
 */
export function materializeSelection(decodedRecords, options = {}) {
  const maxFiles = resolveMaxFiles(options.maxFiles)
  const maxFileChars = resolveBudget(
    options.maxFileChars,
    DEFAULT_MAX_FILE_CHARS,
    DEFAULT_MAX_FILE_CHARS,
    'maxFileChars',
  )
  const maxTotalChars = resolveBudget(
    options.maxTotalChars,
    DEFAULT_MAX_TOTAL_CHARS,
    DEFAULT_MAX_TOTAL_CHARS,
    'maxTotalChars',
  )
  const records = []
  for (const record of Array.isArray(decodedRecords) ? decodedRecords : []) {
    if (records.length >= maxFiles) break
    if (!isSafePath(record?.path) || typeof record?.text !== 'string') continue
    const text = record.text.replace(/\r\n?/g, '\n')
    if (!text.trim() || text.includes('\u0000')) continue
    const replacements = (text.match(/\uFFFD/g) ?? []).length
    if (text.length > 0 && replacements / text.length > 0.02) continue
    records.push({
      ...record,
      text,
      selectionKind: normalizeSelectionKind(record.selectionKind),
      reasons: normalizeStringList(record.reasons),
      relatedFromPaths: normalizeStringList(record.relatedFromPaths)
        .filter(isSafePath)
        .sort(compareCodePoints),
    })
  }

  const capacities = records.map((record) => Math.min(record.text.length, maxFileChars))
  const allocations = fairAllocations(capacities, maxTotalChars)
  const files = records.map((record, index) => {
    const text = safeSlice(record.text, allocations[index])
    return {
      id: `F${index + 1}`,
      path: record.path,
      ...(typeof record.sha === 'string' ? { sha: record.sha } : {}),
      text,
      lineCount: text.split('\n').length,
      truncated: record.truncated === true || text.length < record.text.length,
      selectionKind: record.selectionKind,
      reasons: record.reasons,
      relatedFromPaths: record.relatedFromPaths,
    }
  }).filter((file) => file.text.length > 0)

  // A zero allocation is only possible with a deliberately tiny test budget.
  // Re-number after filtering so IDs are always contiguous.
  files.forEach((file, index) => { file.id = `F${index + 1}` })
  const totalChars = files.reduce((sum, file) => sum + file.text.length, 0)
  const counts = { anchor: 0, related: 0, fallback: 0 }
  for (const file of files) counts[file.selectionKind] += 1
  const metadata = Object.freeze({
    maxFiles,
    maxFileChars,
    maxTotalChars,
    selectedFiles: files.length,
    counts: Object.freeze(counts),
  })
  return { files, totalChars, metadata, selectionMetadata: metadata }
}

function pickBalanced(candidates, count, selectionKind, initial = []) {
  const remaining = candidates.slice()
  const selected = []
  const categoryCounts = new Map()
  const directoryCounts = new Map()
  for (const candidate of initial) {
    increment(categoryCounts, candidate.category)
    increment(directoryCounts, candidate.directory)
  }

  while (selected.length < count && remaining.length > 0) {
    remaining.sort((left, right) => {
      const leftAdjusted = balancedScore(left, categoryCounts, directoryCounts)
      const rightAdjusted = balancedScore(right, categoryCounts, directoryCounts)
      return rightAdjusted - leftAdjusted
        || right.score - left.score
        || compareCodePoints(left.path, right.path)
    })
    const candidate = remaining.shift()
    const categoryNew = !categoryCounts.has(candidate.category)
    const directoryNew = !directoryCounts.has(candidate.directory)
    increment(categoryCounts, candidate.category)
    increment(directoryCounts, candidate.directory)
    selected.push({
      ...candidate,
      selectionKind,
      reasons: [
        ...candidate.reasons,
        ...(categoryNew ? ['분석 범주의 균형'] : []),
        ...(directoryNew ? ['디렉터리 범위의 균형'] : []),
      ],
      relatedFromPaths: [],
    })
  }
  return selected
}

function balancedScore(candidate, categoryCounts, directoryCounts) {
  const categoryCount = categoryCounts.get(candidate.category) ?? 0
  const directoryCount = directoryCounts.get(candidate.directory) ?? 0
  return candidate.score
    + (categoryCount === 0 ? 420 : 0)
    + (directoryCount === 0 ? 240 : 0)
    - categoryCount * 180
    - directoryCount * 120
}

function describePath(path) {
  const lower = path.toLowerCase()
  const name = lower.split('/').at(-1)
  const depth = lower.split('/').length - 1
  let score = Math.max(0, 100 - depth * 10)
  let category = 'other'
  const reasons = []
  if (/^readme(?:\.|$)/.test(name)) {
    score += 1_200
    category = 'documentation'
    reasons.push('프로젝트 개요 문서')
  } else if (/^(license|copying|notice)(?:\.|$)/.test(name)) {
    score += 800
    category = 'documentation'
    reasons.push('라이선스 및 배포 정보')
  } else if (/^(package\.json|pyproject\.toml|cargo\.toml|go\.mod|composer\.json|gemfile|requirements\.txt)$/.test(name)) {
    score += 1_050
    category = 'manifest'
    reasons.push('의존성 및 프로젝트 매니페스트')
  } else if (/^(manifest\.json|tsconfig(?:\.[^.]+)?\.json|dockerfile|compose\.ya?ml|makefile|justfile|vite\.config\.[^.]+|webpack\.config\.[^.]+)$/.test(name)) {
    score += 880
    category = 'configuration'
    reasons.push('빌드 또는 실행 설정')
  } else if (/^(index|main|app|server|cli)\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|cpp|c)$/.test(name)) {
    score += 800
    category = 'entrypoint'
    reasons.push('실행 진입점 후보')
  } else if (/(?:^|\/)(?:architecture|contributing|security)\.md$/.test(lower)
    || lower.startsWith('docs/') || lower.includes('/docs/')) {
    score += 580
    category = 'documentation'
    reasons.push('구조 또는 사용 문서')
  } else if (lower.startsWith('src/') || lower.startsWith('app/') || lower.startsWith('lib/')) {
    score += 430
    category = 'source'
    reasons.push('핵심 소스 경로')
  } else {
    reasons.push('저장소 경로 우선순위')
  }
  if (/(?:test|spec)\./.test(name)) score -= 180
  if (/\.(?:lock|sum)$/.test(name) || name === 'package-lock.json') score -= 900
  return { score, category, reasons }
}

function isCandidateEntry(entry) {
  if (!entry || entry.type !== 'blob' || entry.mode === '120000' || entry.mode === '160000') return false
  if (!isSha(entry.sha) || !isSafePath(entry.path)) return false
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > MAX_BLOB_BYTES) return false
  const segments = entry.path.toLowerCase().split('/')
  if (segments.some((segment) => EXCLUDED_SEGMENTS.has(segment))) return false
  return !BINARY_EXTENSIONS.has(extensionOf(entry.path))
}

function extractJavaScriptSpecifiers(text) {
  const found = []
  const staticPattern = /\b(?:import|export)\s+(?:(?:type\s+)?[^'"\r\n;]{0,500}?\s+from\s*)?["']([^"'`\r\n]{1,500})["']/g
  const callPattern = /\b(?:require|import)\s*\(\s*["']([^"'`\r\n]{1,500})["']\s*\)/g
  for (const pattern of [staticPattern, callPattern]) {
    for (const match of text.matchAll(pattern)) {
      if (isRelativeSpecifier(match[1])) found.push(match[1])
    }
  }
  return [...new Set(found)].sort(compareCodePoints)
}

function extractJsonSpecifiers(text) {
  let parsed
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    return []
  }
  const found = []
  const visit = (value, depth = 0) => {
    if (depth > 30) return
    if (typeof value === 'string') {
      if (value.length > 0 && value.length <= 500) found.push(value)
      return
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 5_000)) visit(item, depth + 1)
      return
    }
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value).sort(compareCodePoints).slice(0, 5_000)) visit(value[key], depth + 1)
    }
  }
  visit(parsed)
  return [...new Set(found)].sort(compareCodePoints)
}

function resolveTreePath(fromPath, rawSpecifier, paths, relativeOnly) {
  if (typeof rawSpecifier !== 'string' || rawSpecifier.length === 0 || rawSpecifier.length > 500) return null
  if (rawSpecifier.includes('\\') || rawSpecifier.includes('\u0000')
    || rawSpecifier.startsWith('/') || /^[A-Za-z][A-Za-z\d+.-]*:/.test(rawSpecifier)) return null
  if (relativeOnly && !isRelativeSpecifier(rawSpecifier)) return null
  const specifier = rawSpecifier.split(/[?#]/, 1)[0]
  if (!specifier || (!relativeOnly && (specifier.startsWith('#') || specifier.startsWith('@')))) return null
  const base = directoryOf(fromPath) === '.' ? [] : directoryOf(fromPath).split('/')
  const segments = [...base]
  for (const segment of specifier.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    if (segment.length > 255) return null
    segments.push(segment)
  }
  const path = segments.join('/')
  if (!isSafePath(path)) return null
  const attempts = [path]
  if (!hasExtension(path)) {
    for (const extension of SOURCE_EXTENSIONS) attempts.push(`${path}${extension}`)
    for (const extension of SOURCE_EXTENSIONS) attempts.push(`${path}/index${extension}`)
  }
  for (const attempt of attempts) if (paths.has(attempt)) return attempt
  return null
}

function fairAllocations(capacities, totalBudget) {
  const allocations = capacities.map(() => 0)
  let remaining = Math.min(totalBudget, capacities.reduce((sum, value) => sum + value, 0))
  let active = capacities.map((_, index) => index).filter((index) => capacities[index] > 0)
  while (remaining > 0 && active.length > 0) {
    const share = Math.floor(remaining / active.length)
    if (share === 0) {
      for (const index of active) {
        if (remaining === 0) break
        allocations[index] += 1
        remaining -= 1
      }
      break
    }
    const small = active.filter((index) => capacities[index] - allocations[index] <= share)
    if (small.length > 0) {
      const smallSet = new Set(small)
      for (const index of small) {
        const addition = capacities[index] - allocations[index]
        allocations[index] += addition
        remaining -= addition
      }
      active = active.filter((index) => !smallSet.has(index))
      continue
    }
    for (const index of active) {
      allocations[index] += share
      remaining -= share
    }
  }
  return allocations
}

function safeSlice(text, length) {
  let end = Math.min(length, text.length)
  if (end > 0 && end < text.length) {
    const last = text.charCodeAt(end - 1)
    if (last >= 0xD800 && last <= 0xDBFF) end -= 1
  }
  return text.slice(0, end)
}

function isReferenceJson(path) {
  const name = path.toLowerCase().split('/').at(-1)
  return name === 'package.json' || /^tsconfig(?:\.[^.]+)?\.json$/.test(name)
}

function normalizeExcludedPaths(value) {
  const values = value instanceof Set ? [...value] : Array.isArray(value) ? value : []
  return values.filter(isSafePath)
}

function normalizeStringList(value) {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item) => typeof item === 'string' && item.length <= 500))]
}

function normalizeSelectionKind(value) {
  return value === 'related' || value === 'fallback' ? value : 'anchor'
}

function resolveMaxFiles(value) {
  return assertMaxFiles(value === undefined ? DEFAULT_MAX_FILES : value)
}

function assertMaxFiles(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_FILES) {
    throw new RangeError(`maxFiles must be an integer between 1 and ${MAX_FILES}.`)
  }
  return value
}

function resolveBudget(value, fallback, maximum, name) {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new RangeError(`${name} must be an integer between 1 and ${maximum}.`)
  }
  return value
}

function isSafePath(path) {
  return typeof path === 'string'
    && path.length > 0
    && path.length <= 500
    && !path.includes('\\')
    && !path.includes('\u0000')
    && !path.startsWith('/')
    && !path.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
}

function isRelativeSpecifier(value) {
  return typeof value === 'string' && (value.startsWith('./') || value.startsWith('../'))
}

function isSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value)
}

function directoryOf(path) {
  const slash = path.lastIndexOf('/')
  return slash < 0 ? '.' : path.slice(0, slash)
}

function extensionOf(path) {
  const name = path.toLowerCase().split('/').at(-1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1)
}

function hasExtension(path) {
  return path.split('/').at(-1).includes('.')
}

function increment(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1)
}

function compareCodePoints(left, right) {
  return left < right ? -1 : left > right ? 1 : 0
}
