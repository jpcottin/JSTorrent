import type {
  SearchPluginContext,
  SearchPluginFetchInput,
  SearchPluginLogEntry,
  SearchPluginRequestTrace,
  SearchResult,
} from '../types.js'
import { ensurePluginFetchAllowed } from '../validation/fetch-policy.js'
import { parseHtml } from '../runtime/node-html.js'

export type MockFetchHandler = (
  input: SearchPluginFetchInput,
) => Promise<{ bodyText: string; statusCode: number }> | { bodyText: string; statusCode: number }

export interface TestContextOptions {
  fetch?: MockFetchHandler
  allowedHosts?: string[]
}

export interface TestContext {
  ctx: SearchPluginContext
  results: SearchResult[]
  logs: SearchPluginLogEntry[]
  requests: SearchPluginRequestTrace[]
}

export function createTestContext(options?: TestContextOptions): TestContext {
  const results: SearchResult[] = []
  const logs: SearchPluginLogEntry[] = []
  const requests: SearchPluginRequestTrace[] = []

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
    requests.push(requestTrace)

    try {
      let bodyText: string
      let statusCode: number

      if (options?.fetch) {
        const response = await Promise.resolve(options.fetch(input))
        bodyText = response.bodyText
        statusCode = response.statusCode
      } else {
        const response = await fetch(input.url, {
          method,
          headers: input.headers,
          body: input.body,
        })
        bodyText = await response.text()
        statusCode = response.status
      }

      requestTrace.status = statusCode
      requestTrace.durationMs = Date.now() - requestStart
      requestTrace.bytes = Buffer.byteLength(bodyText)

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
      results.push(result)
    },
    log(level, message) {
      logs.push({ level, message })
    },
  }

  return { ctx, results, logs, requests }
}
