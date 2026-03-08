package com.jstorrent.app.player

import com.jstorrent.app.viewmodel.FakeTorrentRepository
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class TorrentPlaybackCoordinatorTest {

    private lateinit var repository: FakeTorrentRepository
    private lateinit var coordinator: TorrentPlaybackCoordinator

    @Before
    fun setup() {
        repository = FakeTorrentRepository()
        coordinator = TorrentPlaybackCoordinator(repository)
    }

    @Test
    fun `prepareForPlayback unskips file and resumes stopped torrent`() {
        val result = coordinator.prepareForPlayback(
            PlaybackPreparationInput(
                infoHash = "abc123",
                fileIndex = 7,
                filePath = "movie.mkv",
                isFileSelected = false,
                torrentUserState = "stopped",
                torrentStatus = "stopped"
            )
        )

        assertTrue(result.fileUnskipped)
        assertTrue(result.torrentStarted)
        assertEquals(listOf("abc123" to mapOf(7 to 0)), repository.filePriorityUpdates)
        assertEquals(listOf("abc123"), repository.resumedTorrents)
    }

    @Test
    fun `prepareForPlayback does nothing for already-active selected file`() {
        val result = coordinator.prepareForPlayback(
            PlaybackPreparationInput(
                infoHash = "abc123",
                fileIndex = 3,
                filePath = "movie.mp4",
                isFileSelected = true,
                torrentUserState = "active",
                torrentStatus = "downloading"
            )
        )

        assertFalse(result.fileUnskipped)
        assertFalse(result.torrentStarted)
        assertTrue(repository.filePriorityUpdates.isEmpty())
        assertTrue(repository.resumedTorrents.isEmpty())
    }

    @Test
    fun `prepareForPlayback resumes errored active torrent`() {
        val result = coordinator.prepareForPlayback(
            PlaybackPreparationInput(
                infoHash = "abc123",
                fileIndex = 1,
                filePath = "movie.webm",
                isFileSelected = true,
                torrentUserState = "active",
                torrentStatus = "error"
            )
        )

        assertFalse(result.fileUnskipped)
        assertTrue(result.torrentStarted)
        assertEquals(listOf("abc123"), repository.resumedTorrents)
    }
}
