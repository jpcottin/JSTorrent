package com.jstorrent.app.benchmark

import io.ktor.server.application.*
import io.ktor.server.engine.*
import io.ktor.server.netty.*
import io.ktor.server.routing.*
import io.ktor.server.websocket.*
import io.ktor.websocket.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.channels.ClosedReceiveChannelException
import kotlinx.coroutines.launch
import java.io.Closeable
import java.net.ServerSocket
import java.net.Socket
import java.time.Duration
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * Ktor-based benchmark server for comparing WebSocket performance.
 *
 * This is a JVM-compatible minimal implementation that mirrors the production
 * CompanionHttpServer's WebSocket handling without Android dependencies.
 * Used to isolate and measure Ktor WebSocket overhead.
 *
 * Flow:
 * Mock Seeder (TCP) → Ktor Server (TCP read) → WebSocket TCP_RECV frames → Test Client
 */
class KtorBenchmarkServer(
    private val port: Int = 0,
    private val authToken: String = "test-token",
    private val tcpReadBufferSize: Int = 64 * 1024
) : Closeable {

    private var server: NettyApplicationEngine? = null
    private var actualPort: Int = 0

    val totalBytesRelayed = AtomicLong(0)
    val totalFramesSent = AtomicLong(0)
    val tcpSockets = ConcurrentHashMap<Int, Socket>()
    private val tcpReaders = ConcurrentHashMap<Int, Thread>()

    val uri: String get() = "ws://localhost:$actualPort/io"

    fun start() {
        // Find available port if port=0
        val bindPort = if (port == 0) {
            ServerSocket(0).use { it.localPort }
        } else {
            port
        }

        server = embeddedServer(Netty, port = bindPort) {
            install(WebSockets) {
                pingPeriod = Duration.ofSeconds(30)
                timeout = Duration.ofSeconds(60)
                maxFrameSize = Long.MAX_VALUE
                masking = false
            }
            configureRouting()
        }.start(wait = false)

        actualPort = bindPort
        println("[KtorBenchmarkServer] Started on port $actualPort")
    }

    fun stop() {
        // Close all TCP connections
        tcpReaders.values.forEach { it.interrupt() }
        tcpSockets.values.forEach { runCatching { it.close() } }
        tcpSockets.clear()
        tcpReaders.clear()

        server?.stop(1000, 2000)
        server = null
        println("[KtorBenchmarkServer] Stopped")
    }

    override fun close() = stop()

    private fun Application.configureRouting() {
        routing {
            webSocket("/io") {
                IoSessionHandler(this@KtorBenchmarkServer, this).run()
            }
        }
    }

    /**
     * Handler for a single WebSocket session - mirrors IoWebSocketHandler behavior.
     */
    private class IoSessionHandler(
        private val server: KtorBenchmarkServer,
        private val ws: DefaultWebSocketServerSession
    ) {
        private var authenticated = false
        private val outgoing = Channel<ByteArray>(2000) // Large buffer like production
        private val queueDepth = AtomicInteger(0)

        suspend fun run() {
            // Start sender coroutine
            val senderJob = ws.launch {
                try {
                    for (data in outgoing) {
                        queueDepth.decrementAndGet()
                        ws.send(Frame.Binary(true, data))
                        server.totalFramesSent.incrementAndGet()
                    }
                } catch (e: kotlinx.coroutines.CancellationException) {
                    // Normal shutdown, ignore
                } catch (e: Exception) {
                    println("[KtorBenchmarkServer] Sender error: ${e.message}")
                }
            }

            try {
                for (frame in ws.incoming) {
                    if (frame is Frame.Binary) {
                        handleMessage(frame.readBytes())
                    }
                }
            } catch (e: ClosedReceiveChannelException) {
                // Normal close
            } catch (e: Exception) {
                println("[KtorBenchmarkServer] Handler error: ${e.message}")
            } finally {
                senderJob.cancel()
                outgoing.close()
            }
        }

        private suspend fun handleMessage(data: ByteArray) {
            if (data.size < 8) return

            val envelope = Protocol.Envelope.fromBytes(data) ?: return
            val payload = data.copyOfRange(8, data.size)

            if (!authenticated) {
                handlePreAuth(envelope, payload)
            } else {
                handlePostAuth(envelope, payload)
            }
        }

        private fun handlePreAuth(envelope: Protocol.Envelope, payload: ByteArray) {
            when (envelope.opcode) {
                Protocol.CLIENT_HELLO -> {
                    send(Protocol.createFrame(Protocol.SERVER_HELLO, envelope.requestId))
                }
                Protocol.AUTH -> {
                    // Simple auth: just check token
                    if (payload.isNotEmpty()) {
                        val authType = payload[0]
                        val token = String(payload, 1, payload.size - 1).substringBefore('\u0000')

                        if (token == server.authToken) {
                            authenticated = true
                            send(Protocol.createFrame(Protocol.AUTH_RESULT, envelope.requestId, byteArrayOf(0)))
                        } else {
                            send(Protocol.createFrame(Protocol.AUTH_RESULT, envelope.requestId, byteArrayOf(1)))
                        }
                    }
                }
            }
        }

        private fun handlePostAuth(envelope: Protocol.Envelope, payload: ByteArray) {
            when (envelope.opcode) {
                Protocol.TCP_CONNECT -> handleTcpConnect(envelope.requestId, payload)
                Protocol.TCP_SEND -> handleTcpSend(payload)
                Protocol.TCP_CLOSE -> handleTcpClose(payload)
            }
        }

        private fun handleTcpConnect(requestId: Int, payload: ByteArray) {
            if (payload.size < 6) return

            val socketId = Protocol.getUIntLE(payload, 0)
            val port = Protocol.getUShortLE(payload, 4)
            val hostname = String(payload, 6, payload.size - 6)

            try {
                val socket = Socket(hostname, port)
                socket.tcpNoDelay = true
                socket.receiveBufferSize = server.tcpReadBufferSize
                server.tcpSockets[socketId] = socket

                // Send connected response
                val response = intToLE(socketId) + byteArrayOf(0) + intToLE(0)
                send(Protocol.createFrame(Protocol.TCP_CONNECTED, requestId, response))

                // Start reader thread
                val reader = thread(name = "TcpReader-$socketId", isDaemon = true) {
                    readFromSocket(socketId, socket)
                }
                server.tcpReaders[socketId] = reader

            } catch (e: Exception) {
                val response = intToLE(socketId) + byteArrayOf(1) + intToLE(-1)
                send(Protocol.createFrame(Protocol.TCP_CONNECTED, requestId, response))
            }
        }

        private fun handleTcpSend(payload: ByteArray) {
            if (payload.size < 4) return
            val socketId = Protocol.getUIntLE(payload, 0)
            val data = payload.copyOfRange(4, payload.size)

            val socket = server.tcpSockets[socketId] ?: return
            try {
                socket.getOutputStream().write(data)
            } catch (e: Exception) {
                // Ignore send errors
            }
        }

        private fun handleTcpClose(payload: ByteArray) {
            if (payload.size < 4) return
            val socketId = Protocol.getUIntLE(payload, 0)

            server.tcpReaders.remove(socketId)?.interrupt()
            server.tcpSockets.remove(socketId)?.close()
        }

        private fun readFromSocket(socketId: Int, socket: Socket) {
            // Use zero-copy framed path like production IoWebSocketHandler
            val HEADER_SIZE = 12 // 8 byte WS header + 4 byte socketId
            val bufferSize = server.tcpReadBufferSize

            try {
                val input = socket.getInputStream()

                while (!Thread.currentThread().isInterrupted && !socket.isClosed) {
                    // Allocate frame with header space pre-reserved
                    val frame = ByteArray(HEADER_SIZE + bufferSize)
                    val bytesRead = input.read(frame, HEADER_SIZE, bufferSize)

                    if (bytesRead <= 0) break

                    // Fill in header
                    frame[0] = Protocol.VERSION
                    frame[1] = Protocol.TCP_RECV.toByte()
                    // flags = 0, requestId = 0 (already zero)

                    // Write socketId (little-endian)
                    frame[8] = (socketId and 0xFF).toByte()
                    frame[9] = ((socketId shr 8) and 0xFF).toByte()
                    frame[10] = ((socketId shr 16) and 0xFF).toByte()
                    frame[11] = ((socketId shr 24) and 0xFF).toByte()

                    // Trim to actual size and send
                    val actualFrame = frame.copyOf(HEADER_SIZE + bytesRead)
                    send(actualFrame)
                    server.totalBytesRelayed.addAndGet(bytesRead.toLong())
                }
            } catch (e: Exception) {
                // Socket closed or interrupted
            } finally {
                // Send TCP_CLOSE
                val closePayload = intToLE(socketId) + byteArrayOf(0) + intToLE(0)
                send(Protocol.createFrame(Protocol.TCP_CLOSE, 0, closePayload))

                server.tcpSockets.remove(socketId)
                server.tcpReaders.remove(socketId)
            }
        }

        private fun send(data: ByteArray) {
            val result = outgoing.trySend(data)
            if (result.isSuccess) {
                queueDepth.incrementAndGet()
            }
        }

        private fun intToLE(value: Int): ByteArray {
            return byteArrayOf(
                (value and 0xFF).toByte(),
                ((value shr 8) and 0xFF).toByte(),
                ((value shr 16) and 0xFF).toByte(),
                ((value shr 24) and 0xFF).toByte()
            )
        }
    }
}
