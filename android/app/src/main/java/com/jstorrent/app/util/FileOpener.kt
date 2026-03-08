package com.jstorrent.app.util

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.content.pm.LabeledIntent
import android.net.Uri
import android.os.Build
import android.provider.DocumentsContract
import android.util.Log
import android.webkit.MimeTypeMap
import androidx.documentfile.provider.DocumentFile
import com.jstorrent.app.R
import com.jstorrent.app.player.LocalPlaybackRequest
import com.jstorrent.app.player.PlayerActivityLauncher
import com.jstorrent.app.storage.RootStore

private const val TAG = "FileOpener"

/**
 * Shared utility for opening files and folders via Android intents.
 * Consolidates duplicated file/folder opening logic from TorrentDetailScreen,
 * OpenFolderActivity, NotificationActionReceiver, and StorageSettingsScreen.
 */
object FileOpener {

    data class Result(val ok: Boolean, val error: String? = null)

    private fun shouldLaunchInNewTask(context: Context): Boolean = context !is Activity

    /**
     * Open a file with the system's default application.
     * Resolves rootKey via RootStore and navigates the DocumentFile tree to find the file.
     */
    fun openFile(context: Context, rootKey: String, path: String): Result {
        val rootStore = RootStore(context)
        val rootUri = rootStore.resolveKey(rootKey)
            ?: return Result(false, "Storage root not found")

        val pathParts = path.split("/")
        var docFile: DocumentFile? = DocumentFile.fromTreeUri(context, rootUri)

        for (part in pathParts) {
            docFile = docFile?.findFile(part)
            if (docFile == null) break
        }

        if (docFile == null || !docFile.exists()) {
            return Result(false, "File not found")
        }

        return try {
            val mimeType = getMimeType(path)
            val useNewTask = shouldLaunchInNewTask(context)
            val intent = Intent(Intent.ACTION_VIEW).apply {
                setDataAndType(docFile.uri, mimeType)
                clipData = ClipData.newUri(context.contentResolver, docFile.name ?: path, docFile.uri)
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                if (useNewTask) {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            }
            val chooser = Intent.createChooser(intent, "Open with").apply {
                if (useNewTask) {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
            }
            if (mimeType.startsWith("video/")) {
                val playerIntent = PlayerActivityLauncher.createLocalIntent(
                    context,
                    LocalPlaybackRequest(
                        uri = docFile.uri,
                        title = docFile.name ?: path.substringAfterLast('/'),
                        mimeType = mimeType
                    )
                ).apply {
                    clipData = ClipData.newUri(
                        context.contentResolver,
                        docFile.name ?: path,
                        docFile.uri
                    )
                    if (useNewTask) {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    }
                }
                val labeledPlayerIntent = LabeledIntent(
                    playerIntent,
                    context.packageName,
                    R.string.app_name,
                    R.mipmap.ic_launcher
                )
                chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS, arrayOf(labeledPlayerIntent))
            }
            context.startActivity(chooser)
            Result(true)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to open file: ${e.message}")
            Result(false, e.message ?: "Failed to open file")
        }
    }

    /**
     * Open the root folder for a given rootKey in a file manager.
     */
    fun openFolder(context: Context, rootKey: String): Result {
        val rootStore = RootStore(context)
        val rootUri = rootStore.resolveKey(rootKey)
            ?: return Result(false, "Storage root not found")
        return openFolderByUri(context, rootUri)
    }

    /**
     * Reveal a file's containing folder. For a path like "Ubuntu/ubuntu.iso",
     * opens the "Ubuntu" subfolder. For a single-segment path, opens the root.
     */
    fun revealInFolder(context: Context, rootKey: String, path: String): Result {
        val rootStore = RootStore(context)
        val rootUri = rootStore.resolveKey(rootKey)
            ?: return Result(false, "Storage root not found")

        val pathParts = path.split("/")
        if (pathParts.size <= 1) {
            // Single file at root - just open the root folder
            return openFolderByUri(context, rootUri)
        }

        // Navigate to parent directory
        val parentParts = pathParts.dropLast(1)
        var docFile: DocumentFile? = DocumentFile.fromTreeUri(context, rootUri)
        for (part in parentParts) {
            docFile = docFile?.findFile(part)
            if (docFile == null) break
        }

        if (docFile == null || !docFile.exists()) {
            // Parent not found, fall back to root
            return openFolderByUri(context, rootUri)
        }

        return openFolderByUri(context, docFile.uri)
    }

    /**
     * Open a folder by its SAF URI using a 3-tier fallback strategy:
     * 1. DocumentsContract (Android 11+)
     * 2. Google Files app
     * 3. Generic chooser
     */
    fun openFolderByUri(context: Context, folderUri: Uri): Result {
        val docFile = DocumentFile.fromTreeUri(context, folderUri)
        if (docFile == null || !docFile.exists()) {
            return Result(false, "Folder not found")
        }

        // Try approach 1: DocumentsContract with proper document URI (Android 11+)
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            try {
                val documentId = DocumentsContract.getTreeDocumentId(folderUri)
                val documentUri = DocumentsContract.buildDocumentUriUsingTree(folderUri, documentId)
                val browseIntent = Intent(Intent.ACTION_VIEW).apply {
                    setDataAndType(documentUri, DocumentsContract.Document.MIME_TYPE_DIR)
                    addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(browseIntent)
                Log.i(TAG, "Opened folder with DocumentsContract approach")
                return Result(true)
            } catch (e: Exception) {
                Log.w(TAG, "DocumentsContract approach failed", e)
            }
        }

        // Try approach 2: Google Files app (common on Pixel/ChromeOS)
        try {
            val filesIntent = Intent(Intent.ACTION_VIEW).apply {
                setPackage("com.google.android.apps.nbu.files")
                data = docFile.uri
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(filesIntent)
            Log.i(TAG, "Opened folder with Google Files app")
            return Result(true)
        } catch (e: Exception) {
            Log.w(TAG, "Google Files approach failed", e)
        }

        // Try approach 3: Generic file manager with chooser
        try {
            val viewIntent = Intent(Intent.ACTION_VIEW).apply {
                data = docFile.uri
                addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            val chooser = Intent.createChooser(viewIntent, "Open folder with").apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            }
            context.startActivity(chooser)
            Log.i(TAG, "Opened folder with chooser")
            return Result(true)
        } catch (e: Exception) {
            Log.w(TAG, "Chooser approach failed", e)
        }

        return Result(false, "Could not open folder")
    }

    /**
     * Get MIME type for a file based on its extension.
     * Falls back to Android's MimeTypeMap, then to wildcard.
     */
    fun getMimeType(fileName: String): String {
        val extension = fileName.substringAfterLast('.', "").lowercase()
        // Check common types first for reliable results
        val knownType = MIME_TYPES[extension]
        if (knownType != null) return knownType
        // Fall back to system MIME type map
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: "*/*"
    }

    private val MIME_TYPES = mapOf(
        // Video
        "mp4" to "video/mp4",
        "mkv" to "video/x-matroska",
        "avi" to "video/x-msvideo",
        "mov" to "video/quicktime",
        "wmv" to "video/x-ms-wmv",
        "flv" to "video/x-flv",
        "webm" to "video/webm",
        "m4v" to "video/x-m4v",
        // Audio
        "mp3" to "audio/mpeg",
        "flac" to "audio/flac",
        "wav" to "audio/wav",
        "aac" to "audio/aac",
        "ogg" to "audio/ogg",
        "m4a" to "audio/mp4",
        "wma" to "audio/x-ms-wma",
        // Images
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "png" to "image/png",
        "gif" to "image/gif",
        "bmp" to "image/bmp",
        "webp" to "image/webp",
        "svg" to "image/svg+xml",
        // Documents
        "pdf" to "application/pdf",
        "doc" to "application/msword",
        "docx" to "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "txt" to "text/plain",
        "rtf" to "application/rtf",
        // Archives
        "zip" to "application/zip",
        "rar" to "application/x-rar-compressed",
        "7z" to "application/x-7z-compressed",
        "tar" to "application/x-tar",
        "gz" to "application/gzip",
    )
}
