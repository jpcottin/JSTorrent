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
import kotlinx.coroutines.flow.MutableStateFlow
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
    private lateinit var trackedHashes: MutableStateFlow<Set<String>>
    private lateinit var addedTorrents: MutableList<AddedTorrentRequest>
    private lateinit var viewModel: SearchViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        store = FakeSearchStore()
        runtime = FakeSearchRuntime()
        fetcher = FakeSearchFetcher()
        trackedHashes = MutableStateFlow(emptySet())
        addedTorrents = mutableListOf()
        viewModel = SearchViewModel(
            store = store,
            runtime = runtime,
            fetcher = fetcher,
            trackedTorrentInfoHashes = trackedHashes,
            addTorrent = { payload, displayName ->
                addedTorrents += AddedTorrentRequest(payload, displayName)
            }
        )
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `search defaults to all enabled plugins and sorts aggregated results`() = runTest {
        viewModel.onQueryChanged("ubuntu")

        viewModel.search()

        val state = viewModel.uiState.value
        assertEquals(setOf("plugin-a", "plugin-b"), state.selectedPluginIds)
        assertEquals(3, state.results.size)
        assertEquals("High Seeds", state.results.first().displayResult.result.name)
        assertEquals(2, state.runSummaries.size)
        assertTrue(state.searchedOnce)
    }

    @Test
    fun `search uses only selected plugins`() = runTest {
        viewModel.togglePluginSelection("plugin-b")
        viewModel.onQueryChanged("ubuntu")

        viewModel.search()

        val state = viewModel.uiState.value
        assertEquals(setOf("plugin-a"), state.selectedPluginIds)
        assertEquals(listOf("plugin-a"), state.runSummaries.map { it.pluginId })
        assertTrue(state.results.all { it.displayResult.pluginId == "plugin-a" })
    }

    @Test
    fun `tracked torrents are surfaced in results`() = runTest {
        trackedHashes.value = setOf(HIGH_SEEDS_HASH)
        viewModel.onQueryChanged("ubuntu")

        viewModel.search()

        val trackedResult = viewModel.uiState.value.results.first { it.resolvedInfoHash == HIGH_SEEDS_HASH }
        assertTrue(trackedResult.isTracked)
        assertTrue(trackedResult.canOpenDetails)
        assertFalse(trackedResult.wasAddedFromSearch)
    }

    @Test
    fun `search survives malformed plugin output`() = runTest {
        runtime.overrideResults["plugin-code-a"] = {
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
        viewModel.togglePluginSelection("plugin-b")
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
        runtime.overrideResults["plugin-code-a"] = {
            SearchPluginDraftRunResult(
                manifest = pluginManifest("plugin-a", "Plugin A"),
                trace = SearchPluginRunTrace(
                    ok = true,
                    durationMs = 7,
                    results = emptyList(),
                    logs = emptyList(),
                    requests = emptyList()
                )
            )
        }
        viewModel.togglePluginSelection("plugin-b")
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
    fun `add result uses magnet directly and makes details available`() = runTest {
        viewModel.togglePluginSelection("plugin-b")
        viewModel.onQueryChanged("ubuntu")
        viewModel.search()
        val result = viewModel.uiState.value.results.first { it.resolvedInfoHash == HIGH_SEEDS_HASH }

        viewModel.addResult(result.displayResult)

        assertEquals(
            listOf(
                AddedTorrentRequest(
                    payload = "magnet:?xt=urn:btih:$HIGH_SEEDS_HASH",
                    displayName = "High Seeds"
                )
            ),
            addedTorrents
        )
        val updatedResult = viewModel.uiState.value.results.first { it.stableId == result.stableId }
        assertTrue(updatedResult.wasAddedFromSearch)
        assertTrue(updatedResult.canOpenDetails)
    }

    @Test
    fun `add result downloads torrent and base64 encodes bytes`() = runTest {
        val result = SearchDisplayResult(
            pluginId = "plugin-a",
            pluginName = "Plugin A",
            allowedHosts = listOf("example.com"),
            result = SearchResult(
                name = "Torrent",
                source = "Plugin A",
                torrentUrl = "https://example.com/file.torrent"
            )
        )

        viewModel.addResult(result)

        assertEquals(
            listOf(AddedTorrentRequest(payload = "dGVzdA==", displayName = "Torrent")),
            addedTorrents
        )
        assertEquals("https://example.com/file.torrent", fetcher.lastUrl)
    }

    @Test
    fun `add result clears pending state when torrent fetch fails`() = runTest {
        fetcher.fetchError = IllegalStateException("Plugin fetch failed")
        val result = SearchDisplayResult(
            pluginId = "plugin-a",
            pluginName = "Plugin A",
            allowedHosts = listOf("example.com"),
            result = SearchResult(
                name = "Torrent",
                source = "Plugin A",
                torrentUrl = "https://example.com/file.torrent"
            )
        )

        viewModel.addResult(result)

        val state = viewModel.uiState.value
        assertTrue(addedTorrents.isEmpty())
        assertTrue(state.addingResultIds.isEmpty())
        assertEquals("Plugin fetch failed", state.errorMessage)
    }

    private data class AddedTorrentRequest(
        val payload: String,
        val displayName: String
    )

    private class FakeSearchStore : SearchPluginSettingsStore {
        private val plugins = listOf(
            InstalledPluginRecord(
                pluginId = "plugin-a",
                manifest = SearchPluginManifest(
                    id = "plugin-a",
                    name = "Plugin A",
                    hosts = listOf("example.com"),
                    categories = listOf("all", "movies")
                ),
                sourceHash = "hash-a",
                installedAt = 1L,
                updatedAt = 1L,
                enabled = true,
                code = "plugin-code-a"
            ),
            InstalledPluginRecord(
                pluginId = "plugin-b",
                manifest = SearchPluginManifest(
                    id = "plugin-b",
                    name = "Plugin B",
                    hosts = listOf("example.org"),
                    categories = listOf("all", "books")
                ),
                sourceHash = "hash-b",
                installedAt = 1L,
                updatedAt = 1L,
                enabled = true,
                code = "plugin-code-b"
            )
        )

        override fun recommendedPlugins(): List<RecommendedSearchPlugin> = emptyList()

        override suspend fun listInstalledPlugins(): List<InstalledPluginRecord> = plugins

        override suspend fun installFromUrl(url: String): InstalledPluginRecord = plugins.first()

        override suspend fun setPluginEnabled(pluginId: String, enabled: Boolean): InstalledPluginRecord {
            return plugins.first { it.pluginId == pluginId }.copy(enabled = enabled)
        }

        override suspend fun removePlugin(pluginId: String): Boolean = true
    }

    private class FakeSearchRuntime : SearchPluginExecutionRuntime {
        val overrideResults = mutableMapOf<String, () -> SearchPluginDraftRunResult>()

        override suspend fun fetchSource(url: String): String = ""

        override suspend fun inspectSource(source: String): SearchPluginSourceInspection {
            return SearchPluginSourceInspection(
                when (source) {
                    "plugin-code-a" -> pluginManifest("plugin-a", "Plugin A")
                    "plugin-code-b" -> pluginManifest("plugin-b", "Plugin B", "example.org")
                    else -> pluginManifest("plugin-a", "Plugin A")
                }
            )
        }

        override suspend fun runDraft(
            source: String,
            input: SearchPluginSearchInput
        ): SearchPluginDraftRunResult {
            return overrideResults[source]?.invoke() ?: when (source) {
                "plugin-code-a" -> SearchPluginDraftRunResult(
                    manifest = pluginManifest("plugin-a", "Plugin A"),
                    trace = SearchPluginRunTrace(
                        ok = true,
                        durationMs = 12,
                        results = listOf(
                            SearchResult(
                                name = "Low Seeds",
                                source = "Plugin A",
                                seeds = 1,
                                magnetUrl = "magnet:?xt=urn:btih:$LOW_SEEDS_HASH"
                            ),
                            SearchResult(
                                name = "High Seeds",
                                source = "Plugin A",
                                seeds = 10,
                                infoHash = HIGH_SEEDS_HASH,
                                magnetUrl = "magnet:?xt=urn:btih:$HIGH_SEEDS_HASH"
                            )
                        ),
                        logs = emptyList(),
                        requests = emptyList<SearchPluginRequestTrace>()
                    )
                )

                "plugin-code-b" -> SearchPluginDraftRunResult(
                    manifest = pluginManifest("plugin-b", "Plugin B", "example.org"),
                    trace = SearchPluginRunTrace(
                        ok = true,
                        durationMs = 9,
                        results = listOf(
                            SearchResult(
                                name = "Medium Seeds",
                                source = "Plugin B",
                                seeds = 5,
                                magnetUrl = "magnet:?xt=urn:btih:$MEDIUM_SEEDS_HASH"
                            )
                        ),
                        logs = emptyList(),
                        requests = emptyList<SearchPluginRequestTrace>()
                    )
                )

                else -> error("Unexpected source: $source for ${input.query}")
            }
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

    companion object {
        private const val LOW_SEEDS_HASH = "1111111111111111111111111111111111111111"
        private const val HIGH_SEEDS_HASH = "2222222222222222222222222222222222222222"
        private const val MEDIUM_SEEDS_HASH = "3333333333333333333333333333333333333333"

        private fun pluginManifest(
            id: String,
            name: String,
            host: String = "example.com"
        ) = SearchPluginManifest(
            id = id,
            name = name,
            hosts = listOf(host)
        )
    }
}
