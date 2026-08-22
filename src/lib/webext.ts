interface FirefoxSidebarActionApi {
  open(): Promise<void>
}

type CrossBrowserExtensionApi = typeof chrome & {
  sidebarAction?: FirefoxSidebarActionApi
}

type ExtensionGlobals = typeof globalThis & {
  browser?: typeof chrome
  chrome?: typeof chrome
}

/**
 * Firefox exposes the Promise-based `browser` namespace, while Chrome exposes
 * `chrome`. RepoLens already relies on Promise-returning WebExtension methods,
 * so selecting the native namespace keeps the rest of the runtime portable
 * without a bundled polyfill.
 */
function resolveExtensionApi(): CrossBrowserExtensionApi {
  const globals = globalThis as ExtensionGlobals
  const api = globals.browser ?? globals.chrome
  if (!api) throw new Error('WebExtension API is unavailable.')
  return api as CrossBrowserExtensionApi
}

export const webext = resolveExtensionApi()

