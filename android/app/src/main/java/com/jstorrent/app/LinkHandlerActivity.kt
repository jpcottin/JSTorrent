package com.jstorrent.app

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import android.util.Log
import com.jstorrent.app.auth.TokenStore
import com.jstorrent.app.link.PendingLinkManager
import com.jstorrent.app.mode.ModeDetector
import com.jstorrent.app.service.IoDaemonService

private const val TAG = "LinkHandlerActivity"
private const val EXTENSION_URL = "https://new.jstorrent.com/launch"

/**
 * Unified link handler for magnet links and torrent files.
 *
 * This activity has no UI and finishes immediately after processing the intent.
 * It routes to the appropriate mode based on platform and current app state:
 *
 * Routing logic:
 * - Non-Chromebook: Always route to standalone (NativeStandaloneActivity)
 * - Chromebook:
 *   - If standalone is active (NativeStandaloneActivity in foreground): route to standalone
 *   - If companion has active connection: route to companion (extension bridge)
 *   - Otherwise: use user preference (TokenStore.preferStandaloneOnChromebook)
 */
class LinkHandlerActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val uri = intent?.data
        if (uri == null) {
            Log.w(TAG, "No URI in intent")
            finish()
            return
        }

        Log.d(TAG, "Received intent: $uri")

        val isChromebook = ModeDetector.isChromebook(this)

        if (!isChromebook) {
            // Non-Chromebook: always standalone
            Log.i(TAG, "Non-Chromebook device, routing to standalone")
            handleStandaloneIntent(uri)
        } else {
            // Chromebook: smart routing based on current state
            val routeToStandalone = when {
                // Standalone is currently in foreground
                NativeStandaloneActivity.isActive -> {
                    Log.i(TAG, "Chromebook: Standalone is active, routing to standalone")
                    true
                }
                // Companion has active connection to extension
                IoDaemonService.instance?.hasActiveControlConnection() == true -> {
                    Log.i(TAG, "Chromebook: Companion connection active, routing to companion")
                    false
                }
                // Neither running: use user preference
                else -> {
                    val preferStandalone = TokenStore(this).preferStandaloneOnChromebook
                    Log.i(TAG, "Chromebook: Neither mode active, using preference (standalone=$preferStandalone)")
                    preferStandalone
                }
            }

            if (routeToStandalone) {
                handleStandaloneIntent(uri)
            } else {
                handleCompanionIntent(uri)
            }
        }

        // Always finish immediately - this activity has no UI
        finish()
    }

    /**
     * Companion mode: Process link via IoDaemonService to bridge to extension.
     */
    private fun handleCompanionIntent(uri: Uri) {
        // Ensure service is running
        IoDaemonService.start(this)

        when {
            uri.scheme == "magnet" -> {
                Log.i(TAG, "Companion: Magnet link")
                handleMagnetLink(uri.toString())
            }
            uri.scheme == "file" || uri.scheme == "content" -> {
                Log.i(TAG, "Companion: Torrent file")
                handleTorrentFile(uri)
            }
            else -> {
                Log.w(TAG, "Companion: Unknown URI scheme: ${uri.scheme}")
            }
        }
    }

    /**
     * Standalone mode: Forward to native standalone activity.
     */
    private fun handleStandaloneIntent(uri: Uri) {
        Log.i(TAG, "Standalone: Forwarding to native activity")

        // For torrent files: read now (we have URI permission), write to a temp file,
        // and pass the path. We can't pass the data as an intent extra because large
        // .torrent files cause TransactionTooLargeException (Android's ~500KB Binder limit).
        var torrentTempPath: String? = null
        if (uri.scheme == "content" || uri.scheme == "file") {
            try {
                val bytes = contentResolver.openInputStream(uri)?.use { it.readBytes() }
                if (bytes != null) {
                    val tempFile = java.io.File(cacheDir, "pending_torrent.dat")
                    tempFile.writeBytes(bytes)
                    torrentTempPath = tempFile.absolutePath
                    Log.i(TAG, "Read torrent file: ${bytes.size} bytes, saved to $torrentTempPath")
                } else {
                    Log.e(TAG, "Failed to read torrent file: openInputStream returned null")
                }
            } catch (e: Exception) {
                Log.e(TAG, "Failed to read torrent file", e)
            }
        }

        // Use FLAG_ACTIVITY_NEW_TASK only (not CLEAR_TASK). NativeStandaloneActivity has
        // singleTask launch mode, so the system will either deliver this intent via onNewIntent
        // to an existing instance, or create a new one. CLEAR_TASK would destroy a running
        // instance (triggering engine shutdown) before recreating it.
        startActivity(Intent(this, NativeStandaloneActivity::class.java).apply {
            if (torrentTempPath != null) {
                putExtra("torrent_temp_path", torrentTempPath)
                // Pass filename for immediate UI display while engine parses the torrent
                val displayName = queryDisplayName(uri)?.removeSuffix(".torrent")
                if (displayName != null) {
                    putExtra("torrent_display_name", displayName)
                }
            } else {
                data = uri  // Magnet links pass through as URI
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
            }
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        })
    }

    private fun handleMagnetLink(magnetLink: String) {
        val service = IoDaemonService.instance

        if (service?.hasActiveControlConnection() == true) {
            // Connection exists - send immediately
            Log.i(TAG, "Control connection active, sending magnet immediately")
            service.sendMagnetAdded(magnetLink)
        } else {
            // No connection - queue link and launch extension
            Log.i(TAG, "No control connection, queuing magnet and launching extension")
            PendingLinkManager.addMagnet(magnetLink)
            launchExtension()
        }
    }

    private fun handleTorrentFile(uri: Uri) {
        // Read torrent file and encode as base64
        val name = uri.lastPathSegment ?: "unknown.torrent"
        val bytes = try {
            contentResolver.openInputStream(uri)?.use { it.readBytes() }
        } catch (e: Exception) {
            Log.e(TAG, "Failed to read torrent file: ${e.message}")
            return
        }

        if (bytes == null) {
            Log.e(TAG, "Failed to read torrent file: empty content")
            return
        }

        val contentsBase64 = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)

        val service = IoDaemonService.instance

        if (service?.hasActiveControlConnection() == true) {
            Log.i(TAG, "Control connection active, sending torrent immediately")
            service.sendTorrentAdded(name, contentsBase64)
        } else {
            Log.i(TAG, "No control connection, queuing torrent and launching extension")
            PendingLinkManager.addTorrent(name, contentsBase64)
            launchExtension()
        }
    }

    /**
     * Launch the extension page in Chrome browser.
     */
    private fun launchExtension() {
        // Target Chrome explicitly - on ChromeOS this opens in the real Chrome browser
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(EXTENSION_URL)).apply {
            setPackage("com.android.chrome")
        }
        try {
            startActivity(intent)
            Log.i(TAG, "Launched extension: $EXTENSION_URL")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch Chrome, trying default browser", e)
            // Fallback to default browser if Chrome not available
            val fallbackIntent = Intent(Intent.ACTION_VIEW, Uri.parse(EXTENSION_URL))
            startActivity(fallbackIntent)
        }
    }

    /** Query the content provider for the human-readable filename (content:// URIs). */
    private fun queryDisplayName(uri: Uri): String? {
        if (uri.scheme == "file") return uri.lastPathSegment
        return try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)?.use { cursor ->
                if (cursor.moveToFirst()) cursor.getString(0) else null
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to query display name for $uri", e)
            uri.lastPathSegment  // fallback
        }
    }
}
