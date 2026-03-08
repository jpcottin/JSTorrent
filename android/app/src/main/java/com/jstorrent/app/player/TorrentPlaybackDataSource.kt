package com.jstorrent.app.player

import android.net.Uri
import androidx.media3.common.C
import androidx.media3.datasource.BaseDataSource
import androidx.media3.datasource.DataSource
import androidx.media3.datasource.DataSpec
import com.jstorrent.app.JSTorrentApplication
import kotlin.math.min
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

/**
 * Media3 DataSource backed by a torrent file playback session in QuickJS.
 *
 * Media3 expects blocking reads here, so the suspend torrent bridge is adapted
 * with runBlocking on the player loader thread.
 */
class TorrentPlaybackDataSource(
    private val app: JSTorrentApplication,
    private val request: PlayerLaunchRequest
) : BaseDataSource(false) {

    private var currentUri: Uri? = null
    private var byteSource: EnginePlaybackByteSource? = null
    private var opened = false
    private var readPosition = 0L
    private var bytesRemaining = 0L

    override fun open(dataSpec: DataSpec): Long {
        check(!opened) { "DataSource already opened" }

        transferInitializing(dataSpec)
        currentUri = dataSpec.uri

        val source = runBlocking(Dispatchers.IO) {
            val controller = app.ensureEngineStarted()
            EnginePlaybackByteSource.open(controller, request.infoHash, request.fileIndex)
        }

        val fileSize = source.fileSize
        val startPosition = dataSpec.position
        require(startPosition >= 0) { "Negative playback position: $startPosition" }
        require(startPosition <= fileSize) {
            "Playback position $startPosition beyond file size $fileSize"
        }

        val requestedLength = dataSpec.length
        val resolvedLength = if (requestedLength == C.LENGTH_UNSET.toLong()) {
            fileSize - startPosition
        } else {
            min(requestedLength, fileSize - startPosition)
        }

        byteSource = source
        readPosition = startPosition
        bytesRemaining = resolvedLength
        opened = true
        transferStarted(dataSpec)
        return resolvedLength
    }

    override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
        if (length == 0) return 0
        if (bytesRemaining == 0L) return C.RESULT_END_OF_INPUT

        val source = byteSource ?: return C.RESULT_END_OF_INPUT
        val bytesToRead = min(length.toLong(), bytesRemaining).toInt()
        val chunk = runBlocking(Dispatchers.IO) {
            source.read(readPosition, bytesToRead)
        }

        if (chunk.isEmpty()) {
            bytesRemaining = 0L
            return C.RESULT_END_OF_INPUT
        }

        System.arraycopy(chunk, 0, buffer, offset, chunk.size)
        readPosition += chunk.size
        bytesRemaining -= chunk.size
        bytesTransferred(chunk.size)
        return chunk.size
    }

    override fun getUri(): Uri? = currentUri

    override fun close() {
        byteSource?.close()
        byteSource = null
        currentUri = null
        readPosition = 0L
        bytesRemaining = 0L

        if (opened) {
            opened = false
            transferEnded()
        }
    }
}

class TorrentPlaybackDataSourceFactory(
    private val app: JSTorrentApplication,
    private val request: PlayerLaunchRequest
) : DataSource.Factory {
    override fun createDataSource(): DataSource {
        return TorrentPlaybackDataSource(app, request)
    }
}
