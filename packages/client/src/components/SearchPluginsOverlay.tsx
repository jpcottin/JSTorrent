import { formatBytes } from '@jstorrent/ui'
import { useEffect, useState, type MouseEvent } from 'react'
import { useSearchPluginService } from '../context/SearchPluginServiceContext'
import { standaloneAlert, standaloneConfirm } from '../utils/dialogs'
import { openExternalUrl } from '../utils/external-links'
import type {
  InstalledPluginRecord,
  SearchDisplayResult,
  SearchPluginDraftRunResult,
  SearchPluginManifest,
  SearchPluginSearchInput,
  SearchRunSummary,
} from '../search/types'
import { INTERNET_ARCHIVE_SAMPLE_PLUGIN_SOURCE } from '../search/samples/internet-archive-plugin-source'

type SearchPluginsTab = 'search' | 'installed' | 'add' | 'lab'

interface SearchPluginsOverlayProps {
  isOpen: boolean
  onClose: () => void
}

interface RecommendedPlugin {
  manifest: SearchPluginManifest
  sourceUrl?: string
}

const SEARCH_PLUGINS_OVERLAY_STATE_KEY = 'jstorrent:searchPluginsOverlayState'
const INTERNET_ARCHIVE_PLUGIN_RAW_URL =
  'https://raw.githubusercontent.com/kzahel/jstorrent/main/search-plugins/internet-archive.js'

const EMPTY_DRAFT_RUN_RESULT: SearchPluginDraftRunResult = {
  trace: {
    ok: false,
    durationMs: 0,
    results: [],
    logs: [],
    requests: [],
    error: {
      phase: 'load',
      name: 'HostError',
      message: '',
    },
  },
}

const TABS: { id: SearchPluginsTab; label: string }[] = [
  { id: 'search', label: 'Search' },
  { id: 'installed', label: 'Installed' },
  { id: 'add', label: 'Add from URL' },
  { id: 'lab', label: 'Plugin Lab' },
]

const INITIAL_SAMPLE_SOURCE = INTERNET_ARCHIVE_SAMPLE_PLUGIN_SOURCE

const RECOMMENDED_PLUGINS: RecommendedPlugin[] = [
  {
    manifest: {
      name: 'Internet Archive',
      description: 'First-party provider for public-domain and openly licensed media.',
      hosts: ['archive.org'],
      homepage: 'https://archive.org',
    },
    sourceUrl: INTERNET_ARCHIVE_PLUGIN_RAW_URL,
  },
]

function loadSavedOverlayState(): {
  searchInput: SearchPluginSearchInput
  selectedPluginIds: string[]
} {
  const fallback = {
    searchInput: {
      query: 'night of the living dead',
      category: 'movies',
    },
    selectedPluginIds: [],
  }

  try {
    const raw = globalThis.localStorage?.getItem(SEARCH_PLUGINS_OVERLAY_STATE_KEY)
    if (!raw) return fallback

    const parsed = JSON.parse(raw) as {
      searchInput?: Partial<SearchPluginSearchInput>
      selectedPluginIds?: string[]
    }

    const query =
      typeof parsed.searchInput?.query === 'string' && parsed.searchInput.query.trim().length > 0
        ? parsed.searchInput.query
        : fallback.searchInput.query
    const category =
      typeof parsed.searchInput?.category === 'string' &&
      parsed.searchInput.category.trim().length > 0
        ? parsed.searchInput.category
        : fallback.searchInput.category

    return {
      searchInput: {
        query,
        category,
      },
      selectedPluginIds: Array.isArray(parsed.selectedPluginIds)
        ? parsed.selectedPluginIds.filter((entry): entry is string => typeof entry === 'string')
        : fallback.selectedPluginIds,
    }
  } catch {
    return fallback
  }
}

