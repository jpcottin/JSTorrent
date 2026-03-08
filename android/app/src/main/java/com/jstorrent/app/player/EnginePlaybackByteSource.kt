package com.jstorrent.app.player

import com.jstorrent.quickjs.EngineController
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Thin Android-side adapter around the QuickJS playback session bridge.
 *
 * Each instance owns one JS playback session and is expected to back exactly
 * one native player instance.
 */
class EnginePlaybackByteSource private constructor(
    private val controller: EngineController,
    private val sessionId: String,
    override val fileSize: Long
) : TorrentByteSource {

    private val closed = AtomicBoolean(false)

    override suspend fun read(offset: Long, length: Int): ByteArray {
        check(!closed.get()) { "Playback byte source is closed" }
        if (length <= 0) return ByteArray(0)
        return controller.readPlaybackBytesAsync(sessionId, offset, length)
    }

    override fun close() {
        if (closed.compareAndSet(false, true)) {
            controller.closePlaybackSession(sessionId)
        }
    }

    companion object {
        suspend fun open(
            controller: EngineController,
            infoHash: String,
            fileIndex: Int
        ): EnginePlaybackByteSource {
            val sessionId = "android-player-${UUID.randomUUID()}"
            val info = controller.openPlaybackSessionAsync(sessionId, infoHash, fileIndex)
            val fileSize = info.fileSize
            if (!info.ok || fileSize == null || fileSize < 0) {
                throw IllegalStateException(info.error ?: "Failed to open playback session")
            }

            return EnginePlaybackByteSource(
                controller = controller,
                sessionId = sessionId,
                fileSize = fileSize
            )
        }
    }
}
