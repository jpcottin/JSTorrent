package com.jstorrent.companion.server.streaming

import android.net.Uri
import java.io.InputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Streaming parser for the verified write batch binary format.
 *
 * Parses incrementally as bytes arrive from the socket.
 * Only buffers the current field being read, not the whole batch.
 *
 * Binary format (all multi-byte integers are little-endian):
 *   [count: u32 LE] then for each write:
 *     [rootKeyLen: u8] [rootKey: UTF-8 bytes]
 *     [pathLen: u16 LE] [path: UTF-8 bytes]
 *     [position: u64 LE]
 *     [dataLen: u32 LE] [data: bytes]
 *     [hashHex: 40 bytes] (fixed size - SHA1 hex is always 40 chars)
 *     [callbackIdLen: u8] [callbackId: UTF-8 bytes]
 *
 * @param input The socket input stream (positioned after HTTP headers)
 * @param contentLength Expected body length
 * @param rootResolver Function to resolve rootKey -> Uri
 * @param onWrite Callback for each parsed write (blocks if queue full = backpressure)
 */
class StreamingBatchParser(
    private val input: InputStream,
    private val contentLength: Long,
    private val rootResolver: (String) -> Uri?,
    private val onWrite: (WriteJob) -> Boolean,  // Returns false to abort
) {
    private var bytesRead: Long = 0

    /**
     * Parse the batch and emit writes to the callback.
     *
     * @return Number of writes successfully emitted, or -1 on error
     */
    fun parse(): Int {
        // Read count (u32 LE)
        val count = readU32()
        if (count < 0 || count > 10000) {
            return -1  // Invalid count
        }

        var emitted = 0

        for (i in 0 until count) {
            val job = parseOneWrite() ?: return -1

            if (!onWrite(job)) {
                // Callback returned false (e.g., pool stopped)
                return emitted
            }
            emitted++
        }

        return emitted
    }

    private fun parseOneWrite(): WriteJob? {
        // rootKeyLen (u8) + rootKey
        val rootKeyLen = readU8()
        if (rootKeyLen < 0) return null
        val rootKey = readString(rootKeyLen) ?: return null

        // Resolve rootKey to Uri
        val rootUri = rootResolver(rootKey) ?: return null

        // pathLen (u16 LE) + path
        val pathLen = readU16()
        if (pathLen < 0) return null
        val path = readString(pathLen) ?: return null

        // Validate path (no directory traversal)
        if (path.contains("..")) return null

        // position (u64 LE as two u32)
        val posLow = readU32()
        val posHigh = readU32()
        if (posLow < 0 || posHigh < 0) return null
        val position = (posLow.toLong() and 0xFFFFFFFFL) or ((posHigh.toLong() and 0xFFFFFFFFL) shl 32)

        // dataLen (u32 LE) + data
        val dataLen = readU32()
        if (dataLen < 0 || dataLen > 16 * 1024 * 1024) return null  // Max 16MB per piece
        val data = readBytes(dataLen) ?: return null

        // hashHex (fixed 40 bytes)
        val hashHex = readString(40) ?: return null

        // callbackIdLen (u8) + callbackId
        val callbackIdLen = readU8()
        if (callbackIdLen < 0) return null
        val callbackId = readString(callbackIdLen) ?: return null

        return WriteJob(
            rootUri = rootUri,
            path = path,
            position = position,
            data = data,
            expectedHashHex = hashHex,
            callbackId = callbackId,
        )
    }

    private fun readU8(): Int {
        if (bytesRead >= contentLength) return -1
        val b = input.read()
        if (b < 0) return -1
        bytesRead++
        return b
    }

    private fun readU16(): Int {
        val bytes = readBytes(2) ?: return -1
        return ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF
    }

    private fun readU32(): Int {
        val bytes = readBytes(4) ?: return -1
        return ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).int
    }

    private fun readBytes(len: Int): ByteArray? {
        if (len == 0) return ByteArray(0)
        if (bytesRead + len > contentLength) return null

        val buf = ByteArray(len)
        var offset = 0
        while (offset < len) {
            val n = input.read(buf, offset, len - offset)
            if (n < 0) return null
            offset += n
            bytesRead += n
        }
        return buf
    }

    private fun readString(len: Int): String? {
        val bytes = readBytes(len) ?: return null
        return String(bytes, Charsets.UTF_8)
    }
}
