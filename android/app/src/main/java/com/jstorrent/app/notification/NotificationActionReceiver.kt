package com.jstorrent.app.notification

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import android.widget.Toast
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.app.service.ForegroundNotificationService
import com.jstorrent.app.util.FileOpener
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

private const val TAG = "NotificationActionReceiver"

/**
 * Handles notification action button clicks.
 *
 * Actions:
 * - PAUSE_ALL: Pause all active torrents
 * - RESUME_ALL: Resume all stopped torrents
 * - QUIT: Stop the engine service and exit
 * - OPEN_FOLDER: Open file manager at download folder
 */
class NotificationActionReceiver : BroadcastReceiver() {

    companion object {
        const val ACTION_PAUSE_ALL = "com.jstorrent.app.action.PAUSE_ALL"
        const val ACTION_RESUME_ALL = "com.jstorrent.app.action.RESUME_ALL"
        const val ACTION_QUIT = "com.jstorrent.app.action.QUIT"
        const val ACTION_OPEN_FOLDER = "com.jstorrent.app.action.OPEN_FOLDER"

        const val EXTRA_FOLDER_URI = "folder_uri"
    }

    override fun onReceive(context: Context, intent: Intent) {
        Log.i(TAG, "Received action: ${intent.action}")

        when (intent.action) {
            ACTION_PAUSE_ALL -> {
                Log.i(TAG, "Pausing all torrents")
                doAsync { pauseAllTorrents(context) }
            }
            ACTION_RESUME_ALL -> {
                Log.i(TAG, "Resuming all torrents")
                doAsync { resumeAllTorrents(context) }
            }
            ACTION_QUIT -> {
                Log.i(TAG, "Quitting app")
                val app = context.applicationContext as? JSTorrentApplication
                if (app != null) {
                    // Prevent service from auto-restarting
                    app.serviceLifecycleManager.onUserQuit()
                    // Shutdown the engine (preserves torrent states for next launch)
                    app.shutdownEngine()
                } else {
                    // Fallback if we can't get the app
                    ForegroundNotificationService.stop(context)
                }
            }
            ACTION_OPEN_FOLDER -> {
                val uriString = intent.getStringExtra(EXTRA_FOLDER_URI)
                Log.i(TAG, "Opening folder: $uriString")
                if (uriString != null) {
                    openFolder(context, Uri.parse(uriString))
                }
            }
        }
    }

    /**
     * Run a suspend block asynchronously while keeping the receiver alive.
     * Uses goAsync() to extend the receiver's lifetime beyond onReceive().
     */
    private fun doAsync(block: suspend () -> Unit) {
        val pendingResult = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                block()
            } finally {
                pendingResult.finish()
            }
        }
    }

    private fun openFolder(context: Context, folderUri: Uri) {
        val result = FileOpener.openFolderByUri(context, folderUri)
        if (!result.ok) {
            Toast.makeText(context, result.error ?: "Could not open folder", Toast.LENGTH_SHORT).show()
        }
    }

    /**
     * Pause all active torrents using the engine controller from the Application.
     * Works regardless of whether the ForegroundNotificationService is running.
     */
    private suspend fun pauseAllTorrents(context: Context) {
        val app = context.applicationContext as? JSTorrentApplication ?: return
        val controller = app.engineController ?: return
        val torrents = controller.state.value?.torrents ?: return

        torrents.forEach { torrent ->
            if (torrent.status != "stopped") {
                controller.pauseTorrentAsync(torrent.infoHash)
            }
        }
    }

    /**
     * Resume all stopped torrents using the engine controller from the Application.
     * Works regardless of whether the ForegroundNotificationService is running.
     */
    private suspend fun resumeAllTorrents(context: Context) {
        val app = context.applicationContext as? JSTorrentApplication ?: return
        val controller = app.engineController ?: return
        val torrents = controller.state.value?.torrents ?: return

        torrents.forEach { torrent ->
            if (torrent.status == "stopped") {
                controller.resumeTorrentAsync(torrent.infoHash)
            }
        }
    }
}
