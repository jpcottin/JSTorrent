package com.jstorrent.companion.server.websocket

import android.util.Log
import com.jstorrent.companion.server.BatchWriteResults
import com.jstorrent.companion.server.CompanionServerDeps
import com.jstorrent.companion.server.ControlWebSocketHandler
import com.jstorrent.companion.server.IoWebSocketHandler
import com.jstorrent.companion.server.WriteResult
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.protocol.Protocol
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.java_websocket.WebSocket
import org.java_websocket.handshake.ClientHandshake
import org.java_websocket.server.WebSocketServer
import java.net.InetSocketAddress
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

private const val TAG = "JavaWebSocketServer"

/**
 * High-performance WebSocket server for /io and /control endpoints using java-websocket library.
 *
 * This server achieves ~8x better throughput than Ktor WebSocket by using
 * the java-websocket library's more efficient frame handling.
 *
 * Architecture:
 * - Runs on a separate port from HTTP (default: 7801)
 * - Each connection gets a JavaWebSocketSession + handler (Io or Control)
 * - All protocol handling is delegated to handlers (same as Ktor path)
 *
 * Endpoints:
 * - /io - High-throughput data plane (socket operations)
 * - /control - Control plane (roots, events)
 * - /ws-sink, /ws-source - Throughput testing
 */
