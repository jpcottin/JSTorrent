package com.jstorrent.companion.server.websocket

import io.ktor.server.websocket.DefaultWebSocketServerSession
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readBytes
import kotlinx.coroutines.channels.ClosedReceiveChannelException

/**
 * Ktor/Netty WebSocket session wrapper.
 *
 * Adapts Ktor's DefaultWebSocketServerSession to our transport-agnostic
 * WebSocketSession interface.
 */
class KtorWebSocketSession(
    private val ktorSession: DefaultWebSocketServerSession
) : WebSocketSession {

    override suspend fun receive(): ByteArray? {
        return try {
            for (frame in ktorSession.incoming) {
                if (frame is Frame.Binary) {
                    return frame.readBytes()
                }
                // Ignore non-binary frames (text, ping, pong, etc.)
            }
            // Channel exhausted = connection closed
            null
        } catch (e: ClosedReceiveChannelException) {
            null
        }
    }

    override suspend fun send(data: ByteArray) {
        ktorSession.send(Frame.Binary(true, data))
    }

    override suspend fun close(code: Int, reason: String) {
        val closeCode = when (code) {
            1000 -> CloseReason.Codes.NORMAL
            1001 -> CloseReason.Codes.GOING_AWAY
            1002 -> CloseReason.Codes.PROTOCOL_ERROR
            1003 -> CloseReason.Codes.CANNOT_ACCEPT
            1008 -> CloseReason.Codes.VIOLATED_POLICY
            1009 -> CloseReason.Codes.TOO_BIG
            1011 -> CloseReason.Codes.INTERNAL_ERROR
            1012 -> CloseReason.Codes.SERVICE_RESTART
            1013 -> CloseReason.Codes.TRY_AGAIN_LATER
            else -> CloseReason.Codes.NORMAL
        }
        ktorSession.close(CloseReason(closeCode, reason))
    }

    override val isOpen: Boolean
        get() = !ktorSession.incoming.isClosedForReceive

    /**
     * Access the underlying Ktor session for Ktor-specific operations.
     * Used during migration when full abstraction isn't needed.
     */
    val underlying: DefaultWebSocketServerSession get() = ktorSession
}