export function SearchPluginsOverlay({ isOpen, onClose }: SearchPluginsOverlayProps) {
  const pluginService = useSearchPluginService()
  const [activeTab, setActiveTab] = useState<SearchPluginsTab>('search')
  const [installedPlugins, setInstalledPlugins] = useState<InstalledPluginRecord[]>([])
  const [selectedPluginIds, setSelectedPluginIds] = useState<string[]>(
    () => loadSavedOverlayState().selectedPluginIds,
  )
  const [installPreview, setInstallPreview] = useState<SearchPluginManifest | null>(null)
  const [sourceUrl, setSourceUrl] = useState('')
  const [draftSource, setDraftSource] = useState(INITIAL_SAMPLE_SOURCE)
  const [searchInput, setSearchInput] = useState<SearchPluginSearchInput>(
    () => loadSavedOverlayState().searchInput,
  )
  const [draftRunResult, setDraftRunResult] = useState<SearchPluginDraftRunResult | null>(null)
  const [labBusy, setLabBusy] = useState(false)
  const [labStatus, setLabStatus] = useState<string | null>(null)
  const [installBusy, setInstallBusy] = useState(false)
  const [installStatus, setInstallStatus] = useState<string | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [resultActionBusyKey, setResultActionBusyKey] = useState<string | null>(null)
  const [searchStatus, setSearchStatus] = useState<string | null>(null)
  const [searchResults, setSearchResults] = useState<SearchDisplayResult[]>([])
  const [searchSummaries, setSearchSummaries] = useState<SearchRunSummary[]>([])

  useEffect(() => {
    if (!isOpen) return

    void pluginService
      .listInstalledPlugins()
      .then((plugins) => {
        setInstalledPlugins(plugins)
        setSelectedPluginIds((current) => {
          const available = new Set(
            plugins.filter((plugin) => plugin.enabled).map((p) => p.pluginId),
          )
          if (current.length === 0) {
            return Array.from(available)
          }
          const next = current.filter((pluginId) => available.has(pluginId))
          return next.length > 0 ? next : Array.from(available)
        })
      })
      .catch((error) => {
        console.error('[SearchPluginsOverlay] Failed to load installed plugins', error)
        setInstallStatus(error instanceof Error ? error.message : String(error))
      })
  }, [isOpen, pluginService])

  useEffect(() => {
    try {
      globalThis.localStorage?.setItem(
        SEARCH_PLUGINS_OVERLAY_STATE_KEY,
        JSON.stringify({
          searchInput,
          selectedPluginIds,
        }),
      )
    } catch {
      // Ignore storage failures; the overlay still functions without persistence.
    }
  }, [searchInput, selectedPluginIds])

  useEffect(() => {
    if (!isOpen) return

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  const installDisabled = sourceUrl.trim().length === 0
  const runtimeAvailable = pluginService.isAvailable()

  const handleSourceUrlChange = (value: string) => {
    setSourceUrl(value)
    setInstallPreview(null)
    setInstallStatus(null)
  }

  const handleLoadSourceFromUrl = async () => {
    await loadSourceFromUrl(sourceUrl.trim())
  }

  const loadSourceFromUrl = async (url: string) => {
    setInstallBusy(true)
    setInstallStatus('Fetching plugin source...')
    try {
      const loaded = await pluginService.loadSourceFromUrl(url)
      setDraftSource(loaded.source)
      setInstallPreview(loaded.manifest)
      setActiveTab('lab')
      setLabStatus('Fetched source into the plugin lab.')
      setInstallStatus(`Loaded ${loaded.manifest.name} into the plugin lab.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setInstallStatus(message)
      standaloneAlert(message)
    } finally {
      setInstallBusy(false)
    }
  }

  const handleInstallFromUrl = async () => {
    await installFromUrl(sourceUrl.trim())
  }

  const installFromUrl = async (url: string) => {
    setInstallBusy(true)
    setInstallStatus('Fetching plugin source...')
    try {
      const normalizedUrl = url
      const prepared = await pluginService.prepareInstallFromUrl(normalizedUrl)

      const confirmed = standaloneConfirm(
        `Install plugin "${prepared.plugin.manifest.name}"?\n\nDeclared hosts:\n${prepared.plugin.manifest.hosts
          .map((host: string) => `- ${host}`)
          .join('\n')}`,
      )
      if (!confirmed) {
        setInstallStatus('Install cancelled.')
        return
      }

      await pluginService.saveInstalledPlugin(prepared.plugin)

      const refreshed = await pluginService.listInstalledPlugins()
      setInstalledPlugins(refreshed)
      setSelectedPluginIds((current) =>
        current.includes(prepared.plugin.pluginId)
          ? current
          : [...current, prepared.plugin.pluginId],
      )
      setInstallPreview(prepared.manifest)
      setDraftSource(prepared.source)
      setInstallStatus(`Installed ${prepared.plugin.manifest.name}.`)
      setActiveTab('installed')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setInstallStatus(message)
      standaloneAlert(message)
    } finally {
      setInstallBusy(false)
    }
  }

  const handleUseRecommendedUrl = (url: string) => {
    handleSourceUrlChange(url)
    setInstallStatus('Loaded recommended GitHub raw URL.')
    setActiveTab('add')
  }

  const handleInstallRecommendedPlugin = async (url: string) => {
    handleSourceUrlChange(url)
    await installFromUrl(url)
  }

  const handleRemovePlugin = async (pluginId: string) => {
    if (!standaloneConfirm(`Remove installed plugin "${pluginId}"?`)) {
      return
    }

    try {
      await pluginService.removeInstalledPlugin(pluginId)
      const refreshed = await pluginService.listInstalledPlugins()
      setInstalledPlugins(refreshed)
      setSelectedPluginIds((current) => current.filter((id) => id !== pluginId))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      standaloneAlert(message)
    }
  }

  const runSourceInLab = async (
    source: string,
    options?: { sourceLabel?: string; activateLab?: boolean },
  ) => {
    setLabBusy(true)
    if (options?.activateLab) {
      setActiveTab('lab')
    }
    if (options?.sourceLabel) {
      setDraftSource(source)
    }
    setLabStatus(
      options?.sourceLabel
        ? `Running ${options.sourceLabel} in sandbox...`
        : 'Running plugin in sandbox...',
    )

    try {
      const result = await pluginService.runDraft(source, searchInput)
      setDraftRunResult(result)
      setLabStatus(
        result.trace.ok
          ? `Run finished in ${result.trace.durationMs}ms`
          : `Run failed during ${result.trace.error?.phase ?? 'search'}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLabStatus(message)
      setDraftRunResult({
        ...EMPTY_DRAFT_RUN_RESULT,
        trace: {
          ...EMPTY_DRAFT_RUN_RESULT.trace,
          error: {
            phase: 'load',
            name: 'HostError',
            message,
          },
        },
      })
    } finally {
      setLabBusy(false)
    }
  }

  const handleRunDraft = async () => {
    await runSourceInLab(draftSource)
  }

  const handleInstallFromLab = async () => {
    setLabBusy(true)
    try {
      const plugin = await pluginService.installFromSource(draftSource)
      const refreshed = await pluginService.listInstalledPlugins()
      setInstalledPlugins(refreshed)
      setSelectedPluginIds((current) =>
        current.includes(plugin.pluginId) ? current : [...current, plugin.pluginId],
      )
      setLabStatus(`Installed ${plugin.manifest.name}.`)
      setActiveTab('installed')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLabStatus(message)
      standaloneAlert(message)
    } finally {
      setLabBusy(false)
    }
  }

  const handleLoadInstalledPlugin = (plugin: InstalledPluginRecord) => {
    setDraftSource(plugin.code)
    setDraftRunResult(null)
    setLabStatus(`Loaded ${plugin.manifest.name} into the plugin lab.`)
    setActiveTab('lab')
  }

  const handleRunInstalledPlugin = async (plugin: InstalledPluginRecord) => {
    await runSourceInLab(plugin.code, {
      sourceLabel: plugin.manifest.name,
      activateLab: true,
    })
  }

  const handleTogglePluginEnabled = async (plugin: InstalledPluginRecord) => {
    try {
      const updatedPlugin = await pluginService.setPluginEnabled(plugin, !plugin.enabled)
      const refreshed = await pluginService.listInstalledPlugins()
      setInstalledPlugins(refreshed)
      setSelectedPluginIds((current) => {
        if (updatedPlugin.enabled) {
          return current.includes(plugin.pluginId) ? current : [...current, plugin.pluginId]
        }
        return current.filter((id) => id !== plugin.pluginId)
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      standaloneAlert(message)
    }
  }

  const handleToggleSearchPlugin = (pluginId: string) => {
    setSelectedPluginIds((current) =>
      current.includes(pluginId) ? current.filter((id) => id !== pluginId) : [...current, pluginId],
    )
  }

  const handleRunSearch = async () => {
    const selectedPlugins = installedPlugins.filter(
      (plugin) => plugin.enabled && selectedPluginIds.includes(plugin.pluginId),
    )

    if (selectedPlugins.length === 0) {
      setSearchStatus('Select at least one enabled plugin to run a search.')
      return
    }

    setSearchBusy(true)
    setSearchStatus(
      `Running ${selectedPlugins.length} plugin${selectedPlugins.length === 1 ? '' : 's'}...`,
    )
    setSearchResults([])
    setSearchSummaries([])

    try {
      const output = await pluginService.runSearch(selectedPlugins, searchInput)
      setSearchSummaries(output.summaries)
      setSearchResults(output.results)
      setSearchStatus(
        `Search finished: ${output.results.length} results from ${selectedPlugins.length} plugin${selectedPlugins.length === 1 ? '' : 's'}.`,
      )
    } finally {
      setSearchBusy(false)
    }
  }

  const handleAddSearchResult = async (displayResult: SearchDisplayResult) => {
    const actionKey = `${displayResult.pluginId}:${displayResult.result.name}`
    setResultActionBusyKey(actionKey)

    try {
      const added = await pluginService.addSearchResult(displayResult)
      setSearchStatus(
        added.isDuplicate
          ? `Torrent already exists: ${displayResult.result.name}`
          : `Added torrent ${added.mode === 'magnet' ? 'from magnet' : 'file'}: ${displayResult.result.name}`,
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      standaloneAlert(message)
    } finally {
      setResultActionBusyKey(null)
    }
  }

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(event) => event.stopPropagation()}>
        <div style={styles.header}>
          <div>
            <h2 style={styles.title}>Search Plugins</h2>
            <div style={styles.subtitle}>
              URL-installed providers with a small manifest and sandbox-friendly runtime surface.
            </div>
          </div>
          <button style={styles.closeButton} onClick={onClose} title="Close">
            &times;
          </button>
        </div>

        <div style={styles.content}>
          <div style={styles.sidebar}>
            {TABS.map((tab) => (
              <button
                key={tab.id}
                style={{
                  ...styles.tabButton,
                  ...(activeTab === tab.id ? styles.tabButtonActive : {}),
                }}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div style={styles.tabContent}>
            {!runtimeAvailable && (
              <div style={styles.warningBox}>
                Search plugin execution is not available in this runtime.
              </div>
            )}
            {activeTab === 'search' && (
              <SearchTab
                installedPlugins={installedPlugins}
                searchBusy={searchBusy}
                searchInput={searchInput}
                searchResults={searchResults}
                searchStatus={searchStatus}
                searchSummaries={searchSummaries}
                selectedPluginIds={selectedPluginIds}
                resultActionBusyKey={resultActionBusyKey}
                onSearchInputChange={setSearchInput}
                onAddResult={handleAddSearchResult}
                onRunSearch={handleRunSearch}
                onToggleSearchPlugin={handleToggleSearchPlugin}
              />
            )}
            {activeTab === 'installed' && (
              <InstalledTab
                installedPlugins={installedPlugins}
                recommendedPlugins={RECOMMENDED_PLUGINS}
                actionsDisabled={labBusy || searchBusy}
                runtimeAvailable={runtimeAvailable}
                onOpenAddTab={() => setActiveTab('add')}
                onInstallRecommendedPlugin={handleInstallRecommendedPlugin}
                onLoadPlugin={handleLoadInstalledPlugin}
                onUseRecommendedUrl={handleUseRecommendedUrl}
                onRemovePlugin={handleRemovePlugin}
                onRunPlugin={handleRunInstalledPlugin}
                onTogglePluginEnabled={handleTogglePluginEnabled}
              />
            )}
            {activeTab === 'add' && (
              <AddFromUrlTab
                sourceUrl={sourceUrl}
                installDisabled={installDisabled}
                installBusy={installBusy}
                installPreview={installPreview}
                installStatus={installStatus}
                runtimeAvailable={runtimeAvailable}
                onSourceUrlChange={handleSourceUrlChange}
                onLoadSourceFromUrl={handleLoadSourceFromUrl}
                onInstallFromUrl={handleInstallFromUrl}
              />
            )}
            {activeTab === 'lab' && (
              <PluginLabTab
                draftSource={draftSource}
                draftRunResult={draftRunResult}
                labBusy={labBusy}
                labStatus={labStatus}
                runtimeAvailable={runtimeAvailable}
                searchInput={searchInput}
                onDraftSourceChange={setDraftSource}
                onSearchInputChange={setSearchInput}
                onRunDraft={handleRunDraft}
                onInstallFromLab={handleInstallFromLab}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

interface InstalledTabProps {
  installedPlugins: InstalledPluginRecord[]
  recommendedPlugins: RecommendedPlugin[]
  actionsDisabled: boolean
  runtimeAvailable: boolean
  onOpenAddTab: () => void
  onInstallRecommendedPlugin: (url: string) => Promise<void>
  onLoadPlugin: (plugin: InstalledPluginRecord) => void
  onUseRecommendedUrl: (url: string) => void
  onRemovePlugin: (pluginId: string) => void
  onRunPlugin: (plugin: InstalledPluginRecord) => void
  onTogglePluginEnabled: (plugin: InstalledPluginRecord) => void
}

function InstalledTab({
  installedPlugins,
  recommendedPlugins,
  actionsDisabled,
  runtimeAvailable,
  onOpenAddTab,
  onInstallRecommendedPlugin,
  onLoadPlugin,
  onUseRecommendedUrl,
  onRemovePlugin,
  onRunPlugin,
  onTogglePluginEnabled,
}: InstalledTabProps) {
  return (
    <div style={styles.tabPanel}>
      <Section
        title="Installed Providers"
        description="Installed providers are stored as frozen local copies through the host KV store."
      >
        {installedPlugins.length === 0 ? (
          <div style={styles.emptyState}>
            <strong>No plugins installed yet.</strong>
            <p style={styles.emptyStateText}>
              Start with a raw GitHub URL or ship a first-party Internet Archive provider.
            </p>
            <button style={styles.primaryButton} onClick={onOpenAddTab}>
              Add Plugin URL
            </button>
          </div>
        ) : (
          installedPlugins.map((plugin) => (
            <div key={plugin.pluginId} style={styles.pluginCard}>
              <div style={styles.pluginCardHeader}>
                <strong>{plugin.manifest.name}</strong>
                <div style={styles.inlineActions}>
                  <span style={styles.badge}>{plugin.enabled ? 'Enabled' : 'Disabled'}</span>
                  <button
                    style={styles.linkButton}
                    onClick={() => onTogglePluginEnabled(plugin)}
                    disabled={actionsDisabled}
                  >
                    {plugin.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    style={styles.linkButton}
                    onClick={() => onLoadPlugin(plugin)}
                    disabled={actionsDisabled}
                  >
                    Load In Lab
                  </button>
                  <button
                    style={styles.linkButton}
                    onClick={() => onRunPlugin(plugin)}
                    disabled={actionsDisabled}
                  >
                    Run
                  </button>
                  <button
                    style={styles.linkButton}
                    onClick={() => onRemovePlugin(plugin.pluginId)}
                    disabled={actionsDisabled}
                  >
                    Remove
                  </button>
                </div>
              </div>
              <div style={styles.metaText}>ID: {plugin.pluginId}</div>
              <div style={styles.metaText}>Hosts: {plugin.manifest.hosts.join(', ')}</div>
              {plugin.manifest.description && (
                <div style={styles.metaText}>{plugin.manifest.description}</div>
              )}
              {plugin.sourceUrl && <div style={styles.metaText}>Source: {plugin.sourceUrl}</div>}
            </div>
          ))
        )}
      </Section>

      <Section
        title="Recommended Built-In"
        description="A legal first-party provider keeps the feature useful before any community plugins are installed."
      >
        {recommendedPlugins.map((plugin) => (
          <div key={plugin.manifest.name} style={styles.pluginCard}>
            <div style={styles.pluginCardHeader}>
              <strong>{plugin.manifest.name}</strong>
              <span style={styles.badgeMuted}>{plugin.sourceUrl ? 'Ready' : 'Planned'}</span>
            </div>
            {plugin.manifest.description && (
              <div style={styles.metaText}>{plugin.manifest.description}</div>
            )}
            <div style={styles.metaText}>Hosts: {plugin.manifest.hosts.join(', ')}</div>
            {plugin.sourceUrl && <div style={styles.metaText}>Source: {plugin.sourceUrl}</div>}
            {plugin.sourceUrl && (
              <div style={styles.inlineActions}>
                <button
                  style={styles.secondaryButton}
                  onClick={() => onUseRecommendedUrl(plugin.sourceUrl!)}
                >
                  Use Raw URL
                </button>
                <button
                  style={styles.primaryButton}
                  onClick={() => void onInstallRecommendedPlugin(plugin.sourceUrl!)}
                  disabled={actionsDisabled || !runtimeAvailable}
                >
                  Install
                </button>
              </div>
            )}
          </div>
        ))}
      </Section>
    </div>
  )
}

interface SearchTabProps {
  installedPlugins: InstalledPluginRecord[]
  searchBusy: boolean
  searchInput: SearchPluginSearchInput
  searchResults: SearchDisplayResult[]
  searchStatus: string | null
  searchSummaries: SearchRunSummary[]
  selectedPluginIds: string[]
  resultActionBusyKey: string | null
  onAddResult: (result: SearchDisplayResult) => Promise<void>
  onSearchInputChange: (value: SearchPluginSearchInput) => void
  onRunSearch: () => void
  onToggleSearchPlugin: (pluginId: string) => void
}

function SearchTab({
  installedPlugins,
  searchBusy,
  searchInput,
  searchResults,
  searchStatus,
  searchSummaries,
  selectedPluginIds,
  resultActionBusyKey,
  onAddResult,
  onSearchInputChange,
  onRunSearch,
  onToggleSearchPlugin,
}: SearchTabProps) {
  const enabledPlugins = installedPlugins.filter((plugin) => plugin.enabled)
  const selectedPlugins = enabledPlugins.filter((p) => selectedPluginIds.includes(p.pluginId))
  const overlayCategories = Array.from(
    new Set(selectedPlugins.flatMap((p) => p.manifest.categories ?? [])),
  ).filter((c) => c !== 'all')
  const handleOpenDetails = async (event: MouseEvent<HTMLAnchorElement>, url: string) => {
    event.preventDefault()

    try {
      await openExternalUrl(url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      standaloneAlert(`Failed to open link: ${message}`)
    }
  }

  return (
    <div style={styles.tabPanel}>
      <Section
        title="Search Providers"
        description="Run one or more installed plugins and view normalized results in a single list."
      >
        <label style={styles.fieldLabel}>
          Search Query
          <input
            type="text"
            value={searchInput.query}
            onChange={(event) =>
              onSearchInputChange({
                ...searchInput,
                query: event.target.value,
              })
            }
            style={styles.input}
          />
        </label>

        <label style={styles.fieldLabel}>
          Category
          <select
            value={searchInput.category ?? ''}
            onChange={(event) =>
              onSearchInputChange({
                ...searchInput,
                category: event.target.value || undefined,
              })
            }
            style={styles.input}
          >
            <option value="">All</option>
            {overlayCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>

        {enabledPlugins.length === 0 ? (
          <div style={styles.emptyState}>
            <strong>No enabled plugins available.</strong>
            <p style={styles.emptyStateText}>
              Install a plugin first, or re-enable one from the Installed tab.
            </p>
          </div>
        ) : (
          <div style={styles.checkboxList}>
            {enabledPlugins.map((plugin) => {
              const checked = selectedPluginIds.includes(plugin.pluginId)
              return (
                <label key={plugin.pluginId} style={styles.checkboxRow}>
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => onToggleSearchPlugin(plugin.pluginId)}
                  />
                  <span style={styles.checkboxLabel}>
                    <strong>{plugin.manifest.name}</strong>
                    <span style={styles.checkboxMeta}>{plugin.manifest.hosts.join(', ')}</span>
                  </span>
                </label>
              )
            })}
          </div>
        )}

        <div style={styles.actionRow}>
          <button
            style={styles.primaryButton}
            onClick={onRunSearch}
            disabled={searchBusy || enabledPlugins.length === 0}
          >
            {searchBusy ? 'Running Search...' : 'Run Search'}
          </button>
        </div>
        {searchStatus && <div style={styles.statusText}>{searchStatus}</div>}
      </Section>

      <Section title="Provider Runs" description="Per-plugin status for the most recent search.">
        {searchSummaries.length > 0 ? (
          <div style={styles.summaryList}>
            {searchSummaries.map((summary) => (
              <div key={summary.pluginId} style={styles.summaryCard}>
                <div style={styles.pluginCardHeader}>
                  <strong>{summary.pluginName}</strong>
                  <span style={summary.ok ? styles.badge : styles.badgeError}>
                    {summary.ok ? 'OK' : 'Failed'}
                  </span>
                </div>
                <div style={styles.metaText}>
                  {summary.resultCount} results in {summary.durationMs}ms
                </div>
                {summary.errorMessage && <div style={styles.errorText}>{summary.errorMessage}</div>}
              </div>
            ))}
          </div>
        ) : (
          <div style={styles.metaText}>No search has been run yet.</div>
        )}
      </Section>

      <Section title="Results" description="Normalized results sorted by seeds, then by name.">
        {searchResults.length > 0 ? (
          <div style={styles.resultsList}>
            {searchResults.map((displayResult, index) => {
              const result = displayResult.result
              const actionKey = `${displayResult.pluginId}:${result.name}`
              const actionBusy = resultActionBusyKey === actionKey
              const canAdd = Boolean(result.magnetUrl || result.torrentUrl)

              return (
                <div
                  key={`${displayResult.pluginId}-${result.source}-${result.name}-${index}`}
                  style={styles.resultCard}
                >
                  <div style={styles.resultHeader}>
                    <strong>{result.name}</strong>
                    <span style={styles.badgeMuted}>{result.source}</span>
                  </div>
                  <div style={styles.resultMetaRow}>
                    <span>Seeds: {result.seeds ?? 'n/a'}</span>
                    <span>Leeches: {result.leeches ?? 'n/a'}</span>
                    <span>Size: {formatResultSize(result.size)}</span>
                  </div>
                  <div style={styles.resultLinkRow}>
                    <button
                      style={styles.secondaryButton}
                      onClick={() => void onAddResult(displayResult)}
                      disabled={!canAdd || actionBusy || searchBusy}
                    >
                      {actionBusy ? 'Adding...' : result.magnetUrl ? 'Add Magnet' : 'Add Torrent'}
                    </button>
                    {result.detailsUrl && (
                      <a
                        href={result.detailsUrl}
                        target="_blank"
                        rel="noreferrer"
                        style={styles.resultLink}
                        onClick={(event) => void handleOpenDetails(event, result.detailsUrl!)}
                      >
                        Details
                      </a>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        ) : (
          <div style={styles.metaText}>No aggregated results yet.</div>
        )}
      </Section>
    </div>
  )
}

interface AddFromUrlTabProps {
  sourceUrl: string
  installDisabled: boolean
  installBusy: boolean
  installPreview: SearchPluginManifest | null
  installStatus: string | null
  runtimeAvailable: boolean
  onSourceUrlChange: (value: string) => void
  onLoadSourceFromUrl: () => void
  onInstallFromUrl: () => void
}

function AddFromUrlTab({
  sourceUrl,
  installDisabled,
  installBusy,
  installPreview,
  installStatus,
  runtimeAvailable,
  onSourceUrlChange,
  onLoadSourceFromUrl,
  onInstallFromUrl,
}: AddFromUrlTabProps) {
  return (
    <div style={styles.tabPanel}>
      <Section
        title="Install from URL"
        description="The initial install path targets raw GitHub URLs and other direct source files via the daemon-backed HTTP bridge."
      >
        <label style={styles.fieldLabel}>
          Plugin Source URL
          <input
            type="url"
            value={sourceUrl}
            onChange={(event) => onSourceUrlChange(event.target.value)}
            placeholder="https://raw.githubusercontent.com/example/repo/main/plugin.js"
            style={styles.input}
          />
        </label>
        <div style={styles.helperText}>
          The production flow should fetch once, validate the manifest, show requested hosts, and
          store a local frozen copy.
        </div>
        <div style={styles.actionRow}>
          <button
            style={styles.secondaryButton}
            onClick={onLoadSourceFromUrl}
            disabled={installDisabled || installBusy || !runtimeAvailable}
          >
            {installBusy ? 'Loading...' : 'Load Into Lab'}
          </button>
          <button
            style={styles.primaryButton}
            onClick={onInstallFromUrl}
            disabled={installDisabled || installBusy || !runtimeAvailable}
          >
            {installBusy ? 'Installing...' : 'Install Plugin'}
          </button>
        </div>
        {installStatus && <div style={styles.statusText}>{installStatus}</div>}
        {installPreview && (
          <div style={styles.pluginCard}>
            <div style={styles.pluginCardHeader}>
              <strong>{installPreview.name}</strong>
              <span style={styles.badgeMuted}>{installPreview.version ?? 'Preview'}</span>
            </div>
            {installPreview.description && (
              <div style={styles.metaText}>{installPreview.description}</div>
            )}
            <div style={styles.metaText}>Hosts: {installPreview.hosts.join(', ')}</div>
          </div>
        )}
      </Section>

      <Section
        title="Planned Install Helpers"
        description="Not implemented yet, but already accounted for in the design."
      >
        <ul style={styles.featureList}>
          <li>`jstorrent://plugin?url=...` deep-link install</li>
          <li>Host permission confirmation before enabling</li>
          <li>Optional pinned installs for commit-specific URLs</li>
        </ul>
      </Section>
    </div>
  )
}

interface PluginLabTabProps {
  draftSource: string
  draftRunResult: SearchPluginDraftRunResult | null
  labBusy: boolean
  labStatus: string | null
  runtimeAvailable: boolean
  searchInput: SearchPluginSearchInput
  onDraftSourceChange: (value: string) => void
  onSearchInputChange: (value: SearchPluginSearchInput) => void
  onRunDraft: () => void
  onInstallFromLab: () => void
}

function PluginLabTab({
  draftSource,
  draftRunResult,
  labBusy,
  labStatus,
  runtimeAvailable,
  searchInput,
  onDraftSourceChange,
  onSearchInputChange,
  onRunDraft,
  onInstallFromLab,
}: PluginLabTabProps) {
  const handleResetSample = () => {
    onDraftSourceChange(INITIAL_SAMPLE_SOURCE)
  }

  return (
    <div style={styles.tabPanel}>
      <Section
        title="Plugin Lab"
        description="This shell is intended for fast iteration once the sandbox host is connected."
      >
        <label style={styles.fieldLabel}>
          Search Query
          <input
            type="text"
            value={searchInput.query}
            onChange={(event) =>
              onSearchInputChange({
                ...searchInput,
                query: event.target.value,
              })
            }
            style={styles.input}
          />
        </label>

        <label style={styles.fieldLabel}>
          Category
          <input
            type="text"
            value={searchInput.category ?? ''}
            onChange={(event) =>
              onSearchInputChange({
                ...searchInput,
                category: event.target.value || undefined,
              })
            }
            style={styles.input}
          />
        </label>

        <label style={styles.fieldLabel}>
          Plugin Source
          <textarea
            value={draftSource}
            onChange={(event) => onDraftSourceChange(event.target.value)}
            style={styles.textarea}
            spellCheck={false}
          />
        </label>

        <div style={styles.actionRow}>
          <button style={styles.secondaryButton} onClick={handleResetSample}>
            Load Sample
          </button>
          <button
            style={styles.primaryButton}
            onClick={onRunDraft}
            disabled={labBusy || !runtimeAvailable}
          >
            {labBusy ? 'Running...' : 'Run Draft'}
          </button>
          <button
            style={styles.secondaryButton}
            onClick={onInstallFromLab}
            disabled={labBusy || !runtimeAvailable || !draftSource.trim()}
            title="Install this plugin from the current source"
          >
            Install Plugin
          </button>
        </div>
        {labStatus && <div style={styles.statusText}>{labStatus}</div>}
      </Section>

      <Section
        title="Manifest"
        description="Resolved from the current draft source after a successful sandbox load."
      >
        {draftRunResult?.manifest ? (
          <pre style={styles.outputBlock}>{JSON.stringify(draftRunResult.manifest, null, 2)}</pre>
        ) : (
          <div style={styles.metaText}>Run the draft to inspect the manifest.</div>
        )}
      </Section>

      <Section
        title="Results"
        description="Normalized search output emitted by the plugin runtime."
      >
        {draftRunResult?.trace.results.length ? (
          <pre style={styles.outputBlock}>
            {JSON.stringify(draftRunResult.trace.results, null, 2)}
          </pre>
        ) : (
          <div style={styles.metaText}>No results emitted yet.</div>
        )}
      </Section>

      <Section
        title="Console"
        description="Captured plugin log output and uncaught runtime errors."
      >
        {draftRunResult?.trace.logs.length ? (
          <pre style={styles.outputBlock}>
            {draftRunResult.trace.logs
              .map(
                (entry: { level: string; message: string }) => `[${entry.level}] ${entry.message}`,
              )
              .join('\n')}
          </pre>
        ) : (
          <div style={styles.metaText}>No console output yet.</div>
        )}
        {draftRunResult?.trace.error && (
          <pre style={{ ...styles.outputBlock, borderColor: 'var(--accent-error, #ef4444)' }}>
            {JSON.stringify(draftRunResult.trace.error, null, 2)}
          </pre>
        )}
      </Section>

      <Section title="Network" description="Captured request metadata from sandbox fetch helpers.">
        {draftRunResult?.trace.requests.length ? (
          <pre style={styles.outputBlock}>
            {JSON.stringify(draftRunResult.trace.requests, null, 2)}
          </pre>
        ) : (
          <div style={styles.metaText}>
            No network activity yet. Draft fetches are routed through the daemon-backed HTTP bridge.
          </div>
        )}
      </Section>
    </div>
  )
}

interface SectionProps {
  title: string
  description?: string
  children: React.ReactNode
}

function Section({ title, description, children }: SectionProps) {
  return (
    <section style={styles.section}>
      <div style={styles.sectionHeader}>
        <h3 style={styles.sectionTitle}>{title}</h3>
        {description && <p style={styles.sectionDescription}>{description}</p>}
      </div>
      {children}
    </section>
  )
}

function formatResultSize(size?: number): string {
  if (typeof size !== 'number' || !Number.isFinite(size) || size <= 0) {
    return 'n/a'
  }
  return formatBytes(size)
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0, 0, 0, 0.55)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 1000,
  },
  modal: {
    width: 'min(1100px, calc(100vw - 48px))',
    height: 'min(760px, calc(100vh - 48px))',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: '10px',
    boxShadow: '0 18px 60px rgba(0, 0, 0, 0.35)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  },
  header: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '20px 24px 16px',
    borderBottom: '1px solid var(--border-color)',
  },
  title: {
    margin: 0,
    fontSize: '22px',
    fontWeight: 600,
  },
  subtitle: {
    marginTop: '6px',
    color: 'var(--text-secondary)',
    fontSize: '13px',
    lineHeight: 1.5,
  },
  closeButton: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    fontSize: '28px',
    cursor: 'pointer',
    lineHeight: 1,
    padding: 0,
  },
  content: {
    flex: 1,
    display: 'flex',
    minHeight: 0,
  },
  sidebar: {
    width: '220px',
    borderRight: '1px solid var(--border-color)',
    padding: '20px 16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    background: 'var(--bg-secondary)',
  },
  tabButton: {
    border: '1px solid transparent',
    background: 'transparent',
    color: 'var(--text-primary)',
    textAlign: 'left',
    padding: '10px 12px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '14px',
  },
  tabButtonActive: {
    background: 'var(--button-bg)',
    borderColor: 'var(--border-color)',
  },
  tabContent: {
    flex: 1,
    minWidth: 0,
    overflowY: 'auto',
    padding: '24px',
  },
  tabPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  section: {
    border: '1px solid var(--border-color)',
    borderRadius: '10px',
    padding: '18px',
    background: 'var(--bg-secondary)',
  },
  sectionHeader: {
    marginBottom: '14px',
  },
  sectionTitle: {
    margin: 0,
    fontSize: '16px',
    fontWeight: 600,
  },
  sectionDescription: {
    margin: '6px 0 0',
    color: 'var(--text-secondary)',
    fontSize: '13px',
    lineHeight: 1.5,
  },
  emptyState: {
    border: '1px dashed var(--border-color)',
    borderRadius: '8px',
    padding: '18px',
    background: 'var(--bg-primary)',
  },
  emptyStateText: {
    margin: '8px 0 14px',
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  checkboxList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    marginBottom: '16px',
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '12px',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    background: 'var(--bg-primary)',
  },
  checkboxLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    fontSize: '13px',
  },
  checkboxMeta: {
    color: 'var(--text-secondary)',
    fontSize: '12px',
  },
  primaryButton: {
    background: 'var(--button-bg)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    padding: '10px 14px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  secondaryButton: {
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    padding: '10px 14px',
    borderRadius: '8px',
    cursor: 'pointer',
    fontSize: '13px',
  },
  actionRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    flexWrap: 'wrap',
  },
  fieldLabel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    marginBottom: '14px',
    fontSize: '13px',
    fontWeight: 500,
  },
  input: {
    width: '100%',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    borderRadius: '8px',
    padding: '10px 12px',
    fontSize: '13px',
  },
  textarea: {
    width: '100%',
    minHeight: '260px',
    resize: 'vertical',
    background: 'var(--bg-primary)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    borderRadius: '8px',
    padding: '12px',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    lineHeight: 1.5,
  },
  helperText: {
    marginTop: '-4px',
    marginBottom: '16px',
    color: 'var(--text-secondary)',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  pluginCard: {
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    padding: '14px',
    background: 'var(--bg-primary)',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  pluginCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  inlineActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
  },
  badge: {
    border: '1px solid var(--border-color)',
    borderRadius: '999px',
    padding: '2px 8px',
    fontSize: '11px',
    color: 'var(--text-secondary)',
  },
  badgeMuted: {
    border: '1px solid var(--border-color)',
    borderRadius: '999px',
    padding: '2px 8px',
    fontSize: '11px',
    color: 'var(--text-secondary)',
    opacity: 0.8,
  },
  badgeError: {
    border: '1px solid var(--accent-error, #ef4444)',
    borderRadius: '999px',
    padding: '2px 8px',
    fontSize: '11px',
    color: 'var(--accent-error, #ef4444)',
  },
  metaText: {
    color: 'var(--text-secondary)',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  errorText: {
    color: 'var(--accent-error, #ef4444)',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  linkButton: {
    background: 'transparent',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    fontSize: '12px',
    padding: 0,
  },
  summaryList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
  },
  summaryCard: {
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    padding: '12px',
    background: 'var(--bg-primary)',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  resultsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  resultCard: {
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    padding: '14px',
    background: 'var(--bg-primary)',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  resultHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: '12px',
  },
  resultMetaRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '12px',
    color: 'var(--text-secondary)',
    fontSize: '12px',
  },
  resultLinkRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '12px',
  },
  resultLink: {
    color: 'var(--accent-primary, #2563eb)',
    fontSize: '12px',
    textDecoration: 'none',
  },
  featureList: {
    margin: 0,
    paddingLeft: '20px',
    color: 'var(--text-secondary)',
    lineHeight: 1.7,
  },
  outputBlock: {
    margin: 0,
    padding: '12px',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    background: 'var(--bg-primary)',
    color: 'var(--text-primary)',
    fontSize: '12px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    lineHeight: 1.5,
    whiteSpace: 'pre-wrap',
    overflowX: 'auto',
  },
  statusText: {
    color: 'var(--text-secondary)',
    fontSize: '12px',
    lineHeight: 1.5,
  },
  warningBox: {
    marginBottom: '20px',
    padding: '12px 14px',
    border: '1px solid var(--border-color)',
    borderRadius: '8px',
    background: 'var(--bg-secondary)',
    color: 'var(--text-secondary)',
    fontSize: '13px',
  },
}