class JavaWebSocketServer(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val httpStreams: com.jstorrent.companion.server.HttpStreamSessionRegistry,
    port: Int = 0
) {
    private var server: InnerServer? = null
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Control session management callbacks
    private var onControlSessionRegistered: ((ControlWebSocketHandler) -> Unit)? = null
    private var onControlSessionUnregistered: ((ControlWebSocketHandler) -> Unit)? = null
    private var onPowerHintReceived: ((ControlWebSocketHandler, Int) -> Unit)? = null

    val port: Int get() = server?.port ?: 0
    val isRunning: Boolean get() = server != null

    /**
     * Set callbacks for control session lifecycle events.
     * Must be called before start().
     */
    fun setControlSessionCallbacks(
        onRegistered: (ControlWebSocketHandler) -> Unit,
        onUnregistered: (ControlWebSocketHandler) -> Unit,
        onPowerHint: ((ControlWebSocketHandler, Int) -> Unit)? = null
    ) {
        onControlSessionRegistered = onRegistered
        onControlSessionUnregistered = onUnregistered
        onPowerHintReceived = onPowerHint
    }

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
                val s = InnerServer(
                    port,
                    deps,
                    fileManager,
                    httpStreams,
                    scope,
                    onControlSessionRegistered,
                    onControlSessionUnregistered,
                    onPowerHintReceived
                )
                s.isReuseAddr = true
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
    private val httpStreams: com.jstorrent.companion.server.HttpStreamSessionRegistry,
    private val scope: CoroutineScope,
    private val onControlSessionRegistered: ((ControlWebSocketHandler) -> Unit)?,
    private val onControlSessionUnregistered: ((ControlWebSocketHandler) -> Unit)?,
    private val onPowerHintReceived: ((ControlWebSocketHandler, Int) -> Unit)?
) : WebSocketServer(InetSocketAddress(port)) {

    val startLatch = CountDownLatch(1)

    // Track sessions by connection
    private val ioSessions = ConcurrentHashMap<WebSocket, IoSessionState>()
    private val controlSessions = ConcurrentHashMap<WebSocket, ControlSessionState>()
    private val sinkSessions = ConcurrentHashMap<WebSocket, SinkSession>()
    private val sourceSessions = ConcurrentHashMap<WebSocket, SourceSession>()

    override fun onStart() {
        Log.i(TAG, "WebSocket server started on port $port")

        // Register to receive batch write results for broadcasting
        BatchWriteResults.setNotifyCallback {
            drainAndBroadcastResults()
        }

        startLatch.countDown()
    }

    /**
     * Drain pending batch write results and broadcast ACK/ERROR frames to all IO sessions.
     *
     * This is called when batch writes complete. Each result is packed into a frame
     * with requestId=0 (to indicate batch result) and callbackId in payload.
     */
    private fun drainAndBroadcastResults() {
        val results = BatchWriteResults.drain()
        if (results.isEmpty()) return

        Log.d(TAG, "Broadcasting ${results.size} batch write results to ${ioSessions.size} IO sessions")

        for (result in results) {
            val frame = packBatchResultFrame(result)
            // Broadcast to all IO sessions
            for ((conn, _) in ioSessions) {
                try {
                    if (conn.isOpen) {
                        conn.send(frame)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "Failed to send batch result to session: ${e.message}")
                }
            }
        }
    }

    /**
     * Pack a batch write result into a WebSocket frame.
     *
     * Uses existing OP_FILE_WRITE_ACK (0x31) or OP_FILE_WRITE_ERROR (0x32) opcodes
     * with requestId=0 to indicate batch result. Payload contains callbackId for
     * JS client to match against pending promises.
     *
     * Format: [envelope:8][callbackIdLen:1][callbackId:bytes][bytesWritten:4 LE][resultCode:1]
     */
    private fun packBatchResultFrame(result: WriteResult): ByteArray {
        val opcode = if (result.resultCode == 0) Protocol.OP_FILE_WRITE_ACK else Protocol.OP_FILE_WRITE_ERROR
        val callbackIdBytes = result.callbackId.toByteArray(Charsets.UTF_8)

        // Envelope (8 bytes) + payload
        val payloadSize = 1 + callbackIdBytes.size + 4 + 1
        val frameSize = 8 + payloadSize
        val buffer = ByteBuffer.allocate(frameSize).order(ByteOrder.LITTLE_ENDIAN)

        // Envelope
        buffer.put(Protocol.VERSION)
        buffer.put(opcode)
        buffer.putShort(0)  // flags
        buffer.putInt(0)    // requestId = 0 indicates batch result

        // Payload: [callbackIdLen:1][callbackId:bytes][bytesWritten:4 LE][resultCode:1]
        buffer.put(callbackIdBytes.size.toByte())
        buffer.put(callbackIdBytes)
        buffer.putInt(result.bytesWritten)
        buffer.put(result.resultCode.toByte())

        return buffer.array()
    }

    override fun onOpen(conn: WebSocket, handshake: ClientHandshake) {
        val path = handshake.resourceDescriptor

        when {
            path == "/ws-sink" || path == "/ws-sink/" -> {
                // Throughput test sink - receives data as fast as possible
                Log.i(TAG, "WebSocket /ws-sink connected from ${conn.remoteSocketAddress}")
                val sink = SinkSession()
                sinkSessions[conn] = sink
            }
            path == "/ws-source" || path == "/ws-source/" -> {
                // Throughput test source - sends data as fast as possible
                // Client sends "frames,frameSize" to start (e.g. "1000,65536")
                Log.i(TAG, "WebSocket /ws-source connected from ${conn.remoteSocketAddress}")
                sourceSessions[conn] = SourceSession()
            }
            path == "/io" || path == "/io/" -> {
                Log.i(TAG, "WebSocket /io connected from ${conn.remoteSocketAddress}")

                // Create session wrapper and handler
                val wsSession = JavaWebSocketSession(conn)
                val handler = IoWebSocketHandler(wsSession, deps, fileManager)

                ioSessions[conn] = IoSessionState(wsSession, handler)

                // Launch handler in coroutine - it runs until connection closes
                scope.launch {
                    try {
                        handler.run()
                    } catch (e: Exception) {
                        Log.e(TAG, "IO handler error: ${e.message}")
                    } finally {
                        ioSessions.remove(conn)
                        Log.i(TAG, "WebSocket /io disconnected")
                    }
                }
            }
            path == "/control" || path == "/control/" -> {
                Log.i(TAG, "WebSocket /control connected from ${conn.remoteSocketAddress}")

                // Create session wrapper and handler
                val wsSession = JavaWebSocketSession(conn)
                val handler = ControlWebSocketHandler(
                    wsSession,
                    deps,
                    httpStreams,
                    onSessionRegistered = { onControlSessionRegistered?.invoke(it) },
                    onSessionUnregistered = { onControlSessionUnregistered?.invoke(it) },
                    onPowerHintReceived = { session, count -> onPowerHintReceived?.invoke(session, count) }
                )

                controlSessions[conn] = ControlSessionState(wsSession, handler)

                // Launch handler in coroutine - it runs until connection closes
                scope.launch {
                    try {
                        handler.run()
                    } catch (e: Exception) {
                        Log.e(TAG, "Control handler error: ${e.message}")
                    } finally {
                        controlSessions.remove(conn)
                        Log.i(TAG, "WebSocket /control disconnected")
                    }
                }
            }
            else -> {
                Log.w(TAG, "Rejecting connection to invalid path: $path")
                conn.close(1002, "Invalid path - only /io, /control, /ws-sink, /ws-source supported")
            }
        }
    }

    override fun onClose(conn: WebSocket, code: Int, reason: String?, remote: Boolean) {
        Log.d(TAG, "WebSocket closed: code=$code, reason=$reason, remote=$remote")
        ioSessions.remove(conn)?.wsSession?.onClose()
        controlSessions.remove(conn)?.wsSession?.onClose()
        sinkSessions.remove(conn)?.let { sink ->
            val elapsed = System.currentTimeMillis() - sink.startTime
            val mbps = if (elapsed > 0) sink.totalBytes / (elapsed / 1000.0) / (1024 * 1024) else 0.0
            Log.i(TAG, "WS sink closed: ${sink.totalBytes / (1024*1024)} MB in ${elapsed}ms = ${"%.1f".format(mbps)} MB/s")
        }
        sourceSessions.remove(conn)
    }

    override fun onMessage(conn: WebSocket, message: ByteBuffer) {
        // Check if this is a sink session first (fast path)
        sinkSessions[conn]?.let { sink ->
            val size = message.remaining()
            sink.totalBytes += size
            sink.frameCount++

            // Log every second
            val now = System.currentTimeMillis()
            if (now - sink.lastLogTime >= 1000) {
                val intervalBytes = sink.totalBytes - sink.lastLogBytes
                val intervalSec = (now - sink.lastLogTime) / 1000.0
                val mbps = intervalBytes / intervalSec / (1024 * 1024)
                Log.i(TAG, "WS sink: ${"%.1f".format(mbps)} MB/s (${sink.frameCount} frames, ${sink.totalBytes / (1024*1024)} MB total)")
                sink.lastLogTime = now
                sink.lastLogBytes = sink.totalBytes
            }
            return
        }

        val data = ByteArray(message.remaining())
        message.get(data)

        // Check IO session
        ioSessions[conn]?.wsSession?.onMessage(data)

        // Check control session
        controlSessions[conn]?.wsSession?.onMessage(data)
    }

    override fun onMessage(conn: WebSocket, message: String) {
        // Handle "done" for sink sessions
        sinkSessions[conn]?.let { sink ->
            if (message == "done") {
                val elapsed = System.currentTimeMillis() - sink.startTime
                val mbps = if (elapsed > 0) sink.totalBytes / (elapsed / 1000.0) / (1024 * 1024) else 0.0
                Log.i(TAG, "WS sink done: ${sink.totalBytes / (1024*1024)} MB in ${elapsed}ms = ${"%.1f".format(mbps)} MB/s")
                conn.send("done:$elapsed:${sink.totalBytes}:${"%.1f".format(mbps)}")
            }
            return
        }

        // Handle source sessions - "frames,frameSize" starts sending
        sourceSessions[conn]?.let { source ->
            val parts = message.split(",")
            val frameCount = parts.getOrNull(0)?.toIntOrNull() ?: 1000
            val frameSize = parts.getOrNull(1)?.toIntOrNull() ?: 65536

            Log.i(TAG, "WS source: sending $frameCount frames of $frameSize bytes")

            scope.launch {
                val data = ByteArray(frameSize)
                val startTime = System.currentTimeMillis()
                var lastLogTime = startTime
                var lastLogBytes = 0L

                for (i in 0 until frameCount) {
                    if (!conn.isOpen) break
                    conn.send(data)

                    val bytesSent = (i + 1).toLong() * frameSize
                    val now = System.currentTimeMillis()
                    if (now - lastLogTime >= 1000) {
                        val intervalBytes = bytesSent - lastLogBytes
                        val intervalSec = (now - lastLogTime) / 1000.0
                        val mbps = intervalBytes / intervalSec / (1024 * 1024)
                        Log.i(TAG, "WS source: ${"%.1f".format(mbps)} MB/s (${i+1} frames, ${bytesSent / (1024*1024)} MB)")
                        lastLogTime = now
                        lastLogBytes = bytesSent
                    }
                }

                val elapsed = System.currentTimeMillis() - startTime
                val totalBytes = frameCount.toLong() * frameSize
                val mbps = if (elapsed > 0) totalBytes / (elapsed / 1000.0) / (1024 * 1024) else 0.0
                Log.i(TAG, "WS source done: ${totalBytes / (1024*1024)} MB in ${elapsed}ms = ${"%.1f".format(mbps)} MB/s")

                if (conn.isOpen) {
                    conn.send("done:$elapsed:$totalBytes:${"%.1f".format(mbps)}")
                }
                sourceSessions.remove(conn)
            }
            return
        }

        // Text messages not used in binary protocol
        Log.w(TAG, "Unexpected text message: $message")
    }

    override fun onError(conn: WebSocket?, ex: Exception) {
        if (conn == null) {
            Log.e(TAG, "Server error: ${ex.message}")
        } else {
            Log.e(TAG, "Connection error: ${ex.message}")
            ioSessions.remove(conn)?.wsSession?.onClose()
            controlSessions.remove(conn)?.wsSession?.onClose()
        }
    }

    private data class IoSessionState(
        val wsSession: JavaWebSocketSession,
        val handler: IoWebSocketHandler
    )

    private data class ControlSessionState(
        val wsSession: JavaWebSocketSession,
        val handler: ControlWebSocketHandler
    )

    /** Sink session for throughput testing - just counts bytes */
    private class SinkSession {
        val startTime = System.currentTimeMillis()
        var totalBytes = 0L
        var frameCount = 0
        var lastLogTime = startTime
        var lastLogBytes = 0L
    }

    /** Source session for throughput testing - marker class */
    private class SourceSession
}
