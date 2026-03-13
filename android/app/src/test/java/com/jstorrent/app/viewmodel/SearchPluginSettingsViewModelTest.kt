package com.jstorrent.app.viewmodel

import com.jstorrent.app.search.InstalledPluginRecord
import com.jstorrent.app.search.RecommendedSearchPlugin
import com.jstorrent.app.search.SearchPluginManifest
import com.jstorrent.app.search.SearchPluginSettingsStore
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.resetMain
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.test.setMain
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class SearchPluginSettingsViewModelTest {

    private val dispatcher = UnconfinedTestDispatcher()
    private lateinit var store: FakeSearchPluginSettingsStore
    private lateinit var viewModel: SearchPluginSettingsViewModel

    @Before
    fun setUp() {
        Dispatchers.setMain(dispatcher)
        store = FakeSearchPluginSettingsStore()
        viewModel = SearchPluginSettingsViewModel(store)
    }

    @After
    fun tearDown() {
        Dispatchers.resetMain()
    }

    @Test
    fun `init loads recommended and installed plugins`() = runTest {
        val state = viewModel.uiState.value
        assertEquals(1, state.recommendedPlugins.size)
        assertEquals(1, state.installedPlugins.size)
        assertFalse(state.isLoading)
    }

    @Test
    fun `install from url clears field and appends plugin`() = runTest {
        viewModel.onSourceUrlChanged("https://example.com/second.js")

        viewModel.installFromUrl()

        val state = viewModel.uiState.value
        assertEquals("", state.sourceUrl)
        assertEquals(2, state.installedPlugins.size)
        assertEquals("Plugin installed", state.statusMessage)
    }

    @Test
    fun `blank install url reports error`() = runTest {
        viewModel.onSourceUrlChanged("  ")

        viewModel.installFromUrl()

        assertEquals("Enter a plugin URL", viewModel.uiState.value.errorMessage)
    }

    @Test
    fun `toggle and remove update installed list`() = runTest {
        val pluginId = viewModel.uiState.value.installedPlugins.first().pluginId

        viewModel.setPluginEnabled(pluginId, false)
        assertFalse(viewModel.uiState.value.installedPlugins.first().enabled)

        viewModel.removePlugin(pluginId)
        assertTrue(viewModel.uiState.value.installedPlugins.isEmpty())
    }

    private class FakeSearchPluginSettingsStore : SearchPluginSettingsStore {
        private val recommended = listOf(
            RecommendedSearchPlugin(
                manifest = SearchPluginManifest(
                    id = "org.archive.search",
                    name = "Internet Archive",
                    hosts = listOf("archive.org")
                ),
                sourceUrl = "https://example.com/archive.js"
            )
        )

        private val installed = mutableListOf(
            InstalledPluginRecord(
                pluginId = "org.archive.search",
                manifest = SearchPluginManifest(
                    id = "org.archive.search",
                    name = "Internet Archive",
                    hosts = listOf("archive.org")
                ),
                sourceUrl = "https://example.com/archive.js",
                sourceHash = "abc",
                installedAt = 1L,
                updatedAt = 1L,
                enabled = true,
                code = "code"
            )
        )

        override fun recommendedPlugins(): List<RecommendedSearchPlugin> = recommended

        override suspend fun listInstalledPlugins(): List<InstalledPluginRecord> = installed.toList()

        override suspend fun installFromUrl(url: String): InstalledPluginRecord {
            val plugin = InstalledPluginRecord(
                pluginId = "plugin-${installed.size + 1}",
                manifest = SearchPluginManifest(
                    id = "plugin-${installed.size + 1}",
                    name = "Plugin ${installed.size + 1}",
                    hosts = listOf("example.com")
                ),
                sourceUrl = url,
                sourceHash = "hash-${installed.size + 1}",
                installedAt = installed.size.toLong(),
                updatedAt = installed.size.toLong(),
                enabled = true,
                code = "code"
            )
            installed += plugin
            return plugin
        }

        override suspend fun setPluginEnabled(
            pluginId: String,
            enabled: Boolean
        ): InstalledPluginRecord {
            val index = installed.indexOfFirst { it.pluginId == pluginId }
            val updated = installed[index].copy(enabled = enabled)
            installed[index] = updated
            return updated
        }

        override suspend fun removePlugin(pluginId: String): Boolean {
            return installed.removeAll { it.pluginId == pluginId }
        }
    }
}
