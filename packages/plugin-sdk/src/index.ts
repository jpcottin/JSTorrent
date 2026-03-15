// Types
export type {
  SearchPluginCategory,
  SearchPluginManifest,
  SearchPluginSearchInput,
  SearchPluginFetchInput,
  SearchPluginFetchPolicy,
  SearchPluginFetchResponse,
  SearchResult,
  SearchPluginLogLevel,
  SearchPluginLogEntry,
  SearchPluginRequestTrace,
  SearchPluginRunError,
  SearchPluginRunTrace,
  SearchPluginHtmlNode,
  SearchPluginHtmlDocument,
  SearchPluginContext,
  SearchPluginModule,
} from './types.js'

// Validation (browser-safe, no Node dependencies)
export { normalizeSearchPluginManifest, normalizeDeclaredHost } from './validation/manifest.js'
export { ensurePluginFetchAllowed } from './validation/fetch-policy.js'
export { validateSearchResult } from './validation/result.js'
export { validateModuleSource } from './validation/source.js'
export type { SourceValidationResult } from './validation/source.js'
