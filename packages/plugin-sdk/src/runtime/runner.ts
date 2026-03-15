import type {
  SearchPluginFetchInput,
  SearchPluginModule,
  SearchPluginRunTrace,
  SearchPluginSearchInput,
} from '../types.js'
import { normalizeSearchPluginManifest } from '../validation/manifest.js'
import { createPluginContext } from './context.js'
import { loadPlugin } from './load-module.js'
import { initParseHtml } from './node-html.js'

export interface RunPluginOptions {
  source: string
  input: SearchPluginSearchInput
  enforceHosts?: boolean
  fetch?: (
    input: SearchPluginFetchInput,
  ) => Promise<{ bodyText: string; statusCode: number; bytes: number }>
  timeoutMs?: number
}

export interface RunPluginResult {
  module?: SearchPluginModule
  trace: SearchPluginRunTrace
}

function buildErrorTrace(
  phase: 'load' | 'manifest' | 'search',
  error: unknown,
  durationMs: number,
  trace: Partial<SearchPluginRunTrace>,
): SearchPluginRunTrace {
  return {
    ok: false,
    durationMs,
    results: trace.results ?? [],
    logs: trace.logs ?? [],
    requests: trace.requests ?? [],
    error: {
      phase,
      name: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    },
  }
}

export async function runPlugin(options: RunPluginOptions): Promise<RunPluginResult> {
  const startTime = Date.now()

  await initParseHtml()

  let module: SearchPluginModule
  try {
    module = loadPlugin(options.source)
  } catch (error) {
    return {
      trace: buildErrorTrace('load', error, Date.now() - startTime, {}),
    }
  }

  const manifest = module && typeof module.manifest === 'object' ? module.manifest : undefined
  if (!manifest || typeof manifest.name !== 'string' || !Array.isArray(manifest.hosts)) {
    return {
      trace: buildErrorTrace(
        'manifest',
        new Error('Plugin manifest must export `name` and `hosts`'),
        Date.now() - startTime,
        {},
      ),
    }
  }

  if (!module || typeof module.search !== 'function') {
    return {
      module,
      trace: buildErrorTrace(
        'manifest',
        new Error('Plugin must export a `search(ctx, input)` function'),
        Date.now() - startTime,
        {},
      ),
    }
  }

  let normalizedHosts: string[] | undefined
  try {
    const normalized = normalizeSearchPluginManifest(manifest)
    normalizedHosts = normalized.hosts
  } catch (error) {
    return {
      module,
      trace: buildErrorTrace('manifest', error, Date.now() - startTime, {}),
    }
  }

  const enforceHosts = options.enforceHosts !== false
  const { ctx, collector } = createPluginContext({
    allowedHosts: enforceHosts ? normalizedHosts : undefined,
    fetch: options.fetch,
  })

  try {
    const searchPromise = Promise.resolve(module.search(ctx, options.input))
    const timeoutMs = options.timeoutMs ?? 30000

    await Promise.race([
      searchPromise,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`Plugin search timed out after ${timeoutMs}ms`)),
          timeoutMs,
        ),
      ),
    ])

    return {
      module,
      trace: {
        ok: true,
        durationMs: Date.now() - startTime,
        results: collector.results,
        logs: collector.logs,
        requests: collector.requests,
      },
    }
  } catch (error) {
    return {
      module,
      trace: buildErrorTrace('search', error, Date.now() - startTime, collector),
    }
  }
}
