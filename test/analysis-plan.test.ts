import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANALYSIS_DEPTH,
  ANALYSIS_PLAN_VERSION,
  ANALYSIS_SELECTOR_VERSION,
  createAnalysisPlan,
  parseAnalysisPlan,
  resolveEffectiveAnalysisFileLimit,
} from '../src/lib/analysis-plan.js'

test('creates a canonical deep plan by default', () => {
  assert.deepEqual(createAnalysisPlan(), {
    version: ANALYSIS_PLAN_VERSION,
    depth: ANALYSIS_DEPTH.deep,
    selectorVersion: ANALYSIS_SELECTOR_VERSION,
    maxFiles: 16,
  })
  assert.deepEqual(createAnalysisPlan({ depth: 'overview', maxFiles: 24 }), {
    version: 1,
    depth: 'overview',
    selectorVersion: 'local-two-stage-v1',
    maxFiles: 24,
  })
})

test('strictly parses only the exact version-1 analysis plan schema', () => {
  const canonical = {
    version: 1,
    depth: 'deep',
    selectorVersion: 'local-two-stage-v1',
    maxFiles: 32,
  }
  assert.deepEqual(parseAnalysisPlan(canonical), canonical)

  for (const invalid of [
    undefined,
    null,
    [],
    { ...canonical, version: 2 },
    { ...canonical, depth: 'quick' },
    { ...canonical, selectorVersion: 'local-two-stage-v2' },
    { ...canonical, maxFiles: 0 },
    { ...canonical, maxFiles: 33 },
    { ...canonical, maxFiles: '16' },
    { ...canonical, futureOption: true },
    { depth: 'deep', selectorVersion: 'local-two-stage-v1', maxFiles: 16 },
  ]) {
    assert.throws(() => parseAnalysisPlan(invalid), TypeError)
  }
})

test('rejects invalid plan construction options and file limits', () => {
  assert.throws(() => createAnalysisPlan({ depth: 'quick' }), /overview or deep/)
  assert.throws(() => createAnalysisPlan({ maxFiles: 1.5 }), /integer from 1 through 32/)
  assert.throws(() => createAnalysisPlan({ maxFiles: 32, futureOption: true }), /only depth and maxFiles/)
})

test('resolves overview and deep effective file limits', () => {
  const cases = [
    { maxFiles: 1, overview: 1 },
    { maxFiles: 15, overview: 8 },
    { maxFiles: 16, overview: 8 },
    { maxFiles: 17, overview: 8 },
    { maxFiles: 32, overview: 8 },
  ]

  for (const { maxFiles, overview } of cases) {
    assert.equal(
      resolveEffectiveAnalysisFileLimit(createAnalysisPlan({ depth: 'overview', maxFiles })),
      overview,
    )
    assert.equal(
      resolveEffectiveAnalysisFileLimit(createAnalysisPlan({ depth: 'deep', maxFiles })),
      maxFiles,
    )
  }
})
