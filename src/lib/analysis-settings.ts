export const ANALYSIS_SETTINGS_STORAGE_KEY = 'analysisSettings'
export const ANALYSIS_SETTINGS_VERSION = 1
export const ANALYSIS_FILE_LIMIT = Object.freeze({
  default: 16,
  min: 1,
  max: 32,
})

export interface AnalysisSettings {
  version: typeof ANALYSIS_SETTINGS_VERSION
  maxFiles: number
}

type UnknownRecord = Record<string, unknown>

export function normalizeAnalysisSettings(value?: unknown): AnalysisSettings {
  if (!isRecord(value)
    || value.version !== ANALYSIS_SETTINGS_VERSION
    || Object.keys(value).some((key) => !['version', 'maxFiles'].includes(key))) {
    return defaultAnalysisSettings()
  }
  try {
    return {
      version: ANALYSIS_SETTINGS_VERSION,
      maxFiles: parseAnalysisFileLimit(value.maxFiles),
    }
  } catch {
    return defaultAnalysisSettings()
  }
}

export function defaultAnalysisSettings(): AnalysisSettings {
  return {
    version: ANALYSIS_SETTINGS_VERSION,
    maxFiles: ANALYSIS_FILE_LIMIT.default,
  }
}

export function resolveAnalysisFileLimit(value?: unknown): number {
  return value === undefined ? ANALYSIS_FILE_LIMIT.default : parseAnalysisFileLimit(value)
}

export function parseAnalysisFileLimit(value: unknown): number {
  if (typeof value !== 'number'
    || !Number.isInteger(value)
    || value < ANALYSIS_FILE_LIMIT.min
    || value > ANALYSIS_FILE_LIMIT.max) {
    throw new RangeError(`선택 파일 수는 ${ANALYSIS_FILE_LIMIT.min}~${ANALYSIS_FILE_LIMIT.max} 사이의 정수여야 합니다.`)
  }
  return value
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
