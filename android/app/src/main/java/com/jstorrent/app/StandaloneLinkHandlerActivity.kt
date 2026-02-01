package com.jstorrent.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log

private const val TAG = "StandaloneLinkHandler"

/**
 * Transparent trampoline activity for handling magnet links and torrent files in standalone mode.
 *
 * This is the standalone counterpart to [LinkHandlerActivity] (which handles extension mode).
 * Both are thin routing layers that:
 * - Have no UI (transparent theme, finish immediately)
 * - Pre-read torrent files while we have URI permission
 * - Forward to the appropriate destination
 *
 * On Chromebook, Android shows both handlers in the chooser:
 * - "JSTorrent (Extension)" -> LinkHandlerActivity -> extension/bridge
 * - "JSTorrent (Standalone)" -> StandaloneLinkHandlerActivity -> NativeStandaloneActivity
 *
 * On non-Chromebook devices, only this handler is relevant (LinkHandlerActivity also
 * routes to standalone, but having both registered doesn't hurt).
 */
class StandaloneLinkHandlerActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val uri = intent?.data
        if (uri == null) {
            Log.w(TAG, "No URI in intent")
            finish()
            return
        }

        Log.d(TAG, "Received intent: $uri")

        // Read torrent file now (we have URI permission) and pass as extra
        // This avoids permission issues when forwarding content:// URIs
        var torrentBase64: String? = null
        if (uri.scheme == "content" || uri.scheme == "file") {
            try {
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                if (bytes != null) {
                    torrentBase64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    Log.i(TAG, "Read torrent file: ${bytes.size} bytes")
                } else {
                    Log.e(TAG, "Failed to read torrent file: openInputStream returned null")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to read torrent file", e)
            }
        }

        // Forward to NativeStandaloneActivity
        startActivity(Intent(this, NativeStandaloneActivity::class.java).apply {
            if (torrentBase64 != null) {
                putExtra("torrent_base64", torrentBase64)
            } else {
                data = uri  // Magnet links pass through as URI
            }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
        })

        // Always finish immediately - this activity has no UI
        finish()
    }
}
