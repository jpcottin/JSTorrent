package com.jstorrent.app.storage

import android.net.Uri
import android.provider.DocumentsContract
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * A user-selected download folder.
 * Mirrors the desktop DownloadRoot structure for API compatibility.
 */
@Serializable
data class DownloadRoot(
    /** Opaque key: sha256(salt + uri.toString()), first 16 hex chars */
    val key: String,

    /** SAF tree URI (e.g., content://com.android.externalstorage.documents/tree/...) */
    val uri: String,

    /** User-friendly label extracted from URI path */
    @SerialName("display_name")
    val displayName: String,

    /** Whether this is removable storage (SD card, USB) */
    val removable: Boolean = false,

    /** Last availability check result */
    @SerialName("last_stat_ok")
    val lastStatOk: Boolean = true,

    /** Timestamp of last availability check (epoch millis) */
    @SerialName("last_checked")
    val lastChecked: Long = System.currentTimeMillis(),

    /** Storage volume identifier extracted from SAF tree URI.
     *  "primary" for internal storage, UUID (e.g., "0815-4711") for SD cards. */
    @SerialName("volume_id")
    val volumeId: String = ""
) {
    companion object {
        /**
         * Extract the storage volume ID from a SAF tree URI.
         * Uses DocumentsContract to get the tree document ID, then takes the prefix before ':'.
         * Returns "primary" for internal storage, a UUID for SD cards/USB drives.
         */
        fun extractVolumeId(treeUri: Uri): String {
            return try {
                val docId = DocumentsContract.getTreeDocumentId(treeUri)
                docId?.substringBefore(':') ?: ""
            } catch (_: Exception) {
                ""
            }
        }
    }
}
