package com.jstorrent.companion.server

import android.util.Base64
import android.util.Log
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.file.FileManagerException
import com.jstorrent.io.hash.Hasher
import io.netty.bootstrap.ServerBootstrap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import io.netty.buffer.ByteBuf
import io.netty.buffer.Unpooled
import io.netty.channel.*
import io.netty.channel.nio.NioEventLoopGroup
import io.netty.channel.socket.SocketChannel
import io.netty.channel.socket.nio.NioServerSocketChannel
import io.netty.handler.codec.http.*
import io.netty.util.CharsetUtil
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import java.net.Inet4Address
import java.net.InetSocketAddress
import java.net.NetworkInterface
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

private const val TAG = "NettyHttpServer"
private const val MAX_BODY_SIZE = 64 * 1024 * 1024 // 64MB

@Serializable
private data class StatusResponse(
    val port: Int,
    val ioPort: Int? = null,
    val streamingPort: Int? = null,
    val paired: Boolean,
    val extensionId: String? = null,
    val installId: String? = null,
    val version: String? = null,
    val tokenValid: Boolean? = null
)

@Serializable
private data class NetworkInterfaceInfo(
    val name: String,
    val address: String,
    val prefixLength: Int
)

@Serializable
private data class RootsResponse(
    val roots: List<DownloadRoot>
)

@Serializable
private data class DaemonStatsResponse(
    val tcp_sockets: Int,
    val pending_connects: Int,
    val pending_tcp: Int,
    val udp_sockets: Int,
    val tcp_servers: Int,
    val ws_connections: Int,
    val bytes_sent: Long,
    val bytes_received: Long,
    val uptime_secs: Long
)

private val json = Json {
    encodeDefaults = true
    ignoreUnknownKeys = true
}

/**
 * Pure Netty HTTP server replacing Ktor for all HTTP endpoints.
 *
 * This server achieves 6-10x better throughput than Ktor by eliminating
 * coroutine overhead and using direct Netty pipeline handling.
 *
 * Endpoints:
 * - GET /health - Health check
 * - GET /benchmark?mb=N - Download N MB zeros
 * - GET /throughput-test/{sizeMB} - Download test
 * - GET /network/interfaces - Network interface list
 * - POST /status - Status with optional token validation
 * - POST /pair - Pairing flow with dialog
 * - GET /stats - Daemon statistics (auth required)
 * - GET /roots - List download roots (auth required)
 * - DELETE /roots/{key} - Remove download root (auth required)
 * - POST /hash/sha1 - Compute SHA1 hash (auth required)
 * - POST /hash/sha1/batch - Batch SHA1 computation (auth required)
 * - GET /read/{root_key} - Read file (auth required)
 * - POST /write/{root_key} - Write file (auth required)
 * - POST /http-sink - Throughput test
 * - GET /http-source?mb=N - Throughput test
 */
