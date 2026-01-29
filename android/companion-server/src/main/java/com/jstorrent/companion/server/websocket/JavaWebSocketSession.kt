package com.jstorrent.companion.server.websocket

import kotlinx.coroutines.channels.Channel
import org.java_websocket.WebSocket
import java.nio.ByteBuffer

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

    /**
     * Called by the server when a binary message is received.
     * This is called from the java-websocket callback thread.
     */
    fun onMessage(data: ByteArray) {
        // Non-blocking send - drop if buffer full (matches IoWebSocketHandler behavior)
        incoming.trySend(data)
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
            incoming.receiveCatching().getOrNull()
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
