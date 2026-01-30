package com.jstorrent.companion.server.websocket

import android.util.Log
import kotlinx.coroutines.channels.Channel
import org.java_websocket.WebSocket
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

private const val TAG = "JavaWebSocketSession"

/**
 * Java-WebSocket library wrapper implementing WebSocketSession.
 *
 * Bridges the callback-based java-websocket API to our suspend-based
 * WebSocketSession interface using Kotlin channels.
 *
 * This is used for the high-throughput /io endpoint, achieving 8x better
 * performance than Ktor WebSocket.
 */
class JavaWebSocketSession(
    private val conn: WebSocket
) : WebSocketSession {

    // Incoming data queue - callback thread writes, suspend function reads
    // Capacity of 2000 matches the outgoing buffer in IoWebSocketHandler
    private val incoming = Channel<ByteArray>(2000)

    // Stats for tracking frame arrival rate
    private var statsStartTime = System.currentTimeMillis()
    private var statsFrameCount = 0
    private var statsBytesReceived = 0L
    private var statsMaxQueueDepth = 0
    private val queueDepth = AtomicInteger(0)

    /**
     * Called by the server when a binary message is received.
     * This is called from the java-websocket callback thread.
     */
    fun onMessage(data: ByteArray) {
        // Non-blocking send - drop if buffer full (matches IoWebSocketHandler behavior)
        val result = incoming.trySend(data)
        if (result.isSuccess) {
            val depth = queueDepth.incrementAndGet()
            if (depth > statsMaxQueueDepth) statsMaxQueueDepth = depth
        }

        // Track stats
        statsFrameCount++
        statsBytesReceived += data.size

        // Log every 5 seconds
        val now = System.currentTimeMillis()
        val elapsed = now - statsStartTime
        if (elapsed >= 5000 && statsFrameCount > 0) {
            val mbps = statsBytesReceived / (elapsed / 1000.0) / (1024 * 1024)
            Log.i(TAG, "RECV RATE: ${"%.1f".format(mbps)} MB/s, $statsFrameCount frames, " +
                "queueDepth max=$statsMaxQueueDepth, dropped=${if (result.isFailure) "YES" else "no"}")
            statsStartTime = now
            statsFrameCount = 0
            statsBytesReceived = 0
            statsMaxQueueDepth = queueDepth.get()
        }
    }

    /**
     * Called by the server when the connection is closed.
     * This is called from the java-websocket callback thread.
     */
    fun onClose() {
        incoming.close()
    }

    override suspend fun receive(): ByteArray? {
        return try {
            val data = incoming.receiveCatching().getOrNull()
            if (data != null) queueDepth.decrementAndGet()
            data
        } catch (e: Exception) {
            null
        }
    }

    override suspend fun send(data: ByteArray) {
        if (conn.isOpen) {
            // java-websocket's send is non-blocking, buffers internally
            conn.send(data)
        }
    }

    override suspend fun close(code: Int, reason: String) {
        if (conn.isOpen) {
            conn.close(code, reason)
        }
    }

    override val isOpen: Boolean
        get() = conn.isOpen
}
