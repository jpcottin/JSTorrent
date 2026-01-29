@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.jstorrent.io.socket

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Semaphore
import java.io.IOException
import java.net.Inet6Address
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.nio.channels.SocketChannel
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import javax.net.ssl.SSLSocket
import javax.net.ssl.SSLSocketFactory

/**
 * Represents a pending connection before it's activated.
 * NIO channels are used for plain TCP, TLS sockets for encrypted connections.
 */
private sealed class PendingConnection {
    /** NIO SocketChannel for plain TCP - enables direct ByteBuffer reads. */
    data class NioChannel(val channel: SocketChannel) : PendingConnection()

    /** TLS socket after secure() upgrade - uses classic InputStream. */
    data class TlsSocket(val socket: SSLSocket) : PendingConnection()
}

/**
 * Unified TCP socket service implementing both client and server operations.
 *
 * This class implements [TcpSocketManager] for client connections and
 * [TcpServerManager] for server sockets. Accepted connections share
 * the same connection pool as outgoing connections.
 *
 * @param scope CoroutineScope for all socket operations
 * @param connectSemaphore Semaphore limiting concurrent connection attempts (default 30)
 * @param maxPendingConnects Maximum pending connections before fast-fail (default 60)
 * @param batchingConfig Configuration for read batching behavior (default STANDALONE)
 */
