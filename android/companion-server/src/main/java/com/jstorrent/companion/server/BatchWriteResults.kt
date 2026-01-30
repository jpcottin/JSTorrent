package com.jstorrent.companion.server

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Write result codes for batch processing.
 * Matches the codes used in FileBindings.kt for consistency.
 */
object WriteResultCode {
    const val SUCCESS = 0
    const val HASH_MISMATCH = 1
    const val IO_ERROR = 2
    const val INVALID_ARGS = 3
}

/**
 * Write result for batch processing.
 * Sent via WebSocket after each write in a batch completes.
 */
data class WriteResult(
    val callbackId: String,
    val bytesWritten: Int,
    val resultCode: Int
)

/**
 * Parsed verified write request from batch.
 */
data class VerifiedWriteRequest(
    val rootKey: String,
    val path: String,
    val position: Long,
    val data: ByteArray,
    val expectedHashHex: String,
    val callbackId: String,
)

/**
 * Shared queue for batch write results.
 * HTTP handler adds results, WebSocket server drains and broadcasts.
 *
 * Architecture (single-user scenario):
 * - HTTP POST /write-batch receives packed batch, launches parallel writes
 * - Each write completion adds result to this queue
 * - WebSocket server drains queue and broadcasts ACK/ERROR frames to all clients
 * - JS client matches results by callbackId (only originator has pending promise)
 */
object BatchWriteResults {
    val pending = ConcurrentLinkedQueue<WriteResult>()

    @Volatile
    private var notifyCallback: (() -> Unit)? = null

    /**
     * Register callback to be invoked when results are available.
     * Called by WebSocket server during initialization.
     */
    fun setNotifyCallback(callback: () -> Unit) {
        notifyCallback = callback
    }

    /**
     * Add a result and notify the WebSocket server.
     * Called by write coroutines when each write completes.
     */
    fun addResult(callbackId: String, bytesWritten: Int, resultCode: Int) {
        pending.add(WriteResult(callbackId, bytesWritten, resultCode))
        notifyCallback?.invoke()
    }

    /**
     * Drain all pending results.
     * Called by WebSocket server to get results for broadcasting.
     */
    fun drain(): List<WriteResult> {
        val results = mutableListOf<WriteResult>()
        while (true) {
            val result = pending.poll() ?: break
            results.add(result)
        }
        return results
    }
}

/**
 * Unpack a batch of verified write requests from binary format.
 *
 * Format (all multi-byte integers are little-endian):
 *   [count: u32 LE] then for each write:
 *     [rootKeyLen: u8] [rootKey: UTF-8 bytes]
 *     [pathLen: u16 LE] [path: UTF-8 bytes]
 *     [position: u64 LE]
 *     [dataLen: u32 LE] [data: bytes]
 *     [hashHex: 40 bytes] (fixed size - SHA1 hex is always 40 chars)
 *     [callbackIdLen: u8] [callbackId: UTF-8 bytes]
 *
 * @return List of parsed write requests
 * @throws IllegalArgumentException if format is invalid
 */
fun unpackVerifiedWriteBatch(packed: ByteArray): List<VerifiedWriteRequest> {
    val buffer = ByteBuffer.wrap(packed).order(ByteOrder.LITTLE_ENDIAN)

    val count = buffer.int
    if (count < 0 || count > 10000) {
        throw IllegalArgumentException("Invalid batch count: $count")
    }

    val writes = mutableListOf<VerifiedWriteRequest>()

    for (i in 0 until count) {
        // rootKeyLen + rootKey
        val rootKeyLen = buffer.get().toInt() and 0xFF
        val rootKeyBytes = ByteArray(rootKeyLen)
        buffer.get(rootKeyBytes)
        val rootKey = String(rootKeyBytes, Charsets.UTF_8)

        // pathLen + path
        val pathLen = buffer.short.toInt() and 0xFFFF
        val pathBytes = ByteArray(pathLen)
        buffer.get(pathBytes)
        val path = String(pathBytes, Charsets.UTF_8)

        // position (u64 LE) - read as two u32 and combine
        val positionLow = buffer.int.toLong() and 0xFFFFFFFFL
        val positionHigh = buffer.int.toLong() and 0xFFFFFFFFL
        val position = positionLow or (positionHigh shl 32)

        // dataLen + data
        val dataLen = buffer.int
        if (dataLen < 0) {
            throw IllegalArgumentException("Invalid data length: $dataLen")
        }
        val data = ByteArray(dataLen)
        buffer.get(data)

        // hashHex (fixed 40 bytes)
        val hashHexBytes = ByteArray(40)
        buffer.get(hashHexBytes)
        val hashHex = String(hashHexBytes, Charsets.UTF_8)

        // callbackIdLen + callbackId
        val callbackIdLen = buffer.get().toInt() and 0xFF
        val callbackIdBytes = ByteArray(callbackIdLen)
        buffer.get(callbackIdBytes)
        val callbackId = String(callbackIdBytes, Charsets.UTF_8)

        writes.add(VerifiedWriteRequest(rootKey, path, position, data, hashHex, callbackId))
    }

    return writes
}
