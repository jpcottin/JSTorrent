package com.jstorrent.companion.server.streaming

import java.io.InputStream

/**
 * Parsed HTTP request headers.
 */
data class HttpRequestHeaders(
    val method: String,
    val path: String,
    val contentLength: Long,
    val authToken: String?,
    val extensionId: String?,
    val installId: String?,
)

/**
 * Minimal HTTP header parser for streaming batch writes.
 *
 * Only extracts what we need:
 * - Method and path from request line
 * - Content-Length
 * - Auth headers (X-JST-Auth or Authorization)
 * - Extension headers (X-JST-ExtensionId, X-JST-InstallId)
 *
 * Does NOT handle:
 * - Chunked transfer encoding (we require Content-Length)
 * - HTTP/2
 * - Keep-alive (one request per connection)
 */
object HttpHeaderParser {
    private const val MAX_HEADER_SIZE = 8192  // 8KB max header block
    private const val MAX_LINE_LENGTH = 4096

    /**
     * Parse HTTP headers from input stream.
     *
     * @param input The socket input stream
     * @return Parsed headers, or null if parsing fails
     */
    fun parse(input: InputStream): HttpRequestHeaders? {
        val headerBytes = ByteArray(MAX_HEADER_SIZE)
        var headerLen = 0
        var foundEnd = false

        // Read until we find \r\n\r\n (end of headers)
        while (headerLen < MAX_HEADER_SIZE) {
            val b = input.read()
            if (b == -1) return null  // Connection closed

            headerBytes[headerLen++] = b.toByte()

            // Check for end of headers: \r\n\r\n
            if (headerLen >= 4) {
                if (headerBytes[headerLen - 4] == '\r'.code.toByte() &&
                    headerBytes[headerLen - 3] == '\n'.code.toByte() &&
                    headerBytes[headerLen - 2] == '\r'.code.toByte() &&
                    headerBytes[headerLen - 1] == '\n'.code.toByte()) {
                    foundEnd = true
                    break
                }
            }
        }

        if (!foundEnd) return null  // Headers too large

        // Parse the header block
        val headerStr = String(headerBytes, 0, headerLen, Charsets.ISO_8859_1)
        val lines = headerStr.split("\r\n")
        if (lines.isEmpty()) return null

        // Parse request line: "POST /write-batch/abc HTTP/1.1"
        val requestLine = lines[0]
        val requestParts = requestLine.split(" ")
        if (requestParts.size < 2) return null

        val method = requestParts[0]
        val path = requestParts[1]

        // Parse headers
        var contentLength: Long = -1
        var authToken: String? = null
        var extensionId: String? = null
        var installId: String? = null

        for (i in 1 until lines.size) {
            val line = lines[i]
            if (line.isEmpty()) continue

            val colonIdx = line.indexOf(':')
            if (colonIdx < 0) continue

            val name = line.substring(0, colonIdx).trim().lowercase()
            val value = line.substring(colonIdx + 1).trim()

            when (name) {
                "content-length" -> contentLength = value.toLongOrNull() ?: -1
                "x-jst-auth" -> authToken = value
                "authorization" -> {
                    if (authToken == null && value.startsWith("Bearer ", ignoreCase = true)) {
                        authToken = value.substring(7)
                    }
                }
                "x-jst-extensionid" -> extensionId = value
                "x-jst-installid" -> installId = value
            }
        }

        return HttpRequestHeaders(
            method = method,
            path = path,
            contentLength = contentLength,
            authToken = authToken,
            extensionId = extensionId,
            installId = installId,
        )
    }

    /**
     * Send a simple HTTP response.
     */
    fun sendResponse(
        output: java.io.OutputStream,
        statusCode: Int,
        statusText: String,
        body: String? = null,
        contentType: String = "text/plain",
    ) {
        val bodyBytes = body?.toByteArray(Charsets.UTF_8)
        val response = buildString {
            append("HTTP/1.1 $statusCode $statusText\r\n")
            append("Connection: close\r\n")
            if (bodyBytes != null) {
                append("Content-Type: $contentType\r\n")
                append("Content-Length: ${bodyBytes.size}\r\n")
            } else {
                append("Content-Length: 0\r\n")
            }
            append("\r\n")
        }
        output.write(response.toByteArray(Charsets.ISO_8859_1))
        if (bodyBytes != null) {
            output.write(bodyBytes)
        }
        output.flush()
    }
}
