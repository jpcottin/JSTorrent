package com.jstorrent.companion.server.streaming

import android.net.Uri
import android.util.Log
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
    companion object {
        private const val TAG = "StreamingBatchParser"
    }

    private var bytesRead: Long = 0

    /**
     * Parse the batch and emit writes to the callback.
     *
     * @return Number of writes successfully emitted, or -1 on error
     */
    fun parse(): Int {
        // Read count (u32 LE)
        val countLong = readU32()
        if (countLong == null || countLong > 10000) {
            Log.w(TAG, "Invalid count: $countLong (bytesRead=$bytesRead)")
            return -1  // Invalid count
        }
        val count = countLong.toInt()

        Log.d(TAG, "Parsing batch with $count writes, contentLength=$contentLength")

        var emitted = 0

        for (i in 0 until count) {
            val job = parseOneWrite(i)
            if (job == null) {
                Log.w(TAG, "Failed to parse write #$i of $count (bytesRead=$bytesRead/$contentLength)")
                return -1
            }

            if (!onWrite(job)) {
                // Callback returned false (e.g., pool stopped)
                return emitted
            }
            emitted++
        }

        return emitted
    }

    private fun parseOneWrite(writeIndex: Int): WriteJob? {
        val startBytes = bytesRead

        // rootKeyLen (u8) + rootKey
        val rootKeyLen = readU8()
        if (rootKeyLen < 0) {
            Log.w(TAG, "Write #$writeIndex: failed to read rootKeyLen at byte $startBytes")
            return null
        }
        val rootKey = readString(rootKeyLen)
        if (rootKey == null) {
            Log.w(TAG, "Write #$writeIndex: failed to read rootKey (len=$rootKeyLen) at byte $startBytes")
            return null
        }

        // Resolve rootKey to Uri
        val rootUri = rootResolver(rootKey)
        if (rootUri == null) {
            Log.w(TAG, "Write #$writeIndex: rootKey '$rootKey' not found in rootStore")
            return null
        }

        // pathLen (u16 LE) + path
        val pathLen = readU16()
        if (pathLen == null) {
            Log.w(TAG, "Write #$writeIndex: failed to read pathLen")
            return null
        }
        val path = readString(pathLen)
        if (path == null) {
            Log.w(TAG, "Write #$writeIndex: failed to read path (len=$pathLen)")
            return null
        }

        // Validate path (no directory traversal)
        if (path.contains("..")) {
            Log.w(TAG, "Write #$writeIndex: path contains '..': $path")
            return null
        }

        // position (u64 LE as two u32)
        val posLow = readU32()
        val posHigh = readU32()
        if (posLow == null || posHigh == null) {
            Log.w(TAG, "Write #$writeIndex: failed to read position")
            return null
        }
        val position = posLow or (posHigh shl 32)

        // dataLen (u32 LE) + data
        val dataLenLong = readU32()
        if (dataLenLong == null) {
            Log.w(TAG, "Write #$writeIndex: failed to read dataLen")
            return null
        }
        if (dataLenLong > 16 * 1024 * 1024) {
            Log.w(TAG, "Write #$writeIndex: dataLen too large: $dataLenLong bytes")
            return null
        }
        val dataLen = dataLenLong.toInt()
        val data = readBytes(dataLen)
        if (data == null) {
            Log.w(TAG, "Write #$writeIndex: failed to read data (len=$dataLen)")
            return null
        }

        // hashHex (fixed 40 bytes)
        val hashHex = readString(40)
        if (hashHex == null) {
            Log.w(TAG, "Write #$writeIndex: failed to read hashHex (40 bytes)")
            return null
        }

        // callbackIdLen (u8) + callbackId
        val callbackIdLen = readU8()
        if (callbackIdLen < 0) {
            Log.w(TAG, "Write #$writeIndex: failed to read callbackIdLen")
            return null
        }
        val callbackId = readString(callbackIdLen)
        if (callbackId == null) {
            Log.w(TAG, "Write #$writeIndex: failed to read callbackId (len=$callbackIdLen)")
            return null
        }

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

    private fun readU16(): Int? {
        val bytes = readBytes(2) ?: return null
        return ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).short.toInt() and 0xFFFF
    }

    /**
     * Read a u32 as a Long (0 to 4294967295).
     * Returns null on read failure, never returns negative values.
     *
     * Note: We return Long instead of Int because Kotlin Int is signed,
     * so u32 values >= 2^31 would appear negative. Using Long ensures
     * we can represent the full 0 to 2^32-1 range without sign issues.
     */
    private fun readU32(): Long? {
        val bytes = readBytes(4) ?: return null
        // Read as signed int, then mask to get unsigned value as Long
        val signed = ByteBuffer.wrap(bytes).order(ByteOrder.LITTLE_ENDIAN).int
        return signed.toLong() and 0xFFFFFFFFL
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
