import { useState, useCallback, useRef, useEffect, useLayoutEffect } from 'react'
import { TableMount, formatBytes, ContextMenu } from '@jstorrent/ui'
import type { ColumnDef, ContextMenuItem } from '@jstorrent/ui'
import { useSearchPluginService } from '../context/SearchPluginServiceContext'
import { useSearchStore } from '../stores/useSearchStore'
import type { SearchDisplayResult, InstalledPluginRecord } from '../search/types'

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
      id: 'category',
      header: 'Category',
      getValue: (r) => r.result.category ?? '',
      width: 80,
      defaultHidden: true,
    },
    {
      id: 'uploader',
      header: 'Uploader',
      getValue: (r) => r.result.uploader ?? '',
      width: 100,
      defaultHidden: true,
    },
    {
      id: 'files',
      header: 'Files',
      getValue: (r) => r.result.numFiles ?? '',
      width: 50,
      align: 'right',
      defaultHidden: true,
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
    },
  ]
}

export interface SearchTabProps {
  onOpenSearchOverlay?: () => void
}

export function SearchTab({ onOpenSearchOverlay }: SearchTabProps) {
  const pluginService = useSearchPluginService()

  const query = useSearchStore((s) => s.query)
  const category = useSearchStore((s) => s.category)
  const results = useSearchStore((s) => s.results)
  const summaries = useSearchStore((s) => s.summaries)
  const searching = useSearchStore((s) => s.searching)
  const addingKey = useSearchStore((s) => s.addingKey)
  const status = useSearchStore((s) => s.status)
  const selectedRows = useSearchStore((s) => s.selectedRows)
  const contextMenu = useSearchStore((s) => s.contextMenu)
  const selectedPluginIds = useSearchStore((s) => s.selectedPluginIds)

  const {
    setQuery,
    setCategory,
    setResults,
    setSummaries,
    setSearching,
    setAddingKey,
    setStatus,
    setSelectedRows,
    setContextMenu,
    setSelectedPluginIds,
    togglePlugin,
  } = useSearchStore.getState()

  const resultsRef = useRef(results)
  resultsRef.current = results

  const selectedRowsRef = useRef(selectedRows)
  useLayoutEffect(() => {
    selectedRowsRef.current = selectedRows
  }, [selectedRows])
  const getSelectedKeys = useCallback(() => selectedRowsRef.current, [])
  const onSelectionChange = useCallback((keys: Set<string>) => setSelectedRows(keys), [])

  const [plugins, setPlugins] = useState<InstalledPluginRecord[]>([])

  useEffect(() => {
    void pluginService.listInstalledPlugins().then((list) => {
      setPlugins(list)
      const currentIds = useSearchStore.getState().selectedPluginIds
      if (currentIds.size === 0) {
        const allEnabled = new Set(list.filter((p) => p.enabled).map((p) => p.pluginId))
        setSelectedPluginIds(allEnabled)
      } else {
        const validIds = new Set(list.map((p) => p.pluginId))
        const filtered = new Set([...currentIds].filter((id) => validIds.has(id)))
        if (filtered.size !== currentIds.size) {
          setSelectedPluginIds(filtered)
        }
      }
    })
  }, [pluginService])

  const searchPlugins = plugins.filter((p) => selectedPluginIds.has(p.pluginId))

  // Union of categories from all selected plugins
  const availableCategories = Array.from(
    new Set(searchPlugins.flatMap((p) => p.manifest.categories ?? [])),
  ).filter((c) => c !== 'all')

  const handleSearch = useCallback(async () => {
    const trimmed = query.trim()
    if (!trimmed) return
    if (searchPlugins.length === 0) {
      setStatus('No search plugins selected.')
      return
    }

    setSearching(true)
    setStatus(null)
    setResults([])
    setSummaries([])

    try {
      const output = await pluginService.runSearch(searchPlugins, { query: trimmed, category })
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
  }, [query, category, searchPlugins, pluginService])

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

  const contextRowRef = useRef<SearchDisplayResult | null>(null)
  const handleRowContextMenu = useCallback((row: SearchDisplayResult, x: number, y: number) => {
    contextRowRef.current = row
    setContextMenu({ x, y })
  }, [])

  const handleAddSelected = useCallback(async () => {
    const selected = selectedRowsRef.current
    if (selected.size === 0) return
    const toAdd = resultsRef.current.filter((r) => {
      const key = getResultKey(r)
      return selected.has(key) && (r.result.magnetUrl || r.result.torrentUrl)
    })
    if (toAdd.length === 0) {
      setStatus('No addable results in selection')
      return
    }
    let added = 0
    let dupes = 0
    let failed = 0
    for (const r of toAdd) {
      try {
        const result = await pluginService.addSearchResult(r)
        if (result.isDuplicate) dupes++
        else added++
      } catch {
        failed++
      }
    }
    const parts: string[] = []
    if (added > 0) parts.push(`Added ${added}`)
    if (dupes > 0) parts.push(`${dupes} duplicate${dupes !== 1 ? 's' : ''}`)
    if (failed > 0) parts.push(`${failed} failed`)
    setStatus(parts.join(', '))
  }, [pluginService])

  const selectedCount = selectedRows.size
  const contextRow = contextRowRef.current
  const contextMenuItems: ContextMenuItem[] = [
    {
      id: 'addSelected',
      label: selectedCount > 1 ? `Add ${selectedCount} torrents` : 'Add torrent',
      disabled: selectedCount === 0,
    },
    { id: 'sep1', label: '', separator: true },
    {
      id: 'copyMagnet',
      label: 'Copy magnet URL',
      disabled: !contextRow?.result.magnetUrl,
    },
    {
      id: 'copyTorrentUrl',
      label: 'Copy torrent URL',
      disabled: !contextRow?.result.torrentUrl,
    },
  ]

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
        {availableCategories.length > 0 && (
          <select
            value={category ?? ''}
            onChange={(e) => setCategory(e.target.value || undefined)}
            disabled={searching}
            style={{
              padding: '2px 4px',
              fontSize: 'var(--font-base, 13px)',
              height: 'var(--button-height, 24px)',
              boxSizing: 'border-box',
            }}
          >
            <option value="">All</option>
            {availableCategories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        )}
        {plugins.length > 0 && (
          <div
            style={{
              display: 'flex',
              gap: '2px',
              alignItems: 'center',
            }}
          >
            {plugins
              .filter((p) => p.enabled)
              .map((p) => {
                const selected = selectedPluginIds.has(p.pluginId)
                return (
                  <button
                    key={p.pluginId}
                    onClick={() => togglePlugin(p.pluginId)}
                    title={`${selected ? 'Disable' : 'Enable'} ${p.manifest.name}`}
                    style={{
                      padding: '1px 6px',
                      fontSize: 'var(--font-small, 11px)',
                      height: '20px',
                      boxSizing: 'border-box',
                      cursor: 'pointer',
                      border: '1px solid var(--border-color)',
                      borderRadius: '3px',
                      background: selected ? 'var(--accent-primary)' : 'transparent',
                      color: selected ? '#fff' : 'var(--text-secondary)',
                      opacity: selected ? 1 : 0.6,
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {p.manifest.name}
                  </button>
                )
              })}
          </div>
        )}
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
            title="Manage search plugins"
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
            ⚙
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
            getSelectedKeys={getSelectedKeys}
            onSelectionChange={onSelectionChange}
            onRowContextMenu={handleRowContextMenu}
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
              : plugins.length === 0
                ? 'No search plugins installed'
                : searchPlugins.length === 0
                  ? 'No search plugins selected'
                  : 'Enter a search query above'}
          </div>
        )}
      </div>

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          items={contextMenuItems}
          onSelect={(id) => {
            if (id === 'addSelected') void handleAddSelected()
            else if (id === 'copyMagnet' && contextRowRef.current?.result.magnetUrl) {
              void navigator.clipboard.writeText(contextRowRef.current.result.magnetUrl)
            } else if (id === 'copyTorrentUrl' && contextRowRef.current?.result.torrentUrl) {
              void navigator.clipboard.writeText(contextRowRef.current.result.torrentUrl)
            }
          }}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  )
}
