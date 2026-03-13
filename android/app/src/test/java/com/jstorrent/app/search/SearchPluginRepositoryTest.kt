package com.jstorrent.app.search

import android.content.Context
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.mockito.kotlin.doReturn
import org.mockito.kotlin.mock
import java.io.File

class SearchPluginRepositoryTest {

    @get:Rule
    val temporaryFolder = TemporaryFolder()

    @Test
    fun `install from url persists across repository instances`() = runTest {
        val filesDir = temporaryFolder.newFolder("repo-files")
        val runtime = FakeSearchPluginRuntime(
            sourcesByUrl = mutableMapOf(
                SOURCE_URL to INITIAL_SOURCE
            ),
            manifestsBySource = mutableMapOf(
                INITIAL_SOURCE to TEST_MANIFEST
            )
        )

        val repository = createRepository(filesDir, runtime)
        val installed = repository.installFromUrl(SOURCE_URL)

        assertEquals(TEST_MANIFEST.id, installed.pluginId)
        assertEquals(SOURCE_URL, installed.sourceUrl)

        val reloaded = createRepository(filesDir, runtime)
        val stored = reloaded.listInstalledPlugins()

        assertEquals(1, stored.size)
        assertEquals(installed.pluginId, stored.first().pluginId)
        assertEquals("Test Plugin", stored.first().manifest.name)
        assertTrue(File(filesDir, "search_plugins.json").exists())
    }

    @Test
    fun `update refreshes stored code and toggle persists`() = runTest {
        val filesDir = temporaryFolder.newFolder("repo-update")
        val runtime = FakeSearchPluginRuntime(
            sourcesByUrl = mutableMapOf(
                SOURCE_URL to INITIAL_SOURCE
            ),
            manifestsBySource = mutableMapOf(
                INITIAL_SOURCE to TEST_MANIFEST,
                UPDATED_SOURCE to TEST_MANIFEST.copy(version = "2.0.0")
            )
        )

        val repository = createRepository(filesDir, runtime)
        val installed = repository.installFromUrl(SOURCE_URL)
        repository.setPluginEnabled(installed.pluginId, false)

        runtime.sourcesByUrl[SOURCE_URL] = UPDATED_SOURCE
        val updated = repository.update(installed.pluginId)

        assertFalse(updated.enabled)
        assertEquals("2.0.0", updated.manifest.version)
        assertEquals(UPDATED_SOURCE, updated.code)

        val stored = repository.getInstalledPlugin(installed.pluginId)
        assertNotNull(stored)
        assertFalse(stored!!.enabled)
        assertEquals("2.0.0", stored.manifest.version)
    }

    @Test
    fun `remove plugin deletes stored record`() = runTest {
        val filesDir = temporaryFolder.newFolder("repo-remove")
        val runtime = FakeSearchPluginRuntime(
            sourcesByUrl = mutableMapOf(SOURCE_URL to INITIAL_SOURCE),
            manifestsBySource = mutableMapOf(INITIAL_SOURCE to TEST_MANIFEST)
        )

        val repository = createRepository(filesDir, runtime)
        val installed = repository.installFromUrl(SOURCE_URL)

        assertTrue(repository.removePlugin(installed.pluginId))
        assertTrue(repository.listInstalledPlugins().isEmpty())
        assertFalse(repository.removePlugin(installed.pluginId))
    }

    private fun createRepository(
        filesDir: File,
        runtime: SearchPluginSourceRuntime
    ): SearchPluginRepository {
        val context = mock<Context> {
            on { this.filesDir } doReturn filesDir
        }
        return SearchPluginRepository(context, runtime)
    }

    private class FakeSearchPluginRuntime(
        val sourcesByUrl: MutableMap<String, String>,
        val manifestsBySource: MutableMap<String, SearchPluginManifest>
    ) : SearchPluginSourceRuntime {
        override suspend fun fetchSource(url: String): String {
            return sourcesByUrl[url] ?: error("No source registered for $url")
        }

        override suspend fun inspectSource(source: String): SearchPluginSourceInspection {
            val manifest = manifestsBySource[source] ?: error("No manifest registered for source")
            return SearchPluginSourceInspection(manifest)
        }
    }

    companion object {
        private const val SOURCE_URL = "https://example.com/plugin.js"
        private const val INITIAL_SOURCE = "export const manifest = {}"
        private const val UPDATED_SOURCE = "export const manifest = { version: '2.0.0' }"

        private val TEST_MANIFEST = SearchPluginManifest(
            id = "plugin.test",
            name = "Test Plugin",
            version = "1.0.0",
            hosts = listOf("example.com")
        )
    }
}
