package com.jstorrent.app.player

import com.jstorrent.app.viewmodel.TorrentRepository

data class PlaybackPreparationInput(
    val infoHash: String,
    val fileIndex: Int,
    val filePath: String,
    val isFileSelected: Boolean,
    val torrentUserState: String = "active",
    val torrentStatus: String
)

data class PlaybackPreparationResult(
    val fileUnskipped: Boolean,
    val torrentStarted: Boolean
)

/**
 * Mirrors the desktop playback-prep policy in Android-friendly terms.
 *
 * This class intentionally stays player-agnostic. It only prepares the torrent
 * and file state so a later Media3-backed player can consume the file.
 */
class TorrentPlaybackCoordinator(
    private val repository: TorrentRepository
) {

    fun prepareForPlayback(input: PlaybackPreparationInput): PlaybackPreparationResult {
        val fileUnskipped = !input.isFileSelected
        if (fileUnskipped) {
            repository.setFilePriorities(input.infoHash, mapOf(input.fileIndex to 0))
        }

        val torrentStarted = shouldStartForPlayback(input.torrentUserState, input.torrentStatus)
        if (torrentStarted) {
            repository.resumeTorrent(input.infoHash)
        }

        return PlaybackPreparationResult(
            fileUnskipped = fileUnskipped,
            torrentStarted = torrentStarted
        )
    }

    companion object {
        fun shouldStartForPlayback(
            torrentUserState: String,
            torrentStatus: String
        ): Boolean {
            return torrentUserState != "active" || torrentStatus == "error"
        }
    }
}
