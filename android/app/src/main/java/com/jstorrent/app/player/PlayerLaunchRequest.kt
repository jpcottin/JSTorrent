package com.jstorrent.app.player

import android.content.Context
import android.content.Intent

data class PlayerLaunchRequest(
    val infoHash: String,
    val fileIndex: Int,
    val filePath: String,
    val fileName: String,
    val isFileSelected: Boolean,
    val torrentUserState: String = "active",
    val torrentStatus: String
)

object PlayerActivityLauncher {
    private const val EXTRA_INFO_HASH = "info_hash"
    private const val EXTRA_FILE_INDEX = "file_index"
    private const val EXTRA_FILE_PATH = "file_path"
    private const val EXTRA_FILE_NAME = "file_name"
    private const val EXTRA_FILE_SELECTED = "file_selected"
    private const val EXTRA_TORRENT_USER_STATE = "torrent_user_state"
    private const val EXTRA_TORRENT_STATUS = "torrent_status"

    fun createIntent(
        context: Context,
        request: PlayerLaunchRequest
    ): Intent {
        return Intent(context, PlayerActivity::class.java).apply {
            putExtra(EXTRA_INFO_HASH, request.infoHash)
            putExtra(EXTRA_FILE_INDEX, request.fileIndex)
            putExtra(EXTRA_FILE_PATH, request.filePath)
            putExtra(EXTRA_FILE_NAME, request.fileName)
            putExtra(EXTRA_FILE_SELECTED, request.isFileSelected)
            putExtra(EXTRA_TORRENT_USER_STATE, request.torrentUserState)
            putExtra(EXTRA_TORRENT_STATUS, request.torrentStatus)
        }
    }

    fun fromIntent(intent: Intent): PlayerLaunchRequest? {
        val infoHash = intent.getStringExtra(EXTRA_INFO_HASH) ?: return null
        val filePath = intent.getStringExtra(EXTRA_FILE_PATH) ?: return null
        val fileName = intent.getStringExtra(EXTRA_FILE_NAME) ?: return null
        val torrentStatus = intent.getStringExtra(EXTRA_TORRENT_STATUS) ?: return null

        return PlayerLaunchRequest(
            infoHash = infoHash,
            fileIndex = intent.getIntExtra(EXTRA_FILE_INDEX, -1),
            filePath = filePath,
            fileName = fileName,
            isFileSelected = intent.getBooleanExtra(EXTRA_FILE_SELECTED, true),
            torrentUserState = intent.getStringExtra(EXTRA_TORRENT_USER_STATE) ?: "active",
            torrentStatus = torrentStatus
        ).takeIf { it.fileIndex >= 0 }
    }
}
