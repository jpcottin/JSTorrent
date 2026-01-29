package com.jstorrent.companion.server.websocket

import android.util.Log
import io.netty.bootstrap.ServerBootstrap
import io.netty.buffer.ByteBuf
import io.netty.channel.*
import io.netty.channel.nio.NioEventLoopGroup
import io.netty.channel.socket.SocketChannel
import io.netty.channel.socket.nio.NioServerSocketChannel
import io.netty.handler.codec.http.*
import io.netty.handler.codec.http.websocketx.*
import kotlinx.coroutines.*

private const val TAG = "NettyWebSocketServer"

/**
 * Configuration for WebSocket endpoint handlers.
 */
data class WebSocketEndpointConfig(
    val path: String,
    val sessionHandler: suspend (WebSocketSession) -> Unit
)

/**
 * Raw Netty WebSocket server for high-performance WebSocket handling.
 *
 * This server bypasses Ktor's WebSocket layer for direct Netty performance.
 * It handles HTTP upgrade and routes WebSocket connections to registered paths.
 *
 * Usage:
 * ```kotlin
 * val server = NettyWebSocketServer(port = 7801)
 * server.addEndpoint("/io") { session -> IoWebSocketHandler(session, deps).run() }
 * server.addEndpoint("/control") { session -> ControlWebSocketHandler(session, deps).run() }
 * server.start()
 * ```
 */
class NettyWebSocketServer(
    private val port: Int = 0
) {
    private var bossGroup: EventLoopGroup? = null
    private var workerGroup: EventLoopGroup? = null
    private var channel: Channel? = null
    private var actualPort: Int = 0

    private val endpoints = mutableMapOf<String, WebSocketEndpointConfig>()
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    val boundPort: Int get() = actualPort
    val isRunning: Boolean get() = channel?.isActive == true

    /**
     * Register a WebSocket endpoint handler for a path.
     * Must be called before start().
     */
    fun addEndpoint(path: String, handler: suspend (WebSocketSession) -> Unit) {
        endpoints[path] = WebSocketEndpointConfig(path, handler)
    }

    /**
     * Start the server on the configured port.
     * @param preferredPort Port to bind to (0 for auto-select)
     */
    fun start(preferredPort: Int = port) {
        if (channel != null) {
            Log.w(TAG, "Server already running on port $actualPort")
            return
        }

        bossGroup = NioEventLoopGroup(1)
        workerGroup = NioEventLoopGroup()

        val bootstrap = ServerBootstrap()
            .group(bossGroup, workerGroup)
            .channel(NioServerSocketChannel::class.java)
            .childHandler(WebSocketChannelInitializer(endpoints, scope))
            .option(ChannelOption.SO_BACKLOG, 128)
            .childOption(ChannelOption.SO_KEEPALIVE, true)
            .childOption(ChannelOption.TCP_NODELAY, true)

        // Try to bind
        val channelFuture = bootstrap.bind(preferredPort).sync()
        channel = channelFuture.channel()
        actualPort = (channel?.localAddress() as? java.net.InetSocketAddress)?.port ?: preferredPort

        Log.i(TAG, "Netty WebSocket server started on port $actualPort")
    }

    /**
     * Stop the server gracefully.
     */
    fun stop() {
        scope.cancel()
        channel?.close()?.sync()
        workerGroup?.shutdownGracefully()
        bossGroup?.shutdownGracefully()
        channel = null
        actualPort = 0
        Log.i(TAG, "Netty WebSocket server stopped")
    }
}

/**
 * Channel initializer that sets up the HTTP/WebSocket pipeline.
 */
private class WebSocketChannelInitializer(
    private val endpoints: Map<String, WebSocketEndpointConfig>,
    private val scope: CoroutineScope
) : ChannelInitializer<SocketChannel>() {

    override fun initChannel(ch: SocketChannel) {
        ch.pipeline()
            .addLast("httpCodec", HttpServerCodec())
            .addLast("httpAggregator", HttpObjectAggregator(65536))
            .addLast("wsUpgrade", WebSocketUpgradeHandler(endpoints, scope))
    }
}

