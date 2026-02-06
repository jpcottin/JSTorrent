package com.jstorrent.companion.server

import android.util.Log
import com.jstorrent.companion.server.streaming.StreamingWriteServer
import com.jstorrent.companion.server.websocket.JavaWebSocketServer
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.protocol.Protocol
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.util.concurrent.CopyOnWriteArrayList

private const val TAG = "CompanionHttpServer"

private val json = Json {
    encodeDefaults = true
    ignoreUnknownKeys = true
}

/**
 * HTTP/WebSocket server for the companion mode.
 *
 * Architecture (post-Ktor migration):
 * - Port 7800: NettyHttpServer (all HTTP endpoints)
 * - Port 7801: JavaWebSocketServer (/io + /control WebSocket)
 * - Port 7802: StreamingWriteServer (high-throughput batch writes)
 *
 * This achieves 6-10x better HTTP throughput than Ktor while maintaining
 * all existing functionality.
 */
class CompanionHttpServer(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager
) {
    // Pure Netty HTTP server for all HTTP endpoints
    private var httpServer: NettyHttpServer? = null

    // High-throughput java-websocket server for /io and /control
    private var wsServer: JavaWebSocketServer? = null

    // Streaming write server for high-throughput batch writes (no memory aggregation)
    private var streamingServer: StreamingWriteServer? = null

    // Connected WebSocket sessions for control broadcasts
    private val controlSessions = CopyOnWriteArrayList<ControlWebSocketHandler>()

    val port: Int get() = httpServer?.boundPort ?: 0
    val ioPort: Int get() = wsServer?.port ?: -1
    val streamingPort: Int get() = streamingServer?.let { if (it.isRunning()) httpServer?.boundPort?.plus(2) ?: 0 else 0 } ?: 0
    val isRunning: Boolean get() = httpServer?.isRunning == true

    fun start(preferredPort: Int = 7800) {
        if (httpServer != null) {
            Log.w(TAG, "Server already running on port $port")
            return
        }

        // Reset stats when server starts
        DaemonStats.reset()

        // Start Netty HTTP server on preferred port
        try {
            val http = NettyHttpServer(deps, fileManager, preferredPort)
            http.start()
            httpServer = http
            Log.i(TAG, "Netty HTTP server started on port ${http.boundPort}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start Netty HTTP server: ${e.message}")
            throw e
        }

        val http = httpServer ?: return
        val httpPort = http.boundPort

        // Start JavaWebSocketServer for /io and /control on port+1
        try {
            val ws = JavaWebSocketServer(deps, fileManager)
            // Wire up control session callbacks so broadcasts work
            ws.setControlSessionCallbacks(
                onRegistered = { session -> registerControlSession(session) },
                onUnregistered = { session -> unregisterControlSession(session) }
            )
            ws.start(preferredPort = httpPort + 1)
            wsServer = ws
            // Set ioPort on HTTP server so /status response includes it
            http.ioPort = ws.port
            Log.i(TAG, "WebSocket server started on port ${ws.port}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start WebSocket server: ${e.message}")
            // Continue without WebSocket server - HTTP endpoints still work
        }

        // Start StreamingWriteServer for high-throughput batch writes on port+2
        try {
            val streaming = StreamingWriteServer(
                port = httpPort + 2,
                fileManager = fileManager,
                rootResolver = { key -> deps.rootStore.resolveKey(key) },
                tokenValidator = { token -> deps.tokenStore.isTokenValid(token) },
            )
            streaming.start()
            streamingServer = streaming
            // Set streamingPort on HTTP server so /status response includes it
            http.streamingPort = httpPort + 2
            Log.i(TAG, "Streaming write server started on port ${httpPort + 2}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start streaming write server: ${e.message}")
            // Continue without streaming server - falls back to regular batch writes
        }
    }

    fun stop() {
        // Stop streaming write server
        streamingServer?.stop()
        streamingServer = null

        // Stop WebSocket server
        wsServer?.stop()
        wsServer = null

        // Stop HTTP server
        httpServer?.stop()
        httpServer = null

        // Clear control sessions
        controlSessions.clear()

        Log.i(TAG, "Server stopped")
    }

    // =========================================================================
    // Control Plane
    // =========================================================================

    private fun registerControlSession(session: ControlWebSocketHandler) {
        controlSessions.add(session)
        Log.d(TAG, "Control session registered, total: ${controlSessions.size}")
    }

    private fun unregisterControlSession(session: ControlWebSocketHandler) {
        controlSessions.remove(session)
        Log.d(TAG, "Control session unregistered, total: ${controlSessions.size}")
    }

    /**
     * Check if any authenticated control session is connected.
     */
    fun hasActiveControlConnection(): Boolean = controlSessions.isNotEmpty()

    /**
     * Close all connected WebSocket sessions.
     * Called when user unpairs to disconnect the extension.
     */
    suspend fun closeAllSessions() {
        Log.i(TAG, "Closing all ${controlSessions.size} WebSocket sessions")
        val sessionsToClose = controlSessions.toList()
        for (session in sessionsToClose) {
            try {
                session.closeSession(1001, "Unpaired")
            } catch (e: Exception) {
                Log.w(TAG, "Failed to close session: ${e.message}")
            }
        }
        controlSessions.clear()
    }

    /**
     * Broadcast ROOTS_CHANGED to all authenticated sessions.
     */
    fun broadcastRootsChanged(roots: List<DownloadRoot>) {
        val jsonPayload = json.encodeToString(roots).toByteArray()
        val frame = Protocol.createMessage(Protocol.OP_CTRL_ROOTS_CHANGED, 0, jsonPayload)

        controlSessions.forEach { session ->
            session.sendControl(frame)
        }
    }

    /**
     * Broadcast generic event to all authenticated sessions.
     */
    fun broadcastEvent(event: String, payload: JsonElement?) {
        val eventObj = buildJsonObject {
            put("event", event)
            if (payload != null) {
                put("payload", payload)
            }
        }
        val jsonPayload = eventObj.toString().toByteArray()
        val frame = Protocol.createMessage(Protocol.OP_CTRL_EVENT, 0, jsonPayload)

        controlSessions.forEach { session ->
            session.sendControl(frame)
        }
    }

    /**
     * Mark pairing dialog as closed.
     * Called from app after pairing dialog result.
     */
    fun onPairingDialogClosed() {
        httpServer?.onPairingDialogClosed()
    }
}
