package com.jstorrent.companion.server

import android.util.Log
import io.netty.bootstrap.ServerBootstrap
import io.netty.buffer.Unpooled
import io.netty.channel.*
import io.netty.channel.nio.NioEventLoopGroup
import io.netty.channel.socket.SocketChannel
import io.netty.channel.socket.nio.NioServerSocketChannel
import io.netty.handler.codec.http.*
import java.nio.charset.StandardCharsets

private const val TAG = "NettyHttpSinkServer"

/**
 * Minimal Netty HTTP server for throughput testing without framework overhead.
 *
 * Endpoints:
 * - POST /http-sink: Receives body (streaming), discards it, returns timing stats
 * - GET /http-source?mb=N: Returns N MB of zeros (up to 10GB)
 *
 * Key differences from Ktor:
 * - No HttpObjectAggregator (streams content directly)
 * - No coroutines/suspend overhead
 * - Minimal pipeline
 *
 * Test from Chrome (streaming upload - works with any size):
 * ```javascript
 * async function streamUpload(totalMB, chunkMB = 1) {
 *   const chunkSize = chunkMB * 1024 * 1024;
 *   const totalChunks = Math.ceil(totalMB / chunkMB);
 *   let sent = 0;
 *
 *   const stream = new ReadableStream({
 *     pull(controller) {
 *       if (sent >= totalChunks) {
 *         controller.close();
 *         return;
 *       }
 *       controller.enqueue(new Uint8Array(chunkSize));
 *       sent++;
 *     }
 *   });
 *
 *   const start = performance.now();
 *   const resp = await fetch('http://100.115.92.2:7803/http-sink', {
 *     method: 'POST',
 *     body: stream,
 *     duplex: 'half'  // Required for streaming upload
 *   });
 *   const result = await resp.text();
 *   console.log(result);
 * }
 * streamUpload(1000);  // 1GB upload
 *
 * // Streaming download
 * async function streamDownload(mb) {
 *   const start = performance.now();
 *   const resp = await fetch(`http://100.115.92.2:7803/http-source?mb=${mb}`);
 *   const reader = resp.body.getReader();
 *   let bytes = 0;
 *   while (true) {
 *     const { done, value } = await reader.read();
 *     if (done) break;
 *     bytes += value.length;
 *   }
 *   const elapsed = (performance.now() - start) / 1000;
 *   console.log(`${(bytes/1024/1024).toFixed(1)} MB in ${(elapsed*1000).toFixed(0)}ms = ${(bytes/1024/1024/elapsed).toFixed(1)} MB/s`);
 * }
 * streamDownload(1000);  // 1GB download
 * ```
 */
class NettyHttpSinkServer(private val port: Int = 7803) {

    private var bossGroup: EventLoopGroup? = null
    private var workerGroup: EventLoopGroup? = null
    private var channel: Channel? = null
    private var actualPort: Int = 0

    val boundPort: Int get() = actualPort
    val isRunning: Boolean get() = channel?.isActive == true

    fun start() {
        if (channel != null) {
            Log.w(TAG, "Server already running on port $actualPort")
            return
        }

        bossGroup = NioEventLoopGroup(1)
        workerGroup = NioEventLoopGroup()

        val bootstrap = ServerBootstrap()
            .group(bossGroup, workerGroup)
            .channel(NioServerSocketChannel::class.java)
            .childHandler(HttpSinkChannelInitializer())
            .option(ChannelOption.SO_BACKLOG, 128)
            .childOption(ChannelOption.SO_KEEPALIVE, true)
            .childOption(ChannelOption.TCP_NODELAY, true)
            .childOption(ChannelOption.SO_RCVBUF, 256 * 1024)  // 256KB receive buffer

        val channelFuture = bootstrap.bind(port).sync()
        channel = channelFuture.channel()
        actualPort = (channel?.localAddress() as? java.net.InetSocketAddress)?.port ?: port

        Log.i(TAG, "Netty HTTP sink server started on port $actualPort")
    }

