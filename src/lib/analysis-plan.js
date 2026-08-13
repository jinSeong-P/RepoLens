import { resolveAnalysisFileLimit } from './analysis-settings.js'

export const ANALYSIS_PLAN_VERSION = 1
export const ANALYSIS_SELECTOR_VERSION = 'local-two-stage-v1'
export const ANALYSIS_DEPTH = Object.freeze({
  overview: 'overview',
  deep: 'deep',
})

const ANALYSIS_PLAN_KEYS = Object.freeze([
  'version',
  'depth',
  'selectorVersion',
  'maxFiles',
])

/** Builds the canonical, serializable plan used for one analysis run. */
export function createAnalysisPlan(value = {}) {
  if (!isPlainObject(value)
    || Object.keys(value).some((key) => !['depth', 'maxFiles'].includes(key))) {
    throw new TypeError('Analysis plan options must contain only depth and maxFiles.')
  }

  const depth = value.depth ?? ANALYSIS_DEPTH.deep
  requireAnalysisDepth(depth)

  return Object.freeze({
    version: ANALYSIS_PLAN_VERSION,
    depth,
    selectorVersion: ANALYSIS_SELECTOR_VERSION,
    maxFiles: requireAnalysisFileLimit(value.maxFiles),
  })
}

/** Parses an untrusted stored/RPC value using the exact version-1 schema. */
export function parseAnalysisPlan(value) {
  if (!isPlainObject(value)
    || Object.keys(value).length !== ANALYSIS_PLAN_KEYS.length
    || ANALYSIS_PLAN_KEYS.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError('Analysis plan must use the exact version-1 schema.')
  }
  if (value.version !== ANALYSIS_PLAN_VERSION) {
    throw new TypeError(`Analysis plan version must be ${ANALYSIS_PLAN_VERSION}.`)
  }
  if (value.selectorVersion !== ANALYSIS_SELECTOR_VERSION) {
    throw new TypeError(`Analysis selector version must be ${ANALYSIS_SELECTOR_VERSION}.`)
  }
  requireAnalysisDepth(value.depth)

  return Object.freeze({
    version: ANALYSIS_PLAN_VERSION,
    depth: value.depth,
    selectorVersion: ANALYSIS_SELECTOR_VERSION,
    maxFiles: requireAnalysisFileLimit(value.maxFiles),
  })
}

/**
 * Overview reads a deliberately smaller first-pass set. Deep analysis can use
 * the full user-selected limit, including when it starts without an overview.
 */
export function resolveEffectiveAnalysisFileLimit(plan) {
  const canonical = parseAnalysisPlan(plan)
  return canonical.depth === ANALYSIS_DEPTH.overview
    ? Math.min(8, Math.ceil(canonical.maxFiles / 2))
    : canonical.maxFiles
}

function requireAnalysisDepth(value) {
  if (value !== ANALYSIS_DEPTH.overview && value !== ANALYSIS_DEPTH.deep) {
    throw new TypeError('Analysis plan depth must be overview or deep.')
  }
  return value
}

function requireAnalysisFileLimit(value) {
  try {
    return resolveAnalysisFileLimit(value)
  } catch {
    throw new TypeError('Analysis plan maxFiles must be an integer from 1 through 32.')
  }
}

function isPlainObject(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
