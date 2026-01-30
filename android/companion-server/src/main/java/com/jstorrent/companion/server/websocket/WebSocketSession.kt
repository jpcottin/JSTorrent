package com.jstorrent.companion.server.websocket

/**
 * Transport-agnostic WebSocket session interface.
 *
 * This abstraction decouples handler logic from specific WebSocket implementations,
 * allowing easy swapping of WebSocket providers for performance optimization.
 *
 * Current implementation:
 * - JavaWebSocketSession: Uses java_websocket library (high throughput)
 */
interface WebSocketSession {
    /**
     * Receive a binary frame from the WebSocket.
     * Suspends until data is available.
     *
     * @return The binary data, or null if the connection is closed
     */
    suspend fun receive(): ByteArray?

    /**
     * Send binary data over the WebSocket.
     * Suspends until the data is written to the socket.
     *
     * @param data The binary data to send
     */
    suspend fun send(data: ByteArray)

    /**
     * Close the WebSocket connection.
     *
     * @param code WebSocket close code (default: 1000 = normal closure)
     * @param reason Human-readable close reason
     */
    suspend fun close(code: Int = 1000, reason: String = "")

    /**
     * Whether the WebSocket connection is currently open.
     */
    val isOpen: Boolean
}
