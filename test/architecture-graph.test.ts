import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ARCHITECTURE_GRAPH_LIMITS,
  buildArchitectureFallbackData,
  buildMermaidDefinition,
  parseArchitectureGraph,
  validateCitations,
} from '../src/lib/architecture-graph.js'

const repository = {
  owner: 'owner',
  repo: 'repo',
  sha: 'a'.repeat(40),
}

const files = [
  { id: 'F1', path: 'src/main.js', text: 'one\ntwo\nthree', lineCount: 3 },
  { id: 'F2', path: 'src/lib/api.js', text: 'one\ntwo', lineCount: 2 },
]

test('parses a bounded architecture graph and validates every citation', () => {
  const graph = parseArchitectureGraph({
    caption: '선택한 파일에서 확인한 요청 흐름',
    nodes: [
      {
        id: 'entry',
        label: 'src/main.js',
        kind: 'entry',
        description: '애플리케이션 시작점',
        citations: [
          { fileId: 'F1', start: 1, end: 2 },
          { fileId: 'F1', start: 0, end: 1 },
        ],
      },
      {
        id: 'api',
        label: 'API client',
        kind: 'service',
        description: '외부 요청 담당',
        citations: [{ fileId: 'F2', start: 1, end: 2 }],
      },
    ],
    edges: [
      {
        from: 'entry',
        to: 'api',
        relation: 'calls',
        citations: [
          { fileId: 'F1', start: 2, end: 3 },
          { fileId: 'missing', start: 1, end: 1 },
        ],
      },
    ],
  }, repository, files)

  assert.equal(graph.nodes.length, 2)
  assert.equal(graph.nodes[0].citations.length, 1)
  assert.equal(graph.edges.length, 1)
  assert.equal(graph.edges[0].citations.length, 1)
  assert.equal(
    graph.nodes[0].citations[0].url,
    `https://github.com/owner/repo/blob/${repository.sha}/src/main.js#L1-L2`,
  )
})

test('drops invalid, duplicate, dangling, and excess graph items', () => {
  const nodes = Array.from({ length: ARCHITECTURE_GRAPH_LIMITS.maxNodes + 3 }, (_, index) => ({
    id: `N${index}`,
    label: `Node ${index}`,
    kind: 'library',
  }))
  nodes[1] = { id: 'N0', label: 'duplicate', kind: 'service' }
  nodes[2] = { id: 'bad id', label: 'invalid id', kind: 'service' }
  nodes[3] = { id: 'N3', label: 'invalid kind', kind: 'script' }

  const graph = parseArchitectureGraph({
    nodes,
    edges: [
      { from: 'N0', to: 'N4', relation: 'imports' },
      { from: 'N0', to: 'N4', relation: 'imports' },
      { from: 'N0', to: 'N0', relation: 'calls' },
      { from: 'N0', to: 'missing', relation: 'calls' },
      { from: 'N0', to: 'N4', relation: 'executes' },
      ...Array.from({ length: 20 }, (_, index) => ({
        from: 'N4',
        to: `N${5 + (index % 4)}`,
        relation: index % 2 === 0 ? 'calls' : 'reads',
      })),
    ],
  }, repository, files)

  assert.ok(graph.nodes.length <= ARCHITECTURE_GRAPH_LIMITS.maxNodes)
  assert.ok(graph.edges.length <= ARCHITECTURE_GRAPH_LIMITS.maxEdges)
  assert.equal(graph.nodes.some((node) => node.id === 'bad id'), false)
  assert.equal(graph.edges.filter((edge) => edge.from === 'N0' && edge.to === 'N4').length, 1)
  assert.equal(graph.edges.some((edge) => edge.from === edge.to), false)
  assert.equal(graph.edges.some((edge) => edge.to === 'missing'), false)
})

test('generates only an app-controlled Mermaid flowchart subset from hostile labels', () => {
  const graph = parseArchitectureGraph({
    caption: '<script>alert(1)</script>',
    nodes: [
      {
        id: 'attacker_id',
        label: 'Entry"]\nclick n0 "javascript:alert(1)"\n%%{init: {securityLevel:"loose"}}%%',
        kind: 'entry',
        description: '<img src=x onerror=alert(1)>',
      },
      {
        id: 'target',
        label: 'API | node --> external',
        kind: 'service',
      },
    ],
    edges: [{ from: 'attacker_id', to: 'target', relation: 'calls' }],
  }, repository, files)

  const definition = buildMermaidDefinition(graph)
  const lines = definition.split('\n')
  assert.equal(lines[0], 'flowchart TD')
  assert.equal(lines.length, 4)
  assert.match(lines[1], /^  n0\["[^"\n<>\[\]{}|%]+"\]$/u)
  assert.match(lines[2], /^  n1\["[^"\n<>\[\]{}|%]+"\]$/u)
  assert.equal(lines[3], '  n0 -->|호출| n1')
  assert.doesNotMatch(definition, /\n\s*(?:click|style|classDef|linkStyle)|%%\{|https?:\/\/|javascript:/i)
  assert.doesNotMatch(definition, /attacker_id/)
})

test('builds renderer-independent HTML fallback data with Korean enum labels', () => {
  const graph = parseArchitectureGraph({
    caption: '개념 구조',
    nodes: [
      { id: 'ui', label: 'Side panel', kind: 'ui', description: '결과 표시' },
      { id: 'store', label: 'IndexedDB', kind: 'data', description: '결과 저장' },
    ],
    edges: [{ from: 'ui', to: 'store', relation: 'writes' }],
  }, repository, files)

  const fallback = buildArchitectureFallbackData(graph)
  assert.deepEqual(fallback.nodes.map((node) => node.kindLabel), ['UI', '데이터'])
  assert.deepEqual(fallback.relationships[0], {
    fromId: 'ui',
    fromLabel: 'Side panel',
    toId: 'store',
    toLabel: 'IndexedDB',
    relation: 'writes',
    relationLabel: '기록',
    citations: [],
  })
})

test('returns safe empty values for missing graph data and invalid repository evidence', () => {
  assert.equal(parseArchitectureGraph(null, repository, files), null)
  assert.equal(parseArchitectureGraph({ nodes: [], edges: [] }, repository, files), null)
  assert.equal(parseArchitectureGraph({ nodes: [{ id: 'only', label: 'Only node', kind: 'entry' }] }, repository, files), null)
  assert.equal(buildMermaidDefinition(null), '')
  assert.deepEqual(buildArchitectureFallbackData(null), { caption: '', nodes: [], relationships: [] })
  assert.deepEqual(validateCitations([{ fileId: 'F1', start: 1, end: 1 }], { ...repository, sha: 'bad' }, files), [])
})
