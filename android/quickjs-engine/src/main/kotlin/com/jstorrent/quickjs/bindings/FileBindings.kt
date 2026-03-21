package com.jstorrent.quickjs.bindings

import android.content.Context
import android.net.Uri
import android.util.Log
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.file.FileManagerException
import com.jstorrent.io.file.VerifyChunksFile
import com.jstorrent.io.hash.Hasher
import com.jstorrent.quickjs.JsThread
import com.jstorrent.quickjs.QuickJsContext
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.ConcurrentLinkedQueue

// Must allow a full supported piece write (32MB) plus batch metadata overhead.
// This is a format sanity guard, not a backpressure limit.
private const val MAX_VERIFIED_WRITE_BATCH_PACKED_BYTES = 40 * 1024 * 1024

/**
 * Write result codes for async verified writes.
 * These codes are also used by the Rust io-daemon and must stay in sync
 * with packages/engine/src/core/write-error.ts WriteResultCode.
 */
object WriteResultCode {
    const val SUCCESS = 0
    const val HASH_MISMATCH = 1
    const val IO_ERROR = 2          // Transient I/O error (may be retriable)
    const val INVALID_ARGS = 3
    const val DISK_FULL = 4         // ENOSPC - unrecoverable, user must free space
    const val PERMISSION_DENIED = 5 // EACCES/EPERM - unrecoverable, user must fix permissions
}

/**
 * Read result codes for async read batch.
 */
object ReadResultCode {
    const val SUCCESS = 0
    const val IO_ERROR = 2
    const val INVALID_ARGS = 3
}

/**
 * Phase 4: Event holding disk write result for batch delivery.
 */
data class DiskWriteResultEvent(
    val callbackId: String,
    val bytesWritten: Int,
    val resultCode: Int,
    val timestamp: Long = System.currentTimeMillis()
)

/**
 * Event holding disk read result for batch delivery.
 */
data class DiskReadResultEvent(
    val callbackId: String,
    val data: ByteArray,
    val resultCode: Int,
)

/**
 * Parsed read request from batch.
 */
data class ReadRequest(
    val rootKey: String,
    val path: String,
    val position: Long,
    val length: Int,
    val callbackId: String,
)

/**
 * Unpack a batch of read requests from binary format.
 *
 * Format (all multi-byte integers are little-endian):
 *   [count: u32 LE] then for each read:
 *     [rootKeyLen: u8] [rootKey: UTF-8 bytes]
 *     [pathLen: u16 LE] [path: UTF-8 bytes]
 *     [position: u64 LE]
 *     [length: u32 LE]
 *     [callbackIdLen: u8] [callbackId: UTF-8 bytes]
 */
fun unpackReadBatch(packed: ByteArray): List<ReadRequest> {
    val buffer = ByteBuffer.wrap(packed).order(ByteOrder.LITTLE_ENDIAN)

    val count = buffer.int
    if (count < 0 || count > 10000) {
        throw IllegalArgumentException("Invalid batch count: $count")
    }

    val reads = mutableListOf<ReadRequest>()

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

        // length
        val length = buffer.int

        // callbackIdLen + callbackId
        val callbackIdLen = buffer.get().toInt() and 0xFF
        val callbackIdBytes = ByteArray(callbackIdLen)
        buffer.get(callbackIdBytes)
        val callbackId = String(callbackIdBytes, Charsets.UTF_8)

        reads.add(ReadRequest(rootKey, path, position, length, callbackId))
    }

    return reads
}

/**
 * Parsed verified write request from batch.
 */
data class VerifiedWriteRequest(
    val rootKey: String,
    val path: String,
    val position: Long,
    val packed: ByteArray,
    val dataOffset: Int,
    val dataLength: Int,
    val expectedHashHex: String,
    val callbackId: String,
)

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
    if (packed.size > MAX_VERIFIED_WRITE_BATCH_PACKED_BYTES) {
        throw IllegalArgumentException("Verified write batch too large: ${packed.size} bytes")
    }

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
        if (dataLen < 0 || dataLen > buffer.remaining() - 41) {
            throw IllegalArgumentException("Invalid data length: $dataLen")
        }
        val dataOffset = buffer.position()
        buffer.position(dataOffset + dataLen)

        // hashHex (fixed 40 bytes)
        val hashHexBytes = ByteArray(40)
        buffer.get(hashHexBytes)
        val hashHex = String(hashHexBytes, Charsets.UTF_8)

        // callbackIdLen + callbackId
        val callbackIdLen = buffer.get().toInt() and 0xFF
        val callbackIdBytes = ByteArray(callbackIdLen)
        buffer.get(callbackIdBytes)
        val callbackId = String(callbackIdBytes, Charsets.UTF_8)

        writes.add(
            VerifiedWriteRequest(
                rootKey = rootKey,
                path = path,
                position = position,
                packed = packed,
                dataOffset = dataOffset,
                dataLength = dataLen,
                expectedHashHex = hashHex,
                callbackId = callbackId,
            )
        )
    }

    if (buffer.hasRemaining()) {
        throw IllegalArgumentException("Trailing bytes in verified write batch: ${buffer.remaining()}")
    }

    return writes
}

/**
 * Parsed unverified write request from batch.
 * Same as VerifiedWriteRequest but without expectedHashHex.
 */
data class WriteRequest(
    val rootKey: String,
    val path: String,
    val position: Long,
    val packed: ByteArray,
    val dataOffset: Int,
    val dataLength: Int,
    val callbackId: String,
)

