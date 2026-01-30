@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.jstorrent.companion.server

import android.util.Log
import com.jstorrent.companion.server.websocket.WebSocketSession
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.file.FileManagerException
import com.jstorrent.io.hash.Hasher
import com.jstorrent.io.protocol.Protocol
import com.jstorrent.io.protocol.getUIntLE
import com.jstorrent.io.protocol.getUShortLE
import com.jstorrent.io.protocol.getLongLE
import com.jstorrent.io.protocol.toLEBytes
import com.jstorrent.io.socket.TcpServerCallback
import com.jstorrent.io.socket.TcpSocketCallback
import com.jstorrent.io.socket.TcpSocketService
import com.jstorrent.io.socket.UdpSocketCallback
import com.jstorrent.io.socket.UdpSocketManagerImpl
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "IoWebSocketHandler"

/**
 * WebSocket handler for I/O operations (TCP/UDP sockets).
 *
 * This handler implements io-core callback interfaces and translates
 * socket events into WebSocket protocol messages. It uses io-core's
 * TcpSocketService and UdpSocketManagerImpl for actual socket operations.
 *
 * Per-session lifecycle:
 * 1. Created when WebSocket connects
 * 2. Runs authentication handshake
 * 3. Dispatches socket operations to io-core managers
 * 4. Receives callbacks and sends WS frames
 * 5. Cleans up when WebSocket disconnects
 */
