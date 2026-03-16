import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import type { SearchDisplayResult, SearchRunSummary } from '../search/types'

interface SearchStoreState {
  // Persisted
  query: string
  category: string | undefined
  selectedPluginIds: Set<string>

  // Transient (not persisted)
  results: SearchDisplayResult[]
  summaries: SearchRunSummary[]
  searching: boolean
  addingKey: string | null
  status: string | null
  selectedRows: Set<string>
  contextMenu: { x: number; y: number } | null
}

interface SearchStoreActions {
  setQuery: (query: string) => void
  setCategory: (category: string | undefined) => void
  setSelectedPluginIds: (ids: Set<string>) => void
  togglePlugin: (pluginId: string) => void
  setResults: (results: SearchDisplayResult[]) => void
  setSummaries: (summaries: SearchRunSummary[]) => void
  setSearching: (searching: boolean) => void
  setAddingKey: (key: string | null) => void
  setStatus: (status: string | null) => void
  setSelectedRows: (rows: Set<string>) => void
  setContextMenu: (menu: { x: number; y: number } | null) => void
}

export const useSearchStore = create<SearchStoreState & SearchStoreActions>()(
  persist(
    (set) => ({
      // Persisted defaults
      query: '',
      category: undefined,
      selectedPluginIds: new Set(),

      // Transient defaults
      results: [],
      summaries: [],
      searching: false,
      addingKey: null,
      status: null,
      selectedRows: new Set(),
      contextMenu: null,

      // Actions
      setQuery: (query) => set({ query }),
      setCategory: (category) => set({ category }),
      setSelectedPluginIds: (ids) => set({ selectedPluginIds: ids }),
      togglePlugin: (pluginId) =>
        set((state) => {
          const next = new Set(state.selectedPluginIds)
          if (next.has(pluginId)) {
            next.delete(pluginId)
          } else {
            next.add(pluginId)
          }
          return { selectedPluginIds: next }
        }),
      setResults: (results) => set({ results }),
      setSummaries: (summaries) => set({ summaries }),
      setSearching: (searching) => set({ searching }),
      setAddingKey: (key) => set({ addingKey: key }),
      setStatus: (status) => set({ status }),
      setSelectedRows: (rows) => set({ selectedRows: rows }),
      setContextMenu: (menu) => set({ contextMenu: menu }),
    }),
    {
      name: 'jstorrent:searchTabState',
      partialize: (state) => ({
        query: state.query,
        category: state.category,
        selectedPluginIds: [...state.selectedPluginIds],
      }),
      merge: (persisted, current) => {
        const p = persisted as {
          query?: string
          category?: string
          selectedPluginIds?: string[]
        } | null
        return {
          ...current,
          ...(p?.query != null && { query: p.query }),
          ...(p?.category !== undefined && { category: p.category }),
          ...(Array.isArray(p?.selectedPluginIds) && {
            selectedPluginIds: new Set(
              p.selectedPluginIds.filter((id): id is string => typeof id === 'string'),
            ),
          }),
        }
      },
    },
  ),
)
