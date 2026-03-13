package com.jstorrent.app.search

import kotlinx.serialization.Serializable

@Serializable
data class SearchPluginManifest(
    val id: String? = null,
    val name: String,
    val version: String? = null,
    val description: String? = null,
    val homepage: String? = null,
    val source: String? = null,
    val hosts: List<String>,
    val categories: List<String>? = null
)

@Serializable
data class SearchPluginSearchInput(
    val query: String,
    val category: String? = null
)

@Serializable
data class SearchPluginFetchInput(
    val url: String,
    val method: String? = null,
    val headers: Map<String, String>? = null,
    val body: String? = null
)

@Serializable
data class SearchPluginFetchPolicy(
    val allowedHosts: List<String>? = null
)

@Serializable
data class SearchPluginFetchResponse(
    val bodyText: String,
    val bodyBytes: ByteArray,
    val bytes: Long,
    val statusCode: Int,
    val remoteAddress: String? = null,
    val finalUrl: String? = null
)

@Serializable
data class SearchResult(
    val name: String,
    val source: String,
    val size: Long? = null,
    val seeds: Long? = null,
    val leeches: Long? = null,
    val magnetUrl: String? = null,
    val torrentUrl: String? = null,
    val infoHash: String? = null,
    val detailsUrl: String? = null,
    val publishedAt: Long? = null
)

data class SearchDisplayResult(
    val pluginId: String,
    val pluginName: String,
    val allowedHosts: List<String>,
    val result: SearchResult
) {
    val stableId: String = buildString {
        append(pluginId)
        append('|')
        append(result.infoHash ?: result.magnetUrl ?: result.torrentUrl ?: result.detailsUrl ?: result.name)
    }
}

data class SearchRunSummary(
    val pluginId: String,
    val pluginName: String,
    val ok: Boolean,
    val durationMs: Long,
    val resultCount: Int,
    val errorMessage: String? = null
)

@Serializable
data class SearchPluginLogEntry(
    val level: String,
    val message: String
)

@Serializable
data class SearchPluginRequestTrace(
    val url: String,
    val method: String,
    val status: Int? = null,
    val durationMs: Long? = null,
    val bytes: Long? = null,
    val remoteAddress: String? = null,
    val error: String? = null
)

@Serializable
data class SearchPluginRunError(
    val phase: String,
    val name: String,
    val message: String,
    val stack: String? = null
)

@Serializable
data class SearchPluginRunTrace(
    val ok: Boolean,
    val durationMs: Long,
    val results: List<SearchResult>,
    val logs: List<SearchPluginLogEntry>,
    val requests: List<SearchPluginRequestTrace>,
    val error: SearchPluginRunError? = null
)

@Serializable
data class SearchPluginDraftRunResult(
    val manifest: SearchPluginManifest? = null,
    val trace: SearchPluginRunTrace
)

@Serializable
data class SearchPluginSourceInspection(
    val manifest: SearchPluginManifest
)

@Serializable
data class InstalledPluginRecord(
    val pluginId: String,
    val manifest: SearchPluginManifest,
    val sourceUrl: String? = null,
    val sourceHash: String,
    val installedAt: Long,
    val updatedAt: Long,
    val enabled: Boolean,
    val code: String
)

data class RecommendedSearchPlugin(
    val manifest: SearchPluginManifest,
    val sourceUrl: String
)
