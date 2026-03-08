package com.jstorrent.companion.server

import java.util.concurrent.ConcurrentHashMap

private const val DEFAULT_STREAM_IDLE_TIMEOUT_MS = 12 * 60 * 60 * 1000L

data class RegisteredHttpStream(
    val token: String,
    val ownerId: String,
    val rootKey: String,
    val path: String,
    val fileSize: Long,
    val mimeType: String?,
    val createdAt: Long,
    val lastAccessedAt: Long,
)

data class HttpByteRange(
    val start: Long,
    val endInclusive: Long,
    val totalSize: Long,
    val partial: Boolean,
) {
    val contentLength: Long
        get() = if (endInclusive < start) 0 else endInclusive - start + 1

    fun contentRangeHeader(): String = "bytes $start-$endInclusive/$totalSize"
}

class HttpStreamSessionRegistry(
    private val idleTimeoutMs: Long = DEFAULT_STREAM_IDLE_TIMEOUT_MS,
) {
    private val sessions = ConcurrentHashMap<String, RegisteredHttpStream>()

    fun register(
        ownerId: String,
        token: String,
        rootKey: String,
        path: String,
        fileSize: Long,
        mimeType: String?,
    ): RegisteredHttpStream {
        val now = System.currentTimeMillis()
        val session = RegisteredHttpStream(
            token = token,
            ownerId = ownerId,
            rootKey = rootKey,
            path = path,
            fileSize = fileSize,
            mimeType = mimeType,
            createdAt = now,
            lastAccessedAt = now,
        )
        sessions[token] = session
        return session
    }

    fun getAndTouch(token: String): RegisteredHttpStream? {
        val now = System.currentTimeMillis()
        var updated: RegisteredHttpStream? = null
        sessions.compute(token) { _, current ->
            if (current == null || isExpired(current, now)) {
                null
            } else {
                current.copy(lastAccessedAt = now).also { updated = it }
            }
        }
        return updated
    }

    fun revoke(token: String): Boolean = sessions.remove(token) != null

    fun revokeOwnedBy(ownerId: String): Int {
        var removed = 0
        for ((token, session) in sessions.entries) {
            if (session.ownerId != ownerId) continue
            if (sessions.remove(token, session)) {
                removed++
            }
        }
        return removed
    }

    fun clear() {
        sessions.clear()
    }

    private fun isExpired(session: RegisteredHttpStream, now: Long): Boolean {
        return now - session.lastAccessedAt > idleTimeoutMs
    }
}

fun resolveHttpByteRange(rangeHeader: String?, totalSize: Long): HttpByteRange? {
    if (totalSize < 0) return null

    if (rangeHeader.isNullOrBlank()) {
        return HttpByteRange(
            start = 0,
            endInclusive = if (totalSize == 0L) -1 else totalSize - 1,
            totalSize = totalSize,
            partial = false,
        )
    }

    if (!rangeHeader.startsWith("bytes=") || totalSize == 0L) {
        return null
    }

    val spec = rangeHeader.removePrefix("bytes=").trim()
    if (spec.isEmpty() || spec.contains(",")) return null

    val parts = spec.split('-', limit = 2)
    if (parts.size != 2) return null

    val startPart = parts[0].trim()
    val endPart = parts[1].trim()

    return if (startPart.isEmpty()) {
        val suffixLength = endPart.toLongOrNull() ?: return null
        if (suffixLength <= 0) return null
        val start = (totalSize - suffixLength).coerceAtLeast(0)
        HttpByteRange(
            start = start,
            endInclusive = totalSize - 1,
            totalSize = totalSize,
            partial = true,
        )
    } else {
        val start = startPart.toLongOrNull() ?: return null
        if (start < 0 || start >= totalSize) return null

        val end = when {
            endPart.isEmpty() -> totalSize - 1
            else -> (endPart.toLongOrNull() ?: return null).coerceAtMost(totalSize - 1)
        }

        if (end < start) return null

        HttpByteRange(
            start = start,
            endInclusive = end,
            totalSize = totalSize,
            partial = true,
        )
    }
}