/**
 * Unpack a batch of (unverified) write requests from binary format.
 *
 * Format (all multi-byte integers are little-endian):
 *   [count: u32 LE] then for each write:
 *     [rootKeyLen: u8] [rootKey: UTF-8 bytes]
 *     [pathLen: u16 LE] [path: UTF-8 bytes]
 *     [position: u64 LE]
 *     [dataLen: u32 LE] [data: bytes]
 *     [callbackIdLen: u8] [callbackId: UTF-8 bytes]
 *
 * Same as verified write batch but WITHOUT the 40-byte hash field.
 */
fun unpackWriteBatch(packed: ByteArray): List<WriteRequest> {
    if (packed.size > MAX_VERIFIED_WRITE_BATCH_PACKED_BYTES) {
        throw IllegalArgumentException("Write batch too large: ${packed.size} bytes")
    }

    val buffer = ByteBuffer.wrap(packed).order(ByteOrder.LITTLE_ENDIAN)

    val count = buffer.int
    if (count < 0 || count > 10000) {
        throw IllegalArgumentException("Invalid batch count: $count")
    }

    val writes = mutableListOf<WriteRequest>()

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
        if (dataLen < 0 || dataLen > buffer.remaining() - 1) {
            throw IllegalArgumentException("Invalid data length: $dataLen")
        }
        val dataOffset = buffer.position()
        buffer.position(dataOffset + dataLen)

        // callbackIdLen + callbackId
        val callbackIdLen = buffer.get().toInt() and 0xFF
        val callbackIdBytes = ByteArray(callbackIdLen)
        buffer.get(callbackIdBytes)
        val callbackId = String(callbackIdBytes, Charsets.UTF_8)

        writes.add(
            WriteRequest(
                rootKey = rootKey,
                path = path,
                position = position,
                packed = packed,
                dataOffset = dataOffset,
                dataLength = dataLen,
                callbackId = callbackId,
            )
        )
    }

    if (buffer.hasRemaining()) {
        throw IllegalArgumentException("Trailing bytes in write batch: ${buffer.remaining()}")
    }

    return writes
}

/**
 * File I/O bindings for QuickJS.
 *
 * Implements stateless file operations using [FileManager]:
 * - __jstorrent_file_read(rootKey, path, offset, length) -> ArrayBuffer
 * - __jstorrent_file_write(rootKey, path, offset, data) -> number (sync)
 * - __jstorrent_file_write_verified(rootKey, path, offset, data, expectedSha1Hex, callbackId) -> void (async)
 * - __jstorrent_file_write_verified_batch(packed) -> void (async batched)
 * - __jstorrent_file_write_batch(packed) -> void (async batched, no hash)
 * - __jstorrent_file_stat(rootKey, path) -> string | null
 * - __jstorrent_file_mkdir(rootKey, path) -> boolean
 * - __jstorrent_file_exists(rootKey, path) -> boolean
 * - __jstorrent_file_readdir(rootKey, path) -> string (JSON array)
 * - __jstorrent_file_delete(rootKey, path) -> boolean
 *
 * Sync operations block the JS thread. The async write_verified operation runs
 * hashing and I/O on a background thread, posting results back to JS via callback.
 * The batch versions accept multiple writes packed in binary format to reduce FFI overhead.
 *
 * Root resolution:
 * - Empty or "default" rootKey resolves to app-private downloads directory
 * - Other rootKeys are resolved via [rootResolver] (for SAF URIs)
 */
