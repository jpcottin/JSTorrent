package com.jstorrent.app.notification

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.widget.Toast
import androidx.core.app.NotificationManagerCompat
import com.jstorrent.app.util.FileOpener

private const val TAG = "OpenFolderActivity"

/**
 * Trampoline activity to open a folder and dismiss the notification.
 *
 * This is needed because:
 * 1. Notification action buttons don't auto-cancel the notification
 * 2. Starting activities from BroadcastReceivers is blocked by BAL restrictions
 *
 * This activity is transparent and finishes immediately after launching the file manager.
 */
class OpenFolderActivity : Activity() {

    companion object {
        const val EXTRA_FOLDER_URI = "folder_uri"
        const val EXTRA_NOTIFICATION_ID = "notification_id"
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val folderUriString = intent.getStringExtra(EXTRA_FOLDER_URI)
        val notificationId = intent.getIntExtra(EXTRA_NOTIFICATION_ID, -1)

        Log.i(TAG, "Opening folder: $folderUriString, notificationId: $notificationId")

        // Cancel the notification
        if (notificationId != -1) {
            NotificationManagerCompat.from(this).cancel(notificationId)
        }

        // Open the folder
        if (folderUriString != null) {
            val result = FileOpener.openFolderByUri(this, Uri.parse(folderUriString))
            if (!result.ok) {
                Toast.makeText(this, result.error ?: "Could not open folder", Toast.LENGTH_SHORT).show()
            }
        }

        // Finish immediately - this activity has no UI
        finish()
    }
}
