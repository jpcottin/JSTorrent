export type SearchPluginCategory = string

export interface SearchPluginManifest {
  id?: string
  name: string
  version?: string
  description?: string
  homepage?: string
  source?: string
  hosts: string[]
  categories?: SearchPluginCategory[]
}

export interface SearchPluginSearchInput {
  query: string
  category?: SearchPluginCategory
}

export interface SearchPluginFetchInput {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
}

export interface SearchPluginFetchPolicy {
  allowedHosts?: string[]
}

export interface SearchPluginFetchResponse {
  bodyText: string
  bodyBytes: Uint8Array
  bytes: number
  statusCode: number
  remoteAddress?: string
  finalUrl?: string
}

export interface SearchResult {
  name: string
  source: string
  size?: number
  seeds?: number
  leeches?: number
  magnetUrl?: string
  torrentUrl?: string
  infoHash?: string
  detailsUrl?: string
  publishedAt?: number
}

export type SearchPluginLogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface SearchPluginLogEntry {
  level: SearchPluginLogLevel
  message: string
}

export interface SearchPluginRequestTrace {
  url: string
  method: string
  status?: number
  durationMs?: number
  bytes?: number
  remoteAddress?: string
  error?: string
}

export interface SearchPluginRunError {
  phase: 'load' | 'manifest' | 'search' | 'parse'
  name: string
  message: string
  stack?: string
}

export interface SearchPluginRunTrace {
  ok: boolean
  durationMs: number
  results: SearchResult[]
  logs: SearchPluginLogEntry[]
  requests: SearchPluginRequestTrace[]
  error?: SearchPluginRunError
}

export interface SearchPluginHtmlNode {
  text(): string
  html(): string
  attr(name: string): string | undefined
  query(selector: string): SearchPluginHtmlNode | null
  queryAll(selector: string): SearchPluginHtmlNode[]
}

export type SearchPluginHtmlDocument = SearchPluginHtmlNode

export interface SearchPluginContext {
  encode(value: string): string
  fetchText(input: SearchPluginFetchInput): Promise<string>
  fetchJson<T = unknown>(input: SearchPluginFetchInput): Promise<T>
  parseHtml(html: string): SearchPluginHtmlDocument
  emitResult(result: SearchResult): void
  log(level: SearchPluginLogLevel, message: string): void
}

export interface SearchPluginModule {
  manifest: SearchPluginManifest
  search(ctx: SearchPluginContext, input: SearchPluginSearchInput): Promise<void> | void
}
