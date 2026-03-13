package com.jstorrent.app.search

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.URI
import java.net.URL
import java.nio.charset.Charset
import java.util.Locale

interface SearchPluginFetcher {
    suspend fun fetch(
        input: SearchPluginFetchInput,
        policy: SearchPluginFetchPolicy? = null
    ): SearchPluginFetchResponse
}

class SearchPluginFetchMediator(
    private val connectTimeoutMs: Int = DEFAULT_CONNECT_TIMEOUT_MS,
    private val readTimeoutMs: Int = DEFAULT_READ_TIMEOUT_MS,
    private val maxResponseBytes: Long = DEFAULT_MAX_RESPONSE_BYTES,
    private val maxRedirects: Int = DEFAULT_MAX_REDIRECTS
) : SearchPluginFetcher {

    override suspend fun fetch(
        input: SearchPluginFetchInput,
        policy: SearchPluginFetchPolicy?
    ): SearchPluginFetchResponse = withContext(Dispatchers.IO) {
        fetchInternal(input, policy)
    }

    private fun fetchInternal(
        input: SearchPluginFetchInput,
        policy: SearchPluginFetchPolicy?
    ): SearchPluginFetchResponse {
        val method = normalizeMethod(input.method)
        var currentUrl = parseHttpUrl(input.url)
        ensurePluginFetchAllowed(currentUrl.toString(), policy)

        var redirectCount = 0
        while (true) {
            val connection = openConnection(currentUrl, method, input)
            try {
                val statusCode = connection.responseCode
                val location = connection.getHeaderField("Location")
                if (statusCode in REDIRECT_STATUS_CODES && !location.isNullOrBlank()) {
                    if (redirectCount >= maxRedirects) {
                        throw IOException("Plugin fetch exceeded redirect limit for $currentUrl")
                    }
                    currentUrl = currentUrl.toURI().resolve(location).toURL()
                    ensurePluginFetchAllowed(currentUrl.toString(), policy)
                    redirectCount += 1
                    continue
                }

                val bodyBytes = readBodyBytes(connection)
                val bodyText = decodeBodyText(bodyBytes, connection.contentType)
                return SearchPluginFetchResponse(
                    bodyText = bodyText,
                    bodyBytes = bodyBytes,
                    bytes = bodyBytes.size.toLong(),
                    statusCode = statusCode,
                    remoteAddress = resolveRemoteAddress(currentUrl),
                    finalUrl = currentUrl.toString()
                )
            } finally {
                connection.disconnect()
            }
        }

        throw IOException("Plugin fetch failed to resolve for ${input.url}")
    }

    private fun openConnection(
        url: URL,
        method: String,
        input: SearchPluginFetchInput
    ): HttpURLConnection {
        val connection = (url.openConnection() as HttpURLConnection).apply {
            requestMethod = method
            connectTimeout = connectTimeoutMs
            readTimeout = readTimeoutMs
            instanceFollowRedirects = false
            doInput = true
            useCaches = false
            setRequestProperty("User-Agent", USER_AGENT)
            input.headers.orEmpty().forEach { (key, value) ->
                setRequestProperty(key, value)
            }
        }

        if (method == "POST") {
            val payload = input.body?.toByteArray(Charsets.UTF_8) ?: ByteArray(0)
            connection.doOutput = true
            if (connection.getRequestProperty("Content-Type").isNullOrBlank()) {
                connection.setRequestProperty("Content-Type", "text/plain; charset=utf-8")
            }
            connection.setFixedLengthStreamingMode(payload.size)
            connection.outputStream.use { output ->
                output.write(payload)
            }
        }

        return connection
    }

    private fun readBodyBytes(connection: HttpURLConnection): ByteArray {
        val stream = runCatching { connection.inputStream }.getOrNull()
            ?: connection.errorStream
            ?: return ByteArray(0)
        return stream.use { input ->
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
            var total = 0L
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                total += read
                if (total > maxResponseBytes) {
                    throw IOException("Plugin fetch exceeded max response size of $maxResponseBytes bytes")
                }
                output.write(buffer, 0, read)
            }
            output.toByteArray()
        }
    }

    private fun decodeBodyText(body: ByteArray, contentType: String?): String {
        if (body.isEmpty()) {
            return ""
        }
        val charsetName = contentType
            ?.split(';')
            ?.map { it.trim() }
            ?.firstOrNull { it.startsWith("charset=", ignoreCase = true) }
            ?.substringAfter('=')
            ?.trim()

        val charset = charsetName
            ?.takeIf { it.isNotEmpty() }
            ?.let {
                runCatching { Charset.forName(it) }.getOrNull()
            }
            ?: Charsets.UTF_8
        return body.toString(charset)
    }

    private fun normalizeMethod(method: String?): String {
        val normalized = method?.trim()?.uppercase(Locale.US)?.ifEmpty { "GET" } ?: "GET"
        require(normalized == "GET" || normalized == "POST") {
            "Plugin fetch method is not allowed: $normalized"
        }
        return normalized
    }

    private fun parseHttpUrl(rawUrl: String): URL {
        val uri = try {
            URI(rawUrl)
        } catch (_: Exception) {
            throw IllegalArgumentException("Plugin fetch URL is invalid: $rawUrl")
        }
        val scheme = uri.scheme?.lowercase(Locale.US)
            ?: throw IllegalArgumentException("Plugin fetch URL is invalid: $rawUrl")
        require(scheme == "http" || scheme == "https") {
            "Plugin fetch protocol is not allowed: ${uri.scheme}"
        }
        return uri.toURL()
    }

    private fun resolveRemoteAddress(url: URL): String? {
        return runCatching {
            InetAddress.getByName(url.host).hostAddress
        }.getOrNull()
    }

    companion object {
        private const val USER_AGENT = "JSTorrentAndroidSearchPlugin/1.0"
        private const val DEFAULT_CONNECT_TIMEOUT_MS = 15_000
        private const val DEFAULT_READ_TIMEOUT_MS = 15_000
        private const val DEFAULT_MAX_RESPONSE_BYTES = 1_048_576L
        private const val DEFAULT_MAX_REDIRECTS = 3
        private val REDIRECT_STATUS_CODES = setOf(301, 302, 303, 307, 308)
    }
}
