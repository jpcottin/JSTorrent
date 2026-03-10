package com.jstorrent.companion.server

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Test

class HttpStreamSessionsTest {

    @Test
    fun `resolveHttpByteRange handles open ended range`() {
        val range = resolveHttpByteRange("bytes=100-", 1000)

        assertNotNull(range)
        assertEquals(100L, range!!.start)
        assertEquals(999L, range.endInclusive)
        assertEquals(900L, range.contentLength)
        assertEquals(true, range.partial)
    }

    @Test
    fun `resolveHttpByteRange handles suffix range`() {
        val range = resolveHttpByteRange("bytes=-128", 1000)

        assertNotNull(range)
        assertEquals(872L, range!!.start)
        assertEquals(999L, range.endInclusive)
        assertEquals(128L, range.contentLength)
    }

    @Test
    fun `resolveHttpByteRange rejects multipart range`() {
        val range = resolveHttpByteRange("bytes=0-99,200-299", 1000)
        assertNull(range)
    }

    @Test
    fun `registry revokes streams owned by disconnected session`() {
        val registry = HttpStreamSessionRegistry()

        registry.register(
            ownerId = "owner-a",
            token = "token-a",
            torrentId = "torrent-a",
            fileIndex = 0,
            rootKey = "root",
            path = "video.mp4",
            fileSize = 1234,
            mimeType = "video/mp4",
        )
        registry.register(
            ownerId = "owner-b",
            token = "token-b",
            torrentId = "torrent-b",
            fileIndex = 1,
            rootKey = "root",
            path = "other.mp4",
            fileSize = 5678,
            mimeType = "video/mp4",
        )

        assertNotNull(registry.getAndTouch("token-a"))
        assertNotNull(registry.getAndTouch("token-b"))

        val removed = registry.revokeOwnedBy("owner-a")

        assertEquals(1, removed)
        assertNull(registry.getAndTouch("token-a"))
        assertNotNull(registry.getAndTouch("token-b"))
    }

    @Test
    fun `registry revokes all streams for a removed torrent`() {
        val registry = HttpStreamSessionRegistry()

        registry.register(
            ownerId = "owner-a",
            token = "token-a",
            torrentId = "torrent-a",
            fileIndex = 0,
            rootKey = "root",
            path = "video.mp4",
            fileSize = 1234,
            mimeType = "video/mp4",
        )
        registry.register(
            ownerId = "owner-b",
            token = "token-b",
            torrentId = "torrent-a",
            fileIndex = 1,
            rootKey = "root",
            path = "other.mp4",
            fileSize = 5678,
            mimeType = "video/mp4",
        )
        registry.register(
            ownerId = "owner-c",
            token = "token-c",
            torrentId = "torrent-c",
            fileIndex = 2,
            rootKey = "root",
            path = "third.mp4",
            fileSize = 999,
            mimeType = "video/mp4",
        )

        val removed = registry.revokeTorrent("torrent-a")

        assertEquals(2, removed)
        assertNull(registry.getAndTouch("token-a"))
        assertNull(registry.getAndTouch("token-b"))
        assertNotNull(registry.getAndTouch("token-c"))
    }
}
