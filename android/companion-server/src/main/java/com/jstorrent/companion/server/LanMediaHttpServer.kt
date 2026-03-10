package com.jstorrent.companion.server

import android.util.Log
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.file.FileManagerException
import io.netty.bootstrap.ServerBootstrap
import io.netty.buffer.Unpooled
import io.netty.channel.Channel
import io.netty.channel.ChannelFuture
import io.netty.channel.ChannelHandlerContext
import io.netty.channel.ChannelInitializer
import io.netty.channel.ChannelOption
import io.netty.channel.EventLoopGroup
import io.netty.channel.SimpleChannelInboundHandler
import io.netty.channel.nio.NioEventLoopGroup
import io.netty.channel.socket.SocketChannel
import io.netty.channel.socket.nio.NioServerSocketChannel
import io.netty.handler.codec.http.DefaultFullHttpResponse
import io.netty.handler.codec.http.DefaultHttpContent
import io.netty.handler.codec.http.DefaultHttpResponse
import io.netty.handler.codec.http.FullHttpRequest
import io.netty.handler.codec.http.HttpHeaderNames
import io.netty.handler.codec.http.HttpMethod
import io.netty.handler.codec.http.HttpObjectAggregator
import io.netty.handler.codec.http.HttpResponseStatus
import io.netty.handler.codec.http.HttpServerCodec
import io.netty.handler.codec.http.HttpVersion
import io.netty.handler.codec.http.LastHttpContent
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

private const val TAG = "LanMediaHttpServer"

class LanMediaHttpServer(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val httpStreams: HttpStreamSessionRegistry,
    private val localAppBackend: TorrentHttpStreamBackend,
    private val extensionControlBackend: TorrentHttpStreamBackend,
) {
    private var bossGroup: EventLoopGroup? = null
    private var workerGroup: EventLoopGroup? = null
    private var channel: Channel? = null
    private var actualPort: Int = 0
    private var lifecycleSubscription: AutoCloseable? = null

    val boundPort: Int get() = actualPort
    val isRunning: Boolean get() = channel?.isActive == true

    @Synchronized
    fun startIfNeeded(preferredPort: Int = 0): Int {
        if (channel != null) {
            return actualPort
        }

        bossGroup = NioEventLoopGroup(1)
        workerGroup = NioEventLoopGroup()
        if (lifecycleSubscription == null) {
            lifecycleSubscription = localAppBackend.subscribeLifecycle { event ->
                if (event.reason == "torrent-removed") {
                    httpStreams.revokeTorrent(event.torrentId)
                }
            }
        }

        try {
            val bootstrap = ServerBootstrap()
                .group(bossGroup, workerGroup)
                .channel(NioServerSocketChannel::class.java)
                .childHandler(
                    LanMediaHttpChannelInitializer(
                        deps = deps,
                        fileManager = fileManager,
                        httpStreams = httpStreams,
                        localAppBackend = localAppBackend,
                        extensionControlBackend = extensionControlBackend,
                    )
                )
                .option(ChannelOption.SO_BACKLOG, 128)
                .option(ChannelOption.SO_REUSEADDR, true)
                .childOption(ChannelOption.SO_KEEPALIVE, true)
                .childOption(ChannelOption.TCP_NODELAY, true)

            val channelFuture = bootstrap.bind(preferredPort).sync()
            channel = channelFuture.channel()
            actualPort = (channel?.localAddress() as? InetSocketAddress)?.port ?: preferredPort
            Log.i(TAG, "LAN media server started on port $actualPort")
            return actualPort
        } catch (e: Exception) {
            workerGroup?.shutdownGracefully()
            bossGroup?.shutdownGracefully()
            workerGroup = null
            bossGroup = null
            lifecycleSubscription?.close()
            lifecycleSubscription = null
            throw e
        }
    }

    @Synchronized
    fun stop() {
        channel?.close()?.sync()
        workerGroup?.shutdownGracefully()
        bossGroup?.shutdownGracefully()
        lifecycleSubscription?.close()
        lifecycleSubscription = null
        channel = null
        workerGroup = null
        bossGroup = null
        actualPort = 0
        Log.i(TAG, "LAN media server stopped")
    }
}

private class LanMediaHttpChannelInitializer(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val httpStreams: HttpStreamSessionRegistry,
    private val localAppBackend: TorrentHttpStreamBackend,
    private val extensionControlBackend: TorrentHttpStreamBackend,
) : ChannelInitializer<SocketChannel>() {
    override fun initChannel(ch: SocketChannel) {
        ch.pipeline()
            .addLast("httpCodec", HttpServerCodec())
            .addLast("aggregator", HttpObjectAggregator(64 * 1024))
            .addLast(
                "handler",
                LanMediaHttpHandler(
                    deps = deps,
                    fileManager = fileManager,
                    httpStreams = httpStreams,
                    localAppBackend = localAppBackend,
                    extensionControlBackend = extensionControlBackend,
                )
            )
    }
}

