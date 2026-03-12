import type { IEngineManager } from '../engine-manager/types'
import type { ExtensionSandboxLabHost } from './extension-sandbox-lab-host'
import { createInstalledPluginRecord } from './plugin-utils'
import type {
  InstalledPluginRecord,
  SearchDisplayResult,
  SearchPluginDraftRunResult,
  SearchPluginManifest,
  SearchPluginSearchInput,
  SearchResult,
  SearchRunSummary,
} from './types'

export interface SearchPluginSourceLoadResult {
  source: string
  manifest: SearchPluginManifest
}

export interface SearchPluginInstallPreview extends SearchPluginSourceLoadResult {
  plugin: InstalledPluginRecord
}

export interface SearchPluginSearchOutput {
  results: SearchDisplayResult[]
  summaries: SearchRunSummary[]
}

export class SearchPluginOverlayHost {
  constructor(
    private readonly engineManager: IEngineManager,
    private readonly sandboxHost: ExtensionSandboxLabHost,
  ) {}

  isAvailable(): boolean {
    return this.sandboxHost.isAvailable()
  }

  async listInstalledPlugins(): Promise<InstalledPluginRecord[]> {
    return this.engineManager.listInstalledSearchPlugins()
  }

  async loadSourceFromUrl(url: string): Promise<SearchPluginSourceLoadResult> {
    const source = await this.sandboxHost.fetchSource(url)
    const inspection = await this.sandboxHost.inspectSource(source)
    return {
      source,
      manifest: inspection.manifest,
    }
  }

  async prepareInstallFromUrl(url: string): Promise<SearchPluginInstallPreview> {
    const loaded = await this.loadSourceFromUrl(url)
    const plugin = await createInstalledPluginRecord({
      code: loaded.source,
      manifest: loaded.manifest,
      sourceUrl: url,
    })
    return {
      ...loaded,
      plugin,
    }
  }

  async saveInstalledPlugin(plugin: InstalledPluginRecord): Promise<void> {
    await this.engineManager.saveInstalledSearchPlugin(plugin)
  }

  async installFromUrl(url: string): Promise<InstalledPluginRecord> {
    const prepared = await this.prepareInstallFromUrl(url)
    await this.saveInstalledPlugin(prepared.plugin)
    return prepared.plugin
  }

  async removeInstalledPlugin(pluginId: string): Promise<void> {
    await this.engineManager.removeInstalledSearchPlugin(pluginId)
  }

  async setPluginEnabled(
    plugin: InstalledPluginRecord,
    enabled: boolean,
  ): Promise<InstalledPluginRecord> {
    const updatedPlugin: InstalledPluginRecord = {
      ...plugin,
      enabled,
      updatedAt: Date.now(),
    }
    await this.saveInstalledPlugin(updatedPlugin)
    return updatedPlugin
  }

  async runDraft(
    source: string,
    input: SearchPluginSearchInput,
  ): Promise<SearchPluginDraftRunResult> {
    return this.sandboxHost.runDraft(source, input)
  }

  async runSearch(
    plugins: InstalledPluginRecord[],
    input: SearchPluginSearchInput,
  ): Promise<SearchPluginSearchOutput> {
    const summaries: SearchRunSummary[] = []
    const aggregateResults: SearchDisplayResult[] = []

    for (const plugin of plugins) {
      try {
        const result = await this.runDraft(plugin.code, input)
        aggregateResults.push(
          ...result.trace.results.map((entry: SearchResult) => ({
            pluginId: plugin.pluginId,
            pluginName: plugin.manifest.name,
            allowedHosts: plugin.manifest.hosts,
            result: entry,
          })),
        )
        summaries.push({
          pluginId: plugin.pluginId,
          pluginName: plugin.manifest.name,
          ok: result.trace.ok,
          durationMs: result.trace.durationMs,
          resultCount: result.trace.results.length,
          errorMessage: result.trace.error?.message,
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        summaries.push({
          pluginId: plugin.pluginId,
          pluginName: plugin.manifest.name,
          ok: false,
          durationMs: 0,
          resultCount: 0,
          errorMessage: message,
        })
      }
    }

    aggregateResults.sort((left, right) => {
      const leftSeeds = left.result.seeds ?? -1
      const rightSeeds = right.result.seeds ?? -1
      if (leftSeeds !== rightSeeds) {
        return rightSeeds - leftSeeds
      }
      return left.result.name.localeCompare(right.result.name)
    })

    return {
      results: aggregateResults,
      summaries,
    }
  }

  async addSearchResult(
    displayResult: SearchDisplayResult,
  ): Promise<{ isDuplicate: boolean; mode: 'magnet' | 'torrent' }> {
    const engine = await this.engineManager.init()

    if (displayResult.result.magnetUrl) {
      const added = await engine.addTorrent(displayResult.result.magnetUrl)
      return {
        isDuplicate: added.isDuplicate,
        mode: 'magnet',
      }
    }

    if (displayResult.result.torrentUrl) {
      const response = await this.engineManager.searchPluginFetch(
        {
          url: displayResult.result.torrentUrl,
          method: 'GET',
        },
        { allowedHosts: displayResult.allowedHosts },
      )

      if (response.statusCode >= 400) {
        throw new Error(`Torrent download failed: HTTP ${response.statusCode}`)
      }

      const added = await engine.addTorrent(response.bodyBytes)
      return {
        isDuplicate: added.isDuplicate,
        mode: 'torrent',
      }
    }

    throw new Error('Result does not include a magnet or torrent URL')
  }
}
