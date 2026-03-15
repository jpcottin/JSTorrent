import { useState, useCallback, useRef, useEffect } from 'react'
import { TableMount, formatBytes } from '@jstorrent/ui'
import type { ColumnDef } from '@jstorrent/ui'
import { useSearchPluginService } from '../context/SearchPluginServiceContext'
import type { SearchDisplayResult, SearchRunSummary, InstalledPluginRecord } from '../search/types'

function formatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  })
}

function getResultKey(r: SearchDisplayResult): string {
  return `${r.pluginId}:${r.result.infoHash ?? r.result.magnetUrl ?? r.result.torrentUrl ?? r.result.name}`
}

function createSearchResultColumns(
  onAdd: (result: SearchDisplayResult) => void,
  addingKey: string | null,
): ColumnDef<SearchDisplayResult>[] {
  return [
    {
      id: 'add',
      header: '',
      getValue: () => '',
      width: 32,
      minWidth: 32,
      sortable: false,
      hideable: false,
      align: 'center',
      renderCell: (row) => {
        const key = getResultKey(row)
        const busy = addingKey === key
        const hasLink = !!(row.result.magnetUrl || row.result.torrentUrl)
        const el = document.createElement('button')
        el.textContent = busy ? '...' : '+'
        el.title = hasLink ? 'Add torrent' : 'No link available'
        el.disabled = busy || !hasLink
        el.style.cssText =
          'border:none;background:none;cursor:pointer;font-size:16px;font-weight:bold;line-height:1;padding:0 4px;color:var(--accent-primary);'
        if (busy || !hasLink) {
          el.style.opacity = '0.4'
          el.style.cursor = 'default'
        }
        el.addEventListener('click', (e) => {
          e.stopPropagation()
          if (!busy && hasLink) onAdd(row)
        })
        return el as unknown as string
      },
    },
    {
      id: 'name',
      header: 'Name',
      getValue: (r) => r.result.name,
      width: 400,
      minWidth: 120,
      getCellTitle: (r) => r.result.detailsUrl ?? r.result.name,
    },
    {
      id: 'size',
      header: 'Size',
      getValue: (r) => (r.result.size != null ? r.result.size : ''),
      width: 80,
      align: 'right',
      renderCell: (_, v) => (typeof v === 'number' && v > 0 ? formatBytes(v) : ''),
    },
    {
      id: 'seeds',
      header: 'Seeds',
      getValue: (r) => r.result.seeds ?? -1,
      width: 60,
      align: 'right',
      renderCell: (_, v) => (typeof v === 'number' && v >= 0 ? String(v) : ''),
      getCellStyle: (r) =>
        r.result.seeds != null && r.result.seeds > 0
          ? { color: 'var(--accent-success, #4caf50)' }
          : undefined,
    },
    {
      id: 'leeches',
      header: 'Leeches',
      getValue: (r) => r.result.leeches ?? -1,
      width: 65,
      align: 'right',
      renderCell: (_, v) => (typeof v === 'number' && v >= 0 ? String(v) : ''),
    },
    {
      id: 'source',
      header: 'Source',
      getValue: (r) => r.pluginName,
      width: 100,
    },
    {
      id: 'date',
      header: 'Date',
      getValue: (r) => r.result.publishedAt ?? 0,
      width: 90,
      renderCell: (r) => (r.result.publishedAt ? formatDate(r.result.publishedAt) : ''),
      defaultHidden: true,
    },
  ]
}

export interface SearchTabProps {
  onOpenSearchOverlay?: () => void
}

