package com.jstorrent.app.search

import android.content.Context
import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.decodeFromString
import java.io.File
import java.util.Locale

private const val TAG = "SearchPluginRepository"

interface SearchPluginSourceRuntime {
    suspend fun fetchSource(url: String): String
    suspend fun inspectSource(source: String): SearchPluginSourceInspection
}

class SearchPluginRepository(
    private val context: Context,
    private val runtime: SearchPluginSourceRuntime,
    private val clock: () -> Long = { System.currentTimeMillis() }
) {

    @Serializable
    private data class StoredPlugins(
        val plugins: List<InstalledPluginRecord> = emptyList()
    )

    private val mutex = Mutex()

    private val storageFile: File
        get() = File(context.filesDir, STORAGE_FILE_NAME)

    fun recommendedPlugins(): List<RecommendedSearchPlugin> {
        return listOf(
            RecommendedSearchPlugin(
                manifest = SearchPluginManifest(
                    name = "Internet Archive",
                    description = "First-party provider for public-domain and openly licensed media.",
                    homepage = "https://archive.org",
                    hosts = listOf("archive.org")
                ),
                sourceUrl = INTERNET_ARCHIVE_PLUGIN_RAW_URL
            )
        )
    }

    suspend fun listInstalledPlugins(): List<InstalledPluginRecord> = mutex.withLock {
        withContext(Dispatchers.IO) {
            loadStoredPlugins()
                .plugins
                .sortedWith(
                    compareBy<InstalledPluginRecord>(
                        { it.manifest.name.lowercase(Locale.US) },
                        { it.pluginId }
                    )
                )
        }
    }

    suspend fun getInstalledPlugin(pluginId: String): InstalledPluginRecord? = mutex.withLock {
        withContext(Dispatchers.IO) {
            loadStoredPlugins().plugins.firstOrNull { it.pluginId == pluginId }
        }
    }

    suspend fun inspectSource(source: String): SearchPluginSourceInspection {
        return runtime.inspectSource(source)
    }

    suspend fun installRecommendedInternetArchive(): InstalledPluginRecord {
        return installFromUrl(INTERNET_ARCHIVE_PLUGIN_RAW_URL)
    }

    suspend fun installFromUrl(url: String): InstalledPluginRecord {
        val source = runtime.fetchSource(url)
        return installFromSource(source = source, sourceUrl = url)
    }

    suspend fun installFromSource(source: String, sourceUrl: String? = null): InstalledPluginRecord {
        val inspection = runtime.inspectSource(source)
        val now = clock()
        val created = createInstalledPluginRecord(
            code = source,
            manifest = inspection.manifest,
            sourceUrl = sourceUrl,
            now = now
        )

        return mutex.withLock {
            withContext(Dispatchers.IO) {
                val stored = loadStoredPlugins()
                val existing = stored.plugins.firstOrNull { it.pluginId == created.pluginId }
                val merged = if (existing != null) {
                    created.copy(
                        pluginId = existing.pluginId,
                        installedAt = existing.installedAt,
                        enabled = existing.enabled,
                        sourceUrl = sourceUrl?.trim()?.ifEmpty { null } ?: existing.sourceUrl
                    )
                } else {
                    created
                }
                saveStoredPlugins(
                    StoredPlugins(
                        plugins = upsertPlugin(stored.plugins, merged)
                    )
                )
                merged
            }
        }
    }

    suspend fun saveInstalledPlugin(plugin: InstalledPluginRecord): InstalledPluginRecord = mutex.withLock {
        withContext(Dispatchers.IO) {
            val sanitized = sanitizePluginRecord(plugin)
            val stored = loadStoredPlugins()
            saveStoredPlugins(
                StoredPlugins(
                    plugins = upsertPlugin(stored.plugins, sanitized)
                )
            )
            sanitized
        }
    }

    suspend fun setPluginEnabled(pluginId: String, enabled: Boolean): InstalledPluginRecord = mutex.withLock {
        withContext(Dispatchers.IO) {
            val stored = loadStoredPlugins()
            val existing = stored.plugins.firstOrNull { it.pluginId == pluginId }
                ?: throw IllegalArgumentException("Plugin not found: $pluginId")
            val updated = existing.copy(enabled = enabled, updatedAt = clock())
            saveStoredPlugins(StoredPlugins(plugins = upsertPlugin(stored.plugins, updated)))
            updated
        }
    }

    suspend fun update(pluginId: String): InstalledPluginRecord {
        val existing = getInstalledPlugin(pluginId)
            ?: throw IllegalArgumentException("Plugin not found: $pluginId")
        val sourceUrl = existing.sourceUrl
            ?: throw IllegalArgumentException("Plugin does not have a source URL: $pluginId")
        val source = runtime.fetchSource(sourceUrl)
        val inspection = runtime.inspectSource(source)
        val now = clock()
        val updated = existing.copy(
            manifest = normalizeSearchPluginManifest(inspection.manifest, sourceUrl),
            sourceUrl = sourceUrl,
            sourceHash = sha256Hex(source),
            updatedAt = now,
            code = source
        )
        return saveInstalledPlugin(updated)
    }

    suspend fun removePlugin(pluginId: String): Boolean = mutex.withLock {
        withContext(Dispatchers.IO) {
            val stored = loadStoredPlugins()
            val filtered = stored.plugins.filterNot { it.pluginId == pluginId }
            if (filtered.size == stored.plugins.size) {
                false
            } else {
                saveStoredPlugins(StoredPlugins(plugins = filtered))
                true
            }
        }
    }

    private fun sanitizePluginRecord(plugin: InstalledPluginRecord): InstalledPluginRecord {
        val normalizedManifest = normalizeSearchPluginManifest(plugin.manifest, plugin.sourceUrl)
        return plugin.copy(
            manifest = normalizedManifest,
            sourceUrl = plugin.sourceUrl?.trim()?.ifEmpty { null },
            sourceHash = sha256Hex(plugin.code)
        )
    }

    private fun upsertPlugin(
        plugins: List<InstalledPluginRecord>,
        plugin: InstalledPluginRecord
    ): List<InstalledPluginRecord> {
        return plugins.filterNot { it.pluginId == plugin.pluginId } + plugin
    }

    private fun loadStoredPlugins(): StoredPlugins {
        if (!storageFile.exists()) {
            return StoredPlugins()
        }

        return try {
            SearchPluginJson.decodeFromString<StoredPlugins>(storageFile.readText())
        } catch (error: Exception) {
            Log.w(TAG, "Failed to load stored search plugins, starting fresh", error)
            StoredPlugins()
        }
    }

    private fun saveStoredPlugins(storedPlugins: StoredPlugins) {
        storageFile.parentFile?.mkdirs()
        storageFile.writeText(SearchPluginJson.encodeToString(storedPlugins))
    }

    companion object {
        private const val STORAGE_FILE_NAME = "search_plugins.json"
        const val INTERNET_ARCHIVE_PLUGIN_RAW_URL =
            "https://raw.githubusercontent.com/kzahel/jstorrent/main/search-plugins/internet-archive.js"
    }
}
