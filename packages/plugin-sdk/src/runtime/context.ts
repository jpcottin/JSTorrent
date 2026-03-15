import type {
  SearchPluginContext,
  SearchPluginFetchInput,
  SearchPluginLogEntry,
  SearchPluginRequestTrace,
  SearchResult,
} from '../types.js'
import { ensurePluginFetchAllowed } from '../validation/fetch-policy.js'
import { parseHtml } from './node-html.js'

export interface ContextCollector {
  results: SearchResult[]
  logs: SearchPluginLogEntry[]
  requests: SearchPluginRequestTrace[]
}

export interface CreateContextOptions {
  allowedHosts?: string[]
  fetch?: (
    input: SearchPluginFetchInput,
  ) => Promise<{ bodyText: string; statusCode: number; bytes: number }>
}

export function createPluginContext(options?: CreateContextOptions): {
  ctx: SearchPluginContext
  collector: ContextCollector
} {
  const collector: ContextCollector = {
    results: [],
    logs: [],
    requests: [],
  }

  async function fetchText(input: SearchPluginFetchInput): Promise<string> {
    if (options?.allowedHosts) {
      ensurePluginFetchAllowed(input.url, { allowedHosts: options.allowedHosts })
    }

    const method = input.method ?? 'GET'
    const requestStart = Date.now()
    const requestTrace: SearchPluginRequestTrace = {
      url: input.url,
      method,
    }
    collector.requests.push(requestTrace)

    try {
      let bodyText: string
      let statusCode: number
      let bytes: number

      if (options?.fetch) {
        const response = await options.fetch(input)
        bodyText = response.bodyText
        statusCode = response.statusCode
        bytes = response.bytes
      } else {
        const response = await fetch(input.url, {
          method,
          headers: input.headers,
          body: input.body,
        })
        bodyText = await response.text()
        statusCode = response.status
        bytes = Buffer.byteLength(bodyText)
      }

      requestTrace.status = statusCode
      requestTrace.durationMs = Date.now() - requestStart
      requestTrace.bytes = bytes

      if (statusCode >= 400) {
        requestTrace.error = `HTTP ${statusCode}`
        throw new Error(`Request failed for ${input.url}: HTTP ${statusCode}`)
      }

      return bodyText
    } catch (error) {
      requestTrace.durationMs = Date.now() - requestStart
      if (!requestTrace.error) {
        requestTrace.error = error instanceof Error ? error.message : String(error)
      }
      throw error
    }
  }

  const ctx: SearchPluginContext = {
    encode(value: string) {
      return encodeURIComponent(value)
    },
    fetchText,
    async fetchJson<T = unknown>(input: SearchPluginFetchInput) {
      return JSON.parse(await fetchText(input)) as T
    },
    parseHtml,
    emitResult(result: SearchResult) {
      collector.results.push(result)
    },
    log(level, message) {
      collector.logs.push({ level, message })
    },
  }

  return { ctx, collector }
}
