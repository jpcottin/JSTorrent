package com.jstorrent.app.search

import kotlinx.serialization.json.Json
import java.net.URI
import java.security.MessageDigest
import java.util.Locale

val SearchPluginJson = Json {
    encodeDefaults = true
    ignoreUnknownKeys = true
    prettyPrint = true
}

const val MAX_PLUGIN_RESULTS = 50
const val MAX_PLUGIN_LOGS = 100
const val MAX_PLUGIN_REQUESTS = 50
const val MAX_PLUGIN_STRING_LENGTH = 500
const val MAX_PLUGIN_URL_LENGTH = 2048

private fun trimOptionalString(value: String?): String? {
    val trimmed = value?.trim()
    return if (trimmed.isNullOrEmpty()) null else trimmed
}

private fun slugify(value: String): String {
    return value
        .lowercase(Locale.US)
        .replace(Regex("[^a-z0-9]+"), "-")
        .replace(Regex("^-+|-+$"), "")
        .replace(Regex("-{2,}"), "-")
}

fun normalizeDeclaredHost(host: String): String {
    val trimmed = host.trim().lowercase(Locale.US)
    require(trimmed.isNotEmpty()) { "Plugin manifest hosts must not be empty" }

    val hostname = when {
        "://" in trimmed -> {
            URI(trimmed).host?.lowercase(Locale.US)
                ?: throw IllegalArgumentException("Invalid declared host: $host")
        }
        else -> trimmed
    }.removeSuffix(".")

    require(hostname.isNotEmpty()) { "Invalid declared host: $host" }
    require('/' !in hostname && '*' !in hostname && !hostname.contains(Regex("\\s"))) {
        "Invalid declared host: $host"
    }
    return hostname
}

fun normalizeSearchPluginManifest(
    manifest: SearchPluginManifest,
    sourceUrl: String? = null
): SearchPluginManifest {
    val name = trimOptionalString(manifest.name)
        ?: throw IllegalArgumentException("Plugin manifest must include a non-empty `name`")
    require(manifest.hosts.isNotEmpty()) {
        "Plugin manifest must include at least one declared host"
    }

    val normalizedHosts = manifest.hosts
        .map(::normalizeDeclaredHost)
        .distinct()
        .sorted()

    val categories = manifest.categories
        ?.mapNotNull(::trimOptionalString)
        ?.distinct()
        ?.takeIf { it.isNotEmpty() }

    return SearchPluginManifest(
        id = trimOptionalString(manifest.id),
        name = name,
        version = trimOptionalString(manifest.version),
        description = trimOptionalString(manifest.description),
        homepage = trimOptionalString(manifest.homepage),
        source = trimOptionalString(manifest.source) ?: trimOptionalString(sourceUrl),
        hosts = normalizedHosts,
        categories = categories
    )
}

fun ensurePluginFetchAllowed(url: String, policy: SearchPluginFetchPolicy? = null) {
    val allowedHosts = policy?.allowedHosts
        ?.map(::normalizeDeclaredHost)
        ?.distinct()
        ?.takeIf { it.isNotEmpty() }
        ?: return

    val parsed = try {
        URI(url)
    } catch (_: Exception) {
        throw IllegalArgumentException("Plugin fetch URL is invalid: $url")
    }
    val scheme = parsed.scheme?.lowercase(Locale.US)
        ?: throw IllegalArgumentException("Plugin fetch URL is invalid: $url")
    require(scheme == "http" || scheme == "https") {
        "Plugin fetch protocol is not allowed: ${parsed.scheme}"
    }

    val requestHost = parsed.host?.lowercase(Locale.US)?.removeSuffix(".")
        ?: throw IllegalArgumentException("Plugin fetch URL is invalid: $url")
    val allowed = allowedHosts.any { host ->
        requestHost == host || requestHost.endsWith(".$host")
    }
    require(allowed) {
        "Plugin fetch host is not declared in manifest: $requestHost"
    }
}

fun sha256Hex(input: String): String {
    val digest = MessageDigest.getInstance("SHA-256").digest(input.toByteArray(Charsets.UTF_8))
    return digest.joinToString("") { byte -> "%02x".format(byte) }
}

fun createInstalledPluginRecord(
    code: String,
    manifest: SearchPluginManifest,
    sourceUrl: String? = null,
    now: Long = System.currentTimeMillis()
): InstalledPluginRecord {
    val normalizedManifest = normalizeSearchPluginManifest(manifest, sourceUrl)
    val sourceHash = sha256Hex(code)
    val pluginId = normalizedManifest.id
        ?: "${slugify(normalizedManifest.name).ifEmpty { "plugin" }}-${sourceHash.take(8)}"

    return InstalledPluginRecord(
        pluginId = pluginId,
        manifest = normalizedManifest,
        sourceUrl = trimOptionalString(sourceUrl),
        sourceHash = sourceHash,
        installedAt = now,
        updatedAt = now,
        enabled = true,
        code = code
    )
}

private fun clampString(value: String?, maxLength: Int = MAX_PLUGIN_STRING_LENGTH): String? {
    val trimmed = value?.trim() ?: return null
    if (trimmed.isEmpty()) return null
    return trimmed.take(maxLength)
}

private fun clampUrl(value: String?): String? {
    return clampString(value, MAX_PLUGIN_URL_LENGTH)
}

fun sanitizeSearchResult(result: SearchResult): SearchResult {
    return result.copy(
        name = clampString(result.name) ?: "Untitled result",
        source = clampString(result.source) ?: "Unknown source",
        magnetUrl = clampUrl(result.magnetUrl),
        torrentUrl = clampUrl(result.torrentUrl),
        infoHash = clampString(result.infoHash, 64),
        detailsUrl = clampUrl(result.detailsUrl)
    )
}

fun sanitizeRunTrace(trace: SearchPluginRunTrace): SearchPluginRunTrace {
    return trace.copy(
        results = trace.results
            .take(MAX_PLUGIN_RESULTS)
            .map(::sanitizeSearchResult),
        logs = trace.logs
            .take(MAX_PLUGIN_LOGS)
            .map { log ->
                log.copy(message = clampString(log.message) ?: "")
            },
        requests = trace.requests
            .take(MAX_PLUGIN_REQUESTS)
            .map { request ->
                request.copy(
                    url = clampUrl(request.url) ?: "",
                    method = clampString(request.method, 16) ?: "GET",
                    remoteAddress = clampString(request.remoteAddress, 128),
                    error = clampString(request.error)
                )
            },
        error = trace.error?.copy(
            name = clampString(trace.error.name, 64) ?: "Error",
            message = clampString(trace.error.message) ?: "Plugin failed",
            stack = clampString(trace.error.stack, 4_000)
        )
    )
}

fun sanitizeDraftRunResult(result: SearchPluginDraftRunResult): SearchPluginDraftRunResult {
    return result.copy(
        manifest = result.manifest?.let { normalizeSearchPluginManifest(it) },
        trace = sanitizeRunTrace(result.trace)
    )
}
