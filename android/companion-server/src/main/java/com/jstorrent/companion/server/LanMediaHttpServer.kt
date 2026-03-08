package com.jstorrent.companion.server

import android.net.Uri
import android.util.Log
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.file.FileManagerException
import io.netty.bootstrap.ServerBootstrap
import io.netty.buffer.Unpooled
import io.netty.channel.*
import io.netty.channel.nio.NioEventLoopGroup
import io.netty.channel.socket.SocketChannel
import io.netty.channel.socket.nio.NioServerSocketChannel
import io.netty.handler.codec.http.*
import java.net.InetSocketAddress

private const val TAG = "LanMediaHttpServer"

class LanMediaHttpServer(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val httpStreams: HttpStreamSessionRegistry,
) {
    private var bossGroup: EventLoopGroup? = null
    private var workerGroup: EventLoopGroup? = null
    private var channel: Channel? = null
    private var actualPort: Int = 0

    val boundPort: Int get() = actualPort
    val isRunning: Boolean get() = channel?.isActive == true

    @Synchronized
    fun startIfNeeded(preferredPort: Int = 0): Int {
        if (channel != null) {
            return actualPort
        }

        bossGroup = NioEventLoopGroup(1)
        workerGroup = NioEventLoopGroup()

        try {
            val bootstrap = ServerBootstrap()
                .group(bossGroup, workerGroup)
                .channel(NioServerSocketChannel::class.java)
                .childHandler(LanMediaHttpChannelInitializer(deps, fileManager, httpStreams))
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
            throw e
        }
    }

    @Synchronized
    fun stop() {
        channel?.close()?.sync()
        workerGroup?.shutdownGracefully()
        bossGroup?.shutdownGracefully()
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
) : ChannelInitializer<SocketChannel>() {
    override fun initChannel(ch: SocketChannel) {
        ch.pipeline()
            .addLast("httpCodec", HttpServerCodec())
            .addLast("aggregator", HttpObjectAggregator(64 * 1024))
            .addLast("handler", LanMediaHttpHandler(deps, fileManager, httpStreams))
    }
}

private class LanMediaHttpHandler(
    private val deps: CompanionServerDeps,
    private val fileManager: FileManager,
    private val httpStreams: HttpStreamSessionRegistry,
) : SimpleChannelInboundHandler<FullHttpRequest>() {

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

        val stat = try {
            fileManager.stat(rootUri, stream.path)
        } catch (e: Exception) {
            Log.w(TAG, "stat failed for ${stream.path}: ${e.message}")
            null
        }
        if (stat == null || !stat.isFile) {
            httpStreams.revoke(streamToken)
            sendNotFound(ctx)
            return
        }

        val range = resolveHttpByteRange(request.headers().get(HttpHeaderNames.RANGE), stat.size)
        if (range == null) {
            sendRangeNotSatisfiable(ctx, stat.size)
            return
        }

        sendStreamResponse(
            ctx = ctx,
            method = request.method(),
            rootUri = rootUri,
            relativePath = stream.path,
            range = range,
            contentType = stream.mimeType ?: "application/octet-stream",
        )
    }

    private fun sendStreamResponse(
        ctx: ChannelHandlerContext,
        method: HttpMethod,
        rootUri: Uri,
        relativePath: String,
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

        if (method == HttpMethod.HEAD) {
            ctx.writeAndFlush(LastHttpContent.EMPTY_LAST_CONTENT)
            return
        }

        val chunkSize = 256 * 1024
        var nextOffset = range.start

        fun sendNextChunk() {
            if (!ctx.channel().isActive) return
            if (nextOffset > range.endInclusive) {
                ctx.writeAndFlush(LastHttpContent.EMPTY_LAST_CONTENT)
                return
            }

            val bytesToRead = minOf(chunkSize.toLong(), range.endInclusive - nextOffset + 1).toInt()
            val chunk = try {
                fileManager.read(rootUri, relativePath, nextOffset, bytesToRead)
            } catch (e: FileManagerException) {
                Log.w(TAG, "read failed at $nextOffset for $relativePath: ${e.message}")
                ctx.close()
                return
            } catch (e: Exception) {
                Log.w(TAG, "read failed at $nextOffset for $relativePath: ${e.message}")
                ctx.close()
                return
            }

            nextOffset += chunk.size
            ctx.writeAndFlush(DefaultHttpContent(Unpooled.wrappedBuffer(chunk))).addListener { future ->
                if (future.isSuccess) {
                    sendNextChunk()
                } else {
                    ctx.close()
                }
            }
        }

        sendNextChunk()
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

    private fun sendEmpty(ctx: ChannelHandlerContext, status: HttpResponseStatus) {
        val response = DefaultFullHttpResponse(HttpVersion.HTTP_1_1, status)
        response.headers().set(HttpHeaderNames.CONTENT_LENGTH, 0)
        ctx.writeAndFlush(response)
    }
}
