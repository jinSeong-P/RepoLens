export const ARCHITECTURE_GRAPH_LIMITS = Object.freeze({
  maxNodes: 10,
  maxEdges: 14,
  maxNodeLabelChars: 80,
  maxNodeDescriptionChars: 240,
  maxCaptionChars: 300,
  maxCitationsPerItem: 5,
})

export const ARCHITECTURE_NODE_KINDS = Object.freeze([
  'entry',
  'ui',
  'service',
  'library',
  'data',
  'config',
  'external',
])

export const ARCHITECTURE_RELATIONS = Object.freeze([
  'calls',
  'imports',
  'reads',
  'writes',
  'configures',
  'contains',
  'sends',
  'returns',
  'depends_on',
])

const NODE_KIND_LABELS = Object.freeze({
  entry: '시작점',
  ui: 'UI',
  service: '서비스',
  library: '라이브러리',
  data: '데이터',
  config: '설정',
  external: '외부',
})

const RELATION_LABELS = Object.freeze({
  calls: '호출',
  imports: '가져옴',
  reads: '읽음',
  writes: '기록',
  configures: '설정',
  contains: '포함',
  sends: '전달',
  returns: '반환',
  depends_on: '의존',
})

const NODE_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,23}$/
const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/i
const UNSAFE_FORMATTING = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g
const NON_DIAGRAM_TEXT = /[^\p{L}\p{N}\p{M}\s.,:_/@+\-]/gu
const URI_SCHEME_TEXT = /\b(?:https?|javascript|data|vbscript|file)\s*:/giu

/**
 * Converts untrusted AI graph data into the only graph shape RepoLens stores.
 * Invalid items are discarded and all display text is reduced to a small,
 * newline-free character set before it can reach a diagram renderer.
 */
export function parseArchitectureGraph(value, repository, files) {
  if (!isPlainObject(value) || !Array.isArray(value.nodes) || value.nodes.length === 0) return null

  const nodes = []
  const nodeIds = new Set()
  for (const candidate of value.nodes.slice(0, ARCHITECTURE_GRAPH_LIMITS.maxNodes)) {
    if (!isPlainObject(candidate) || typeof candidate.id !== 'string' || !NODE_ID_PATTERN.test(candidate.id)) continue
    if (nodeIds.has(candidate.id) || !ARCHITECTURE_NODE_KINDS.includes(candidate.kind)) continue

    const label = sanitizeDiagramText(candidate.label, ARCHITECTURE_GRAPH_LIMITS.maxNodeLabelChars)
    if (!label) continue

    nodeIds.add(candidate.id)
    nodes.push({
      id: candidate.id,
      label,
      kind: candidate.kind,
      description: sanitizeDiagramText(candidate.description, ARCHITECTURE_GRAPH_LIMITS.maxNodeDescriptionChars),
      citations: validateCitations(
        Array.isArray(candidate.citations)
          ? candidate.citations.slice(0, ARCHITECTURE_GRAPH_LIMITS.maxCitationsPerItem)
          : [],
        repository,
        files,
      ),
    })
  }
  if (nodes.length < 2) return null

  const edges = []
  const edgeIdentities = new Set()
  const candidates = Array.isArray(value.edges) ? value.edges : []
  for (const candidate of candidates.slice(0, ARCHITECTURE_GRAPH_LIMITS.maxEdges)) {
    if (!isPlainObject(candidate)) continue
    if (!nodeIds.has(candidate.from) || !nodeIds.has(candidate.to) || candidate.from === candidate.to) continue
    if (!ARCHITECTURE_RELATIONS.includes(candidate.relation)) continue

    const identity = `${candidate.from}\u0000${candidate.to}\u0000${candidate.relation}`
    if (edgeIdentities.has(identity)) continue
    edgeIdentities.add(identity)
    edges.push({
      from: candidate.from,
      to: candidate.to,
      relation: candidate.relation,
      citations: validateCitations(
        Array.isArray(candidate.citations)
          ? candidate.citations.slice(0, ARCHITECTURE_GRAPH_LIMITS.maxCitationsPerItem)
          : [],
        repository,
        files,
      ),
    })
  }

  return {
    caption: sanitizeDiagramText(value.caption, ARCHITECTURE_GRAPH_LIMITS.maxCaptionChars)
      || '선택된 파일을 바탕으로 구성한 개념 구조입니다.',
    nodes,
    edges,
  }
}

/**
 * Generates a deliberately tiny Mermaid subset. AI-provided IDs, relation
 * labels, directives, styles, URLs, and Mermaid source are never emitted.
 */
export function buildMermaidDefinition(graph) {
  const fallback = buildArchitectureFallbackData(graph)
  if (fallback.nodes.length === 0) return ''

  const nodeIndex = new Map(fallback.nodes.map((node, index) => [node.id, `n${index}`]))
  const lines = ['flowchart TD']
  for (const node of fallback.nodes) {
    lines.push(`  ${nodeIndex.get(node.id)}["${node.label} · ${node.kindLabel}"]`)
  }
  for (const relationship of fallback.relationships) {
    const from = nodeIndex.get(relationship.fromId)
    const to = nodeIndex.get(relationship.toId)
    if (from && to) lines.push(`  ${from} -->|${relationship.relationLabel}| ${to}`)
  }
  return lines.join('\n')
}

export const buildMermaidSource = buildMermaidDefinition

/**
 * Returns renderer-independent, text-only data for an accessible HTML list.
 * It also defensively normalizes cached graph objects before the UI uses them.
 */
