package com.jstorrent.app.player

/**
 * Player-facing byte source abstraction for torrent-backed reads.
 *
 * This keeps the torrent playback path independent of Media3 so the same logic
 * can later back a custom DataSource.
 */
interface TorrentByteSource : AutoCloseable {
    val fileSize: Long

    suspend fun read(offset: Long, length: Int): ByteArray

    override fun close()
}
