package com.jstorrent.app.viewmodel

import com.jstorrent.app.search.InstalledPluginRecord
import com.jstorrent.app.search.RecommendedSearchPlugin
import com.jstorrent.app.search.SearchDisplayResult
import com.jstorrent.app.search.SearchPluginDraftRunResult
import com.jstorrent.app.search.SearchPluginExecutionRuntime
import com.jstorrent.app.search.SearchPluginFetchInput
import com.jstorrent.app.search.SearchPluginFetchPolicy
import com.jstorrent.app.search.SearchPluginFetchResponse
import com.jstorrent.app.search.SearchPluginFetcher
import com.jstorrent.app.search.SearchPluginManifest
import com.jstorrent.app.search.SearchPluginRequestTrace
import com.jstorrent.app.search.SearchPluginRunTrace
import com.jstorrent.app.search.SearchPluginSearchInput
import com.jstorrent.app.search.SearchPluginSettingsStore
import com.jstorrent.app.search.SearchPluginSourceInspection
import com.jstorrent.app.search.SearchResult
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SearchViewModelTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private lateinit var store: FakeSearchStore
    private lateinit var runtime: FakeSearchRuntime
    private lateinit var fetcher: FakeSearchFetcher
    private lateinit var addedTorrents: MutableList<String>
    private lateinit var viewModel: SearchViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        store = FakeSearchStore()
        runtime = FakeSearchRuntime()
        fetcher = FakeSearchFetcher()
        addedTorrents = mutableListOf()
        viewModel = SearchViewModel(
            store = store,
            runtime = runtime,
            fetcher = fetcher,
            addTorrent = { addedTorrents += it }
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `search aggregates and sorts results`() = runTest {
        viewModel.onQueryChanged("ubuntu")

        viewModel.search()

        val state = viewModel.uiState.value
        assertEquals(2, state.results.size)
        assertEquals("High Seeds", state.results.first().result.name)
        assertEquals(2, state.runSummaries.first().resultCount)
        assertTrue(state.searchedOnce)
    }

    @Test
    fun `search survives malformed plugin output`() = runTest {
        runtime.resultFactory = {
            SearchPluginDraftRunResult(
                manifest = SearchPluginManifest(
                    id = "broken",
                    name = "Broken Plugin",
                    hosts = emptyList()
                ),
                trace = SearchPluginRunTrace(
                    ok = true,
                    durationMs = 5,
                    results = emptyList(),
                    logs = emptyList(),
                    requests = emptyList()
                )
            )
        }
        viewModel.onQueryChanged("ubuntu")

        viewModel.search()

        val state = viewModel.uiState.value
        assertTrue(state.searchedOnce)
        assertFalse(state.isSearching)
        assertTrue(state.results.isEmpty())
        assertEquals(1, state.runSummaries.size)
        assertFalse(state.runSummaries.first().ok)
        assertEquals("Plugin manifest must include at least one declared host", state.errorMessage)
    }

    @Test
    fun `search survives plugin returning no results`() = runTest {
        runtime.resultFactory = {
            SearchPluginDraftRunResult(
                manifest = pluginManifest(),
                trace = SearchPluginRunTrace(
                    ok = true,
                    durationMs = 7,
                    results = emptyList(),
                    logs = emptyList(),
                    requests = emptyList()
                )
            )
        }
        viewModel.onQueryChanged("ubuntu")

        viewModel.search()

        val state = viewModel.uiState.value
        assertTrue(state.searchedOnce)
        assertFalse(state.isSearching)
        assertTrue(state.results.isEmpty())
        assertEquals(1, state.runSummaries.size)
        assertTrue(state.runSummaries.first().ok)
        assertNull(state.errorMessage)
    }

    @Test
    fun `add result uses magnet directly`() = runTest {
        val result = SearchDisplayResult(
            pluginId = "plugin",
            pluginName = "Plugin",
            allowedHosts = listOf("example.com"),
            result = SearchResult(
                name = "Magnet",
                source = "Plugin",
                magnetUrl = "magnet:?xt=urn:btih:abc123"
            )
        )

        viewModel.addResult(result)

        assertEquals(listOf("magnet:?xt=urn:btih:abc123"), addedTorrents)
    }

    @Test
    fun `add result downloads torrent and base64 encodes bytes`() = runTest {
        val result = SearchDisplayResult(
            pluginId = "plugin",
            pluginName = "Plugin",
            allowedHosts = listOf("example.com"),
            result = SearchResult(
                name = "Torrent",
                source = "Plugin",
                torrentUrl = "https://example.com/file.torrent"
            )
        )

        viewModel.addResult(result)

        assertEquals(listOf("dGVzdA=="), addedTorrents)
        assertEquals("https://example.com/file.torrent", fetcher.lastUrl)
    }

    @Test
    fun `add result clears pending state when torrent fetch fails`() = runTest {
        fetcher.fetchError = IllegalStateException("Plugin fetch failed")
        val result = SearchDisplayResult(
            pluginId = "plugin",
            pluginName = "Plugin",
            allowedHosts = listOf("example.com"),
            result = SearchResult(
                name = "Torrent",
                source = "Plugin",
                torrentUrl = "https://example.com/file.torrent"
            )
        )

        viewModel.addResult(result)

        val state = viewModel.uiState.value
        assertTrue(addedTorrents.isEmpty())
        assertTrue(state.addingResultIds.isEmpty())
        assertEquals("Plugin fetch failed", state.errorMessage)
    }

    private fun pluginManifest() = SearchPluginManifest(
        id = "plugin",
        name = "Plugin",
        hosts = listOf("example.com")
    )

    private class FakeSearchStore : SearchPluginSettingsStore {
        private val plugins = listOf(
            InstalledPluginRecord(
                pluginId = "plugin",
                manifest = SearchPluginManifest(
                    id = "plugin",
                    name = "Plugin",
                    hosts = listOf("example.com"),
                    categories = listOf("all", "movies")
                ),
                sourceHash = "hash",
                installedAt = 1L,
                updatedAt = 1L,
                enabled = true,
                code = "plugin-code"
            )
        )

        override fun recommendedPlugins(): List<RecommendedSearchPlugin> = emptyList()

        override suspend fun listInstalledPlugins(): List<InstalledPluginRecord> = plugins

        override suspend fun installFromUrl(url: String): InstalledPluginRecord = plugins.first()

        override suspend fun setPluginEnabled(pluginId: String, enabled: Boolean): InstalledPluginRecord {
            return plugins.first().copy(enabled = enabled)
        }

        override suspend fun removePlugin(pluginId: String): Boolean = true
    }

    private class FakeSearchRuntime : SearchPluginExecutionRuntime {
        var resultFactory: (SearchPluginSearchInput) -> SearchPluginDraftRunResult = { input ->
            SearchPluginDraftRunResult(
                manifest = SearchPluginManifest(
                    id = "plugin",
                    name = "Plugin",
                    hosts = listOf("example.com")
                ),
                trace = SearchPluginRunTrace(
                    ok = true,
                    durationMs = 12,
                    results = listOf(
                        SearchResult(
                            name = "Low Seeds",
                            source = "Plugin",
                            seeds = 1,
                            magnetUrl = "magnet:?xt=urn:btih:low"
                        ),
                        SearchResult(
                            name = "High Seeds",
                            source = "Plugin",
                            seeds = 10,
                            magnetUrl = "magnet:?xt=urn:btih:high"
                        )
                    ),
                    logs = emptyList(),
                    requests = emptyList<SearchPluginRequestTrace>()
                )
            )
        }

        override suspend fun fetchSource(url: String): String = ""

        override suspend fun inspectSource(source: String): SearchPluginSourceInspection {
            return SearchPluginSourceInspection(
                SearchPluginManifest(
                    id = "plugin",
                    name = "Plugin",
                    hosts = listOf("example.com")
                )
            )
        }

        override suspend fun runDraft(
            source: String,
            input: SearchPluginSearchInput
        ): SearchPluginDraftRunResult {
            return resultFactory(input)
        }
    }

    private class FakeSearchFetcher : SearchPluginFetcher {
        var lastUrl: String? = null
        var fetchError: Throwable? = null

        override suspend fun fetch(
            input: SearchPluginFetchInput,
            policy: SearchPluginFetchPolicy?
        ): SearchPluginFetchResponse {
            lastUrl = input.url
            fetchError?.let { throw it }
            return SearchPluginFetchResponse(
                bodyText = "test",
                bodyBytes = "test".toByteArray(),
                bytes = 4,
                statusCode = 200,
                finalUrl = input.url
            )
        }
    }

}