class TcpSocketService(
    private val scope: CoroutineScope,
    private val connectSemaphore: Semaphore = Semaphore(30),
    private val maxPendingConnects: Int = 60,
    private val batchingConfig: BatchingConfig = BatchingConfig.STANDALONE
) : TcpSocketManager, TcpServerManager {

    // Callbacks
    private var socketCallback: TcpSocketCallback? = null
    private var serverCallback: TcpServerCallback? = null

    // Socket state
    private val pendingConnects = ConcurrentHashMap<Int, Job>()
    private val pendingConnections = ConcurrentHashMap<Int, PendingConnection>()
    private val activeConnections = ConcurrentHashMap<Int, TcpConnectionBase>()

    // Server state
    private val servers = ConcurrentHashMap<Int, ServerHandler>()

    // Statistics
    private val pendingConnectCount = AtomicInteger(0)
    private val nextSocketId = AtomicInteger(0x10000) // For accepted sockets

    companion object {
        private const val TAG = "TcpSocketService"

        // Socket configuration
        private const val TCP_NO_DELAY = true
        private const val RECEIVE_BUFFER_SIZE = 2 * 1024 * 1024 // 2MB (kernel may double)
        private const val SO_TIMEOUT = 60_000 // 60 seconds
        private const val CONNECT_TIMEOUT = 5_000 // 5 seconds (allows trying multiple addresses within client timeout)
        private const val SEMAPHORE_TIMEOUT = 5000L // 5 seconds
    }

    // ============================================================
    // TcpSocketManager implementation
    // ============================================================

    override fun connect(socketId: Int, host: String, port: Int) {
        // Fast-fail if too many connects are already pending
        val currentPending = pendingConnectCount.get()
        if (currentPending >= maxPendingConnects) {
            socketCallback?.onTcpConnected(socketId, false, 1)
            return
        }

        pendingConnectCount.incrementAndGet()

        val job = scope.launch {
            var acquiredSemaphore = false
            try {
                // Limit concurrent pending connections to prevent resource exhaustion
                val acquired = withTimeoutOrNull(SEMAPHORE_TIMEOUT) {
                    connectSemaphore.acquire()
                    true
                }
                if (acquired != true) {
                    // Timeout waiting for semaphore
                    socketCallback?.onTcpConnected(socketId, false, 1)
                    return@launch
                }
                acquiredSemaphore = true

                // Check if we were cancelled while waiting for semaphore
                if (!isActive) return@launch

                // Resolve hostname to all addresses, prefer IPv6 for better peer discovery
                val addresses = InetAddress.getAllByName(host)
                    .sortedByDescending { it is Inet6Address }

                var channel: SocketChannel? = null
                var lastException: Exception? = null

                for (addr in addresses) {
                    val ch = SocketChannel.open()
                    ch.configureBlocking(true)  // Blocking mode for coroutine-based I/O
                    try {
                        configureChannel(ch)
                        ch.socket().connect(InetSocketAddress(addr, port), CONNECT_TIMEOUT)
                        channel = ch
                        break
                    } catch (e: Exception) {
                        lastException = e
                        ch.close()
                    }
                }

                if (channel == null) {
                    throw lastException ?: Exception("No addresses found for $host")
                }

                // Check if we were cancelled during connect
                if (!isActive) {
                    channel.close()
                    return@launch
                }

                // Store in pending - don't start read/write tasks yet
                pendingConnections[socketId] = PendingConnection.NioChannel(channel)
                Log.d(TAG, "Socket $socketId connected via NIO to $host:$port")

                // Notify success
                socketCallback?.onTcpConnected(socketId, true, 0)

            } catch (_: CancellationException) {
                // Don't send failure - socket was intentionally closed
                throw CancellationException()
            } catch (_: Exception) {
                // Connection failed
                socketCallback?.onTcpConnected(socketId, false, 1)
            } finally {
                if (acquiredSemaphore) {
                    connectSemaphore.release()
                }
                pendingConnectCount.decrementAndGet()
                pendingConnects.remove(socketId)
            }
        }

        pendingConnects[socketId] = job
    }

    override fun send(socketId: Int, data: ByteArray) {
        // Check if socket is pending (not yet activated) - auto-activate
        val pending = pendingConnections.remove(socketId)
        if (pending != null) {
            val connection = createConnectionFromPending(socketId, pending)
            activeConnections[socketId] = connection
            connection.activate()
            connection.send(data)
            return
        }

        // Send to active connection
        activeConnections[socketId]?.send(data)
    }

    override fun close(socketId: Int) {
        // Cancel any pending connect
        pendingConnects.remove(socketId)?.cancel()

        // Close pending connection (connected but not activated)
        pendingConnections.remove(socketId)?.let { pending ->
            closePendingConnection(pending)
        }

        // Close active connection
        activeConnections.remove(socketId)?.close()
    }

    override fun secure(socketId: Int, hostname: String, skipValidation: Boolean) {
        // Must be a pending connection (not yet active)
        val pending = pendingConnections.remove(socketId)
        if (pending == null) {
            socketCallback?.onTcpSecured(socketId, false)
            return
        }

        // Get the underlying socket from the pending connection
        val socket = when (pending) {
            is PendingConnection.NioChannel -> pending.channel.socket()
            is PendingConnection.TlsSocket -> {
                // Already TLS - shouldn't happen but handle gracefully
                socketCallback?.onTcpSecured(socketId, false)
                return
            }
        }

        scope.launch {
            try {
                // Create SSLSocketFactory
                val sslSocketFactory = if (skipValidation) {
                    InsecureTrustManager.createInsecureSocketFactory()
                } else {
                    SSLSocketFactory.getDefault() as SSLSocketFactory
                }

                // Create SSLSocket wrapping the existing socket
                // Note: This transitions from NIO to classic Socket I/O for TLS
                val sslSocket = sslSocketFactory.createSocket(
                    socket,
                    hostname,
                    socket.port,
                    true // autoClose
                ) as SSLSocket

                // Configure and start handshake
                sslSocket.useClientMode = true
                sslSocket.startHandshake()

                Log.d(TAG, "Socket $socketId upgraded to TLS (using classic InputStream)")

                // Store as TLS pending - will use TcpConnection (not NIO) when activated
                pendingConnections[socketId] = PendingConnection.TlsSocket(sslSocket)

                socketCallback?.onTcpSecured(socketId, true)

            } catch (e: Exception) {
                Log.e(TAG, "Socket $socketId TLS handshake failed: ${e.message}")
                try {
                    socket.close()
                } catch (_: Exception) {}
                socketCallback?.onTcpSecured(socketId, false)
            }
        }
    }

    override fun activate(socketId: Int) {
        val pending = pendingConnections.remove(socketId) ?: return

        val connection = createConnectionFromPending(socketId, pending)
        activeConnections[socketId] = connection
        connection.activate()
    }

    override fun setCallback(callback: TcpSocketCallback) {
        socketCallback = callback
    }

    override fun pauseAllReads() {
        for (connection in activeConnections.values) {
            connection.pauseReads()
        }
    }

    override fun resumeAllReads() {
        for (connection in activeConnections.values) {
            connection.resumeReads()
        }
    }

    // ============================================================
    // TcpServerManager implementation
    // ============================================================

    override fun listen(serverId: Int, port: Int) {
        scope.launch {
            try {
                val serverSocket = ServerSocket(port)
                val boundPort = serverSocket.localPort

                val handler = ServerHandler(serverId, serverSocket)
                servers[serverId] = handler

                // Notify success
                serverCallback?.onTcpListenResult(serverId, true, boundPort, 0)

                // Start accepting connections
                handler.startAccepting()

            } catch (_: Exception) {
                serverCallback?.onTcpListenResult(serverId, false, 0, 1)
            }
        }
    }

    override fun stopListen(serverId: Int) {
        servers.remove(serverId)?.close()
    }

    override fun setCallback(callback: TcpServerCallback) {
        serverCallback = callback
    }

    // ============================================================
    // Lifecycle
    // ============================================================

    /**
     * Shutdown the service, closing all sockets and cancelling operations.
     */
    fun shutdown() {
        // Cancel all pending connects
        pendingConnects.values.forEach { it.cancel() }
        pendingConnects.clear()

        // Close pending connections
        pendingConnections.values.forEach { closePendingConnection(it) }
        pendingConnections.clear()

        // Close active connections
        activeConnections.values.forEach { it.close() }
        activeConnections.clear()

        // Close servers
        servers.values.forEach { it.close() }
        servers.clear()
    }

    // ============================================================
    // Internal helpers
    // ============================================================

    /**
     * Configure a SocketChannel with optimal settings.
     *
     * Note: We don't set SO_RCVBUF explicitly to allow TCP autotuning.
     * Testing showed autotuning achieves better throughput than fixed buffers on ChromeOS ARCVM.
     */
    private fun configureChannel(channel: SocketChannel) {
        val socket = channel.socket()
        socket.tcpNoDelay = TCP_NO_DELAY
        // Let kernel autotune SO_RCVBUF - better throughput than fixed setting
        socket.soTimeout = SO_TIMEOUT
        socket.setKeepAlive(true)
    }

    /**
     * Configure a Socket with optimal settings (for accepted sockets and TLS).
     */
    private fun configureSocket(socket: Socket) {
        socket.tcpNoDelay = TCP_NO_DELAY
        socket.receiveBufferSize = RECEIVE_BUFFER_SIZE
        socket.soTimeout = SO_TIMEOUT
        socket.setKeepAlive(true)
    }

    /**
     * Close a pending connection quickly.
     */
    private fun closePendingConnection(pending: PendingConnection) {
        try {
            when (pending) {
                is PendingConnection.NioChannel -> pending.channel.close()
                is PendingConnection.TlsSocket -> {
                    val socket = pending.socket
                    if (!socket.isInputShutdown) socket.shutdownInput()
                    if (!socket.isOutputShutdown) socket.shutdownOutput()
                    socket.close()
                }
            }
        } catch (_: Exception) {}
    }

    /**
     * Create appropriate connection type based on pending connection.
     * - NioChannel -> TcpConnectionNio (direct ByteBuffer, no 128KB cap)
     * - TlsSocket -> TcpConnection (classic InputStream for SSLSocket)
     */
    private fun createConnectionFromPending(socketId: Int, pending: PendingConnection): TcpConnectionBase {
        val onData: (ByteArray) -> Unit = { data ->
            socketCallback?.onTcpData(socketId, data)
        }
        val onDataFramed: (ByteArray, Int, Int) -> Unit = { frame, offset, len ->
            socketCallback?.onTcpDataFramed(socketId, frame, offset, len)
        }
        val onClose: (Boolean, Int) -> Unit = { hadError, errorCode ->
            activeConnections.remove(socketId)
            socketCallback?.onTcpClose(socketId, hadError, errorCode)
        }

        return when (pending) {
            is PendingConnection.NioChannel -> {
                Log.d(TAG, "Socket $socketId: activating with NIO (direct ByteBuffer, zero-copy framing)")
                TcpConnectionNio(
                    socketId = socketId,
                    channel = pending.channel,
                    scope = scope,
                    onDataFramed = onDataFramed,
                    onClose = onClose
                )
            }
            is PendingConnection.TlsSocket -> {
                Log.d(TAG, "Socket $socketId: activating with TLS (classic InputStream)")
                TcpConnection(
                    socketId = socketId,
                    socket = pending.socket,
                    scope = scope,
                    batchingConfig = batchingConfig,
                    onData = onData,
                    onClose = onClose
                )
            }
        }
    }

    /**
     * Create TcpConnection for accepted sockets (server mode).
     * Server sockets use classic I/O for now.
     */
    private fun createConnection(socketId: Int, socket: Socket): TcpConnection {
        return TcpConnection(
            socketId = socketId,
            socket = socket,
            scope = scope,
            batchingConfig = batchingConfig,
            onData = { data ->
                socketCallback?.onTcpData(socketId, data)
            },
            onClose = { hadError, errorCode ->
                activeConnections.remove(socketId)
                socketCallback?.onTcpClose(socketId, hadError, errorCode)
            }
        )
    }

    /**
     * Internal handler for TCP server socket.
     */
    private inner class ServerHandler(
        private val serverId: Int,
        private val serverSocket: ServerSocket
    ) {
        private var acceptJob: Job? = null

        fun startAccepting() {
            acceptJob = scope.launch {
                try {
                    while (true) {
                        val socket = serverSocket.accept()
                        configureSocket(socket)

                        val socketId = nextSocketId.getAndIncrement()
                        val peerAddr = socket.inetAddress.hostAddress ?: "unknown"
                        val peerPort = socket.port

                        // Create and activate connection
                        val connection = createConnection(socketId, socket)
                        activeConnections[socketId] = connection
                        connection.activate()

                        // Notify callback
                        serverCallback?.onTcpAccepted(serverId, socketId, peerAddr, peerPort)
                    }
                } catch (_: IOException) {
                    // Server socket closed
                }
            }
        }

        fun close() {
            acceptJob?.cancel()
            try {
                serverSocket.close()
            } catch (_: Exception) {}
            // Note: Don't close accepted connections - they're managed separately
        }
    }
}
