import { INTERNET_ARCHIVE_SAMPLE_PLUGIN_SOURCE } from '../packages/client/src/search/samples/internet-archive-plugin-source'
import { NodeHasher } from '../packages/engine/src/adapters/node/node-hasher'
import { TorrentParser } from '../packages/engine/src/core/torrent-parser'
import { infoHashFromBytes } from '../packages/engine/src/utils/infohash'
import type {
  SearchPluginContext,
  SearchPluginLogEntry,
  SearchPluginModule,
  SearchPluginSearchInput,
  SearchResult,
} from '../packages/client/src/search/types'

interface RunTrace {
  durationMs: number
  logs: SearchPluginLogEntry[]
  requests: { url: string; status?: number; bytes?: number; durationMs?: number }[]
  results: SearchResult[]
}

interface SearchCase {
  query: string
  category?: string
}

interface TorrentValidation {
  url: string
  status: number
  bytes: number
  name: string
  infoHash: string
  fileCount: number
  announceCount: number
  webSeedCount: number
}

interface TorrentValidationFailure {
  url: string
  error: string
}

function transformModuleSource(source: string): string {
  const exportedNames: string[] = []
  let transformed = source

  transformed = transformed.replace(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g, (_, name) => {
    exportedNames.push(name)
    return `const ${name} =`
  })

  transformed = transformed.replace(
    /export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
    (_, asyncKeyword, name) => {
      exportedNames.push(name)
      return `${asyncKeyword || ''}function ${name}(`
    },
  )

  if (/\bexport\s+default\b/.test(transformed)) {
    throw new Error('export default is not supported in the node harness')
  }

  if (/\bexport\s+/.test(transformed)) {
    throw new Error('Unsupported export syntax in plugin source')
  }

  const exportLines = exportedNames
    .map((name) => `exports.${name} = typeof ${name} !== 'undefined' ? ${name} : undefined;`)
    .join('\n')

  return `${transformed}\n${exportLines}\nreturn exports;`
}

function loadPluginModule(source: string): SearchPluginModule {
  const transformed = transformModuleSource(source)
  const exportsObject = Object.create(null) as SearchPluginModule
  return new Function('exports', transformed)(exportsObject) as SearchPluginModule
}

async function fetchTextWithTrace(
  input: { url: string; method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string },
  trace: RunTrace,
): Promise<string> {
  const startedAt = Date.now()
  const method = input.method ?? 'GET'
  const requestTrace = {
    url: input.url,
    status: undefined as number | undefined,
    bytes: undefined as number | undefined,
    durationMs: undefined as number | undefined,
  }
  trace.requests.push(requestTrace)

  const response = await fetch(input.url, {
    method,
    headers: input.headers,
    body: input.body,
  })
  const text = await response.text()
  requestTrace.status = response.status
  requestTrace.bytes = Buffer.byteLength(text)
  requestTrace.durationMs = Date.now() - startedAt

  if (!response.ok) {
    throw new Error(`Request failed for ${input.url}: HTTP ${response.status}`)
  }

  return text
}

async function runSearchCase(
  plugin: SearchPluginModule,
  input: SearchPluginSearchInput,
): Promise<RunTrace> {
  const trace: RunTrace = {
    durationMs: 0,
    logs: [],
    requests: [],
    results: [],
  }
  const startedAt = Date.now()

  const ctx: SearchPluginContext = {
    encode(value: string) {
      return encodeURIComponent(value)
    },
    async fetchText(fetchInput) {
      return fetchTextWithTrace(fetchInput, trace)
    },
    async fetchJson<T = unknown>(fetchInput) {
      return JSON.parse(await fetchTextWithTrace(fetchInput, trace)) as T
    },
    parseHtml() {
      throw new Error('parseHtml is not implemented in this harness')
    },
    emitResult(result) {
      trace.results.push(result)
    },
    log(level, message) {
      trace.logs.push({ level, message })
    },
  }

  await plugin.search(ctx, input)
  trace.durationMs = Date.now() - startedAt
  return trace
}

async function validateTorrentUrl(url: string): Promise<TorrentValidation> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Torrent fetch failed for ${url}: HTTP ${response.status}`)
  }

  const bytes = new Uint8Array(await response.arrayBuffer())
  const parsed = await TorrentParser.parse(bytes, new NodeHasher())

  return {
    url,
    status: response.status,
    bytes: bytes.byteLength,
    name: parsed.name,
    infoHash: infoHashFromBytes(parsed.infoHash),
    fileCount: parsed.files.length,
    announceCount: parsed.announce.length,
    webSeedCount: parsed.urlSeeds?.length ?? 0,
  }
}

function printRun(input: SearchCase, trace: RunTrace): void {
  const categoryLabel = input.category ? ` [${input.category}]` : ''
  console.log(`\nQuery: ${input.query}${categoryLabel}`)
  console.log(`Duration: ${trace.durationMs}ms`)
  console.log(`Requests: ${trace.requests.length}`)
  for (const request of trace.requests) {
    console.log(
      `  ${request.status ?? '?'} ${request.url} (${request.bytes ?? 0} bytes, ${request.durationMs ?? 0}ms)`,
    )
  }

  if (trace.logs.length > 0) {
    console.log('Logs:')
    for (const log of trace.logs) {
      console.log(`  [${log.level}] ${log.message}`)
    }
  }

  console.log(`Results: ${trace.results.length}`)
  for (const result of trace.results.slice(0, 5)) {
    console.log(
      `  - ${result.name} | torrent=${result.torrentUrl ?? 'n/a'} | details=${result.detailsUrl ?? 'n/a'}`,
    )
  }
}

function printTorrentValidation(validation: TorrentValidation): void {
  console.log(
    `  - ${validation.name} | infoHash=${validation.infoHash} | files=${validation.fileCount} | trackers=${validation.announceCount} | webSeeds=${validation.webSeedCount} | bytes=${validation.bytes}`,
  )
}

function printTorrentValidationFailure(failure: TorrentValidationFailure): void {
  console.log(`  - FAILED ${failure.url} | ${failure.error}`)
}

async function main(): Promise<void> {
  const plugin = loadPluginModule(INTERNET_ARCHIVE_SAMPLE_PLUGIN_SOURCE)
  if (!plugin.manifest || typeof plugin.search !== 'function') {
    throw new Error('Failed to load Internet Archive sample plugin')
  }

  console.log(`Plugin: ${plugin.manifest.name} (${plugin.manifest.version ?? 'unversioned'})`)
  console.log(`Hosts: ${plugin.manifest.hosts.join(', ')}`)

  const cases: SearchCase[] = [
    { query: 'night of the living dead', category: 'movies' },
    { query: 'sintel', category: 'movies' },
    { query: 'librivox sherlock holmes', category: 'books' },
  ]

  for (const searchCase of cases) {
    const trace = await runSearchCase(plugin, searchCase)
    printRun(searchCase, trace)

    const torrentCandidates = trace.results
      .filter((result) => typeof result.torrentUrl === 'string' && result.torrentUrl.length > 0)
      .slice(0, 3)

    if (torrentCandidates.length === 0) {
      console.log('Torrent validation: no torrent URLs to validate')
      continue
    }

    console.log('Torrent validation:')
    for (const result of torrentCandidates) {
      try {
        const validation = await validateTorrentUrl(result.torrentUrl!)
        printTorrentValidation(validation)
      } catch (error) {
        printTorrentValidationFailure({
          url: result.torrentUrl!,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }
}

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