class IoWebSocketHandler(
    private val session: WebSocketSession,
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val onControlSessionRegistered: (IoWebSocketHandler) -> Unit = {},
    private val onControlSessionUnregistered: (IoWebSocketHandler) -> Unit = {}
) : TcpSocketCallback, UdpSocketCallback, TcpServerCallback {

    private var authenticated = false
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Socket managers - created per session, share global semaphore
    private val tcpService = SocketManagerFactory.createTcpService(scope)
    private val udpManager = SocketManagerFactory.createUdpManager(scope)

    // RequestId tracking for async responses
    private val tcpConnectRequests = ConcurrentHashMap<Int, Int>() // socketId → requestId
    private val tcpSecureRequests = ConcurrentHashMap<Int, Int>()  // socketId → requestId
    private val tcpListenRequests = ConcurrentHashMap<Int, Int>()  // serverId → requestId
    private val udpBindRequests = ConcurrentHashMap<Int, Int>()    // socketId → requestId

    // Track socket states for global stats
    private val activatedTcpSockets = ConcurrentHashMap.newKeySet<Int>() // socketIds that have been activated
    private val pendingTcpSockets = ConcurrentHashMap.newKeySet<Int>()   // socketIds in pending (connected, not activated)
    private val activeServerIds = ConcurrentHashMap.newKeySet<Int>()     // serverIds with active listeners
    private val activeUdpSockets = ConcurrentHashMap.newKeySet<Int>()    // socketIds with active UDP bindings

    // Outgoing message queue - large buffer for high throughput
    // At 65KB frames, 2000 frames = ~130MB buffer capacity
    private val outgoing = Channel<ByteArray>(2000)

    // Session statistics
    private val dropCount = AtomicLong(0)
    private val queueDepth = AtomicInteger(0)
    private val maxQueueDepth = AtomicInteger(0)
    private val bytesReceived = AtomicLong(0)
    private val bytesSent = AtomicLong(0)
    private val framesReceived = AtomicLong(0)
    private val framesSent = AtomicLong(0)
    private val connectTime = System.currentTimeMillis()

    // TCP recv throughput tracking (separate from WS send)
    private val tcpRecvBytes = AtomicLong(0)
    private val tcpRecvFrames = AtomicLong(0)
    private val tcpFrameBuildTimeNs = AtomicLong(0)

    companion object {
        private const val ENABLE_SEND_LOGGING = true
    }

    init {
        // Register this handler as callback for all io-core managers
        // Explicit casts needed to resolve overload ambiguity
        tcpService.setCallback(this as TcpSocketCallback)
        tcpService.setCallback(this as TcpServerCallback)
        udpManager.setCallback(this)
    }

    // ==========================================================================
    // Main run loop
    // ==========================================================================

    suspend fun run() {
        // Track global WS connection
        DaemonStats.wsConnections.incrementAndGet()

        // Start sender coroutine with time-based throughput tracking
        val senderJob = scope.launch {
            var statsStartTime = System.currentTimeMillis()
            var statsSendCount = 0L
            var statsBytesSent = 0L
            var statsTotalSendTimeNs = 0L
            var statsMaxSendTimeMs = 0L

            try {
                for (data in outgoing) {
                    val depth = queueDepth.decrementAndGet()
                    val t0 = System.nanoTime()
                    session.send(data)
                    val sendTimeNs = System.nanoTime() - t0
                    val sendTimeMs = sendTimeNs / 1_000_000

                    statsSendCount++
                    statsBytesSent += data.size
                    statsTotalSendTimeNs += sendTimeNs
                    if (sendTimeMs > statsMaxSendTimeMs) statsMaxSendTimeMs = sendTimeMs

                    // Log slow sends (>50ms)
                    if (sendTimeMs > 50) {
                        val opcode = if (data.size >= 2) data[1].toInt() and 0xFF else -1
                        Log.w(TAG, "SLOW WS SEND: ${sendTimeMs}ms, opcode=0x${opcode.toString(16)}, " +
                            "size=${data.size}, queueDepth=$depth")
                    }

                    // Log throughput stats every 5 seconds
                    val now = System.currentTimeMillis()
                    val elapsed = now - statsStartTime
                    if (elapsed >= 5000 && statsSendCount > 0) {
                        val wsSendMbps = statsBytesSent / (elapsed / 1000.0) / (1024 * 1024)
                        val avgSendUs = statsTotalSendTimeNs / statsSendCount / 1000
                        val avgFrameSize = statsBytesSent / statsSendCount
                        val tcpRecvMbps = tcpRecvBytes.getAndSet(0) / (elapsed / 1000.0) / (1024 * 1024)
                        val tcpFrames = tcpRecvFrames.getAndSet(0)
                        val frameBuildNs = tcpFrameBuildTimeNs.getAndSet(0)
                        val avgFrameBuildUs = if (tcpFrames > 0) frameBuildNs / tcpFrames / 1000 else 0
                        val frameBuildPct = (frameBuildNs / 1_000_000.0) / elapsed * 100
                        val maxDepth = maxQueueDepth.getAndSet(depth)
                        Log.i(TAG, "WS THROUGHPUT: send=${"%.1f".format(wsSendMbps)} MB/s ($statsSendCount frames), " +
                            "tcpRecv=${"%.1f".format(tcpRecvMbps)} MB/s ($tcpFrames frames), " +
                            "avgSend=${avgSendUs}µs, maxSend=${statsMaxSendTimeMs}ms, " +
                            "frameBuild=${avgFrameBuildUs}µs (${"%.1f".format(frameBuildPct)}%), " +
                            "avgFrame=$avgFrameSize bytes, queueDepth=$depth (max=$maxDepth)")

                        // Reset stats
                        statsStartTime = now
                        statsSendCount = 0
                        statsBytesSent = 0
                        statsTotalSendTimeNs = 0
                        statsMaxSendTimeMs = 0
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "WebSocket sender failed: ${e.message}")
                try {
                    session.close(1001, "Sender failed")
                } catch (_: Exception) {}
            }
        }

        try {
            while (true) {
                val data = session.receive() ?: break
                scope.launch { handleMessage(data) }  // Don't block read loop
            }
            Log.d(TAG, "WebSocket closed normally")
        } catch (e: Exception) {
            Log.e(TAG, "WebSocket error: ${e.message}")
        } finally {
            cleanup()
            senderJob.cancel()
        }
    }

    // ==========================================================================
    // Message handling
    // ==========================================================================

    private suspend fun handleMessage(data: ByteArray) {
        framesReceived.incrementAndGet()
        bytesReceived.addAndGet(data.size.toLong())

        if (data.size < 8) {
            Log.w(TAG, "Message too short: ${data.size} bytes")
            return
        }

        val envelope = Protocol.Envelope.fromBytes(data) ?: run {
            Log.e(TAG, "Failed to parse envelope from ${data.size} bytes")
            return
        }

        Log.d(TAG, "RECV: opcode=0x${envelope.opcode.toString(16)}, reqId=${envelope.requestId}, " +
            "payloadSize=${data.size - 8}, authenticated=$authenticated")

        if (envelope.version != Protocol.VERSION) {
            Log.e(TAG, "Invalid version: ${envelope.version} (expected ${Protocol.VERSION})")
            sendError(envelope.requestId, "Invalid protocol version")
            return
        }

        // Validate opcode is allowed for IO endpoint
        if (envelope.opcode !in Protocol.IO_OPCODES) {
            Log.w(TAG, "Opcode 0x${envelope.opcode.toString(16)} not allowed on IO endpoint")
            sendError(envelope.requestId, "Opcode not allowed on this endpoint")
            return
        }

        val payload = data.copyOfRange(8, data.size)

        if (!authenticated) {
            handlePreAuth(envelope, payload)
        } else {
            handlePostAuth(envelope, payload)
        }
    }

    private suspend fun handlePreAuth(envelope: Protocol.Envelope, payload: ByteArray) {
        when (envelope.opcode) {
            Protocol.OP_CLIENT_HELLO -> {
                send(Protocol.createMessage(Protocol.OP_SERVER_HELLO, envelope.requestId))
            }
            Protocol.OP_AUTH -> {
                if (payload.isEmpty()) {
                    sendError(envelope.requestId, "Invalid auth payload")
                    return
                }

                // Parse AUTH payload: authType(1) + token + \0 + extensionId + \0 + installId
                val authType = payload[0]
                val payloadStr = String(payload, 1, payload.size - 1)
                val parts = payloadStr.split('\u0000')

                if (parts.size < 3) {
                    sendError(envelope.requestId, "Invalid auth payload format")
                    return
                }

                val token = parts[0]
                val extensionId = parts[1]
                val installId = parts[2]

                // For extension auth, also verify pairing
                val isExtensionAuth = deps.tokenStore.token != null &&
                    token == deps.tokenStore.token &&
                    deps.tokenStore.isPairedWith(extensionId, installId)
                // For standalone mode, just the standalone token is enough
                val isStandaloneAuth = token == deps.tokenStore.standaloneToken

                if (isExtensionAuth || isStandaloneAuth) {
                    authenticated = true
                    send(Protocol.createMessage(Protocol.OP_AUTH_RESULT, envelope.requestId, byteArrayOf(0)))
                    val authTypeStr = if (isStandaloneAuth) "standalone" else "extension"
                    Log.i(TAG, "WebSocket authenticated ($authTypeStr, IO)")
                } else {
                    val errorMsg = "Invalid credentials".toByteArray()
                    send(Protocol.createMessage(Protocol.OP_AUTH_RESULT, envelope.requestId, byteArrayOf(1) + errorMsg))
                    Log.w(TAG, "WebSocket auth failed: extensionAuth=$isExtensionAuth, standaloneAuth=$isStandaloneAuth")
                }
            }
            else -> {
                sendError(envelope.requestId, "Not authenticated")
            }
        }
    }

    private fun handlePostAuth(envelope: Protocol.Envelope, payload: ByteArray) {
        when (envelope.opcode) {
            Protocol.OP_TCP_CONNECT -> handleTcpConnect(envelope.requestId, payload)
            Protocol.OP_TCP_SEND -> handleTcpSend(payload)
            Protocol.OP_TCP_CLOSE -> handleTcpClose(payload)
            Protocol.OP_TCP_SECURE -> handleTcpSecure(envelope.requestId, payload)
            Protocol.OP_TCP_LISTEN -> handleTcpListen(envelope.requestId, payload)
            Protocol.OP_TCP_STOP_LISTEN -> handleTcpStopListen(payload)
            Protocol.OP_UDP_BIND -> handleUdpBind(envelope.requestId, payload)
            Protocol.OP_UDP_SEND -> handleUdpSend(payload)
            Protocol.OP_UDP_CLOSE -> handleUdpClose(payload)
            Protocol.OP_UDP_JOIN_MULTICAST -> handleUdpJoinMulticast(payload)
            Protocol.OP_UDP_LEAVE_MULTICAST -> handleUdpLeaveMulticast(payload)
            Protocol.OP_FILE_WRITE -> handleFileWrite(envelope.requestId, payload)
            else -> sendError(envelope.requestId, "Unknown opcode: ${envelope.opcode}")
        }
    }

    // ==========================================================================
    // TCP handlers - delegate to io-core
    // ==========================================================================

    private fun handleTcpConnect(requestId: Int, payload: ByteArray) {
        if (payload.size < 6) return

        val socketId = payload.getUIntLE(0)
        val port = payload.getUShortLE(4)
        val hostname = String(payload, 6, payload.size - 6)

        Log.d(TAG, "TCP_CONNECT: socketId=$socketId, $hostname:$port")

        // Track requestId for response
        tcpConnectRequests[socketId] = requestId

        // Track global pending connects
        DaemonStats.pendingConnects.incrementAndGet()

        // Delegate to io-core
        tcpService.connect(socketId, hostname, port)
    }

    private fun handleTcpSend(payload: ByteArray) {
        if (payload.size < 4) return

        val socketId = payload.getUIntLE(0)
        val data = payload.copyOfRange(4, payload.size)

        Log.d(TAG, "TCP_SEND: socketId=$socketId, ${data.size} bytes")

        // Track activation for global stats
        trackTcpActivation(socketId)

        // Activate and send - TcpSocketService handles pending sockets
        tcpService.activate(socketId)
        tcpService.send(socketId, data)

        // Track bytes sent
        DaemonStats.bytesSent.addAndGet(data.size.toLong())
    }

    /**
     * Track TCP socket activation for global stats.
     * When a pending socket is activated, it transitions from pendingTcp to tcpSockets.
     */
    private fun trackTcpActivation(socketId: Int) {
        if (activatedTcpSockets.add(socketId)) {
            // First activation - transition from pending to active
            if (pendingTcpSockets.remove(socketId)) {
                DaemonStats.pendingTcp.decrementAndGet()
            }
            DaemonStats.tcpSockets.incrementAndGet()
        }
    }

    private fun handleTcpClose(payload: ByteArray) {
        if (payload.size < 4) return

        val socketId = payload.getUIntLE(0)
        Log.d(TAG, "TCP_CLOSE: socketId=$socketId")

        // Clean up request tracking
        tcpConnectRequests.remove(socketId)
        tcpSecureRequests.remove(socketId)

        tcpService.close(socketId)
    }

    private fun handleTcpSecure(requestId: Int, payload: ByteArray) {
        // Payload: socketId(4) + flags(1) + hostname(utf8)
        // flags bit 0: skipValidation
        if (payload.size < 5) return

        val socketId = payload.getUIntLE(0)
        val flags = payload[4].toInt()
        val skipValidation = (flags and 1) != 0
        val hostname = String(payload, 5, payload.size - 5)

        Log.d(TAG, "TCP_SECURE: socketId=$socketId, hostname=$hostname, skipValidation=$skipValidation")

        // Track requestId for response
        tcpSecureRequests[socketId] = requestId

        tcpService.secure(socketId, hostname, skipValidation)
    }

    private fun handleTcpListen(requestId: Int, payload: ByteArray) {
        if (payload.size < 6) return

        val serverId = payload.getUIntLE(0)
        val port = payload.getUShortLE(4)

        Log.d(TAG, "TCP_LISTEN: serverId=$serverId, port=$port")

        // Track requestId for response
        tcpListenRequests[serverId] = requestId

        tcpService.listen(serverId, port)
    }

    private fun handleTcpStopListen(payload: ByteArray) {
        if (payload.size < 4) return

        val serverId = payload.getUIntLE(0)
        Log.d(TAG, "TCP_STOP_LISTEN: serverId=$serverId")

        // Update global stats: TCP server stopped
        if (activeServerIds.remove(serverId)) {
            DaemonStats.tcpServers.decrementAndGet()
        }

        tcpListenRequests.remove(serverId)
        tcpService.stopListen(serverId)
    }

    // ==========================================================================
    // UDP handlers - delegate to io-core
    // ==========================================================================

    private fun handleUdpBind(requestId: Int, payload: ByteArray) {
        if (payload.size < 6) return

        val socketId = payload.getUIntLE(0)
        val port = payload.getUShortLE(4)

        Log.d(TAG, "UDP_BIND: socketId=$socketId, port=$port")

        // Track requestId for response
        udpBindRequests[socketId] = requestId

        udpManager.bind(socketId, port)
    }

    private fun handleUdpSend(payload: ByteArray) {
        if (payload.size < 8) return

        val socketId = payload.getUIntLE(0)
        val destPort = payload.getUShortLE(4)
        val addrLen = payload.getUShortLE(6)

        if (payload.size < 8 + addrLen) return

        val destAddr = String(payload, 8, addrLen)
        val data = payload.copyOfRange(8 + addrLen, payload.size)

        // Track bytes sent
        DaemonStats.bytesSent.addAndGet(data.size.toLong())

        udpManager.send(socketId, destAddr, destPort, data)
    }

    private fun handleUdpClose(payload: ByteArray) {
        if (payload.size < 4) return

        val socketId = payload.getUIntLE(0)
        udpBindRequests.remove(socketId)
        udpManager.close(socketId)
    }

    private fun handleUdpJoinMulticast(payload: ByteArray) {
        if (payload.size < 4) return

        val socketId = payload.getUIntLE(0)
        val groupAddr = String(payload, 4, payload.size - 4)

        Log.d(TAG, "UDP_JOIN_MULTICAST: socketId=$socketId, group=$groupAddr")
        udpManager.joinMulticast(socketId, groupAddr)
    }

    private fun handleUdpLeaveMulticast(payload: ByteArray) {
        if (payload.size < 4) return

        val socketId = payload.getUIntLE(0)
        val groupAddr = String(payload, 4, payload.size - 4)

        Log.d(TAG, "UDP_LEAVE_MULTICAST: socketId=$socketId, group=$groupAddr")
        udpManager.leaveMulticast(socketId, groupAddr)
    }

    // ==========================================================================
    // File I/O handlers
    // ==========================================================================

    // Write instrumentation
    private val wsWriteConcurrent = AtomicInteger(0)
    private val wsWriteTotal = AtomicLong(0)
    private val wsWriteBytes = AtomicLong(0)
    private val wsWriteTotalTimeMs = AtomicLong(0)
    private val wsWriteHashTimeMs = AtomicLong(0)
    private val wsWriteDiskTimeMs = AtomicLong(0)
    private val wsWriteQueueTimeMs = AtomicLong(0)
    private val wsWriteMaxConcurrent = AtomicInteger(0)
    @Volatile private var wsWriteLogTime = System.currentTimeMillis()

    // Track frame arrival timing
    private val writeFramesInFlight = AtomicInteger(0)
    private val writeFrameMaxInFlight = AtomicInteger(0)
    @Volatile private var lastWriteFrameArrival = 0L

    /**
     * Handle file write via WebSocket.
     * Payload format: [root_key_len:1][root_key:N][path_len:2 LE][path:M][offset:8 LE][flags:1][optional sha1:20][data:K]
     *
     * root_key: String key (hex, e.g., "a1b2c3d4e5f6a7b8") matching HTTP API
     * flags bit 0: hash verification enabled (if set, next 20 bytes are expected SHA1 hash)
     *
     * If requestId is 0, operates in fire-and-forget mode (no ACK on success).
     * Errors are always reported via OP_FILE_WRITE_ERROR.
     */
    private fun handleFileWrite(requestId: Int, payload: ByteArray) {
        // Minimum size: root_key_len(1) + path_len(2) + offset(8) + flags(1) = 12 bytes + variable
        if (payload.size < 12) {
            Log.w(TAG, "FILE_WRITE: payload too short: ${payload.size}")
            sendFileWriteError(requestId, "", 0L, "Payload too short")
            return
        }

        var idx = 0
        val rootKeyLen = payload[idx].toInt() and 0xFF
        idx += 1

        if (payload.size < idx + rootKeyLen + 2 + 8 + 1) {
            Log.w(TAG, "FILE_WRITE: payload too short for root key: ${payload.size}, rootKeyLen=$rootKeyLen")
            sendFileWriteError(requestId, "", 0L, "Invalid root key length")
            return
        }

        val rootKey = String(payload, idx, rootKeyLen)
        idx += rootKeyLen

        val pathLen = payload.getUShortLE(idx)
        idx += 2

        if (payload.size < idx + pathLen + 8 + 1) {
            Log.w(TAG, "FILE_WRITE: payload too short for path: ${payload.size}, pathLen=$pathLen")
            sendFileWriteError(requestId, rootKey, 0L, "Invalid path length")
            return
        }

        val path = String(payload, idx, pathLen)
        idx += pathLen

        val offset = payload.getLongLE(idx)
        idx += 8

        val flags = payload[idx].toInt() and 0xFF
        idx += 1

        val hasHash = (flags and 1) != 0
        var expectedHash: ByteArray? = null

        if (hasHash) {
            if (payload.size < idx + 20) {
                Log.w(TAG, "FILE_WRITE: payload too short for hash: ${payload.size}")
                sendFileWriteError(requestId, rootKey, offset, "Hash expected but not provided")
                return
            }
            expectedHash = payload.copyOfRange(idx, idx + 20)
            idx += 20
        }

        val data = payload.copyOfRange(idx, payload.size)
        val tEnqueue = System.currentTimeMillis()

        // Track frame arrival timing
        val inFlight = writeFramesInFlight.incrementAndGet()
        var currentMax = writeFrameMaxInFlight.get()
        while (inFlight > currentMax && !writeFrameMaxInFlight.compareAndSet(currentMax, inFlight)) {
            currentMax = writeFrameMaxInFlight.get()
        }
        val sinceLastFrame = if (lastWriteFrameArrival > 0) tEnqueue - lastWriteFrameArrival else 0
        lastWriteFrameArrival = tEnqueue

        // Log.d(TAG, "FILE_WRITE: rootKey=$rootKey, path=$path, offset=$offset, size=${data.size}, hasHash=$hasHash, inFlight=$inFlight, sinceLastFrame=${sinceLastFrame}ms")

        // Resolve root key to SAF URI
        val rootUri = deps.rootStore.resolveKey(rootKey)
        if (rootUri == null) {
            Log.w(TAG, "FILE_WRITE: Invalid root key: $rootKey")
            sendFileWriteError(requestId, rootKey, offset, "Invalid root key")
            return
        }

        // Validate path (prevent directory traversal)
        if (path.contains("..")) {
            Log.w(TAG, "FILE_WRITE: Invalid path with ..: $path")
            sendFileWriteError(requestId, rootKey, offset, "Invalid path")
            return
        }

        // Perform write on IO dispatcher
        scope.launch(Dispatchers.IO) {
            val tStart = System.currentTimeMillis()
            val queueTime = tStart - tEnqueue
            val concurrent = wsWriteConcurrent.incrementAndGet()

            // Track max concurrent
            var currentMax = wsWriteMaxConcurrent.get()
            while (concurrent > currentMax && !wsWriteMaxConcurrent.compareAndSet(currentMax, concurrent)) {
                currentMax = wsWriteMaxConcurrent.get()
            }

            try {
                var hashTime = 0L

                // Hash verification FIRST (before any file operations)
                if (expectedHash != null) {
                    val tHash = System.currentTimeMillis()
                    val actualHash = Hasher.sha1(data)
                    hashTime = System.currentTimeMillis() - tHash

                    if (!actualHash.contentEquals(expectedHash)) {
                        val expectedHex = expectedHash.joinToString("") { "%02x".format(it) }
                        val actualHex = actualHash.joinToString("") { "%02x".format(it) }
                        Log.w(TAG, "FILE_WRITE hash mismatch: expected=$expectedHex, actual=$actualHex")
                        sendFileWriteError(requestId, rootKey, offset, "Hash mismatch: expected $expectedHex, got $actualHex")
                        wsWriteConcurrent.decrementAndGet()
                        writeFramesInFlight.decrementAndGet()
                        return@launch
                    }
                }

                val tDisk = System.currentTimeMillis()
                fileManager.write(rootUri, path, offset, data)
                val diskTime = System.currentTimeMillis() - tDisk
                val totalTime = System.currentTimeMillis() - tStart

                // Only send ACK if requestId is non-zero
                if (requestId != 0) {
                    sendFileWriteAck(requestId, rootKey, offset)
                }

                // Track frame completion
                writeFramesInFlight.decrementAndGet()

                // Update stats
                val writeNum = wsWriteTotal.incrementAndGet()
                wsWriteBytes.addAndGet(data.size.toLong())
                wsWriteTotalTimeMs.addAndGet(totalTime)
                wsWriteHashTimeMs.addAndGet(hashTime)
                wsWriteDiskTimeMs.addAndGet(diskTime)
                wsWriteQueueTimeMs.addAndGet(queueTime)
                wsWriteConcurrent.decrementAndGet()

                // Log every 5 seconds
                val now = System.currentTimeMillis()
                val elapsed = now - wsWriteLogTime
                if (elapsed >= 5000 && writeNum > 0) {
                    val bytes = wsWriteBytes.getAndSet(0)
                    val count = wsWriteTotal.getAndSet(0)
                    val totalMs = wsWriteTotalTimeMs.getAndSet(0)
                    val hashMs = wsWriteHashTimeMs.getAndSet(0)
                    val diskMs = wsWriteDiskTimeMs.getAndSet(0)
                    val queueMs = wsWriteQueueTimeMs.getAndSet(0)
                    val maxConc = wsWriteMaxConcurrent.getAndSet(concurrent)
                    wsWriteLogTime = now

                    val mbps = bytes / (elapsed / 1000.0) / (1024 * 1024)
                    val avgTotal = if (count > 0) totalMs / count else 0
                    val avgHash = if (count > 0) hashMs / count else 0
                    val avgDisk = if (count > 0) diskMs / count else 0
                    val avgQueue = if (count > 0) queueMs / count else 0

                    val curFrameInFlight = writeFramesInFlight.get()
                    val maxFrameInFlight = writeFrameMaxInFlight.getAndSet(curFrameInFlight)
                    Log.i(TAG, "WS_WRITE: %.1f MB/s, %d writes, concurrent=%d (max=%d), framesInFlight=%d (max=%d), avg: total=%dms queue=%dms hash=%dms disk=%dms".format(
                        mbps, count, concurrent, maxConc, curFrameInFlight, maxFrameInFlight, avgTotal, avgQueue, avgHash, avgDisk))
                }
            } catch (e: FileManagerException) {
                wsWriteConcurrent.decrementAndGet()
                writeFramesInFlight.decrementAndGet()
                val errorMsg = when (e) {
                    is FileManagerException.FileNotFound -> "File not found: ${e.message}"
                    is FileManagerException.CannotCreateFile -> "Cannot create file: ${e.message}"
                    is FileManagerException.CannotOpenFile -> "Cannot open file: ${e.message}"
                    is FileManagerException.WriteError -> "Write error: ${e.message}"
                    is FileManagerException.DiskFull -> "Disk full: ${e.message}"
                    else -> "Error: ${e.message}"
                }
                Log.e(TAG, "FILE_WRITE failed: $errorMsg")
                sendFileWriteError(requestId, rootKey, offset, errorMsg)
            } catch (e: Exception) {
                wsWriteConcurrent.decrementAndGet()
                writeFramesInFlight.decrementAndGet()
                Log.e(TAG, "FILE_WRITE unexpected error: ${e.message}", e)
                sendFileWriteError(requestId, rootKey, offset, "Unexpected error: ${e.message}")
            }
        }
    }

    private fun sendFileWriteAck(requestId: Int, rootKey: String, offset: Long) {
        // Payload: [root_key_len:1][root_key:N][offset:8 LE][status:1]
        val rootKeyBytes = rootKey.toByteArray()
        val payload = ByteArray(1 + rootKeyBytes.size + 8 + 1)
        var idx = 0

        // root_key_len
        payload[idx++] = rootKeyBytes.size.toByte()
        // root_key
        System.arraycopy(rootKeyBytes, 0, payload, idx, rootKeyBytes.size)
        idx += rootKeyBytes.size
        // offset (little-endian)
        payload[idx++] = (offset and 0xFF).toByte()
        payload[idx++] = ((offset shr 8) and 0xFF).toByte()
        payload[idx++] = ((offset shr 16) and 0xFF).toByte()
        payload[idx++] = ((offset shr 24) and 0xFF).toByte()
        payload[idx++] = ((offset shr 32) and 0xFF).toByte()
        payload[idx++] = ((offset shr 40) and 0xFF).toByte()
        payload[idx++] = ((offset shr 48) and 0xFF).toByte()
        payload[idx++] = ((offset shr 56) and 0xFF).toByte()
        // status: 0 = success
        payload[idx] = 0

        send(Protocol.createMessage(Protocol.OP_FILE_WRITE_ACK, requestId, payload))
    }

    private fun sendFileWriteError(requestId: Int, rootKey: String, offset: Long, message: String) {
        // Payload: [root_key_len:1][root_key:N][offset:8 LE][error_code:4 LE][message:M]
        val rootKeyBytes = rootKey.toByteArray()
        val msgBytes = message.toByteArray()
        val payload = ByteArray(1 + rootKeyBytes.size + 8 + 4 + msgBytes.size)
        var idx = 0

        // root_key_len
        payload[idx++] = rootKeyBytes.size.toByte()
        // root_key
        System.arraycopy(rootKeyBytes, 0, payload, idx, rootKeyBytes.size)
        idx += rootKeyBytes.size
        // offset (little-endian)
        payload[idx++] = (offset and 0xFF).toByte()
        payload[idx++] = ((offset shr 8) and 0xFF).toByte()
        payload[idx++] = ((offset shr 16) and 0xFF).toByte()
        payload[idx++] = ((offset shr 24) and 0xFF).toByte()
        payload[idx++] = ((offset shr 32) and 0xFF).toByte()
        payload[idx++] = ((offset shr 40) and 0xFF).toByte()
        payload[idx++] = ((offset shr 48) and 0xFF).toByte()
        payload[idx++] = ((offset shr 56) and 0xFF).toByte()
        // error_code (1 = generic error, little-endian)
        payload[idx++] = 1
        payload[idx++] = 0
        payload[idx++] = 0
        payload[idx++] = 0
        // message
        System.arraycopy(msgBytes, 0, payload, idx, msgBytes.size)

        send(Protocol.createMessage(Protocol.OP_FILE_WRITE_ERROR, requestId, payload))
    }

    // ==========================================================================
    // TcpSocketCallback implementation - translate io-core events to WS frames
    // ==========================================================================

    override fun onTcpConnected(socketId: Int, success: Boolean, errorCode: Int) {
        val requestId = tcpConnectRequests.remove(socketId) ?: 0
        Log.i(TAG, "TCP_CONNECTED: socketId=$socketId, success=$success, errorCode=$errorCode")

        // Update global stats: pending connect finished
        DaemonStats.pendingConnects.decrementAndGet()
        if (success) {
            // Socket is connected but not yet activated (pending TCP)
            pendingTcpSockets.add(socketId)
            DaemonStats.pendingTcp.incrementAndGet()
        }

        val response = socketId.toLEBytes() +
            byteArrayOf(if (success) 0 else 1) +
            errorCode.toLEBytes()
        send(Protocol.createMessage(Protocol.OP_TCP_CONNECTED, requestId, response))

        // Don't auto-activate here - leave socket in pending state.
        // This allows TLS upgrade via TCP_SECURE before activation.
        // Socket will be activated on first send() or explicit activate().
    }

    override fun onTcpData(socketId: Int, data: ByteArray) {
        // Legacy path - allocate frame and copy (used by TLS connections)
        val t0 = System.nanoTime()

        // Track bytes received (global and session TCP metrics)
        DaemonStats.bytesReceived.addAndGet(data.size.toLong())
        tcpRecvBytes.addAndGet(data.size.toLong())
        tcpRecvFrames.incrementAndGet()

        // Build TCP_RECV frame with minimal allocations
        // Frame structure: [header:8][socketId:4][data:N]
        val frameSize = 8 + 4 + data.size
        val frame = ByteArray(frameSize)

        // Write header directly
        frame[0] = Protocol.VERSION
        frame[1] = Protocol.OP_TCP_RECV
        // flags = 0 (bytes 2-3 already zero)
        // requestId = 0 (bytes 4-7 already zero)

        // Write socketId (little-endian)
        frame[8] = (socketId and 0xFF).toByte()
        frame[9] = ((socketId shr 8) and 0xFF).toByte()
        frame[10] = ((socketId shr 16) and 0xFF).toByte()
        frame[11] = ((socketId shr 24) and 0xFF).toByte()

        // Copy data
        System.arraycopy(data, 0, frame, 12, data.size)

        tcpFrameBuildTimeNs.addAndGet(System.nanoTime() - t0)

        send(frame)
    }

    /**
     * Zero-copy optimized path - frame already has header space allocated.
     * Just fill in the 12-byte header and send directly.
     */
    override fun onTcpDataFramed(socketId: Int, frame: ByteArray, dataOffset: Int, dataLen: Int) {
        val t0 = System.nanoTime()

        // Track bytes received (global and session TCP metrics)
        DaemonStats.bytesReceived.addAndGet(dataLen.toLong())
        tcpRecvBytes.addAndGet(dataLen.toLong())
        tcpRecvFrames.incrementAndGet()

        // Fill in header - frame already has data at correct offset
        // Frame structure: [header:8][socketId:4][data:N]
        frame[0] = Protocol.VERSION
        frame[1] = Protocol.OP_TCP_RECV
        // flags = 0 (bytes 2-3 already zero from ByteArray init)
        // requestId = 0 (bytes 4-7 already zero)

        // Write socketId (little-endian)
        frame[8] = (socketId and 0xFF).toByte()
        frame[9] = ((socketId shr 8) and 0xFF).toByte()
        frame[10] = ((socketId shr 16) and 0xFF).toByte()
        frame[11] = ((socketId shr 24) and 0xFF).toByte()

        tcpFrameBuildTimeNs.addAndGet(System.nanoTime() - t0)

        // Send directly - no copy needed!
        send(frame)
    }

    override fun onTcpClose(socketId: Int, hadError: Boolean, errorCode: Int) {
        Log.d(TAG, "TCP_CLOSE: socketId=$socketId, hadError=$hadError, errorCode=$errorCode")

        // Update global stats: socket closed
        if (activatedTcpSockets.remove(socketId)) {
            DaemonStats.tcpSockets.decrementAndGet()
        } else if (pendingTcpSockets.remove(socketId)) {
            DaemonStats.pendingTcp.decrementAndGet()
        }

        val payload = socketId.toLEBytes() +
            byteArrayOf(if (hadError) 1 else 0) +
            errorCode.toLEBytes()
        send(Protocol.createMessage(Protocol.OP_TCP_CLOSE, 0, payload))
    }

    override fun onTcpSecured(socketId: Int, success: Boolean) {
        val requestId = tcpSecureRequests.remove(socketId) ?: 0
        Log.i(TAG, "TCP_SECURED: socketId=$socketId, success=$success")

        val response = socketId.toLEBytes() + byteArrayOf(if (success) 0 else 1)
        send(Protocol.createMessage(Protocol.OP_TCP_SECURED, requestId, response))

        // Auto-activate on success
        if (success) {
            trackTcpActivation(socketId)
            tcpService.activate(socketId)
        }
    }

    // ==========================================================================
    // TcpServerCallback implementation
    // ==========================================================================

    override fun onTcpListenResult(serverId: Int, success: Boolean, boundPort: Int, errorCode: Int) {
        val requestId = tcpListenRequests.remove(serverId) ?: 0
        Log.i(TAG, "TCP_LISTEN_RESULT: serverId=$serverId, success=$success, boundPort=$boundPort")

        // Update global stats: TCP server listening
        if (success && activeServerIds.add(serverId)) {
            DaemonStats.tcpServers.incrementAndGet()
        }

        val response = serverId.toLEBytes() +
            byteArrayOf(if (success) 0 else 1) +
            boundPort.toShort().toLEBytes() +
            errorCode.toLEBytes()
        send(Protocol.createMessage(Protocol.OP_TCP_LISTEN_RESULT, requestId, response))
    }

    override fun onTcpAccepted(serverId: Int, socketId: Int, peerAddr: String, peerPort: Int) {
        Log.d(TAG, "TCP_ACCEPT: serverId=$serverId, socketId=$socketId, peer=$peerAddr:$peerPort")

        val addrBytes = peerAddr.toByteArray()
        val payload = serverId.toLEBytes() +
            socketId.toLEBytes() +
            peerPort.toShort().toLEBytes() +
            addrBytes
        send(Protocol.createMessage(Protocol.OP_TCP_ACCEPT, 0, payload))
    }

    // ==========================================================================
    // UdpSocketCallback implementation
    // ==========================================================================

    override fun onUdpBound(socketId: Int, success: Boolean, boundPort: Int, errorCode: Int) {
        val requestId = udpBindRequests.remove(socketId) ?: 0
        Log.i(TAG, "UDP_BOUND: socketId=$socketId, success=$success, boundPort=$boundPort")

        // Update global stats: UDP socket bound
        if (success && activeUdpSockets.add(socketId)) {
            DaemonStats.udpSockets.incrementAndGet()
        }

        val response = socketId.toLEBytes() +
            byteArrayOf(if (success) 0 else 1) +
            boundPort.toShort().toLEBytes() +
            errorCode.toLEBytes()
        send(Protocol.createMessage(Protocol.OP_UDP_BOUND, requestId, response))
    }

    override fun onUdpMessage(socketId: Int, srcAddr: String, srcPort: Int, data: ByteArray) {
        Log.d(TAG, "UDP_RECV: socketId=$socketId, from=$srcAddr:$srcPort, ${data.size} bytes")

        // Track bytes received
        DaemonStats.bytesReceived.addAndGet(data.size.toLong())

        val addrBytes = srcAddr.toByteArray()
        val payloadSize = 4 + 2 + 2 + addrBytes.size + data.size
        val payload = ByteArray(payloadSize)
        var offset = 0

        // socketId (4 bytes, little-endian)
        payload[offset++] = (socketId and 0xFF).toByte()
        payload[offset++] = ((socketId shr 8) and 0xFF).toByte()
        payload[offset++] = ((socketId shr 16) and 0xFF).toByte()
        payload[offset++] = ((socketId shr 24) and 0xFF).toByte()

        // srcPort (2 bytes, little-endian)
        payload[offset++] = (srcPort and 0xFF).toByte()
        payload[offset++] = ((srcPort shr 8) and 0xFF).toByte()

        // addrLen (2 bytes, little-endian)
        payload[offset++] = (addrBytes.size and 0xFF).toByte()
        payload[offset++] = ((addrBytes.size shr 8) and 0xFF).toByte()

        // addr + data
        System.arraycopy(addrBytes, 0, payload, offset, addrBytes.size)
        offset += addrBytes.size
        System.arraycopy(data, 0, payload, offset, data.size)

        send(Protocol.createMessage(Protocol.OP_UDP_RECV, 0, payload))
    }

    override fun onUdpClose(socketId: Int, hadError: Boolean, errorCode: Int) {
        Log.d(TAG, "UDP_CLOSE: socketId=$socketId, hadError=$hadError, errorCode=$errorCode")

        // Update global stats: UDP socket closed
        if (activeUdpSockets.remove(socketId)) {
            DaemonStats.udpSockets.decrementAndGet()
        }

        val payload = socketId.toLEBytes() +
            byteArrayOf(if (hadError) 1 else 0) +
            errorCode.toLEBytes()
        send(Protocol.createMessage(Protocol.OP_UDP_CLOSE, 0, payload))
    }

    // ==========================================================================
    // Send helpers
    // ==========================================================================

    internal fun send(data: ByteArray) {
        framesSent.incrementAndGet()
        bytesSent.addAndGet(data.size.toLong())

        if (data.size >= 8 && ENABLE_SEND_LOGGING) {
            val envelope = Protocol.Envelope.fromBytes(data)
            if (envelope != null) {
                Log.d(TAG, "SEND: opcode=0x${envelope.opcode.toString(16)}, reqId=${envelope.requestId}, " +
                    "payloadSize=${data.size - 8}")
            }
        }

        // Use trySend for non-blocking send
        val result = outgoing.trySend(data)
        if (result.isSuccess) {
            val depth = queueDepth.incrementAndGet()
            // Track max queue depth
            var currentMax = maxQueueDepth.get()
            while (depth > currentMax && !maxQueueDepth.compareAndSet(currentMax, depth)) {
                currentMax = maxQueueDepth.get()
            }
            // Log when queue is building up
            if (depth > 100 && depth % 100 == 0) {
                val opcode = if (data.size >= 2) data[1].toInt() and 0xFF else -1
                Log.w(TAG, "Queue building: depth=$depth, opcode=0x${opcode.toString(16)}")
            }
        } else {
            if (dropCount.incrementAndGet() % 100 == 1L) {
                Log.w(TAG, "Outgoing buffer full, dropped ${dropCount.get()} messages total")
            }
        }
    }

    /**
     * Send a control frame. Only works if authenticated.
     */
    fun sendControl(frame: ByteArray) {
        if (authenticated) {
            send(frame)
        }
    }

    private fun sendError(requestId: Int, message: String) {
        send(Protocol.createError(requestId, message))
    }

    // ==========================================================================
    // Cleanup
    // ==========================================================================

    private fun cleanup() {
        // Update global stats
        DaemonStats.wsConnections.decrementAndGet()

        // Log session statistics
        val duration = (System.currentTimeMillis() - connectTime) / 1000.0
        val recvMB = bytesReceived.get() / 1024.0 / 1024.0
        val sentMB = bytesSent.get() / 1024.0 / 1024.0
        Log.i(TAG, "Session closed after ${String.format("%.1f", duration)}s: " +
            "recv=${String.format("%.1f", recvMB)}MB/${framesReceived.get()} frames, " +
            "sent=${String.format("%.1f", sentMB)}MB/${framesSent.get()} frames, " +
            "dropped=${dropCount.get()}")

        // Clean up request tracking
        tcpConnectRequests.clear()
        tcpSecureRequests.clear()
        tcpListenRequests.clear()
        udpBindRequests.clear()

        // Clean up global stats for any sockets not properly closed
        val pendingConnects = tcpConnectRequests.size
        if (pendingConnects > 0) {
            DaemonStats.pendingConnects.addAndGet(-pendingConnects)
        }
        val pendingTcpCount = pendingTcpSockets.size
        if (pendingTcpCount > 0) {
            DaemonStats.pendingTcp.addAndGet(-pendingTcpCount)
        }
        val activeTcpCount = activatedTcpSockets.size
        if (activeTcpCount > 0) {
            DaemonStats.tcpSockets.addAndGet(-activeTcpCount)
        }
        val activeServerCount = activeServerIds.size
        if (activeServerCount > 0) {
            DaemonStats.tcpServers.addAndGet(-activeServerCount)
        }
        val activeUdpCount = activeUdpSockets.size
        if (activeUdpCount > 0) {
            DaemonStats.udpSockets.addAndGet(-activeUdpCount)
        }

        // Clear session tracking sets
        pendingTcpSockets.clear()
        activatedTcpSockets.clear()
        activeServerIds.clear()
        activeUdpSockets.clear()

        // Shutdown io-core managers
        tcpService.shutdown()
        udpManager.shutdown()

        scope.cancel()
        outgoing.close()
    }
}
