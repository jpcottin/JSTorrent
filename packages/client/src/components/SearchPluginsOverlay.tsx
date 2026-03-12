import { useEffect, useRef, useState } from 'react'
import { useEngineManager } from '../context/EngineManagerContext'
import { standaloneAlert } from '../utils/dialogs'
import type {
  InstalledPluginRecord,
  SearchPluginDraftRunResult,
  SearchPluginManifest,
  SearchPluginSearchInput,
} from '../search/types'
import { ExtensionSandboxLabHost } from '../search/extension-sandbox-lab-host'

type SearchPluginsTab = 'installed' | 'add' | 'lab'

interface SearchPluginsOverlayProps {
  isOpen: boolean
  onClose: () => void
}

const TABS: { id: SearchPluginsTab; label: string }[] = [
  { id: 'installed', label: 'Installed' },
  { id: 'add', label: 'Add from URL' },
  { id: 'lab', label: 'Plugin Lab' },
]

const INITIAL_SAMPLE_SOURCE = `export const manifest = {
  name: 'Internet Archive',
  hosts: ['archive.org'],
  categories: ['all', 'books', 'movies', 'music'],
}

export async function search(ctx, input) {
  ctx.log('info', 'Sample plugin loaded')
  ctx.log('info', \`Try fetching against archive.org for: \${input.query}\`)
}`

const RECOMMENDED_PLUGINS: SearchPluginManifest[] = [
  {
    name: 'Internet Archive',
    description: 'Planned first-party plugin for public-domain and openly licensed media.',
    hosts: ['archive.org'],
    homepage: 'https://archive.org',
  },
]

const INSTALLED_PLUGINS: InstalledPluginRecord[] = []

export function SearchPluginsOverlay({ isOpen, onClose }: SearchPluginsOverlayProps) {
  const engineManager = useEngineManager()
  const hostRef = useRef<ExtensionSandboxLabHost | null>(null)
  const [activeTab, setActiveTab] = useState<SearchPluginsTab>('installed')
  const [sourceUrl, setSourceUrl] = useState('')
  const [draftSource, setDraftSource] = useState(INITIAL_SAMPLE_SOURCE)
  const [searchInput, setSearchInput] = useState<SearchPluginSearchInput>({
    query: 'night of the living dead',
    category: 'movies',
  })
  const [draftRunResult, setDraftRunResult] = useState<SearchPluginDraftRunResult | null>(null)
  const [labBusy, setLabBusy] = useState(false)
  const [labStatus, setLabStatus] = useState<string | null>(null)

  if (!hostRef.current) {
    hostRef.current = new ExtensionSandboxLabHost({
      fetch: (input) => engineManager.searchPluginFetch(input),
    })
  }

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

  useEffect(() => {
    return () => {
      hostRef.current?.dispose()
      hostRef.current = null
    }
  }, [])

  if (!isOpen) return null

  const installDisabled = sourceUrl.trim().length === 0
  const runtimeAvailable = hostRef.current.isAvailable()

  const handleLoadSourceFromUrl = async () => {
    setLabBusy(true)
    setLabStatus('Fetching plugin source...')
    try {
      const source = await hostRef.current!.fetchSource(sourceUrl.trim())
      setDraftSource(source)
      setActiveTab('lab')
      setLabStatus('Fetched source into the plugin lab.')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setLabStatus(message)
      standaloneAlert(message)
    } finally {
      setLabBusy(false)
    }
  }

  const handleRunDraft = async () => {
    setLabBusy(true)
    setLabStatus('Running plugin in sandbox...')
    try {
      const result = await hostRef.current!.runDraft(draftSource, searchInput)
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
        trace: {
          ok: false,
          durationMs: 0,
          results: [],
          logs: [],
          requests: [],
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
                Search plugin execution is currently available only inside the Chrome extension UI.
              </div>
            )}
            {activeTab === 'installed' && (
              <InstalledTab
                installedPlugins={INSTALLED_PLUGINS}
                recommendedPlugins={RECOMMENDED_PLUGINS}
                onOpenAddTab={() => setActiveTab('add')}
              />
            )}
            {activeTab === 'add' && (
              <AddFromUrlTab
                sourceUrl={sourceUrl}
                installDisabled={installDisabled}
                labBusy={labBusy}
                onSourceUrlChange={setSourceUrl}
                onLoadSourceFromUrl={handleLoadSourceFromUrl}
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
  recommendedPlugins: SearchPluginManifest[]
  onOpenAddTab: () => void
}

function InstalledTab({
  installedPlugins,
  recommendedPlugins,
  onOpenAddTab,
}: InstalledTabProps) {
  return (
    <div style={styles.tabPanel}>
      <Section
        title="Installed Providers"
        description="Providers will appear here once URL install and local storage are wired."
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
                <span style={styles.badge}>{plugin.enabled ? 'Enabled' : 'Disabled'}</span>
              </div>
              <div style={styles.metaText}>ID: {plugin.pluginId}</div>
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
          <div key={plugin.name} style={styles.pluginCard}>
            <div style={styles.pluginCardHeader}>
              <strong>{plugin.name}</strong>
              <span style={styles.badgeMuted}>Planned</span>
            </div>
            {plugin.description && <div style={styles.metaText}>{plugin.description}</div>}
            <div style={styles.metaText}>Hosts: {plugin.hosts.join(', ')}</div>
          </div>
        ))}
      </Section>
    </div>
  )
}

interface AddFromUrlTabProps {
  sourceUrl: string
  installDisabled: boolean
  labBusy: boolean
  onSourceUrlChange: (value: string) => void
  onLoadSourceFromUrl: () => void
}

function AddFromUrlTab({
  sourceUrl,
  installDisabled,
  labBusy,
  onSourceUrlChange,
  onLoadSourceFromUrl,
}: AddFromUrlTabProps) {
  const handleInstall = () => {
    standaloneAlert(
      'Plugin installation is not wired yet.\n\nNext step: fetch the source URL, extract the manifest, confirm hosts, and store a frozen local copy.',
    )
  }

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
            disabled={installDisabled || labBusy}
          >
            {labBusy ? 'Loading...' : 'Load Into Lab'}
          </button>
          <button style={styles.primaryButton} onClick={handleInstall} disabled={installDisabled}>
            Install Plugin
          </button>
        </div>
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
        </div>
        {labStatus && <div style={styles.statusText}>{labStatus}</div>}
      </Section>

      <Section
        title="Manifest"
        description="Resolved from the current draft source after a successful sandbox load."
      >
        {draftRunResult?.manifest ? (
          <pre style={styles.outputBlock}>
            {JSON.stringify(draftRunResult.manifest, null, 2)}
          </pre>
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

      <Section title="Console" description="Captured plugin log output and uncaught runtime errors.">
        {draftRunResult?.trace.logs.length ? (
          <pre style={styles.outputBlock}>
            {draftRunResult.trace.logs
              .map((entry) => `[${entry.level}] ${entry.message}`)
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
  metaText: {
    color: 'var(--text-secondary)',
    fontSize: '12px',
    lineHeight: 1.5,
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
