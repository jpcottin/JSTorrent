package com.jstorrent.app.player

import android.content.Context
import android.content.Intent
import android.net.Uri

data class PlayerLaunchRequest(
    val infoHash: String,
    val fileIndex: Int,
    val filePath: String,
    val fileName: String,
    val isFileSelected: Boolean,
    val torrentUserState: String = "active",
    val torrentStatus: String
)

data class LocalPlaybackRequest(
    val uri: Uri,
    val title: String,
    val mimeType: String? = null
)

object PlayerActivityLauncher {
    private const val EXTRA_INFO_HASH = "info_hash"
    private const val EXTRA_FILE_INDEX = "file_index"
    private const val EXTRA_FILE_PATH = "file_path"
    private const val EXTRA_FILE_NAME = "file_name"
    private const val EXTRA_FILE_SELECTED = "file_selected"
    private const val EXTRA_TORRENT_USER_STATE = "torrent_user_state"
    private const val EXTRA_TORRENT_STATUS = "torrent_status"
    private const val EXTRA_LOCAL_URI = "local_uri"
    private const val EXTRA_LOCAL_TITLE = "local_title"
    private const val EXTRA_LOCAL_MIME_TYPE = "local_mime_type"

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

    fun createLocalIntent(
        context: Context,
        request: LocalPlaybackRequest
    ): Intent {
        return Intent(context, PlayerActivity::class.java).apply {
            data = request.uri
            putExtra(EXTRA_LOCAL_URI, request.uri.toString())
            putExtra(EXTRA_LOCAL_TITLE, request.title)
            putExtra(EXTRA_LOCAL_MIME_TYPE, request.mimeType)
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
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

    fun localFromIntent(intent: Intent): LocalPlaybackRequest? {
        val uri = intent.getStringExtra(EXTRA_LOCAL_URI)?.let(Uri::parse)
            ?: intent.data
            ?: return null
        val title = intent.getStringExtra(EXTRA_LOCAL_TITLE)
            ?: uri.lastPathSegment
            ?: "Video"
        return LocalPlaybackRequest(
            uri = uri,
            title = title,
            mimeType = intent.getStringExtra(EXTRA_LOCAL_MIME_TYPE) ?: intent.type
        )
    }

    fun buildPlaybackUri(request: PlayerLaunchRequest): Uri {
        return Uri.Builder()
            .scheme("jstorrent")
            .authority("playback")
            .appendPath(request.infoHash)
            .appendPath(request.fileName)
            .build()
    }
}
