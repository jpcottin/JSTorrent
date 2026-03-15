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

// Validation
export { normalizeSearchPluginManifest, normalizeDeclaredHost } from './validation/manifest.js'
export { ensurePluginFetchAllowed } from './validation/fetch-policy.js'
export { validateSearchResult } from './validation/result.js'
export { validateModuleSource } from './validation/source.js'
export type { SourceValidationResult } from './validation/source.js'

// Runtime
export { transformModuleSource } from './runtime/transform.js'
export { loadPlugin } from './runtime/load-module.js'
export { runPlugin } from './runtime/runner.js'
export { initParseHtml, parseHtml } from './runtime/node-html.js'
export type { RunPluginOptions, RunPluginResult } from './runtime/runner.js'