export function SearchTab({ onOpenSearchOverlay }: SearchTabProps) {
  const pluginService = useSearchPluginService()
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchDisplayResult[]>([])
  const [summaries, setSummaries] = useState<SearchRunSummary[]>([])
  const [searching, setSearching] = useState(false)
  const [addingKey, setAddingKey] = useState<string | null>(null)
  const [status, setStatus] = useState<string | null>(null)
  const resultsRef = useRef(results)
  resultsRef.current = results

  const [plugins, setPlugins] = useState<InstalledPluginRecord[]>([])
  useEffect(() => {
    void pluginService.listInstalledPlugins().then((list) => {
      setPlugins(list)
    })
  }, [pluginService])

  const enabledPlugins = plugins.filter((p) => p.enabled)

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed) return
    if (enabledPlugins.length === 0) {
      setStatus('No search plugins enabled. Install plugins in the Search Plugins overlay.')
      return
    }

    setSearching(true)
    setStatus(null)
    setResults([])
    setSummaries([])

    try {
      const output = await pluginService.runSearch(enabledPlugins, { query: trimmed })
      setResults(output.results)
      setSummaries(output.summaries)

      const totalResults = output.results.length
      const failedCount = output.summaries.filter((s) => !s.ok).length
      const parts: string[] = [`${totalResults} result${totalResults !== 1 ? 's' : ''}`]
      if (failedCount > 0) {
        parts.push(`${failedCount} plugin${failedCount !== 1 ? 's' : ''} failed`)
      }
      setStatus(parts.join(' \u00b7 '))
    } catch (err) {
      setStatus(`Search failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSearching(false)
    }
  }, [query, enabledPlugins, pluginService])

  const handleAdd = useCallback(
    async (displayResult: SearchDisplayResult) => {
      const key = getResultKey(displayResult)
      setAddingKey(key)
      try {
        const result = await pluginService.addSearchResult(displayResult)
        if (result.isDuplicate) {
          setStatus(`Already added: ${displayResult.result.name}`)
        } else {
          setStatus(`Added: ${displayResult.result.name}`)
        }
      } catch (err) {
        setStatus(`Failed to add: ${err instanceof Error ? err.message : String(err)}`)
      } finally {
        setAddingKey(null)
      }
    },
    [pluginService],
  )

  const columns = createSearchResultColumns(handleAdd, addingKey)

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Search input bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-xs, 4px)',
          padding: '4px 8px',
          borderBottom: '1px solid var(--border-color)',
          background: 'var(--bg-secondary)',
          flexShrink: 0,
        }}
      >
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void handleSearch()
          }}
          placeholder="Search torrents..."
          style={{
            flex: 1,
            padding: '2px 6px',
            fontSize: 'var(--font-base, 13px)',
            height: 'var(--button-height, 24px)',
            boxSizing: 'border-box',
          }}
          disabled={searching}
        />
        <button
          onClick={() => void handleSearch()}
          disabled={searching || !query.trim()}
          style={{
            padding: '2px 8px',
            fontSize: 'var(--font-base, 13px)',
            height: 'var(--button-height, 24px)',
            boxSizing: 'border-box',
            cursor: searching || !query.trim() ? 'default' : 'pointer',
            opacity: searching || !query.trim() ? 0.5 : 1,
          }}
        >
          {searching ? 'Searching...' : 'Search'}
        </button>
        {onOpenSearchOverlay && (
          <button
            onClick={onOpenSearchOverlay}
            title="Open Search Plugins overlay"
            style={{
              padding: '2px 6px',
              fontSize: 'var(--font-base, 13px)',
              height: 'var(--button-height, 24px)',
              boxSizing: 'border-box',
              cursor: 'pointer',
              background: 'none',
              border: '1px solid var(--border-color)',
            }}
          >
            Plugins
          </button>
        )}
        {status && (
          <span
            style={{
              fontSize: 'var(--font-small, 11px)',
              color: 'var(--text-secondary)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              maxWidth: '300px',
            }}
            title={
              summaries.length > 0
                ? summaries
                    .map(
                      (s) =>
                        `${s.pluginName}: ${s.ok ? `${s.resultCount} results (${s.durationMs}ms)` : `failed: ${s.errorMessage}`}`,
                    )
                    .join('\n')
                : undefined
            }
          >
            {status}
          </span>
        )}
      </div>

      {/* Results table */}
      <div style={{ flex: 1, minHeight: 0 }}>
        {results.length > 0 ? (
          <TableMount<SearchDisplayResult>
            getRows={() => resultsRef.current}
            getRowKey={getResultKey}
            columns={columns}
            storageKey="search-results"
          />
        ) : (
          <div
            style={{
              height: '100%',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-secondary)',
            }}
          >
            {searching
              ? 'Searching...'
              : enabledPlugins.length === 0
                ? 'No search plugins enabled'
                : 'Enter a search query above'}
          </div>
        )}
      </div>
    </div>
  )
}
