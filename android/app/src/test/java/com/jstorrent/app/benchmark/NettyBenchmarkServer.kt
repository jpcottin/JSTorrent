package com.jstorrent.app.benchmark

import io.netty.bootstrap.ServerBootstrap
import io.netty.buffer.ByteBuf
import io.netty.buffer.Unpooled
import io.netty.channel.*
import io.netty.channel.nio.NioEventLoopGroup
import io.netty.channel.socket.SocketChannel
import io.netty.channel.socket.nio.NioServerSocketChannel
import io.netty.handler.codec.http.*
import io.netty.handler.codec.http.websocketx.*
import java.io.Closeable
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlin.concurrent.thread

/**
 * Raw Netty WebSocket benchmark server for comparing WebSocket performance.
 *
 * This is a JVM-compatible minimal implementation that bypasses Ktor entirely
 * to measure raw Netty WebSocket performance.
 *
 * Flow:
 * Mock Seeder (TCP) → Netty Server (TCP read) → WebSocket TCP_RECV frames → Test Client
 */
class NettyBenchmarkServer(
    private val port: Int = 0,
    private val authToken: String = "test-token",
    private val tcpReadBufferSize: Int = 64 * 1024
) : Closeable {

    private var bossGroup: EventLoopGroup? = null
    private var workerGroup: EventLoopGroup? = null
    private var channel: Channel? = null
    private var actualPort: Int = 0

    val totalBytesRelayed = AtomicLong(0)
    val totalFramesSent = AtomicLong(0)

    val uri: String get() = "ws://localhost:$actualPort/io"

    fun start() {
        // Find available port if port=0
        val bindPort = if (port == 0) {
            ServerSocket(0).use { it.localPort }
        } else {
            port
        }

        bossGroup = NioEventLoopGroup(1)
        workerGroup = NioEventLoopGroup()

        val bootstrap = ServerBootstrap()
            .group(bossGroup, workerGroup)
            .channel(NioServerSocketChannel::class.java)
            .childHandler(object : ChannelInitializer<SocketChannel>() {
                override fun initChannel(ch: SocketChannel) {
                    ch.pipeline()
                        .addLast("httpCodec", HttpServerCodec())
                        .addLast("httpAggregator", HttpObjectAggregator(65536))
                        .addLast("wsUpgrade", WsUpgradeHandler())
                }
            })
            .option(ChannelOption.SO_BACKLOG, 128)
            .childOption(ChannelOption.SO_KEEPALIVE, true)
            .childOption(ChannelOption.TCP_NODELAY, true)

        val channelFuture = bootstrap.bind(bindPort).sync()
        channel = channelFuture.channel()
        actualPort = (channel?.localAddress() as? InetSocketAddress)?.port ?: bindPort

        println("[NettyBenchmarkServer] Started on port $actualPort")
    }

    fun stop() {
        channel?.close()?.sync()
        workerGroup?.shutdownGracefully()?.sync()
        bossGroup?.shutdownGracefully()?.sync()
        channel = null
        actualPort = 0
        println("[NettyBenchmarkServer] Stopped")
    }

    override fun close() = stop()

    /**
     * Handles HTTP upgrade to WebSocket.
     */
    private inner class WsUpgradeHandler : SimpleChannelInboundHandler<FullHttpRequest>() {

        override fun channelRead0(ctx: ChannelHandlerContext, msg: FullHttpRequest) {
            val path = msg.uri().substringBefore('?')

            if (path != "/io") {
                val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.NOT_FOUND)
                ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
                return
            }

            val upgrade = msg.headers().get(HttpHeaderNames.UPGRADE)
            if (!"websocket".equals(upgrade, ignoreCase = true)) {
                val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.BAD_REQUEST)
                ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
                return
            }

            val wsFactory = WebSocketServerHandshakerFactory(
                "ws://${msg.headers().get(HttpHeaderNames.HOST)}$path",
                null,
                true,
                Int.MAX_VALUE
            )
            val handshaker = wsFactory.newHandshaker(msg)

            if (handshaker == null) {
                WebSocketServerHandshakerFactory.sendUnsupportedVersionResponse(ctx.channel())
            } else {
                // The handshaker.handshake() replaces HttpServerCodec with WebSocket codec
                // We need to remove the aggregator and ourselves, then add our frame handler
                handshaker.handshake(ctx.channel(), msg).addListener { future ->
                    if (future.isSuccess) {
                        val pipeline = ctx.pipeline()
                        // Remove aggregator if still present
                        if (pipeline.get("httpAggregator") != null) {
                            pipeline.remove("httpAggregator")
                        }
                        // Remove ourselves (the upgrade handler)
                        if (pipeline.context(this) != null) {
                            pipeline.remove(this)
                        }
                        // Add our WebSocket frame handler
                        pipeline.addLast("wsHandler", IoSessionHandler(handshaker))
                    }
                }
            }
        }
    }

    /**
     * Handles WebSocket frames - mirrors IoWebSocketHandler behavior.
     */
    private inner class IoSessionHandler(
        private val handshaker: WebSocketServerHandshaker
    ) : SimpleChannelInboundHandler<WebSocketFrame>() {

        private var authenticated = false
        private val tcpSockets = ConcurrentHashMap<Int, Socket>()
        private val tcpReaders = ConcurrentHashMap<Int, Thread>()
        @Volatile
        private var ctx: ChannelHandlerContext? = null

        override fun handlerAdded(ctx: ChannelHandlerContext) {
            this.ctx = ctx
            super.handlerAdded(ctx)
        }

        override fun channelActive(ctx: ChannelHandlerContext) {
            this.ctx = ctx
            super.channelActive(ctx)
        }

        override fun channelRead0(ctx: ChannelHandlerContext, frame: WebSocketFrame) {
            // Ensure context is set (it might not be if handlerAdded wasn't called first)
            if (this.ctx == null) {
                this.ctx = ctx
            }

            when (frame) {
                is BinaryWebSocketFrame -> {
                    val buf = frame.content()
                    val data = ByteArray(buf.readableBytes())
                    buf.readBytes(data)
                    handleMessage(data, ctx)
                }
                is PingWebSocketFrame -> {
                    ctx.writeAndFlush(PongWebSocketFrame(frame.content().retain()))
                }
                is CloseWebSocketFrame -> {
                    cleanup()
                    handshaker.close(ctx.channel(), frame.retain())
                }
            }
        }

        override fun channelInactive(ctx: ChannelHandlerContext) {
            cleanup()
            super.channelInactive(ctx)
        }

        private fun handleMessage(data: ByteArray, ctx: ChannelHandlerContext) {
            if (data.size < 8) return

            val envelope = Protocol.Envelope.fromBytes(data) ?: return
            val payload = data.copyOfRange(8, data.size)

            if (!authenticated) {
                handlePreAuth(envelope, payload, ctx)
            } else {
                handlePostAuth(envelope, payload, ctx)
            }
        }

        private fun handlePreAuth(envelope: Protocol.Envelope, payload: ByteArray, ctx: ChannelHandlerContext) {
            when (envelope.opcode) {
                Protocol.CLIENT_HELLO -> {
                    send(Protocol.createFrame(Protocol.SERVER_HELLO, envelope.requestId), ctx)
                }
                Protocol.AUTH -> {
                    if (payload.isNotEmpty()) {
                        val token = String(payload, 1, payload.size - 1).substringBefore('\u0000')
                        if (token == authToken) {
                            authenticated = true
                            send(Protocol.createFrame(Protocol.AUTH_RESULT, envelope.requestId, byteArrayOf(0)), ctx)
                        } else {
                            send(Protocol.createFrame(Protocol.AUTH_RESULT, envelope.requestId, byteArrayOf(1)), ctx)
                        }
                    }
                }
            }
        }

        private fun handlePostAuth(envelope: Protocol.Envelope, payload: ByteArray, ctx: ChannelHandlerContext) {
            when (envelope.opcode) {
                Protocol.TCP_CONNECT -> handleTcpConnect(envelope.requestId, payload, ctx)
                Protocol.TCP_SEND -> handleTcpSend(payload)
                Protocol.TCP_CLOSE -> handleTcpClose(payload)
            }
        }

        private fun handleTcpConnect(requestId: Int, payload: ByteArray, ctx: ChannelHandlerContext) {
            if (payload.size < 6) return

            val socketId = Protocol.getUIntLE(payload, 0)
            val port = Protocol.getUShortLE(payload, 4)
            val hostname = String(payload, 6, payload.size - 6)

            try {
                val socket = Socket(hostname, port)
                socket.tcpNoDelay = true
                socket.receiveBufferSize = tcpReadBufferSize
                tcpSockets[socketId] = socket

                val response = intToLE(socketId) + byteArrayOf(0) + intToLE(0)
                send(Protocol.createFrame(Protocol.TCP_CONNECTED, requestId, response), ctx)

                val reader = thread(name = "TcpReader-$socketId", isDaemon = true) {
                    readFromSocket(socketId, socket, ctx)
                }
                tcpReaders[socketId] = reader

            } catch (e: Exception) {
                val response = intToLE(socketId) + byteArrayOf(1) + intToLE(-1)
                send(Protocol.createFrame(Protocol.TCP_CONNECTED, requestId, response), ctx)
            }
        }

        private fun handleTcpSend(payload: ByteArray) {
            if (payload.size < 4) return
            val socketId = Protocol.getUIntLE(payload, 0)
            val data = payload.copyOfRange(4, payload.size)

            tcpSockets[socketId]?.let { socket ->
                try {
                    socket.getOutputStream().write(data)
                } catch (e: Exception) {
                    // Ignore
                }
            }
        }

        private fun handleTcpClose(payload: ByteArray) {
            if (payload.size < 4) return
            val socketId = Protocol.getUIntLE(payload, 0)
            tcpReaders.remove(socketId)?.interrupt()
            tcpSockets.remove(socketId)?.close()
        }

        private fun readFromSocket(socketId: Int, socket: Socket, ctx: ChannelHandlerContext) {
            val HEADER_SIZE = 12 // 8 byte WS header + 4 byte socketId
            val bufferSize = tcpReadBufferSize

            try {
                val input = socket.getInputStream()

                while (!Thread.currentThread().isInterrupted && !socket.isClosed && ctx.channel().isActive) {
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
                    send(actualFrame, ctx)
                    totalBytesRelayed.addAndGet(bytesRead.toLong())
                }
            } catch (e: Exception) {
                // Socket closed or interrupted
            } finally {
                val closePayload = intToLE(socketId) + byteArrayOf(0) + intToLE(0)
                send(Protocol.createFrame(Protocol.TCP_CLOSE, 0, closePayload), ctx)

                tcpSockets.remove(socketId)
                tcpReaders.remove(socketId)
            }
        }

        private fun send(data: ByteArray, ctx: ChannelHandlerContext) {
            if (!ctx.channel().isActive) return

            val buf = Unpooled.wrappedBuffer(data)
            val frame = BinaryWebSocketFrame(buf)
            ctx.writeAndFlush(frame)
            totalFramesSent.incrementAndGet()
        }

        private fun cleanup() {
            tcpReaders.values.forEach { it.interrupt() }
            tcpSockets.values.forEach { runCatching { it.close() } }
            tcpSockets.clear()
            tcpReaders.clear()
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