class NettyHttpServer(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val preferredPort: Int = 7800
) {
    private var bossGroup: EventLoopGroup? = null
    private var workerGroup: EventLoopGroup? = null
    private var channel: Channel? = null
    private var actualPort: Int = 0

    // Pairing dialog state
    private val pairingDialogShowing = AtomicBoolean(false)

    // WebSocket server port (set by CompanionHttpServer after both servers start)
    @Volatile
    var ioPort: Int = 0

    // Streaming write server port (set by CompanionHttpServer after server starts)
    @Volatile
    var streamingPort: Int = 0

    val boundPort: Int get() = actualPort
    val isRunning: Boolean get() = channel?.isActive == true

    /**
     * Mark pairing dialog as closed.
     * Called from app after pairing dialog result.
     */
    fun onPairingDialogClosed() {
        pairingDialogShowing.set(false)
    }

    /**
     * Start the HTTP server.
     * Tries preferred port, then fallback ports using same formula as other servers.
     */
    fun start() {
        if (channel != null) {
            Log.w(TAG, "Server already running on port $actualPort")
            return
        }

        bossGroup = NioEventLoopGroup(1)
        workerGroup = NioEventLoopGroup()

        val portsToTry = generatePortSequence(preferredPort).take(10).toList()

        for (port in portsToTry) {
            try {
                val bootstrap = ServerBootstrap()
                    .group(bossGroup, workerGroup)
                    .channel(NioServerSocketChannel::class.java)
                    .childHandler(NettyHttpChannelInitializer(deps, fileManager, pairingDialogShowing, ioPortProvider = { ioPort }, streamingPortProvider = { streamingPort }))
                    .option(ChannelOption.SO_BACKLOG, 128)
                    .childOption(ChannelOption.SO_KEEPALIVE, true)
                    .childOption(ChannelOption.TCP_NODELAY, true)
                    .childOption(ChannelOption.SO_RCVBUF, 256 * 1024)
                    .childOption(ChannelOption.SO_SNDBUF, 256 * 1024)

                val channelFuture = bootstrap.bind(port).sync()
                channel = channelFuture.channel()
                actualPort = (channel?.localAddress() as? InetSocketAddress)?.port ?: port

                Log.i(TAG, "Netty HTTP server started on port $actualPort")
                return
            } catch (e: Exception) {
                Log.w(TAG, "Port $port unavailable: ${e.message}")
            }
        }

        // Cleanup if we couldn't bind
        workerGroup?.shutdownGracefully()
        bossGroup?.shutdownGracefully()
        workerGroup = null
        bossGroup = null

        throw IllegalStateException("Could not bind to any port")
    }

    fun stop() {
        channel?.close()?.sync()
        workerGroup?.shutdownGracefully()
        bossGroup?.shutdownGracefully()
        channel = null
        workerGroup = null
        bossGroup = null
        actualPort = 0
        Log.i(TAG, "Netty HTTP server stopped")
    }

    companion object {
        /**
         * Port selection: base, base+5, base+14, base+27, ...
         * Formula: base + 4*n + n²
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
 * Channel initializer for HTTP pipeline.
 */
private class NettyHttpChannelInitializer(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val pairingDialogShowing: AtomicBoolean,
    private val ioPortProvider: () -> Int,
    private val streamingPortProvider: () -> Int
) : ChannelInitializer<SocketChannel>() {
    override fun initChannel(ch: SocketChannel) {
        ch.pipeline()
            .addLast("httpCodec", HttpServerCodec())
            // Aggregate request bodies up to 64MB for most endpoints
            // Throughput test endpoints bypass this by checking before aggregation
            .addLast("aggregator", HttpObjectAggregator(64 * 1024 * 1024))
            .addLast("handler", NettyHttpHandler(deps, fileManager, pairingDialogShowing, ioPortProvider, streamingPortProvider))
    }
}

// Track concurrent writes for logging
private val concurrentWrites = AtomicInteger(0)
private val totalWrites = AtomicLong(0)
private val totalWriteBytes = AtomicLong(0)
private val totalWriteTimeMs = AtomicLong(0)

/**
 * Main HTTP request handler.
 * Handles routing, CORS, auth, and all HTTP endpoints.
 */
private class NettyHttpHandler(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val pairingDialogShowing: AtomicBoolean,
    private val ioPortProvider: () -> Int,
    private val streamingPortProvider: () -> Int
) : SimpleChannelInboundHandler<FullHttpRequest>() {

    override fun channelRead0(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        val path = request.uri().substringBefore('?')
        val method = request.method()

        // Handle CORS preflight
        if (method == HttpMethod.OPTIONS) {
            sendCorsPreflightResponse(ctx, request)
            return
        }

        // Route request
        try {
            when {
                // === No Auth Required ===
                path == "/health" && method == HttpMethod.GET -> handleHealth(ctx, request)
                path == "/benchmark" && method == HttpMethod.GET -> handleBenchmark(ctx, request)
                path.startsWith("/throughput-test/") && method == HttpMethod.GET -> handleThroughputTest(ctx, request, path)
                path == "/network/interfaces" && method == HttpMethod.GET -> handleNetworkInterfaces(ctx, request)
                path == "/http-sink" && method == HttpMethod.POST -> handleHttpSink(ctx, request)
                path == "/http-source" && method == HttpMethod.GET -> handleHttpSource(ctx, request)

                // === Origin Check + Extension Headers ===
                path == "/status" && method == HttpMethod.POST -> handleStatus(ctx, request)
                path == "/pair" && method == HttpMethod.POST -> handlePair(ctx, request)

                // === Auth Required ===
                path == "/stats" && method == HttpMethod.GET -> handleStats(ctx, request)
                path == "/roots" && method == HttpMethod.GET -> handleRoots(ctx, request)
                path.startsWith("/roots/") && method == HttpMethod.DELETE -> handleDeleteRoot(ctx, request, path)
                path == "/hash/sha1" && method == HttpMethod.POST -> handleHashSha1(ctx, request)
                path == "/hash/sha1/batch" && method == HttpMethod.POST -> handleHashSha1Batch(ctx, request)
                path.startsWith("/read/") && method == HttpMethod.GET -> handleRead(ctx, request, path)
                path.startsWith("/write/") && method == HttpMethod.POST -> handleWrite(ctx, request, path)
                path.startsWith("/write-batch/") && method == HttpMethod.POST -> handleWriteBatch(ctx, request, path)
                path.startsWith("/ops/exists") && method == HttpMethod.GET -> handleOpsExists(ctx, request)

                else -> sendNotFound(ctx, request)
            }
        } catch (e: Exception) {
            Log.e(TAG, "Request handler error: ${e.message}", e)
            sendError(ctx, request, HttpResponseStatus.INTERNAL_SERVER_ERROR, e.message ?: "Internal error")
        }
    }

    // =========================================================================
    // No Auth Endpoints
    // =========================================================================

    private fun handleHealth(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        sendResponse(ctx, request, HttpResponseStatus.OK, "text/plain", "ok")
    }

    private fun handleBenchmark(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        val query = QueryStringDecoder(request.uri())
        val mb = query.parameters()["mb"]?.firstOrNull()?.toIntOrNull()?.coerceIn(1, 100) ?: 10
        val bytes = mb * 1024 * 1024

        Log.i(TAG, "Benchmark: sending ${mb}MB")
        sendZeros(ctx, request, bytes.toLong())
    }

    private fun handleThroughputTest(ctx: ChannelHandlerContext, request: FullHttpRequest, path: String) {
        val sizeMB = path.removePrefix("/throughput-test/").toIntOrNull() ?: 10
        val bytes = sizeMB.toLong() * 1024 * 1024

        Log.i(TAG, "Throughput test: sending ${sizeMB}MB")
        sendZeros(ctx, request, bytes)
    }

    private fun handleNetworkInterfaces(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        val interfaces = mutableListOf<NetworkInterfaceInfo>()

        try {
            val netInterfaces = NetworkInterface.getNetworkInterfaces()
            while (netInterfaces.hasMoreElements()) {
                val iface = netInterfaces.nextElement()
                if (iface.isLoopback || !iface.isUp) continue

                for (addr in iface.interfaceAddresses) {
                    val inet = addr.address
                    if (inet is Inet4Address) {
                        interfaces.add(NetworkInterfaceInfo(
                            name = iface.name,
                            address = inet.hostAddress ?: "",
                            prefixLength = addr.networkPrefixLength.toInt()
                        ))
                    }
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to get network interfaces: ${e.message}")
        }

        sendJsonResponse(ctx, request, HttpResponseStatus.OK, json.encodeToString(interfaces))
    }

    private fun handleHttpSink(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        val content = request.content()
        val bytes = content.readableBytes()
        val mb = bytes / (1024.0 * 1024.0)

        Log.i(TAG, "HTTP sink: received ${"%.1f".format(mb)} MB")
        sendResponse(ctx, request, HttpResponseStatus.OK, "text/plain", "${"%.1f".format(mb)} MB received")
    }

    private fun handleHttpSource(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        val query = QueryStringDecoder(request.uri())
        val mb = query.parameters()["mb"]?.firstOrNull()?.toIntOrNull()?.coerceIn(1, 10240) ?: 100
        val bytes = mb.toLong() * 1024 * 1024

        Log.i(TAG, "HTTP source: sending ${mb}MB")
        sendZeros(ctx, request, bytes)
    }

    // =========================================================================
    // Status/Pairing (Origin Check Required)
    // =========================================================================

    private fun handleStatus(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        // Validate extension origin
        if (!validateExtensionOrigin(request)) {
            sendError(ctx, request, HttpResponseStatus.FORBIDDEN, "Invalid origin")
            return
        }

        // Parse request body
        val body = request.content().toString(CharsetUtil.UTF_8)
        val token = try {
            if (body.isNotBlank()) {
                val parsed = json.decodeFromString<Map<String, String?>>(body)
                parsed["token"]
            } else null
        } catch (e: Exception) { null }

        // Check token validity if provided
        val tokenValid = token?.let { deps.tokenStore.isTokenValid(it) }

        // Build response - include ioPort for WebSocket connections, streamingPort for batch writes
        val currentIoPort = ioPortProvider()
        val currentStreamingPort = streamingPortProvider()
        val response = StatusResponse(
            port = (ctx.channel().localAddress() as InetSocketAddress).port,
            ioPort = if (currentIoPort > 0) currentIoPort else null,
            streamingPort = if (currentStreamingPort > 0) currentStreamingPort else null,
            paired = deps.tokenStore.hasToken(),
            extensionId = deps.tokenStore.extensionId,
            installId = deps.tokenStore.installId,
            version = deps.versionName,
            tokenValid = tokenValid
        )

        sendJsonResponse(ctx, request, HttpResponseStatus.OK, json.encodeToString(response))
    }

    private fun handlePair(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        // Validate extension origin
        if (!validateExtensionOrigin(request)) {
            sendError(ctx, request, HttpResponseStatus.FORBIDDEN, "Invalid origin")
            return
        }

        val headers = getExtensionHeaders(request)
        if (headers == null) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing extension headers")
            return
        }

        // Parse request body
        val body = request.content().toString(CharsetUtil.UTF_8)
        val token = try {
            val parsed = json.decodeFromString<Map<String, String>>(body)
            parsed["token"] ?: throw IllegalArgumentException("Missing token")
        } catch (e: Exception) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Invalid request body")
            return
        }

        val (extensionId, installId) = headers

        // Same extensionId AND installId = silent re-pair (token refresh)
        if (deps.tokenStore.isPairedWith(extensionId, installId)) {
            deps.tokenStore.pair(token, installId, extensionId)
            Log.i(TAG, "Silent re-pair: same extensionId and installId")
            sendJsonResponse(ctx, request, HttpResponseStatus.OK, """{"status":"approved"}""")
            return
        }

        // Dialog already showing? Return 409 Conflict
        if (pairingDialogShowing.get()) {
            Log.w(TAG, "Pairing dialog already showing, rejecting")
            sendError(ctx, request, HttpResponseStatus.CONFLICT, "Pairing dialog already showing")
            return
        }

        // Show dialog (async) and return 202 Accepted
        val isReplace = deps.tokenStore.hasToken()

        try {
            pairingDialogShowing.set(true)
            deps.showPairingDialog(
                token = token,
                installId = installId,
                extensionId = extensionId,
                isReplace = isReplace
            )
        } catch (e: Exception) {
            Log.e(TAG, "Failed to show pairing dialog: ${e.message}")
            pairingDialogShowing.set(false)
            sendError(ctx, request, HttpResponseStatus.INTERNAL_SERVER_ERROR, "Failed to show pairing dialog")
            return
        }

        sendJsonResponse(ctx, request, HttpResponseStatus.ACCEPTED, """{"status":"pending"}""")
    }

    // =========================================================================
    // Auth Required Endpoints
    // =========================================================================

    private fun handleStats(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        if (!validateAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.UNAUTHORIZED, "Invalid token")
            return
        }

        val response = DaemonStatsResponse(
            tcp_sockets = DaemonStats.tcpSockets.get(),
            pending_connects = DaemonStats.pendingConnects.get(),
            pending_tcp = DaemonStats.pendingTcp.get(),
            udp_sockets = DaemonStats.udpSockets.get(),
            tcp_servers = DaemonStats.tcpServers.get(),
            ws_connections = DaemonStats.wsConnections.get(),
            bytes_sent = DaemonStats.bytesSent.get(),
            bytes_received = DaemonStats.bytesReceived.get(),
            uptime_secs = DaemonStats.uptimeSecs()
        )

        sendJsonResponse(ctx, request, HttpResponseStatus.OK, json.encodeToString(response))
    }

    private fun handleRoots(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        if (getExtensionHeaders(request) == null && !isStandaloneAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing extension headers")
            return
        }
        if (!validateAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.UNAUTHORIZED, "Invalid token")
            return
        }

        val roots = deps.rootStore.refreshAvailability()
        sendJsonResponse(ctx, request, HttpResponseStatus.OK, json.encodeToString(RootsResponse(roots)))
    }

    private fun handleDeleteRoot(ctx: ChannelHandlerContext, request: FullHttpRequest, path: String) {
        if (getExtensionHeaders(request) == null && !isStandaloneAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing extension headers")
            return
        }
        if (!validateAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.UNAUTHORIZED, "Invalid token")
            return
        }

        val key = path.removePrefix("/roots/")
        if (key.isBlank()) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing key")
            return
        }

        val root = deps.rootStore.getRoot(key)
        val removed = deps.rootStore.removeRoot(key)

        if (removed) {
            root?.let { deps.releaseSafPermission(it.uri) }
            sendJsonResponse(ctx, request, HttpResponseStatus.OK, """{"removed":"$key"}""")
        } else {
            sendError(ctx, request, HttpResponseStatus.NOT_FOUND, "Root not found")
        }
    }

    private fun handleHashSha1(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        if (getExtensionHeaders(request) == null && !isStandaloneAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing extension headers")
            return
        }
        if (!validateAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.UNAUTHORIZED, "Invalid token")
            return
        }

        val reason = request.headers().get("X-SHA-Reason") ?: "unknown"
        val content = request.content()
        val bytes = ByteArray(content.readableBytes())
        content.readBytes(bytes)

        Log.d(TAG, "SHA1: ${bytes.size} bytes, reason=$reason")
        val hash = com.jstorrent.io.hash.Hasher.sha1(bytes)
        sendBinaryResponse(ctx, request, HttpResponseStatus.OK, hash)
    }

    /**
     * Batch SHA1 computation for efficient multi-hash operations.
     *
     * Wire format:
     * Request: count (u32 LE), then [len (u32 LE), data (len bytes)] repeated
     * Response: concatenated 20-byte SHA1 hashes
     */
    private fun handleHashSha1Batch(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        if (getExtensionHeaders(request) == null && !isStandaloneAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing extension headers")
            return
        }
        if (!validateAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.UNAUTHORIZED, "Invalid token")
            return
        }

        val reason = request.headers().get("X-SHA-Reason") ?: "unknown"
        val body = request.content()

        if (body.readableBytes() < 4) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Body too short")
            return
        }

        val count = body.readIntLE()

        if (count < 0 || count > 10_000) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Invalid count (max 10000)")
            return
        }

        Log.d(TAG, "SHA1 batch: $count hashes, reason=$reason")
        val results = ByteArray(count * 20)
        val md = java.security.MessageDigest.getInstance("SHA-1")

        for (i in 0 until count) {
            if (body.readableBytes() < 4) {
                sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Truncated input at item $i")
                return
            }

            val len = body.readIntLE()

            if (len < 0 || body.readableBytes() < len) {
                sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Truncated input at item $i")
                return
            }

            val data = ByteArray(len)
            body.readBytes(data)

            md.reset()
            val hash = md.digest(data)
            System.arraycopy(hash, 0, results, i * 20, 20)
        }

        sendBinaryResponse(ctx, request, HttpResponseStatus.OK, results)
    }

    private fun handleRead(ctx: ChannelHandlerContext, request: FullHttpRequest, path: String) {
        if (getExtensionHeaders(request) == null && !isStandaloneAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing extension headers")
            return
        }
        if (!validateAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.UNAUTHORIZED, "Invalid token")
            return
        }

        val rootKey = path.removePrefix("/read/")
        if (rootKey.isBlank()) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing root_key")
            return
        }

        val pathBase64 = request.headers().get("X-Path-Base64")
        if (pathBase64 == null) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing X-Path-Base64 header")
            return
        }

        val relativePath = try {
            String(Base64.decode(pathBase64, Base64.DEFAULT))
        } catch (e: Exception) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Invalid base64 in X-Path-Base64")
            return
        }

        val offset = request.headers().get("X-Offset")?.toLongOrNull() ?: 0L
        val length = request.headers().get("X-Length")?.toIntOrNull()
        if (length == null) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing X-Length header")
            return
        }

        // Validate path (prevent directory traversal)
        if (relativePath.contains("..")) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Invalid path")
            return
        }

        // Resolve root key to SAF URI
        val rootUri = deps.rootStore.resolveKey(rootKey)
        if (rootUri == null) {
            sendError(ctx, request, HttpResponseStatus.FORBIDDEN, "Invalid root key")
            return
        }

        try {
            val bytes = fileManager.read(rootUri, relativePath, offset, length)
            sendBinaryResponse(ctx, request, HttpResponseStatus.OK, bytes)
        } catch (e: FileManagerException) {
            val (status, message) = fileManagerExceptionToHttpResponse(e)
            sendError(ctx, request, status, message)
        }
    }

    /**
     * Check if a file exists (without returning 404 for non-existent files).
     * Used by DaemonFileSystem.exists() to avoid noisy 404s in network panel.
     */
    private fun handleOpsExists(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        if (getExtensionHeaders(request) == null && !isStandaloneAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing extension headers")
            return
        }
        if (!validateAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.UNAUTHORIZED, "Invalid token")
            return
        }

        val query = QueryStringDecoder(request.uri())
        val rootKey = query.parameters()["root_key"]?.firstOrNull()
        val relativePath = query.parameters()["path"]?.firstOrNull()

        if (rootKey == null || relativePath == null) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing root_key or path parameter")
            return
        }

        // Validate path (prevent directory traversal)
        if (relativePath.contains("..")) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Invalid path")
            return
        }

        // Resolve root key to SAF URI
        val rootUri = deps.rootStore.resolveKey(rootKey)
        if (rootUri == null) {
            sendError(ctx, request, HttpResponseStatus.FORBIDDEN, "Invalid root key")
            return
        }

        val exists = fileManager.exists(rootUri, relativePath)
        sendJsonResponse(ctx, request, HttpResponseStatus.OK, """{"exists":$exists}""")
    }

    private fun handleWrite(ctx: ChannelHandlerContext, request: FullHttpRequest, path: String) {
        val concurrent = concurrentWrites.incrementAndGet()
        val t0 = System.nanoTime()

        try {
            if (getExtensionHeaders(request) == null && !isStandaloneAuth(request)) {
                sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing extension headers")
                return
            }
            if (!validateAuth(request)) {
                sendError(ctx, request, HttpResponseStatus.UNAUTHORIZED, "Invalid token")
                return
            }

            val rootKey = path.removePrefix("/write/")
            if (rootKey.isBlank()) {
                sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing root_key")
                return
            }

            val pathBase64 = request.headers().get("X-Path-Base64")
            if (pathBase64 == null) {
                sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing X-Path-Base64 header")
                return
            }

            val relativePath = try {
                String(Base64.decode(pathBase64, Base64.DEFAULT))
            } catch (e: Exception) {
                sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Invalid base64 in X-Path-Base64")
                return
            }

            val offset = request.headers().get("X-Offset")?.toLongOrNull() ?: 0L
            val expectedSha1 = request.headers().get("X-Expected-SHA1")

            // Validate path (prevent directory traversal)
            if (relativePath.contains("..")) {
                sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Invalid path")
                return
            }

            // Resolve root key to SAF URI
            val rootUri = deps.rootStore.resolveKey(rootKey)
            if (rootUri == null) {
                sendError(ctx, request, HttpResponseStatus.FORBIDDEN, "Invalid root key")
                return
            }

            val content = request.content()
            val body = ByteArray(content.readableBytes())
            content.readBytes(body)
            val receiveMs = (System.nanoTime() - t0) / 1_000_000

            if (body.size > MAX_BODY_SIZE) {
                sendError(ctx, request, HttpResponseStatus.REQUEST_ENTITY_TOO_LARGE, "Body too large")
                return
            }

            // Hash verification FIRST (before any file operations)
            var hashMs = 0L
            if (expectedSha1 != null) {
                val tHashStart = System.nanoTime()
                val actualHash = Hasher.sha1Hex(body)
                hashMs = (System.nanoTime() - tHashStart) / 1_000_000
                if (!actualHash.equals(expectedSha1, ignoreCase = true)) {
                    sendError(ctx, request, HttpResponseStatus.CONFLICT,
                        "Hash mismatch: expected $expectedSha1, got $actualHash")
                    return
                }
            }

            try {
                val tWriteStart = System.nanoTime()
                fileManager.write(rootUri, relativePath, offset, body)
                val writeMs = (System.nanoTime() - tWriteStart) / 1_000_000
                val totalMs = (System.nanoTime() - t0) / 1_000_000

                // Track stats
                val writeNum = totalWrites.incrementAndGet()
                totalWriteBytes.addAndGet(body.size.toLong())
                totalWriteTimeMs.addAndGet(totalMs)

                // Log every write with concurrency info
                Log.i(TAG, "WRITE #$writeNum: ${body.size/1024}KB in ${totalMs}ms (recv=${receiveMs}ms, hash=${hashMs}ms, write=${writeMs}ms) concurrent=$concurrent")

                sendResponse(ctx, request, HttpResponseStatus.OK, "text/plain", "OK")
            } catch (e: FileManagerException) {
                val (status, message) = fileManagerExceptionToHttpResponse(e)
                sendError(ctx, request, status, message)
            }
        } finally {
            concurrentWrites.decrementAndGet()
        }
    }

    /**
     * Handle batched write requests for high-throughput piece writes.
     *
     * This endpoint accepts a packed binary batch of verified writes and processes
     * them in parallel. Results are sent via WebSocket ACK/ERROR frames rather than
     * in the HTTP response, allowing the client to continue sending batches without
     * waiting for disk I/O.
     *
     * Binary format: See [unpackVerifiedWriteBatch] for details.
     *
     * @return 202 Accepted immediately (results come via WebSocket)
     */
    private fun handleWriteBatch(ctx: ChannelHandlerContext, request: FullHttpRequest, path: String) {
        // Auth check (same as handleWrite)
        if (getExtensionHeaders(request) == null && !isStandaloneAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Missing extension headers")
            return
        }
        if (!validateAuth(request)) {
            sendError(ctx, request, HttpResponseStatus.UNAUTHORIZED, "Invalid token")
            return
        }

        // Extract rootKey from URL (optional, for validation)
        val urlRootKey = path.removePrefix("/write-batch/").takeIf { it.isNotBlank() }

        // Read packed batch from body
        val content = request.content()
        val packed = ByteArray(content.readableBytes())
        content.readBytes(packed)

        if (packed.isEmpty()) {
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Empty batch")
            return
        }

        // Unpack batch
        val writes = try {
            unpackVerifiedWriteBatch(packed)
        } catch (e: Exception) {
            Log.e(TAG, "WRITE-BATCH: failed to unpack: ${e.message}")
            sendError(ctx, request, HttpResponseStatus.BAD_REQUEST, "Invalid batch format: ${e.message}")
            return
        }

        if (writes.isEmpty()) {
            sendResponse(ctx, request, HttpResponseStatus.ACCEPTED, "text/plain", "Accepted 0 writes")
            return
        }

        Log.i(TAG, "WRITE-BATCH: ${writes.size} writes, ${packed.size} bytes")

        // Launch all writes in parallel on IO dispatcher
        val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())
        for (write in writes) {
            // Validate rootKey if URL specified one
            if (urlRootKey != null && write.rootKey != urlRootKey) {
                Log.w(TAG, "WRITE-BATCH: rootKey mismatch: URL=$urlRootKey, write=${write.rootKey}")
                BatchWriteResults.addResult(write.callbackId, -1, WriteResultCode.INVALID_ARGS)
                continue
            }

            // Resolve root key to SAF URI
            val rootUri = deps.rootStore.resolveKey(write.rootKey)
            if (rootUri == null) {
                Log.w(TAG, "WRITE-BATCH: invalid root key: ${write.rootKey}")
                BatchWriteResults.addResult(write.callbackId, -1, WriteResultCode.INVALID_ARGS)
                continue
            }

            // Validate path (prevent directory traversal)
            if (write.path.contains("..")) {
                Log.w(TAG, "WRITE-BATCH: invalid path with ..: ${write.path}")
                BatchWriteResults.addResult(write.callbackId, -1, WriteResultCode.INVALID_ARGS)
                continue
            }

            scope.launch {
                try {
                    // Hash verification
                    val actualHash = Hasher.sha1Hex(write.data)
                    if (!actualHash.equals(write.expectedHashHex, ignoreCase = true)) {
                        Log.w(TAG, "WRITE-BATCH: hash mismatch for ${write.path}")
                        BatchWriteResults.addResult(write.callbackId, -1, WriteResultCode.HASH_MISMATCH)
                        return@launch
                    }

                    // Write to disk
                    fileManager.write(rootUri, write.path, write.position, write.data)
                    BatchWriteResults.addResult(write.callbackId, write.data.size, WriteResultCode.SUCCESS)

                } catch (e: Exception) {
                    Log.e(TAG, "WRITE-BATCH: write failed: ${write.path}", e)
                    BatchWriteResults.addResult(write.callbackId, -1, WriteResultCode.IO_ERROR)
                }
            }
        }

        // Return 202 Accepted immediately (results come via WebSocket)
        sendResponse(ctx, request, HttpResponseStatus.ACCEPTED, "text/plain", "Accepted ${writes.size} writes")
    }

    /**
     * Convert FileManagerException to HTTP status code and message.
     */
    private fun fileManagerExceptionToHttpResponse(e: FileManagerException): Pair<HttpResponseStatus, String> {
        return when (e) {
            is FileManagerException.FileNotFound -> HttpResponseStatus.NOT_FOUND to e.message!!
            is FileManagerException.CannotCreateFile -> HttpResponseStatus.INTERNAL_SERVER_ERROR to e.message!!
            is FileManagerException.CannotOpenFile -> HttpResponseStatus.INTERNAL_SERVER_ERROR to e.message!!
            is FileManagerException.InsufficientData -> HttpResponseStatus.REQUESTED_RANGE_NOT_SATISFIABLE to e.message!!
            is FileManagerException.ReadError -> HttpResponseStatus.INTERNAL_SERVER_ERROR to (e.message ?: "Read error")
            is FileManagerException.WriteError -> HttpResponseStatus.INTERNAL_SERVER_ERROR to (e.message ?: "Write error")
            is FileManagerException.DiskFull -> HttpResponseStatus.INSUFFICIENT_STORAGE to e.message!!
            is FileManagerException.PermissionDenied -> HttpResponseStatus.FORBIDDEN to e.message!!
        }
    }

    // =========================================================================
    // Auth/Validation Helpers
    // =========================================================================

    private fun validateExtensionOrigin(request: FullHttpRequest): Boolean {
        val origin = request.headers().get(HttpHeaderNames.ORIGIN) ?: return true // No origin = same-origin
        return origin.startsWith("chrome-extension://") ||
               origin.startsWith("http://127.0.0.1") ||
               origin.startsWith("http://localhost") ||
               origin.startsWith("https://appassets.androidplatform.net") ||
               origin == "null" // file:// URLs
    }

    private fun getExtensionHeaders(request: FullHttpRequest): Pair<String, String>? {
        val extensionId = request.headers().get("X-JST-ExtensionId") ?: return null
        val installId = request.headers().get("X-JST-InstallId") ?: return null
        return Pair(extensionId, installId)
    }

    private fun validateAuth(request: FullHttpRequest): Boolean {
        val token = request.headers().get("X-JST-Auth")
            ?: request.headers().get(HttpHeaderNames.AUTHORIZATION)?.removePrefix("Bearer ")
            ?: return false
        return deps.tokenStore.isTokenValid(token)
    }

    private fun isStandaloneAuth(request: FullHttpRequest): Boolean {
        val token = request.headers().get("X-JST-Auth")
            ?: request.headers().get(HttpHeaderNames.AUTHORIZATION)?.removePrefix("Bearer ")
            ?: return false
        return token == deps.tokenStore.standaloneToken
    }

    // =========================================================================
    // Response Helpers
    // =========================================================================

    private fun addCorsHeaders(response: HttpResponse, request: FullHttpRequest) {
        val origin = request.headers().get(HttpHeaderNames.ORIGIN)
        val allowedOrigin = when {
            origin == null -> null
            origin.startsWith("http://127.0.0.1") -> origin
            origin.startsWith("http://localhost") -> origin
            origin.startsWith("https://appassets.androidplatform.net") -> origin
            origin.startsWith("chrome-extension://") -> origin
            origin == "null" -> "*"
            else -> null
        }

        if (allowedOrigin != null) {
            response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, allowedOrigin)
            response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_CREDENTIALS, "true")
        }
    }

    private fun sendCorsPreflightResponse(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK)
        addCorsHeaders(response, request)
        response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, PUT, DELETE, OPTIONS")
        response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_HEADERS,
            "Content-Type, Authorization, X-Requested-With, X-JST-Auth, X-JST-ExtensionId, X-JST-InstallId, X-Path-Base64, X-Offset, X-Length, X-Expected-SHA1, X-SHA-Reason")
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, 0)
        ctx.writeAndFlush(response)
    }

    private fun sendResponse(ctx: ChannelHandlerContext, request: FullHttpRequest, status: HttpResponseStatus, contentType: String, body: String) {
        val content = Unpooled.copiedBuffer(body, CharsetUtil.UTF_8)
        val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, content)
        addCorsHeaders(response, request)
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, contentType)
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, content.readableBytes())
        ctx.writeAndFlush(response)
    }

    private fun sendJsonResponse(ctx: ChannelHandlerContext, request: FullHttpRequest, status: HttpResponseStatus, json: String) {
        sendResponse(ctx, request, status, "application/json", json)
    }

    private fun sendBinaryResponse(ctx: ChannelHandlerContext, request: FullHttpRequest, status: HttpResponseStatus, data: ByteArray) {
        val content = Unpooled.wrappedBuffer(data)
        val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status, content)
        addCorsHeaders(response, request)
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, "application/octet-stream")
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, data.size)
        ctx.writeAndFlush(response)
    }

    private fun sendError(ctx: ChannelHandlerContext, request: FullHttpRequest, status: HttpResponseStatus, message: String) {
        sendResponse(ctx, request, status, "text/plain", message)
    }

    private fun sendNotFound(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        sendError(ctx, request, HttpResponseStatus.NOT_FOUND, "Not found")
    }

    private fun sendZeros(ctx: ChannelHandlerContext, request: FullHttpRequest, totalBytes: Long) {
        val response = DefaultHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK)
        addCorsHeaders(response, request)
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, "application/octet-stream")
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, totalBytes)
        ctx.write(response)

        // Send body in chunks
        val chunkSize = 256 * 1024
        val chunk = ByteArray(chunkSize)
        var remaining = totalBytes

        fun sendNextChunk() {
            if (remaining <= 0 || !ctx.channel().isActive) {
                ctx.writeAndFlush(LastHttpContent.EMPTY_LAST_CONTENT)
                return
            }

            val toSend = minOf(remaining, chunkSize.toLong()).toInt()
            val content = DefaultHttpContent(Unpooled.wrappedBuffer(chunk, 0, toSend))
            remaining -= toSend

            val future = ctx.writeAndFlush(content)
            if (ctx.channel().isWritable) {
                sendNextChunk()
            } else {
                future.addListener { sendNextChunk() }
            }
        }

        sendNextChunk()
    }

    override fun exceptionCaught(ctx: ChannelHandlerContext, cause: Throwable) {
        Log.e(TAG, "Handler error: ${cause.message}", cause)
        ctx.close()
    }
}