/**
 * Handles HTTP upgrade to WebSocket and routes to the appropriate endpoint.
 */
private class WebSocketUpgradeHandler(
    private val endpoints: Map<String, WebSocketEndpointConfig>,
    private val scope: CoroutineScope
) : SimpleChannelInboundHandler<FullHttpRequest>() {

    override fun channelRead0(ctx: ChannelHandlerContext, msg: FullHttpRequest) {
        val uri = msg.uri()
        val path = uri.substringBefore('?')

        val endpoint = endpoints[path]
        if (endpoint == null) {
            // Not a registered WebSocket path - return 404
            val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.NOT_FOUND)
            ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
            return
        }

        // Check if it's a WebSocket upgrade request
        val upgrade = msg.headers().get(HttpHeaderNames.UPGRADE)
        if (!"websocket".equals(upgrade, ignoreCase = true)) {
            val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.BAD_REQUEST)
            ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
            return
        }

        // Perform WebSocket handshake
        val wsFactory = WebSocketServerHandshakerFactory(
            "ws://${msg.headers().get(HttpHeaderNames.HOST)}$path",
            null,
            true,
            Int.MAX_VALUE // No frame size limit
        )
        val handshaker = wsFactory.newHandshaker(msg)

        if (handshaker == null) {
            WebSocketServerHandshakerFactory.sendUnsupportedVersionResponse(ctx.channel())
        } else {
            handshaker.handshake(ctx.channel(), msg).addListener { future ->
                if (future.isSuccess) {
                    // Remove HTTP handlers and add WebSocket frame handler
                    ctx.pipeline().remove("httpCodec")
                    ctx.pipeline().remove("httpAggregator")
                    ctx.pipeline().remove(this)

                    // Create session and start handler
                    val session = NettyWebSocketSession(ctx)
                    ctx.pipeline().addLast("wsFrameHandler", WebSocketFrameHandler(session, handshaker))

                    // Start the coroutine handler
                    scope.launch {
                        try {
                            endpoint.sessionHandler(session)
                        } catch (e: Exception) {
                            Log.e(TAG, "WebSocket handler error for $path: ${e.message}")
                        } finally {
                            session.close(1000, "Handler completed")
                        }
                    }
                } else {
                    Log.e(TAG, "WebSocket handshake failed: ${future.cause()?.message}")
                }
            }
        }
    }

    override fun exceptionCaught(ctx: ChannelHandlerContext, cause: Throwable) {
        Log.e(TAG, "Upgrade handler error: ${cause.message}")
        ctx.close()
    }
}

/**
 * Handles WebSocket frames after upgrade is complete.
 */
private class WebSocketFrameHandler(
    private val session: NettyWebSocketSession,
    private val handshaker: WebSocketServerHandshaker
) : SimpleChannelInboundHandler<WebSocketFrame>() {

    override fun channelRead0(ctx: ChannelHandlerContext, frame: WebSocketFrame) {
        when (frame) {
            is BinaryWebSocketFrame -> {
                val buf: ByteBuf = frame.content()
                val data = ByteArray(buf.readableBytes())
                buf.readBytes(data)
                session.onBinaryFrame(data)
            }
            is TextWebSocketFrame -> {
                // Ignore text frames - binary protocol only
            }
            is PingWebSocketFrame -> {
                ctx.writeAndFlush(PongWebSocketFrame(frame.content().retain()))
            }
            is PongWebSocketFrame -> {
                // Ignore pong
            }
            is CloseWebSocketFrame -> {
                session.onClose()
                handshaker.close(ctx.channel(), frame.retain())
            }
        }
    }

    override fun channelInactive(ctx: ChannelHandlerContext) {
        session.onClose()
        super.channelInactive(ctx)
    }

    override fun exceptionCaught(ctx: ChannelHandlerContext, cause: Throwable) {
        Log.e(TAG, "WebSocket frame handler error: ${cause.message}")
        session.onClose()
        ctx.close()
    }
}