export function buildArchitectureFallbackData(graph) {
  const candidates = isPlainObject(graph) && Array.isArray(graph.nodes) ? graph.nodes : []
  const nodes = []
  const nodeIds = new Set()
  for (const candidate of candidates.slice(0, ARCHITECTURE_GRAPH_LIMITS.maxNodes)) {
    if (!isPlainObject(candidate) || typeof candidate.id !== 'string' || !NODE_ID_PATTERN.test(candidate.id)) continue
    if (nodeIds.has(candidate.id) || !ARCHITECTURE_NODE_KINDS.includes(candidate.kind)) continue
    const label = sanitizeDiagramText(candidate.label, ARCHITECTURE_GRAPH_LIMITS.maxNodeLabelChars)
    if (!label) continue

    nodeIds.add(candidate.id)
    nodes.push({
      id: candidate.id,
      label,
      kind: candidate.kind,
      kindLabel: NODE_KIND_LABELS[candidate.kind],
      description: sanitizeDiagramText(candidate.description, ARCHITECTURE_GRAPH_LIMITS.maxNodeDescriptionChars),
      citations: copyStoredCitations(candidate.citations),
    })
  }

  const byId = new Map(nodes.map((node) => [node.id, node]))
  const relationships = []
  const identities = new Set()
  const edgeCandidates = isPlainObject(graph) && Array.isArray(graph.edges) ? graph.edges : []
  for (const candidate of edgeCandidates.slice(0, ARCHITECTURE_GRAPH_LIMITS.maxEdges)) {
    if (!isPlainObject(candidate)) continue
    const from = byId.get(candidate.from)
    const to = byId.get(candidate.to)
    if (!from || !to || from.id === to.id || !ARCHITECTURE_RELATIONS.includes(candidate.relation)) continue
    const identity = `${from.id}\u0000${to.id}\u0000${candidate.relation}`
    if (identities.has(identity)) continue
    identities.add(identity)
    relationships.push({
      fromId: from.id,
      fromLabel: from.label,
      toId: to.id,
      toLabel: to.label,
      relation: candidate.relation,
      relationLabel: RELATION_LABELS[candidate.relation],
      citations: copyStoredCitations(candidate.citations),
    })
  }

  return {
    caption: sanitizeDiagramText(graph?.caption, ARCHITECTURE_GRAPH_LIMITS.maxCaptionChars),
    nodes,
    relationships,
  }
}

export function validateCitations(citations, repository, files) {
  if (!Array.isArray(citations) || !Array.isArray(files) || !isRepositorySnapshot(repository)) return []
  const byId = new Map(files.map((file) => [file?.id, file]))
  const result = []
  const seen = new Set()

  for (const citation of citations.slice(0, 30)) {
    if (!isPlainObject(citation)) continue
    const file = byId.get(citation.fileId)
    if (!file || !isSafePath(file.path) || !Number.isInteger(file.lineCount) || file.lineCount < 1) continue
    const start = Number(citation.start)
    const end = Number(citation.end ?? citation.start)
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > file.lineCount) continue
    const identity = `${file.id}:${start}:${end}`
    if (seen.has(identity)) continue
    seen.add(identity)

    const encodedPath = file.path.split('/').map(encodeURIComponent).join('/')
    result.push({
      fileId: file.id,
      path: file.path,
      start,
      end,
      label: `${file.path}:L${start}${end === start ? '' : `–L${end}`}`,
      url: `https://github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/blob/${repository.sha}/${encodedPath}#L${start}${end === start ? '' : `-L${end}`}`,
    })
  }
  return result
}

function sanitizeDiagramText(value, maxLength) {
  if (typeof value !== 'string') return ''
  const normalized = value
    .normalize('NFKC')
    .replace(UNSAFE_FORMATTING, ' ')
    .replace(URI_SCHEME_TEXT, ' ')
    .replace(NON_DIAGRAM_TEXT, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return Array.from(normalized).slice(0, maxLength).join('').trim()
}

function copyStoredCitations(citations) {
  if (!Array.isArray(citations)) return []
  const result = []
  const seen = new Set()
  for (const citation of citations.slice(0, ARCHITECTURE_GRAPH_LIMITS.maxCitationsPerItem)) {
    if (!isPlainObject(citation) || !isSafePath(citation.path)) continue
    if (!Number.isInteger(citation.start) || !Number.isInteger(citation.end)) continue
    if (citation.start < 1 || citation.end < citation.start || !isSafeGitHubCitationUrl(citation.url)) continue
    const identity = `${citation.path}:${citation.start}:${citation.end}`
    if (seen.has(identity)) continue
    seen.add(identity)
    result.push({
      fileId: typeof citation.fileId === 'string' ? citation.fileId.slice(0, 30) : '',
      path: citation.path,
      start: citation.start,
      end: citation.end,
      label: `${citation.path}:L${citation.start}${citation.end === citation.start ? '' : `–L${citation.end}`}`,
      url: citation.url,
    })
  }
  return result
}

function isSafeGitHubCitationUrl(value) {
  try {
    const url = new URL(value)
    return url.origin === 'https://github.com'
      && /^\/[^/]+\/[^/]+\/blob\/[0-9a-f]{40}\//i.test(url.pathname)
      && /^#L\d+(?:-L\d+)?$/.test(url.hash)
      && url.search === ''
      && !url.username
      && !url.password
  } catch {
    return false
  }
}

function isRepositorySnapshot(repository) {
  return isPlainObject(repository)
    && isSafeRepositoryPart(repository.owner)
    && isSafeRepositoryPart(repository.repo)
    && typeof repository.sha === 'string'
    && COMMIT_SHA_PATTERN.test(repository.sha)
}

function isSafeRepositoryPart(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9_.-]{1,100}$/.test(value)
    && value !== '.'
    && value !== '..'
}

function isSafePath(path) {
  return typeof path === 'string'
    && path.length <= 500
    && !path.includes('\\')
    && !path.includes('\u0000')
    && !path.split('/').some((part) => part === '..' || part === '')
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