    fun stop() {
        channel?.close()?.sync()
        workerGroup?.shutdownGracefully()
        bossGroup?.shutdownGracefully()
        channel = null
        actualPort = 0
        Log.i(TAG, "Netty HTTP sink server stopped")
    }
}

private class HttpSinkChannelInitializer : ChannelInitializer<SocketChannel>() {
    override fun initChannel(ch: SocketChannel) {
        ch.pipeline()
            .addLast("httpCodec", HttpServerCodec())
            // NO HttpObjectAggregator - we stream content directly
            .addLast("handler", HttpSinkHandler())
    }
}

/**
 * Handles HTTP requests for sink/source throughput testing.
 * Processes HttpRequest and HttpContent separately for streaming.
 */
private class HttpSinkHandler : ChannelInboundHandlerAdapter() {

    // Per-connection state for upload tracking
    private var uploadStartTime: Long = 0
    private var uploadBytes: Long = 0
    private var lastLogTime: Long = 0
    private var lastLogBytes: Long = 0
    private var isUploading = false
    private var currentPath: String? = null

    override fun channelRead(ctx: ChannelHandlerContext, msg: Any) {
        when (msg) {
            is HttpRequest -> handleRequest(ctx, msg)
            is HttpContent -> handleContent(ctx, msg)
            else -> ctx.fireChannelRead(msg)
        }
    }

