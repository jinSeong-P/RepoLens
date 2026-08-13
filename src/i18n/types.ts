export const SUPPORTED_UI_LOCALES = ['ko', 'en'] as const
export type UiLocale = (typeof SUPPORTED_UI_LOCALES)[number]

export const SUPPORTED_OUTPUT_LOCALES = ['ko', 'en'] as const
export type AiOutputLocale = (typeof SUPPORTED_OUTPUT_LOCALES)[number]

export const UI_PREFERENCES_STORAGE_KEY = 'uiPreferences'
export const UI_PREFERENCES_VERSION = 1
export const DEFAULT_UI_LOCALE: UiLocale = 'ko'
export const DEFAULT_OUTPUT_LOCALE: AiOutputLocale = 'ko'

export interface UiPreferences {
  version: typeof UI_PREFERENCES_VERSION
  uiLocale: UiLocale
  aiOutputLocale: AiOutputLocale
}

export function isUiLocale(value: unknown): value is UiLocale {
  return typeof value === 'string' && SUPPORTED_UI_LOCALES.includes(value as UiLocale)
}

export function isAiOutputLocale(value: unknown): value is AiOutputLocale {
  return typeof value === 'string' && SUPPORTED_OUTPUT_LOCALES.includes(value as AiOutputLocale)
}

export function normalizeUiPreferences(value?: unknown): UiPreferences {
  const candidate = isRecord(value) ? value : {}
  return {
    version: UI_PREFERENCES_VERSION,
    uiLocale: isUiLocale(candidate.uiLocale) ? candidate.uiLocale : DEFAULT_UI_LOCALE,
    aiOutputLocale: isAiOutputLocale(candidate.aiOutputLocale)
      ? candidate.aiOutputLocale
      : DEFAULT_OUTPUT_LOCALE,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
