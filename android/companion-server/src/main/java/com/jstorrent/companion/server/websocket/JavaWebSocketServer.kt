package com.jstorrent.companion.server.websocket

import android.util.Log
import com.jstorrent.companion.server.CompanionServerDeps
import com.jstorrent.companion.server.IoWebSocketHandler
import com.jstorrent.io.file.FileManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val TAG = "JavaWebSocketServer"

/**
 * High-performance WebSocket server for the /io endpoint using java-websocket library.
 *
 * This server achieves ~8x better throughput than Ktor WebSocket by using
 * the java-websocket library's more efficient frame handling.
 *
 * Architecture:
 * - Runs on a separate port from Ktor (default: 7801)
 * - Each connection gets a JavaWebSocketSession + IoWebSocketHandler
 * - All protocol handling is delegated to IoWebSocketHandler (same as Ktor path)
 *
 * Only handles /io endpoint - /control stays on Ktor for simplicity since
 * it's low-volume and doesn't need the performance optimization.
 */
class JavaWebSocketServer(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    port: Int = 0
) {
    private var server: InnerServer? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    val port: Int get() = server?.port ?: 0
    val isRunning: Boolean get() = server != null

    /**
     * Start the WebSocket server on the given port.
     * @param preferredPort Port to try first (0 = any available port)
     * @param timeoutMs How long to wait for server startup
     * @throws Exception if server fails to start
     */
    fun start(preferredPort: Int = 7801, timeoutMs: Long = 5000) {
        if (server != null) {
            Log.w(TAG, "Server already running on port ${server?.port}")
            return
        }

        // Try preferred port, then fallback ports using same formula as Ktor
        val portsToTry = generatePortSequence(preferredPort).take(10).toList()

        for (port in portsToTry) {
            try {
                val s = InnerServer(port, deps, fileManager, scope)
                s.connectionLostTimeout = 60
                s.isTcpNoDelay = true
                s.start()

                if (!s.startLatch.await(timeoutMs, TimeUnit.MILLISECONDS)) {
                    s.stop()
                    continue
                }

                server = s
                Log.i(TAG, "Server started on port ${s.port}")
                return
            } catch (e: Exception) {
                Log.w(TAG, "Port $port unavailable: ${e.message}")
            }
        }

        throw IllegalStateException("Could not bind to any port")
    }

    fun stop() {
        server?.let { s ->
            try {
                s.stop(1000)
            } catch (e: Exception) {
                Log.w(TAG, "Error stopping server: ${e.message}")
            }
        }
        server = null
        scope.cancel()
        Log.i(TAG, "Server stopped")
    }

    companion object {
        /**
         * Port selection: base, base+5, base+14, base+27, ...
         * Formula: base + 4*n + n² (same as Ktor server)
         */
        fun generatePortSequence(base: Int): Sequence<Int> = sequence {
            var n = 0
            while (true) {
                yield(base + 4 * n + n * n)
                n++
            }
        }
    }
}

/**
 * Inner WebSocketServer implementation.
 */
private class InnerServer(
    port: Int,
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val scope: CoroutineScope
) : WebSocketServer(InetSocketAddress(port)) {

    val startLatch = CountDownLatch(1)

    // Track sessions by connection
    private val sessions = ConcurrentHashMap<WebSocket, SessionState>()

    override fun onStart() {
        Log.i(TAG, "WebSocket server started on port $port")
        startLatch.countDown()
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        // Check path - only accept /io
        val path = handshake.resourceDescriptor
        if (path != "/io" && path != "/io/") {
            Log.w(TAG, "Rejecting connection to invalid path: $path")
            conn.close(1002, "Invalid path - only /io is supported")
            return
        }

        Log.i(TAG, "WebSocket /io connected from ${conn.remoteSocketAddress}")

        // Create session wrapper and handler
        val wsSession = JavaWebSocketSession(conn)
        val handler = IoWebSocketHandler(wsSession, deps, fileManager)

        sessions[conn] = SessionState(wsSession, handler)

        // Launch handler in coroutine - it runs until connection closes
        scope.launch {
            try {
                handler.run()
            } catch (e: Exception) {
                Log.e(TAG, "Handler error: ${e.message}")
            } finally {
                sessions.remove(conn)
                Log.i(TAG, "WebSocket /io disconnected")
            }
        }
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
        Log.d(TAG, "WebSocket closed: code=$code, reason=$reason, remote=$remote")
        sessions.remove(conn)?.wsSession?.onClose()
    }

    override fun onMessage(conn: WebSocket, message: ByteBuffer) {
        val data = ByteArray(message.remaining())
        message.get(data)
        sessions[conn]?.wsSession?.onMessage(data)
    }

    override fun onMessage(conn: WebSocket, message: String) {
        // Text messages not used in binary protocol
        Log.w(TAG, "Unexpected text message: $message")
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
        if (conn == null) {
            Log.e(TAG, "Server error: ${ex.message}")
        } else {
            Log.e(TAG, "Connection error: ${ex.message}")
            sessions.remove(conn)?.wsSession?.onClose()
        }
    }

    private data class SessionState(
        val wsSession: JavaWebSocketSession,
        val handler: IoWebSocketHandler
    )
}
