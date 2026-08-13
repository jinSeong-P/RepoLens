import test from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRepositoryCandidates,
  extractInternalReferences,
  materializeSelection,
  quickFileLimit,
  selectAnchorCandidates,
  selectExpansionCandidates,
} from '../src/lib/repository-selector.js'

const sha = 'a'.repeat(40)
const entry = (path, size = 100, extra = {}) => ({
  type: 'blob', mode: '100644', path, sha, size, ...extra,
})

test('validates the configurable file limit and derives a bounded quick pass', () => {
  assert.equal(quickFileLimit(1), 1)
  assert.equal(quickFileLimit(16), 8)
  assert.equal(quickFileLimit(17), 8)
  assert.equal(quickFileLimit(32), 8)
  for (const value of [0, 33, 1.5, '16', null]) {
    assert.throws(() => quickFileLimit(value), RangeError)
  }
})

test('filters unsafe, binary, generated, oversized, symlink, and malformed tree entries', () => {
  const candidates = buildRepositoryCandidates([
    entry('src/good.ts'),
    entry('../escape.ts'),
    entry('/absolute.ts'),
    entry('src\\windows.ts'),
    entry('assets/logo.png'),
    entry('node_modules/pkg/index.js'),
    entry('src/huge.ts', 100_001),
    entry('src/link.ts', 10, { mode: '120000' }),
    entry('src/bad.ts', 100, { sha: 'bad' }),
  ])
  assert.deepEqual(candidates.map((candidate) => candidate.path), ['src/good.ts'])
})

test('anchor selection is deterministic and balances categories and directories', () => {
  const entries = [
    entry('src/feature-a.ts'), entry('README.md'), entry('src/index.ts'),
    entry('package.json'), entry('docs/architecture.md'), entry('lib/main.ts'),
  ]
  const selected = selectAnchorCandidates(entries, { maxFiles: 4 })
  const reversed = selectAnchorCandidates(entries.toReversed(), { maxFiles: 4 })
  assert.deepEqual(selected.map((candidate) => candidate.path), reversed.map((candidate) => candidate.path))
  assert.equal(new Set(selected.map((candidate) => candidate.category)).size >= 3, true)
  assert.equal(new Set(selected.map((candidate) => candidate.directory)).size >= 3, true)
  assert.ok(selected.every((candidate) => candidate.selectionKind === 'anchor'))
})

test('resolves relative JS/TS imports through exact, extension, and index paths', () => {
  const entries = [
    entry('src/app.ts'), entry('src/util.ts'), entry('src/view/index.tsx'),
    entry('src/exact.js'), entry('outside.ts'),
  ]
  const edges = extractInternalReferences([{
    path: 'src/app.ts',
    text: `
      import { util } from './util'
      export { View } from './view'
      const exact = require('./exact.js')
      const lazy = import('../outside')
      import external from 'external-package'
      import nope from '../../escape'
    `,
  }], entries)
  assert.deepEqual(edges.map((edge) => edge.toPath), [
    'outside.ts', 'src/exact.js', 'src/util.ts', 'src/view/index.tsx',
  ])
})

test('resolves exact package and tsconfig JSON paths but ignores URLs and packages', () => {
  const entries = [
    entry('package.json'), entry('src/index.ts'), entry('src/types.d.ts'),
    entry('configs/tsconfig.app.json'), entry('configs/setup.ts'),
  ]
  const edges = extractInternalReferences([
    {
      path: 'package.json',
      text: JSON.stringify({ main: './src/index', types: './src/types.d.ts', dependency: 'react' }),
    },
    {
      path: 'configs/tsconfig.app.json',
      text: JSON.stringify({ files: ['./setup.ts'], remote: 'https://evil.example/x.js' }),
    },
  ], entries)
  assert.deepEqual(edges.map((edge) => `${edge.fromPath}->${edge.toPath}`), [
    'configs/tsconfig.app.json->configs/setup.ts',
    'package.json->src/index.ts',
    'package.json->src/types.d.ts',
  ])
})

test('ranks referenced files before deterministic balanced fallbacks', () => {
  const entries = [
    entry('src/app.ts'), entry('src/a.ts'), entry('src/b.ts'),
    entry('docs/guide.md'), entry('package.json'),
  ]
  const expansion = selectExpansionCandidates(entries, [{
    path: 'src/app.ts',
    text: `import './b'; import './a';`,
  }], { maxFiles: 4 })
  assert.deepEqual(expansion.slice(0, 2).map((candidate) => candidate.path), ['src/a.ts', 'src/b.ts'])
  assert.ok(expansion.slice(0, 2).every((candidate) => candidate.selectionKind === 'related'))
  assert.ok(expansion.slice(2).every((candidate) => candidate.selectionKind === 'fallback'))
  assert.deepEqual(expansion[0].relatedFromPaths, ['src/app.ts'])
})

test('fairly materializes text under per-file and total budgets with final IDs', () => {
  const long = 'x'.repeat(30_000)
  const result = materializeSelection([
    { path: 'a.ts', text: 'a'.repeat(1_000), selectionKind: 'anchor', reasons: ['anchor'] },
    { path: 'b.ts', text: long, selectionKind: 'related', relatedFromPaths: ['a.ts'] },
    { path: 'c.ts', text: long, selectionKind: 'fallback' },
  ], { maxFiles: 3 })
  assert.equal(result.totalChars, 48_000)
  assert.deepEqual(result.files.map((file) => file.text.length), [1_000, 23_500, 23_500])
  assert.deepEqual(result.files.map((file) => file.id), ['F1', 'F2', 'F3'])
  assert.ok(result.files.every((file) => file.text.length <= 24_000))
  assert.deepEqual(result.metadata.counts, { anchor: 1, related: 1, fallback: 1 })
  assert.equal(result.selectionMetadata, result.metadata)
})

test('materialization rejects unsafe decoded records and never splits a surrogate pair', () => {
  const result = materializeSelection([
    { path: '../secret', text: 'secret' },
    { path: 'binary.ts', text: 'before\u0000after' },
    { path: 'safe.ts', text: `a\u{1F642}b` },
  ], { maxFiles: 3, maxFileChars: 2, maxTotalChars: 2 })
  assert.equal(result.files.length, 1)
  assert.equal(result.files[0].text, 'a')
  assert.equal(result.totalChars, 1)
})
