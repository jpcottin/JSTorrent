// Re-export plugin-facing types from SDK
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
} from '@jstorrent/plugin-sdk'

// Client-only types

export interface SearchRunSummary {
  pluginId: string
  pluginName: string
  ok: boolean
  durationMs: number
  resultCount: number
  errorMessage?: string
}

export interface SearchDisplayResult {
  pluginId: string
  pluginName: string
  allowedHosts: string[]
  result: import('@jstorrent/plugin-sdk').SearchResult
}

export interface SearchPluginDraftRunResult {
  manifest?: import('@jstorrent/plugin-sdk').SearchPluginManifest
  trace: import('@jstorrent/plugin-sdk').SearchPluginRunTrace
}

export interface SearchPluginSourceInspection {
  manifest: import('@jstorrent/plugin-sdk').SearchPluginManifest
}

export interface InstalledPluginRecord {
  pluginId: string
  manifest: import('@jstorrent/plugin-sdk').SearchPluginManifest
  sourceUrl?: string
  sourceHash: string
  installedAt: number
  updatedAt: number
  enabled: boolean
  code: string
}

export interface SearchPluginHost {
  install(source: string): Promise<InstalledPluginRecord>
  run(
    pluginId: string,
    input: import('@jstorrent/plugin-sdk').SearchPluginSearchInput,
  ): Promise<import('@jstorrent/plugin-sdk').SearchPluginRunTrace>
  list(): Promise<InstalledPluginRecord[]>
  update(pluginId: string): Promise<void>
  remove(pluginId: string): Promise<void>
}