    private fun handleRequest(ctx: ChannelHandlerContext, request: HttpRequest) {
        val path = request.uri().substringBefore('?')
        currentPath = path

        // Add CORS headers helper
        fun addCorsHeaders(response: HttpResponse) {
            response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, "*")
            response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_METHODS, "GET, POST, OPTIONS")
            response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_HEADERS, "Content-Type")
        }

        // Handle OPTIONS preflight
        if (request.method() == HttpMethod.OPTIONS) {
            val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK)
            addCorsHeaders(response)
            response.headers().set(HttpHeaderNames.CONTENT_LENGTH, 0)
            ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
            return
        }

        // Handle Expect: 100-continue for streaming uploads
        if (HttpUtil.is100ContinueExpected(request)) {
            val continueResponse = DefaultFullHttpResponse(
                HttpVersion.HTTP_1_1,
                HttpResponseStatus.CONTINUE
            )
            ctx.writeAndFlush(continueResponse)
            Log.d(TAG, "Sent 100 Continue")
        }

        when {
            path == "/http-sink" && request.method() == HttpMethod.POST -> {
                // Start tracking upload
                uploadStartTime = System.currentTimeMillis()
                lastLogTime = uploadStartTime
                uploadBytes = 0
                lastLogBytes = 0
                isUploading = true
                Log.i(TAG, "HTTP sink: upload started")
            }

            path == "/http-source" && request.method() == HttpMethod.GET -> {
                // Parse mb parameter (up to 10GB)
                val query = request.uri().substringAfter('?', "")
                val mb = query.split('&')
                    .map { it.split('=') }
                    .find { it.firstOrNull() == "mb" }
                    ?.getOrNull(1)
                    ?.toIntOrNull()
                    ?.coerceIn(1, 10240)  // Up to 10GB
                    ?: 100

                sendSource(ctx, mb)
            }

            else -> {
                val response = DefaultFullHttpResponse(
                    HttpVersion.HTTP_1_1,
                    HttpResponseStatus.NOT_FOUND,
                    Unpooled.copiedBuffer("Not found. Use /http-sink or /http-source?mb=N", StandardCharsets.UTF_8)
                )
                addCorsHeaders(response)
                response.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/plain")
                response.headers().set(HttpHeaderNames.CONTENT_LENGTH, response.content().readableBytes())
                ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
            }
        }
    }

    private fun handleContent(ctx: ChannelHandlerContext, content: HttpContent) {
        if (isUploading) {
            uploadBytes += content.content().readableBytes()

            // Log every second
            val now = System.currentTimeMillis()
            if (now - lastLogTime >= 1000) {
                val intervalBytes = uploadBytes - lastLogBytes
                val intervalSec = (now - lastLogTime) / 1000.0
                val mbps = intervalBytes / intervalSec / (1024 * 1024)
                Log.i(TAG, "HTTP sink: ${"%.1f".format(mbps)} MB/s (${uploadBytes / (1024*1024)} MB total)")
                lastLogTime = now
                lastLogBytes = uploadBytes
            }

            if (content is LastHttpContent) {
                // Upload complete
                isUploading = false
                val elapsed = System.currentTimeMillis() - uploadStartTime
                val mbps = if (elapsed > 0) uploadBytes / (elapsed / 1000.0) / (1024 * 1024) else 0.0
                val mbReceived = uploadBytes / (1024.0 * 1024.0)

                Log.i(TAG, "HTTP sink done: ${"%.1f".format(mbReceived)} MB in ${elapsed}ms = ${"%.1f".format(mbps)} MB/s")

                val body = "${"%.1f".format(mbReceived)} MB in ${elapsed}ms = ${"%.1f".format(mbps)} MB/s"
                val response = DefaultFullHttpResponse(
                    HttpVersion.HTTP_1_1,
                    HttpResponseStatus.OK,
                    Unpooled.copiedBuffer(body, StandardCharsets.UTF_8)
                )
                response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, "*")
                response.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/plain")
                response.headers().set(HttpHeaderNames.CONTENT_LENGTH, response.content().readableBytes())
                ctx.writeAndFlush(response).addListener(ChannelFutureListener.CLOSE)
            }
        }

        // Release the content buffer
        content.content().release()
    }

    private fun sendSource(ctx: ChannelHandlerContext, mb: Int) {
        val totalBytes = mb.toLong() * 1024 * 1024
        val startTime = System.currentTimeMillis()

        Log.i(TAG, "HTTP source: sending ${mb} MB")

        // Send response header
        val response = DefaultHttpResponse(HttpVersion.HTTP_1_1, HttpResponseStatus.OK)
        response.headers().set(HttpHeaderNames.ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, "application/octet-stream")
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, totalBytes)
        ctx.write(response)

        // Send body in chunks with backpressure handling
        val chunkSize = 256 * 1024  // 256KB chunks
        val chunk = ByteArray(chunkSize)
        var remaining = totalBytes
        var bytesSent = 0L
        var lastLogTime = startTime
        var lastLogBytes = 0L

        // Use a recursive approach to handle backpressure
        fun sendNextChunk() {
            if (remaining <= 0 || !ctx.channel().isActive) {
                // Done - send last chunk
                ctx.writeAndFlush(LastHttpContent.EMPTY_LAST_CONTENT).addListener { future ->
                    val elapsed = System.currentTimeMillis() - startTime
                    val mbps = if (elapsed > 0) totalBytes / (elapsed / 1000.0) / (1024 * 1024) else 0.0
                    Log.i(TAG, "HTTP source done: ${mb} MB in ${elapsed}ms = ${"%.1f".format(mbps)} MB/s")
                    ctx.close()
                }
                return
            }

            val toSend = minOf(remaining, chunkSize.toLong()).toInt()
            val content = DefaultHttpContent(Unpooled.wrappedBuffer(chunk, 0, toSend))
            remaining -= toSend
            bytesSent += toSend

            // Log every second
            val now = System.currentTimeMillis()
            if (now - lastLogTime >= 1000) {
                val intervalBytes = bytesSent - lastLogBytes
                val intervalSec = (now - lastLogTime) / 1000.0
                val mbps = intervalBytes / intervalSec / (1024 * 1024)
                Log.i(TAG, "HTTP source: ${"%.1f".format(mbps)} MB/s (${bytesSent / (1024*1024)} MB sent)")
                lastLogTime = now
                lastLogBytes = bytesSent
            }

            // Write and check if channel is writable
            val future = ctx.writeAndFlush(content)
            if (ctx.channel().isWritable) {
                // Channel buffer has room, continue immediately
                sendNextChunk()
            } else {
                // Wait for write to complete before sending more
                future.addListener { sendNextChunk() }
            }
        }

        sendNextChunk()
    }

    override fun exceptionCaught(ctx: ChannelHandlerContext, cause: Throwable) {
        Log.e(TAG, "Handler error: ${cause.message}")
        ctx.close()
    }
}