class FileBindings(
    private val context: Context,
    private val fileManager: FileManager,
    private val rootResolver: (String) -> Uri?,
    private val jsThread: JsThread? = null,
) {
    // Coroutine scope for async I/O operations (hash + write on background thread)
    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    companion object {
        private const val TAG = "FileBindings"

        // Pending callback queue tracking (callbacks waiting to be processed by JS thread)
        private val pendingCallbacks = java.util.concurrent.atomic.AtomicInteger(0)
        @Volatile private var maxQueueDepth = 0
        @Volatile private var queueLogTime = System.currentTimeMillis()

        // Throughput and latency tracking for backpressure detection
        @Volatile private var bytesWritten = 0L
        @Volatile private var writeCount = 0
        @Volatile private var totalWriteTimeMs = 0L
        @Volatile private var maxWriteLatencyMs = 0L
        @Volatile private var lastLogTime = System.currentTimeMillis()

        // Separate tracking for hash vs disk time (batch writes only)
        @Volatile private var totalHashTimeMs = 0L
        @Volatile private var totalDiskTimeMs = 0L
        @Volatile private var maxHashTimeMs = 0L
        @Volatile private var maxDiskTimeMs = 0L

        // ============================================================
        // Phase 4: Batch disk write result crossing
        // ============================================================

        /**
         * Pending disk write results from I/O threads, waiting to be flushed to JS.
         * Thread-safe: I/O threads add, JS thread drains via flushDiskWriteResults().
         */
        private val pendingDiskResults = ConcurrentLinkedQueue<DiskWriteResultEvent>()

        /**
         * Metrics for batch processing.
         */
        @Volatile private var diskBatchFlushCount = 0
        @Volatile private var diskBatchEventsTotal = 0L
        @Volatile private var diskBatchLogTime = System.currentTimeMillis()

        /**
         * Get number of events pending in the disk write result queue.
         */
        fun getPendingDiskEventCount(): Int = pendingDiskResults.size

        /**
         * Queue a disk write result for batch processing.
         * Called from I/O threads, drained by flushDiskWriteResults on JS thread.
         */
        fun queueDiskWriteResult(callbackId: String, bytesWritten: Int, resultCode: Int) {
            pendingDiskResults.add(DiskWriteResultEvent(callbackId, bytesWritten, resultCode))
        }

        /**
         * Drain pending events and pack into binary format.
         * Format: [count: u32 LE] then for each:
         *   [callbackIdLen: u8] [callbackId: bytes] [bytesWritten: i32 LE] [resultCode: u8]
         * Returns null if queue is empty.
         */
        fun drainAndPackDiskBatch(): ByteArray? {
            val batch = mutableListOf<DiskWriteResultEvent>()
            while (true) {
                val event = pendingDiskResults.poll() ?: break
                batch.add(event)
            }

            if (batch.isEmpty()) return null

            // Update metrics
            diskBatchFlushCount++
            diskBatchEventsTotal += batch.size

            // Log batch stats periodically
            val now = System.currentTimeMillis()
            if (now - diskBatchLogTime >= 5000 && diskBatchFlushCount > 0) {
                val avgEvents = diskBatchEventsTotal.toFloat() / diskBatchFlushCount
                Log.i(TAG, "Disk batch: %d flushes, avg %.1f events/flush".format(
                    diskBatchFlushCount, avgEvents))
                diskBatchFlushCount = 0
                diskBatchEventsTotal = 0
                diskBatchLogTime = now
            }

            // Pack format: [count: u32 LE] then for each:
            // [callbackIdLen: u8] [callbackId: bytes] [bytesWritten: i32 LE] [resultCode: u8]
            val packedSize = 4 + batch.sumOf { event ->
                1 + event.callbackId.toByteArray(Charsets.UTF_8).size + 4 + 1
            }
            val buf = ByteBuffer.allocate(packedSize).order(ByteOrder.LITTLE_ENDIAN)
            buf.putInt(batch.size)
            for (event in batch) {
                val idBytes = event.callbackId.toByteArray(Charsets.UTF_8)
                buf.put(idBytes.size.toByte())
                buf.put(idBytes)
                buf.putInt(event.bytesWritten)
                buf.put(event.resultCode.toByte())
            }
            return buf.array()
        }

        // ============================================================
        // Async disk read result crossing
        // ============================================================

        /**
         * Pending disk read results from I/O threads, waiting to be flushed to JS.
         * Thread-safe: I/O threads add, JS thread drains via __jstorrent_file_flush().
         */
        private val pendingDiskReadResults = ConcurrentLinkedQueue<DiskReadResultEvent>()

        @Volatile private var readBatchFlushCount = 0
        @Volatile private var readBatchEventsTotal = 0L
        @Volatile private var readBatchBytesTotal = 0L
        @Volatile private var readBatchLogTime = System.currentTimeMillis()

        /**
         * Queue a disk read result for batch processing.
         * Called from I/O threads, drained at start of next tick.
         */
        fun queueDiskReadResult(callbackId: String, data: ByteArray, resultCode: Int) {
            pendingDiskReadResults.add(DiskReadResultEvent(callbackId, data, resultCode))
        }

        /**
         * Drain pending read results and pack into binary format.
         * Format: [count: u32 LE] then for each:
         *   [callbackIdLen: u8] [callbackId: bytes] [resultCode: u8] [dataLen: u32 LE] [data: bytes]
         * Returns null if queue is empty.
         */
        fun drainAndPackDiskReadBatch(): ByteArray? {
            val batch = mutableListOf<DiskReadResultEvent>()
            while (true) {
                val event = pendingDiskReadResults.poll() ?: break
                batch.add(event)
            }

            if (batch.isEmpty()) return null

            // Update metrics
            readBatchFlushCount++
            readBatchEventsTotal += batch.size
            readBatchBytesTotal += batch.sumOf { it.data.size.toLong() }

            // Log batch stats periodically
            val now = System.currentTimeMillis()
            if (now - readBatchLogTime >= 5000 && readBatchFlushCount > 0) {
                val avgEvents = readBatchEventsTotal.toFloat() / readBatchFlushCount
                val totalMB = readBatchBytesTotal / (1024.0 * 1024.0)
                Log.i(TAG, "Read batch: %d flushes, avg %.1f events/flush, %.2f MB total".format(
                    readBatchFlushCount, avgEvents, totalMB))
                readBatchFlushCount = 0
                readBatchEventsTotal = 0
                readBatchBytesTotal = 0
                readBatchLogTime = now
            }

            // Pack format: [count: u32 LE] then for each:
            // [callbackIdLen: u8] [callbackId: bytes] [resultCode: u8] [dataLen: u32 LE] [data: bytes]
            val packedSize = 4 + batch.sumOf { event ->
                1 + event.callbackId.toByteArray(Charsets.UTF_8).size + 1 + 4 + event.data.size
            }
            val buf = ByteBuffer.allocate(packedSize).order(ByteOrder.LITTLE_ENDIAN)
            buf.putInt(batch.size)
            for (event in batch) {
                val idBytes = event.callbackId.toByteArray(Charsets.UTF_8)
                buf.put(idBytes.size.toByte())
                buf.put(idBytes)
                buf.put(event.resultCode.toByte())
                buf.putInt(event.data.size)
                buf.put(event.data)
            }
            return buf.array()
        }

        /**
         * Get current callback queue depth.
         * This is the number of disk callbacks waiting to be processed by JS.
         */
        fun getQueueDepth(): Int = pendingCallbacks.get()

        /**
         * Get max queue depth since last reset (resets every 5 seconds during logging).
         */
        fun getMaxQueueDepth(): Int = maxQueueDepth

        /**
         * Track queue depth increment and log if needed.
         */
        private fun incrementQueue(): Int {
            val depth = pendingCallbacks.incrementAndGet()
            if (depth > maxQueueDepth) {
                maxQueueDepth = depth
            }
            if (depth > 20) {
                Log.w(TAG, "Disk callback queue depth: $depth (BACKPRESSURE)")
            }
            return depth
        }

        /**
         * Track queue depth decrement and periodic logging.
         */
        private fun decrementQueue() {
            pendingCallbacks.decrementAndGet()
            val now = System.currentTimeMillis()
            if (now - queueLogTime >= 5000 && maxQueueDepth > 0) {
                Log.i(TAG, "Disk callback queue: current=%d, max=%d".format(
                    pendingCallbacks.get(), maxQueueDepth))
                maxQueueDepth = 0
                queueLogTime = now
            }
        }
    }

    // App-private downloads directory (fallback when rootKey is empty/"default")
    private val appPrivateDownloads: File by lazy {
        File(context.filesDir, "downloads").also { it.mkdirs() }
    }

    /**
     * Register all file bindings on the given context.
     */
    fun register(ctx: QuickJsContext) {
        registerReadWrite(ctx)
        registerAsyncWrite(ctx)
        registerAsyncRead(ctx)
        registerPathFunctions(ctx)
    }

    /**
     * Drain queued disk write and read results and deliver them to JS from a
     * top-level Kotlin entry point.
     *
     * This must run on the JS thread. Using a top-level call avoids re-entering
     * QuickJS from inside a JS -> Kotlin callback.
     */
    fun dispatchPendingCallbacks(ctx: QuickJsContext) {
        val writePacked = drainAndPackDiskBatch()
        if (writePacked != null) {
            ctx.callGlobalFunctionWithBinary(
                "__jstorrent_file_dispatch_batch",
                writePacked,
                0,
                null
            )
        }

        val readPacked = drainAndPackDiskReadBatch()
        if (readPacked != null) {
            ctx.callGlobalFunctionWithBinary(
                "__jstorrent_file_dispatch_read_batch",
                readPacked,
                0,
                null
            )
        }
    }

    /**
     * Resolve rootKey to a Uri.
     * - Empty or "default" -> app-private downloads directory
     * - Otherwise -> use rootResolver (for SAF URIs)
     */
    private fun resolveRoot(rootKey: String): Uri? {
        return when {
            rootKey.isEmpty() || rootKey == "default" ->
                Uri.fromFile(appPrivateDownloads)
            else -> rootResolver(rootKey)
        }
    }

    /**
     * Register stateless read/write functions.
     */
    private fun registerReadWrite(ctx: QuickJsContext) {
        // __jstorrent_file_read(rootKey: string, path: string, offset: number, length: number): ArrayBuffer
        ctx.setGlobalFunctionReturnsBinary("__jstorrent_file_read") { args, _ ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""
            val offset = args.getOrNull(2)?.toLongOrNull() ?: 0L
            val length = args.getOrNull(3)?.toIntOrNull() ?: 0

            if (path.isEmpty() || length <= 0) {
                return@setGlobalFunctionReturnsBinary ByteArray(0)
            }

            val rootUri = resolveRoot(rootKey)
            if (rootUri == null) {
                Log.w(TAG, "Unknown root key: $rootKey")
                return@setGlobalFunctionReturnsBinary ByteArray(0)
            }

            try {
                fileManager.read(rootUri, path, offset, length)
            } catch (e: FileManagerException) {
                Log.e(TAG, "Read failed: $path", e)
                ByteArray(0)
            } catch (e: Exception) {
                Log.e(TAG, "Read failed: $path", e)
                ByteArray(0)
            }
        }

        // __jstorrent_file_write(rootKey: string, path: string, offset: number, data: ArrayBuffer): number
        ctx.setGlobalFunctionWithBinary("__jstorrent_file_write", 3) { args, binary ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""
            val offset = args.getOrNull(2)?.toLongOrNull() ?: 0L

            if (path.isEmpty() || binary == null) {
                return@setGlobalFunctionWithBinary "-1"
            }

            val rootUri = resolveRoot(rootKey)
            if (rootUri == null) {
                Log.w(TAG, "Unknown root key: $rootKey")
                return@setGlobalFunctionWithBinary "-1"
            }

            try {
                val startTime = System.currentTimeMillis()
                fileManager.write(rootUri, path, offset, binary)
                val elapsed = System.currentTimeMillis() - startTime

                // Track stats
                bytesWritten += binary.size
                writeCount++
                totalWriteTimeMs += elapsed
                if (elapsed > maxWriteLatencyMs) {
                    maxWriteLatencyMs = elapsed
                }

                // Log every 5 seconds
                val now = System.currentTimeMillis()
                val sinceLastLog = now - lastLogTime
                if (sinceLastLog >= 5000) {
                    val mbWritten = bytesWritten / (1024.0 * 1024.0)
                    val mbps = mbWritten / (sinceLastLog / 1000.0)
                    val avgLatency = if (writeCount > 0) totalWriteTimeMs / writeCount else 0
                    Log.i(TAG, "Disk write: %.2f MB/s, %d writes, avg %dms, max %dms".format(
                        mbps, writeCount, avgLatency, maxWriteLatencyMs))
                    bytesWritten = 0
                    writeCount = 0
                    totalWriteTimeMs = 0
                    maxWriteLatencyMs = 0
                    lastLogTime = now
                }

                binary.size.toString()
            } catch (e: FileManagerException) {
                Log.e(TAG, "Write failed: $path", e)
                "-1"
            } catch (e: Exception) {
                Log.e(TAG, "Write failed: $path", e)
                "-1"
            }
        }
    }

    /**
     * Register functions that operate on paths.
     */
    private fun registerPathFunctions(ctx: QuickJsContext) {
        // __jstorrent_file_stat(rootKey: string, path: string): string | null
        ctx.setGlobalFunction("__jstorrent_file_stat") { args ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""

            val rootUri = resolveRoot(rootKey) ?: return@setGlobalFunction null

            try {
                val stat = fileManager.stat(rootUri, path) ?: return@setGlobalFunction null
                JSONObject().apply {
                    put("size", stat.size)
                    put("mtime", stat.mtime)
                    put("isDirectory", stat.isDirectory)
                    put("isFile", stat.isFile)
                }.toString()
            } catch (e: Exception) {
                Log.e(TAG, "Stat failed: $path", e)
                null
            }
        }

        // __jstorrent_file_mkdir(rootKey: string, path: string): string ("true"/"false")
        // NOTE: setGlobalFunction returns String, so booleans arrive as "true"/"false" in JS.
        // JS callers must use === 'true' comparison, NOT truthiness checks (see bindings.d.ts).
        ctx.setGlobalFunction("__jstorrent_file_mkdir") { args ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""

            val rootUri = resolveRoot(rootKey) ?: return@setGlobalFunction "false"

            try {
                fileManager.mkdir(rootUri, path).toString()
            } catch (e: Exception) {
                Log.e(TAG, "Mkdir failed: $path", e)
                "false"
            }
        }

        // __jstorrent_file_exists(rootKey: string, path: string): string ("true"/"false")
        ctx.setGlobalFunction("__jstorrent_file_exists") { args ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""

            val rootUri = resolveRoot(rootKey) ?: return@setGlobalFunction "false"

            try {
                fileManager.exists(rootUri, path).toString()
            } catch (e: Exception) {
                Log.e(TAG, "Exists failed: $path", e)
                "false"
            }
        }

        // __jstorrent_file_readdir(rootKey: string, path: string): string (JSON array)
        ctx.setGlobalFunction("__jstorrent_file_readdir") { args ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""

            val rootUri = resolveRoot(rootKey) ?: return@setGlobalFunction "[]"

            try {
                val entries = fileManager.readdir(rootUri, path)
                JSONArray(entries).toString()
            } catch (e: Exception) {
                Log.e(TAG, "Readdir failed: $path", e)
                "[]"
            }
        }

        // __jstorrent_file_delete(rootKey: string, path: string): string ("true"/"false")
        ctx.setGlobalFunction("__jstorrent_file_delete") { args ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""

            val rootUri = resolveRoot(rootKey) ?: return@setGlobalFunction "false"

            try {
                fileManager.delete(rootUri, path).toString()
            } catch (e: Exception) {
                Log.e(TAG, "Delete failed: $path", e)
                "false"
            }
        }

        // __jstorrent_file_batch_delete(rootKey: string, requestJson: string): string (JSON array of failed entries)
        ctx.setGlobalFunction("__jstorrent_file_batch_delete") { args ->
            val rootKey = args.getOrNull(0) ?: ""
            val requestJson = args.getOrNull(1) ?: ""

            val rootUri = resolveRoot(rootKey) ?: return@setGlobalFunction "[]"

            try {
                val json = JSONObject(requestJson)
                val directory = json.getString("directory")
                val entriesArr = json.getJSONArray("entries")
                val entries = (0 until entriesArr.length()).map { i -> entriesArr.getString(i) }
                val failed = fileManager.batchDelete(rootUri, directory, entries)
                JSONArray(failed).toString()
            } catch (e: Exception) {
                Log.e(TAG, "BatchDelete failed", e)
                "[]"
            }
        }

        // __jstorrent_file_list_tree(rootKey: string, path: string): string (JSON array)
        ctx.setGlobalFunction("__jstorrent_file_list_tree") { args ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""

            val rootUri = resolveRoot(rootKey) ?: return@setGlobalFunction "[]"

            try {
                val entries = fileManager.listTree(rootUri, path)
                val arr = JSONArray()
                for (entry in entries) {
                    arr.put(JSONObject().apply {
                        put("path", entry.path)
                        put("size", entry.size)
                    })
                }
                arr.toString()
            } catch (e: Exception) {
                Log.e(TAG, "ListTree failed: $path", e)
                "[]"
            }
        }

        // __jstorrent_file_free_space(rootKey: string): number | string | null
        ctx.setGlobalFunction("__jstorrent_file_free_space") { args ->
            val rootKey = args.getOrNull(0) ?: ""
            val rootUri = resolveRoot(rootKey) ?: return@setGlobalFunction null

            try {
                fileManager.getFreeDiskSpace(rootUri).toString()
            } catch (e: Exception) {
                Log.e(TAG, "getFreeDiskSpace failed", e)
                null
            }
        }

        // __jstorrent_file_write_atomic(rootKey: string, path: string, data: ArrayBuffer): string ("true"/"false")
        // binaryArgIndex=2 means arg[2] (data) is delivered as binary ByteArray
        ctx.setGlobalFunctionWithBinary("__jstorrent_file_write_atomic", binaryArgIndex = 2) { args, binary ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""
            val data = binary ?: ByteArray(0)

            val rootUri = resolveRoot(rootKey) ?: return@setGlobalFunctionWithBinary "false"

            try {
                fileManager.writeAtomic(rootUri, path, data)
                "true"
            } catch (e: Exception) {
                Log.e(TAG, "writeAtomic failed: $path", e)
                "false"
            }
        }

        // __jstorrent_file_verify_chunks(rootKey: string, requestJson: string): ArrayBuffer
        ctx.setGlobalFunctionReturnsBinary("__jstorrent_file_verify_chunks") { args, _ ->
            val rootKey = args.getOrNull(0) ?: ""
            val requestJson = args.getOrNull(1) ?: ""

            val rootUri = resolveRoot(rootKey)
            if (rootUri == null) {
                Log.w(TAG, "verify_chunks: unknown root key: $rootKey")
                throw IllegalStateException("verify_chunks: unknown root key: $rootKey")
            }

            try {
                val json = JSONObject(requestJson)
                val filesArr = json.getJSONArray("files")
                val files = (0 until filesArr.length()).map { i ->
                    val f = filesArr.getJSONObject(i)
                    VerifyChunksFile(f.getString("path"), f.getLong("length"))
                }
                val chunkSize = json.getLong("chunkSize")
                val hashesBase64 = json.getString("hashes")
                val hashes = android.util.Base64.decode(hashesBase64, android.util.Base64.DEFAULT)
                val startChunk = json.optLong("startChunk", 0)
                val chunkCount = json.optLong("chunkCount", 0)

                fileManager.verifyChunks(rootUri, files, chunkSize, hashes, startChunk, chunkCount)
            } catch (e: Exception) {
                Log.e(TAG, "verify_chunks failed", e)
                throw e
            }
        }
    }

    /**
     * Register async verified write function.
     *
     * This moves hashing and I/O to a background thread, freeing the JS thread
     * to continue processing data callbacks. Results are posted back via callback.
     */
    private fun registerAsyncWrite(ctx: QuickJsContext) {
        // Register the JS dispatch function for write results
        ctx.evaluate("""
            globalThis.__jstorrent_file_write_callbacks = {};
            globalThis.__jstorrent_file_dispatch_write_result = function(callbackId, bytesWritten, resultCode) {
                const callback = globalThis.__jstorrent_file_write_callbacks[callbackId];
                if (callback) {
                    delete globalThis.__jstorrent_file_write_callbacks[callbackId];
                    callback(bytesWritten, resultCode);
                }
            };
        """.trimIndent(), "file-bindings-init.js")

        // __jstorrent_file_flush(): void
        // Android host-driven mode dispatches pending callbacks from Kotlin before
        // entering __jstorrent_engine_tick(). Keep this as a no-op so the shared JS
        // engine can still call flushCallbacks() without triggering nested FFI re-entry.
        ctx.setGlobalFunction("__jstorrent_file_flush") { _ ->
            null
        }

        // __jstorrent_file_write_verified(rootKey, path, offset, data, expectedSha1Hex, callbackId): void
        // Async verified write - hashes data, compares to expected, writes if match.
        // Posts result back to JS via __jstorrent_file_dispatch_write_result.
        ctx.setGlobalFunctionWithBinary("__jstorrent_file_write_verified", 3) { args, binary ->
            val rootKey = args.getOrNull(0) ?: ""
            val path = args.getOrNull(1) ?: ""
            val offset = args.getOrNull(2)?.toLongOrNull() ?: 0L
            // arg[3] is binary (data)
            val expectedSha1Hex = args.getOrNull(4) ?: ""
            val callbackId = args.getOrNull(5) ?: ""

            if (jsThread == null) {
                Log.e(TAG, "write_verified: jsThread not available")
                return@setGlobalFunctionWithBinary null
            }

            if (path.isEmpty() || binary == null || expectedSha1Hex.isEmpty() || callbackId.isEmpty()) {
                Log.w(TAG, "write_verified: invalid args")
                // Phase 4: Queue error for batch processing at tick boundary
                queueDiskWriteResult(callbackId, -1, WriteResultCode.INVALID_ARGS)
                return@setGlobalFunctionWithBinary null
            }

            val rootUri = resolveRoot(rootKey)
            if (rootUri == null) {
                Log.w(TAG, "write_verified: unknown root key: $rootKey")
                // Phase 4: Queue error for batch processing at tick boundary
                queueDiskWriteResult(callbackId, -1, WriteResultCode.INVALID_ARGS)
                return@setGlobalFunctionWithBinary null
            }

            // Launch async work on I/O dispatcher
            ioScope.launch {
                val startTime = System.currentTimeMillis()

                try {
                    // 1. Hash the data
                    val actualHash = Hasher.sha1(binary)
                    val actualHashHex = actualHash.joinToString("") { "%02x".format(it) }

                    // 2. Compare hashes
                    if (!actualHashHex.equals(expectedSha1Hex, ignoreCase = true)) {
                        Log.w(TAG, "write_verified: hash mismatch for $path")
                        // Phase 4: Queue error for batch processing at tick boundary
                        queueDiskWriteResult(callbackId, -1, WriteResultCode.HASH_MISMATCH)
                        return@launch
                    }

                    // 3. Write the data (hash matched)
                    fileManager.write(rootUri, path, offset, binary)
                    val elapsed = System.currentTimeMillis() - startTime

                    // Track stats
                    synchronized(Companion) {
                        bytesWritten += binary.size
                        writeCount++
                        totalWriteTimeMs += elapsed
                        if (elapsed > maxWriteLatencyMs) {
                            maxWriteLatencyMs = elapsed
                        }

                        // Log every 5 seconds
                        val now = System.currentTimeMillis()
                        val sinceLastLog = now - lastLogTime
                        if (sinceLastLog >= 5000) {
                            val mbWritten = bytesWritten / (1024.0 * 1024.0)
                            val mbps = mbWritten / (sinceLastLog / 1000.0)
                            val avgLatency = if (writeCount > 0) totalWriteTimeMs / writeCount else 0
                            Log.i(TAG, "Verified write: %.2f MB/s, %d writes, avg %dms, max %dms".format(
                                mbps, writeCount, avgLatency, maxWriteLatencyMs))
                            bytesWritten = 0
                            writeCount = 0
                            totalWriteTimeMs = 0
                            maxWriteLatencyMs = 0
                            lastLogTime = now
                        }
                    }

                    // 4. Phase 4: Queue success for batch processing at tick boundary
                    queueDiskWriteResult(callbackId, binary.size, WriteResultCode.SUCCESS)

                } catch (e: Exception) {
                    Log.e(TAG, "write_verified failed: $path", e)
                    // Phase 4: Queue error for batch processing at tick boundary
                    // Map specific exception types to appropriate result codes
                    val resultCode = when (e) {
                        is FileManagerException.DiskFull -> WriteResultCode.DISK_FULL
                        is FileManagerException.PermissionDenied -> WriteResultCode.PERMISSION_DENIED
                        else -> WriteResultCode.IO_ERROR
                    }
                    queueDiskWriteResult(callbackId, -1, resultCode)
                }
            }

            null // Return immediately, result comes via callback
        }

        // __jstorrent_file_write_verified_batch(packed: ArrayBuffer): void
        // Batch verified write - unpacks multiple write requests, runs in parallel.
        // Results queue to pendingDiskResults for batch delivery via __jstorrent_file_flush.
        ctx.setGlobalFunctionWithBinary("__jstorrent_file_write_verified_batch", 0) { _, binary ->
            if (jsThread == null) {
                Log.e(TAG, "write_verified_batch: jsThread not available")
                return@setGlobalFunctionWithBinary null
            }

            if (binary == null || binary.isEmpty()) {
                Log.w(TAG, "write_verified_batch: empty batch")
                return@setGlobalFunctionWithBinary null
            }

            val writes = try {
                unpackVerifiedWriteBatch(binary)
            } catch (t: Throwable) {
                Log.e(TAG, "write_verified_batch: failed to unpack", t)
                return@setGlobalFunctionWithBinary null
            }

            if (writes.isEmpty()) {
                return@setGlobalFunctionWithBinary null
            }

            Log.d(TAG, "write_verified_batch: processing ${writes.size} writes")

            // Launch all writes in parallel on I/O dispatcher
            for (write in writes) {
                val rootUri = resolveRoot(write.rootKey)
                if (rootUri == null) {
                    Log.w(TAG, "write_verified_batch: unknown root key: ${write.rootKey}")
                    queueDiskWriteResult(write.callbackId, -1, WriteResultCode.INVALID_ARGS)
                    continue
                }

                ioScope.launch {
                    val startTime = System.currentTimeMillis()

                    try {
                        // 1. Hash the data (timed separately)
                        val hashStart = System.currentTimeMillis()
                        val actualHash = Hasher.sha1(write.packed, write.dataOffset, write.dataLength)
                        val actualHashHex = actualHash.joinToString("") { "%02x".format(it) }
                        val hashTime = System.currentTimeMillis() - hashStart

                        // 2. Compare hashes
                        if (!actualHashHex.equals(write.expectedHashHex, ignoreCase = true)) {
                            Log.w(TAG, "write_verified_batch: hash mismatch for ${write.path}")
                            queueDiskWriteResult(write.callbackId, -1, WriteResultCode.HASH_MISMATCH)
                            return@launch
                        }

                        // 3. Write the data (hash matched, timed separately)
                        val diskStart = System.currentTimeMillis()
                        fileManager.write(
                            rootUri,
                            write.path,
                            write.position,
                            write.packed,
                            write.dataOffset,
                            write.dataLength,
                        )
                        val diskTime = System.currentTimeMillis() - diskStart
                        val elapsed = System.currentTimeMillis() - startTime

                        // Track stats
                        synchronized(Companion) {
                            bytesWritten += write.dataLength
                            writeCount++
                            totalWriteTimeMs += elapsed
                            totalHashTimeMs += hashTime
                            totalDiskTimeMs += diskTime
                            if (elapsed > maxWriteLatencyMs) {
                                maxWriteLatencyMs = elapsed
                            }
                            if (hashTime > maxHashTimeMs) {
                                maxHashTimeMs = hashTime
                            }
                            if (diskTime > maxDiskTimeMs) {
                                maxDiskTimeMs = diskTime
                            }

                            // Log every 5 seconds
                            val now = System.currentTimeMillis()
                            val sinceLastLog = now - lastLogTime
                            if (sinceLastLog >= 5000) {
                                val mbWritten = bytesWritten / (1024.0 * 1024.0)
                                val mbps = mbWritten / (sinceLastLog / 1000.0)
                                val avgLatency = if (writeCount > 0) totalWriteTimeMs / writeCount else 0
                                val avgHash = if (writeCount > 0) totalHashTimeMs / writeCount else 0
                                val avgDisk = if (writeCount > 0) totalDiskTimeMs / writeCount else 0
                                Log.i(TAG, "Batch write: %.2f MB/s, %d writes, avg %dms (hash=%dms/%dms, disk=%dms/%dms)".format(
                                    mbps, writeCount, avgLatency, avgHash, maxHashTimeMs, avgDisk, maxDiskTimeMs))
                                bytesWritten = 0
                                writeCount = 0
                                totalWriteTimeMs = 0
                                totalHashTimeMs = 0
                                totalDiskTimeMs = 0
                                maxWriteLatencyMs = 0
                                maxHashTimeMs = 0
                                maxDiskTimeMs = 0
                                lastLogTime = now
                            }
                        }

                        // 4. Queue success for batch processing at tick boundary
                        queueDiskWriteResult(write.callbackId, write.dataLength, WriteResultCode.SUCCESS)

                    } catch (e: Exception) {
                        Log.e(TAG, "write_verified_batch failed: ${write.path}", e)
                        // Map specific exception types to appropriate result codes
                        val resultCode = when (e) {
                            is FileManagerException.DiskFull -> WriteResultCode.DISK_FULL
                            is FileManagerException.PermissionDenied -> WriteResultCode.PERMISSION_DENIED
                            else -> WriteResultCode.IO_ERROR
                        }
                        queueDiskWriteResult(write.callbackId, -1, resultCode)
                    }
                }
            }

            null
        }

        // __jstorrent_file_write_batch(packed: ArrayBuffer): void
        // Batch async write (no hash verification) - used for boundary-piece writes
        // and other unverified writes that previously blocked the JS thread.
        // Results queue to pendingDiskResults for batch delivery via __jstorrent_file_flush.
        ctx.setGlobalFunctionWithBinary("__jstorrent_file_write_batch", 0) { _, binary ->
            if (jsThread == null) {
                Log.e(TAG, "write_batch: jsThread not available")
                return@setGlobalFunctionWithBinary null
            }

            if (binary == null || binary.isEmpty()) {
                Log.w(TAG, "write_batch: empty batch")
                return@setGlobalFunctionWithBinary null
            }

            val writes = try {
                unpackWriteBatch(binary)
            } catch (t: Throwable) {
                Log.e(TAG, "write_batch: failed to unpack", t)
                return@setGlobalFunctionWithBinary null
            }

            if (writes.isEmpty()) {
                return@setGlobalFunctionWithBinary null
            }

            Log.d(TAG, "write_batch: processing ${writes.size} writes")

            // Launch all writes in parallel on I/O dispatcher
            for (write in writes) {
                val rootUri = resolveRoot(write.rootKey)
                if (rootUri == null) {
                    Log.w(TAG, "write_batch: unknown root key: ${write.rootKey}")
                    queueDiskWriteResult(write.callbackId, -1, WriteResultCode.INVALID_ARGS)
                    continue
                }

                ioScope.launch {
                    try {
                        fileManager.write(
                            rootUri,
                            write.path,
                            write.position,
                            write.packed,
                            write.dataOffset,
                            write.dataLength,
                        )

                        queueDiskWriteResult(write.callbackId, write.dataLength, WriteResultCode.SUCCESS)

                    } catch (e: Exception) {
                        Log.e(TAG, "write_batch failed: ${write.path}", e)
                        val resultCode = when (e) {
                            is FileManagerException.DiskFull -> WriteResultCode.DISK_FULL
                            is FileManagerException.PermissionDenied -> WriteResultCode.PERMISSION_DENIED
                            else -> WriteResultCode.IO_ERROR
                        }
                        queueDiskWriteResult(write.callbackId, -1, resultCode)
                    }
                }
            }

            null
        }
    }

    /**
     * Register async read batch function.
     *
     * Dispatches disk reads to background I/O threads, results queued in
     * pendingDiskReadResults and flushed to JS at start of next tick
     * via __jstorrent_file_flush().
     */
    private fun registerAsyncRead(ctx: QuickJsContext) {
        // Register the JS callback storage for read results
        ctx.evaluate("""
            globalThis.__jstorrent_file_read_callbacks = {};
        """.trimIndent(), "file-read-bindings-init.js")

        // __jstorrent_file_read_batch(packed: ArrayBuffer): void
        // Batch async read - unpacks multiple read requests, runs in parallel on I/O threads.
        // Results queue to pendingDiskReadResults for batch delivery via __jstorrent_file_flush.
        ctx.setGlobalFunctionWithBinary("__jstorrent_file_read_batch", 0) { _, binary ->
            if (binary == null || binary.isEmpty()) {
                Log.w(TAG, "read_batch: empty batch")
                return@setGlobalFunctionWithBinary null
            }

            val reads = try {
                unpackReadBatch(binary)
            } catch (e: Exception) {
                Log.e(TAG, "read_batch: failed to unpack", e)
                return@setGlobalFunctionWithBinary null
            }

            if (reads.isEmpty()) {
                return@setGlobalFunctionWithBinary null
            }

            // Launch all reads in parallel on I/O dispatcher
            for (read in reads) {
                val rootUri = resolveRoot(read.rootKey)
                if (rootUri == null) {
                    Log.w(TAG, "read_batch: unknown root key: ${read.rootKey}")
                    queueDiskReadResult(read.callbackId, ByteArray(0), ReadResultCode.INVALID_ARGS)
                    continue
                }

                if (read.path.isEmpty() || read.length <= 0) {
                    queueDiskReadResult(read.callbackId, ByteArray(0), ReadResultCode.INVALID_ARGS)
                    continue
                }

                ioScope.launch {
                    try {
                        val data = fileManager.read(rootUri, read.path, read.position, read.length)
                        queueDiskReadResult(read.callbackId, data, ReadResultCode.SUCCESS)
                    } catch (e: Exception) {
                        Log.e(TAG, "read_batch failed: ${read.path}", e)
                        queueDiskReadResult(read.callbackId, ByteArray(0), ReadResultCode.IO_ERROR)
                    }
                }
            }

            null
        }
    }
}
