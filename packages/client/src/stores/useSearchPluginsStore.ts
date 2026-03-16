import { create } from 'zustand'
import { persist } from 'zustand/middleware'
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

interface SearchPluginsStoreState {
  // Persisted
  searchInput: SearchPluginSearchInput
  selectedPluginIds: string[]

  // Transient
  activeTab: SearchPluginsTab
  installedPlugins: InstalledPluginRecord[]
  installPreview: SearchPluginManifest | null
  sourceUrl: string
  draftSource: string
  draftRunResult: SearchPluginDraftRunResult | null
  labBusy: boolean
  labStatus: string | null
  installBusy: boolean
  installStatus: string | null
  searchBusy: boolean
  searchStatus: string | null
  searchResults: SearchDisplayResult[]
  searchSummaries: SearchRunSummary[]
  resultActionBusyKey: string | null
}

interface SearchPluginsStoreActions {
  setSearchInput: (input: SearchPluginSearchInput) => void
  setSelectedPluginIds: (ids: string[]) => void
  setActiveTab: (tab: SearchPluginsTab) => void
  setInstalledPlugins: (plugins: InstalledPluginRecord[]) => void
  setInstallPreview: (preview: SearchPluginManifest | null) => void
  setSourceUrl: (url: string) => void
  setDraftSource: (source: string) => void
  setDraftRunResult: (result: SearchPluginDraftRunResult | null) => void
  setLabBusy: (busy: boolean) => void
  setLabStatus: (status: string | null) => void
  setInstallBusy: (busy: boolean) => void
  setInstallStatus: (status: string | null) => void
  setSearchBusy: (busy: boolean) => void
  setSearchStatus: (status: string | null) => void
  setSearchResults: (results: SearchDisplayResult[]) => void
  setSearchSummaries: (summaries: SearchRunSummary[]) => void
  setResultActionBusyKey: (key: string | null) => void
  toggleSearchPlugin: (pluginId: string) => void
}

const DEFAULT_SEARCH_INPUT: SearchPluginSearchInput = {
  query: 'night of the living dead',
  category: 'movies',
}

export type { SearchPluginsTab }

export const useSearchPluginsStore = create<SearchPluginsStoreState & SearchPluginsStoreActions>()(
  persist(
    (set) => ({
      // Persisted defaults
      searchInput: DEFAULT_SEARCH_INPUT,
      selectedPluginIds: [],

      // Transient defaults
      activeTab: 'search' as SearchPluginsTab,
      installedPlugins: [],
      installPreview: null,
      sourceUrl: '',
      draftSource: INTERNET_ARCHIVE_SAMPLE_PLUGIN_SOURCE,
      draftRunResult: null,
      labBusy: false,
      labStatus: null,
      installBusy: false,
      installStatus: null,
      searchBusy: false,
      searchStatus: null,
      searchResults: [],
      searchSummaries: [],
      resultActionBusyKey: null,

      // Actions
      setSearchInput: (input) => set({ searchInput: input }),
      setSelectedPluginIds: (ids) => set({ selectedPluginIds: ids }),
      setActiveTab: (tab) => set({ activeTab: tab }),
      setInstalledPlugins: (plugins) => set({ installedPlugins: plugins }),
      setInstallPreview: (preview) => set({ installPreview: preview }),
      setSourceUrl: (url) => set({ sourceUrl: url }),
      setDraftSource: (source) => set({ draftSource: source }),
      setDraftRunResult: (result) => set({ draftRunResult: result }),
      setLabBusy: (busy) => set({ labBusy: busy }),
      setLabStatus: (status) => set({ labStatus: status }),
      setInstallBusy: (busy) => set({ installBusy: busy }),
      setInstallStatus: (status) => set({ installStatus: status }),
      setSearchBusy: (busy) => set({ searchBusy: busy }),
      setSearchStatus: (status) => set({ searchStatus: status }),
      setSearchResults: (results) => set({ searchResults: results }),
      setSearchSummaries: (summaries) => set({ searchSummaries: summaries }),
      setResultActionBusyKey: (key) => set({ resultActionBusyKey: key }),
      toggleSearchPlugin: (pluginId) =>
        set((state) => ({
          selectedPluginIds: state.selectedPluginIds.includes(pluginId)
            ? state.selectedPluginIds.filter((id) => id !== pluginId)
            : [...state.selectedPluginIds, pluginId],
        })),
    }),
    {
      name: 'jstorrent:searchPluginsOverlayState',
      partialize: (state) => ({
        searchInput: state.searchInput,
        selectedPluginIds: state.selectedPluginIds,
      }),
      merge: (persisted, current) => {
        const p = persisted as {
          searchInput?: Partial<SearchPluginSearchInput>
          selectedPluginIds?: string[]
        } | null

        const query =
          typeof p?.searchInput?.query === 'string' && p.searchInput.query.trim().length > 0
            ? p.searchInput.query
            : DEFAULT_SEARCH_INPUT.query
        const category =
          typeof p?.searchInput?.category === 'string' && p.searchInput.category.trim().length > 0
            ? p.searchInput.category
            : DEFAULT_SEARCH_INPUT.category

        return {
          ...current,
          searchInput: { query, category },
          selectedPluginIds: Array.isArray(p?.selectedPluginIds)
            ? p.selectedPluginIds.filter((id): id is string => typeof id === 'string')
            : current.selectedPluginIds,
        }
      },
    },
  ),
)