private class LanMediaHttpHandler(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val httpStreams: HttpStreamSessionRegistry,
    private val localAppBackend: TorrentHttpStreamBackend,
    private val extensionControlBackend: TorrentHttpStreamBackend,
) : SimpleChannelInboundHandler<FullHttpRequest>() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun channelRead0(ctx: ChannelHandlerContext, request: FullHttpRequest) {
        val path = request.uri().substringBefore('?')
        val method = request.method()

        when {
            path.startsWith("/stream/") && (method == HttpMethod.GET || method == HttpMethod.HEAD) ->
                handleStream(ctx, request, path)
            path == "/health" && method == HttpMethod.GET ->
                sendEmpty(ctx, HttpResponseStatus.OK)
            else ->
                sendNotFound(ctx)
        }
    }

    private fun handleStream(ctx: ChannelHandlerContext, request: FullHttpRequest, path: String) {
        val streamToken = path.removePrefix("/stream/")
        if (streamToken.isBlank()) {
            sendNotFound(ctx)
            return
        }

        val stream = httpStreams.getAndTouch(streamToken)
        if (stream == null) {
            sendNotFound(ctx)
            return
        }

        val rootUri = deps.rootStore.resolveKey(stream.rootKey)
        if (rootUri == null) {
            httpStreams.revoke(streamToken)
            sendNotFound(ctx)
            return
        }

        val range = resolveHttpByteRange(request.headers().get(HttpHeaderNames.RANGE), stream.fileSize)
        if (range == null) {
            sendRangeNotSatisfiable(ctx, stream.fileSize)
            return
        }

        if (request.method() == HttpMethod.HEAD || range.contentLength == 0L) {
            sendStreamHeaders(
                ctx = ctx,
                range = range,
                contentType = stream.mimeType ?: "application/octet-stream",
            )
            ctx.writeAndFlush(LastHttpContent.EMPTY_LAST_CONTENT)
            return
        }

        val sessionId = "lan-stream-$streamToken-${System.nanoTime()}"
        val closed = AtomicBoolean(false)
        val backend = backendForStream(stream)
        val closeSession = { reason: String ->
            if (closed.compareAndSet(false, true)) {
                backend.closeStreamSession(stream, sessionId, reason)
            }
        }
        ctx.channel().closeFuture().addListener { closeSession("client-aborted") }

        scope.launch {
            streamTorrentResponse(
                ctx = ctx,
                streamToken = streamToken,
                stream = stream,
                rootUri = rootUri,
                range = range,
                sessionId = sessionId,
                closeSession = closeSession,
            )
        }
    }

    private suspend fun streamTorrentResponse(
        ctx: ChannelHandlerContext,
        streamToken: String,
        stream: RegisteredHttpStream,
        rootUri: android.net.Uri,
        range: HttpByteRange,
        sessionId: String,
        closeSession: (String) -> Unit,
    ) {
        var headersSent = false
        val backend = backendForStream(stream)

        try {
            backend.openStreamSession(stream, sessionId)

            val chunkSize = 256 * 1024
            var nextOffset = range.start
            while (ctx.channel().isActive && nextOffset <= range.endInclusive) {
                val bytesToRead = minOf(chunkSize.toLong(), range.endInclusive - nextOffset + 1).toInt()
                backend.waitForStreamRange(stream, sessionId, nextOffset, bytesToRead)
                val chunk = fileManager.read(rootUri, stream.path, nextOffset, bytesToRead)
                if (chunk.isEmpty()) {
                    throw IllegalStateException("Unexpected empty read while streaming torrent")
                }

                if (!headersSent) {
                    sendStreamHeaders(
                        ctx = ctx,
                        range = range,
                        contentType = stream.mimeType ?: "application/octet-stream",
                    )
                    headersSent = true
                }

                nextOffset += chunk.size
                writeAndFlush(ctx, DefaultHttpContent(Unpooled.wrappedBuffer(chunk)))
            }

            if (ctx.channel().isActive) {
                if (!headersSent) {
                    sendStreamHeaders(
                        ctx = ctx,
                        range = range,
                        contentType = stream.mimeType ?: "application/octet-stream",
                    )
                }
                writeAndFlush(ctx, LastHttpContent.EMPTY_LAST_CONTENT)
            }
        } catch (e: TorrentHttpStreamException) {
            if (!headersSent) {
                handleStreamError(ctx, streamToken, e)
            } else {
                Log.w(TAG, "stream failed after headers for ${stream.path}: ${e.status}")
                ctx.close()
            }
        } catch (e: FileManagerException) {
            Log.e(TAG, "file read failed for ${stream.path}: ${e.message}")
            if (!headersSent) {
                sendText(ctx, HttpResponseStatus.INTERNAL_SERVER_ERROR, e.message ?: "Read error")
            } else {
                ctx.close()
            }
        } catch (e: Exception) {
            val aborted = e.message == "Aborted"
            if (!aborted) {
                Log.w(TAG, "stream failed for ${stream.path}: ${e.message}")
            }
            if (!headersSent && !aborted) {
                sendNotFound(ctx)
            } else {
                ctx.close()
            }
        } finally {
            closeSession("request-complete")
        }
    }

    private fun backendForStream(stream: RegisteredHttpStream): TorrentHttpStreamBackend {
        return when (stream.backendKind) {
            HttpStreamBackendKind.LocalApp -> localAppBackend
            HttpStreamBackendKind.ExtensionControl -> extensionControlBackend
        }
    }

    private fun sendStreamHeaders(
        ctx: ChannelHandlerContext,
        range: HttpByteRange,
        contentType: String,
    ) {
        val status = if (range.partial) HttpResponseStatus.PARTIAL_CONTENT else HttpResponseStatus.OK
        val response = DefaultHttpResponse(HttpVersion.HTTP_1_1, status)
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, contentType)
        response.headers().set(HttpHeaderNames.ACCEPT_RANGES, "bytes")
        response.headers().set(HttpHeaderNames.CACHE_CONTROL, "private, no-store")
        response.headers().set(HttpHeaderNames.PRAGMA, "no-cache")
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, range.contentLength)
        if (range.partial) {
            response.headers().set(HttpHeaderNames.CONTENT_RANGE, range.contentRangeHeader())
        }
        ctx.write(response)
    }

    private fun handleStreamError(
        ctx: ChannelHandlerContext,
        streamToken: String,
        error: TorrentHttpStreamException,
    ) {
        when (error.status) {
            TorrentHttpStreamStatus.TorrentStopped ->
                sendText(ctx, HttpResponseStatus.CONFLICT, "Torrent is stopped")

            TorrentHttpStreamStatus.TorrentInactive ->
                sendText(ctx, HttpResponseStatus.CONFLICT, "Torrent is not active")

            TorrentHttpStreamStatus.TorrentErrored ->
                sendText(ctx, HttpResponseStatus.CONFLICT, "Torrent is in an error state")

            TorrentHttpStreamStatus.FileSkipped ->
                sendText(ctx, HttpResponseStatus.CONFLICT, "File is skipped")

            TorrentHttpStreamStatus.TorrentRemoved,
            TorrentHttpStreamStatus.StreamSessionMismatch,
            TorrentHttpStreamStatus.StreamSessionNotFound -> {
                httpStreams.revoke(streamToken)
                sendNotFound(ctx)
            }
        }
    }

    private suspend fun writeAndFlush(
        ctx: ChannelHandlerContext,
        message: Any,
    ) {
        suspendCancellableCoroutine<Unit> { continuation ->
            val future = ctx.writeAndFlush(message)
            future.addListener { channelFuture ->
                if (channelFuture.isSuccess) {
                    continuation.resume(Unit)
                } else {
                    continuation.resumeWithException(
                        channelFuture.cause() ?: IllegalStateException("Channel write failed")
                    )
                }
            }
            continuation.invokeOnCancellation {
                if (!future.isDone) {
                    future.cancel(true)
                }
            }
        }
    }

    private fun sendRangeNotSatisfiable(ctx: ChannelHandlerContext, totalSize: Long) {
        val response = DefaultFullHttpResponse(
            HttpVersion.HTTP_1_1,
            HttpResponseStatus.REQUESTED_RANGE_NOT_SATISFIABLE,
        )
        response.headers().set(HttpHeaderNames.ACCEPT_RANGES, "bytes")
        response.headers().set(HttpHeaderNames.CONTENT_RANGE, "bytes */$totalSize")
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, 0)
        ctx.writeAndFlush(response)
    }

    private fun sendNotFound(ctx: ChannelHandlerContext) {
        val response = DefaultFullHttpResponse(
            HttpVersion.HTTP_1_1,
            HttpResponseStatus.NOT_FOUND,
        )
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, 0)
        ctx.writeAndFlush(response)
    }

    private fun sendText(ctx: ChannelHandlerContext, status: HttpResponseStatus, text: String) {
        val bytes = text.toByteArray()
        val response = DefaultFullHttpResponse(
            HttpVersion.HTTP_1_1,
            status,
            Unpooled.wrappedBuffer(bytes),
        )
        response.headers().set(HttpHeaderNames.CONTENT_TYPE, "text/plain; charset=utf-8")
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, bytes.size)
        ctx.writeAndFlush(response)
    }

    private fun sendEmpty(ctx: ChannelHandlerContext, status: HttpResponseStatus) {
        val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status)
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, 0)
        ctx.writeAndFlush(response)
    }

    override fun handlerRemoved(ctx: ChannelHandlerContext) {
        super.handlerRemoved(ctx)
        scope.cancel()
    }
}
