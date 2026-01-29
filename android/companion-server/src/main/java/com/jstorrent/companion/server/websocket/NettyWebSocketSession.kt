package com.jstorrent.companion.server.websocket

import io.netty.buffer.Unpooled
import io.netty.channel.Channel
import io.netty.channel.ChannelHandlerContext
import io.netty.handler.codec.http.websocketx.BinaryWebSocketFrame
import io.netty.handler.codec.http.websocketx.CloseWebSocketFrame
import kotlinx.coroutines.channels.Channel as KChannel
import kotlinx.coroutines.channels.ClosedReceiveChannelException

/**
 * Raw Netty WebSocket session wrapper.
 *
 * Adapts a Netty Channel to our transport-agnostic WebSocketSession interface.
 * This bypasses Ktor's WebSocket layer for direct Netty performance.
 *
 * Threading model:
 * - Netty I/O thread calls channelRead0() which puts data into the receive channel
 * - Coroutine calls receive() which takes data from the channel
 * - Coroutine calls send() which writes to the Netty channel (thread-safe)
 */
class NettyWebSocketSession(
    private val ctx: ChannelHandlerContext
) : WebSocketSession {

    // Incoming binary frames - Netty I/O thread produces, coroutine consumes
    // Using a generous buffer to avoid blocking the I/O thread
    private val incoming = KChannel<ByteArray>(2000)

    // Track close state
    @Volatile
    private var closed = false

    /**
     * Called by Netty handler when a binary frame is received.
     * This is called from the Netty I/O thread.
     */
    fun onBinaryFrame(data: ByteArray) {
        if (!closed) {
            // Non-blocking offer - drop if buffer is full (shouldn't happen with large buffer)
            incoming.trySend(data)
        }
    }

    /**
     * Called by Netty handler when the channel is closed.
     */
    fun onClose() {
        closed = true
        incoming.close()
    }

    override suspend fun receive(): ByteArray? {
        return try {
            incoming.receive()
        } catch (e: ClosedReceiveChannelException) {
            null
        }
    }

    override suspend fun send(data: ByteArray) {
        if (closed) return

        val buf = Unpooled.wrappedBuffer(data)
        val frame = BinaryWebSocketFrame(buf)
        ctx.writeAndFlush(frame)
    }

    override suspend fun close(code: Int, reason: String) {
        if (closed) return
        closed = true

        val frame = CloseWebSocketFrame(code, reason)
        ctx.writeAndFlush(frame).addListener { incoming.close() }
    }

    override val isOpen: Boolean
        get() = !closed && ctx.channel().isActive

    /**
     * Access the underlying Netty channel for advanced operations.
     */
    val channel: Channel get() = ctx.channel()
}
