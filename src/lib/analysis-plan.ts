import { resolveAnalysisFileLimit } from './analysis-settings.js'

export const ANALYSIS_PLAN_VERSION = 1
export const ANALYSIS_SELECTOR_VERSION = 'local-two-stage-v1'
export const ANALYSIS_DEPTH = Object.freeze({
  overview: 'overview',
  deep: 'deep',
})

export type AnalysisDepth = typeof ANALYSIS_DEPTH[keyof typeof ANALYSIS_DEPTH]

export interface AnalysisPlanOptions {
  depth?: unknown
  maxFiles?: unknown
}

export interface AnalysisPlan {
  readonly version: typeof ANALYSIS_PLAN_VERSION
  readonly depth: AnalysisDepth
  readonly selectorVersion: typeof ANALYSIS_SELECTOR_VERSION
  readonly maxFiles: number
}

type UnknownRecord = Record<string, unknown>

const ANALYSIS_PLAN_KEYS = Object.freeze([
  'version',
  'depth',
  'selectorVersion',
  'maxFiles',
])

/** Builds the canonical, serializable plan used for one analysis run. */
export function createAnalysisPlan(value: AnalysisPlanOptions | unknown = {}): AnalysisPlan {
  if (!isPlainObject(value)
    || Object.keys(value).some((key) => !['depth', 'maxFiles'].includes(key))) {
    throw new TypeError('Analysis plan options must contain only depth and maxFiles.')
  }

  const depth = requireAnalysisDepth(value.depth ?? ANALYSIS_DEPTH.deep)

  return Object.freeze({
    version: ANALYSIS_PLAN_VERSION,
    depth,
    selectorVersion: ANALYSIS_SELECTOR_VERSION,
    maxFiles: requireAnalysisFileLimit(value.maxFiles),
  })
}

/** Parses an untrusted stored/RPC value using the exact version-1 schema. */
export function parseAnalysisPlan(value: unknown): AnalysisPlan {
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
  const depth = requireAnalysisDepth(value.depth)

  return Object.freeze({
    version: ANALYSIS_PLAN_VERSION,
    depth,
    selectorVersion: ANALYSIS_SELECTOR_VERSION,
    maxFiles: requireAnalysisFileLimit(value.maxFiles),
  })
}

/**
 * Overview reads a deliberately smaller first-pass set. Deep analysis can use
 * the full user-selected limit, including when it starts without an overview.
 */
export function resolveEffectiveAnalysisFileLimit(plan: unknown): number {
  const canonical = parseAnalysisPlan(plan)
  return canonical.depth === ANALYSIS_DEPTH.overview
    ? Math.min(8, Math.ceil(canonical.maxFiles / 2))
    : canonical.maxFiles
}

function requireAnalysisDepth(value: unknown): AnalysisDepth {
  if (value !== ANALYSIS_DEPTH.overview && value !== ANALYSIS_DEPTH.deep) {
    throw new TypeError('Analysis plan depth must be overview or deep.')
  }
  return value
}

function requireAnalysisFileLimit(value: unknown): number {
  try {
    return resolveAnalysisFileLimit(value)
  } catch {
    throw new TypeError('Analysis plan maxFiles must be an integer from 1 through 32.')
  }
}

function isPlainObject(value: unknown): value is UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}
