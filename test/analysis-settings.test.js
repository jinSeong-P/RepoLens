import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ANALYSIS_FILE_LIMIT,
  ANALYSIS_SETTINGS_VERSION,
  defaultAnalysisSettings,
  normalizeAnalysisSettings,
  parseAnalysisFileLimit,
  resolveAnalysisFileLimit,
} from '../src/lib/analysis-settings.js'

test('defaults missing or malformed analysis settings to 16 files', () => {
  const expected = { version: ANALYSIS_SETTINGS_VERSION, maxFiles: ANALYSIS_FILE_LIMIT.default }
  assert.deepEqual(defaultAnalysisSettings(), expected)
  assert.deepEqual(normalizeAnalysisSettings(), expected)
  assert.deepEqual(normalizeAnalysisSettings({ version: 99, maxFiles: 32 }), expected)
  assert.deepEqual(normalizeAnalysisSettings({ maxFiles: 24 }), expected)
  assert.deepEqual(normalizeAnalysisSettings({ version: 1, maxFiles: '16' }), expected)
  assert.deepEqual(normalizeAnalysisSettings({ version: 1, maxFiles: 33 }), expected)
  assert.deepEqual(normalizeAnalysisSettings({ version: 1, maxFiles: 24, futureOption: true }), expected)
})

test('accepts only integer analysis file limits from 1 through 32', () => {
  for (const value of [1, 16, 32]) assert.equal(parseAnalysisFileLimit(value), value)
  for (const value of [0, 33, -1, 1.5, '16', NaN, null]) {
    assert.throws(() => parseAnalysisFileLimit(value), RangeError)
  }
  assert.equal(resolveAnalysisFileLimit(), 16)
  assert.throws(() => resolveAnalysisFileLimit(0), RangeError)
})

test('normalizes a canonical versioned analysis settings record', () => {
  assert.deepEqual(normalizeAnalysisSettings({ version: 1, maxFiles: 24 }), {
    version: 1,
    maxFiles: 24,
  })
})
