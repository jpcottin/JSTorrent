package com.jstorrent.app.model

import com.jstorrent.quickjs.model.FileInfo
import com.jstorrent.quickjs.model.TorrentInfo
import com.jstorrent.quickjs.model.TorrentSummary
import java.util.BitSet

/**
 * UI state models for torrent screens.
 */

// =============================================================================
// Torrent List Screen
// =============================================================================

/**
 * State for the torrent list screen.
 */
sealed class TorrentListUiState {
    /**
     * Engine is starting up.
     */
    data object Loading : TorrentListUiState()

    /**
     * Engine is loaded, displaying torrents.
     *
     * @param torrents List of torrents to display
     * @param filter Current filter applied
     * @param sortOrder Current sort order
     * @param isLive True when engine is running and data is live, false when showing cached data.
     *               When false, speeds are stale (should show "—") and progress may be outdated.
     */
    data class Loaded(
        val torrents: List<TorrentSummary>,
        val filter: TorrentFilter,
        val sortOrder: TorrentSortOrder,
        val isLive: Boolean = true
    ) : TorrentListUiState()

    /**
     * Engine failed to load.
     */
    data class Error(val message: String) : TorrentListUiState()
}

/**
 * Filter options for torrent list.
 */
enum class TorrentFilter(val displayName: String) {
    /** Show all torrents */
    ALL("All"),
    /** Show downloading torrents (downloading, downloading_metadata, checking) */
    ACTIVE("Downloading"),
    /** Show completed torrents (seeding, stopped with progress = 1.0) */
    FINISHED("Finished")
}

/**
 * Sort order options for torrent list.
 */
enum class TorrentSortOrder {
    /** Alphabetical by name */
    NAME,
    /** By date added (newest first) */
    DATE_ADDED,
    /** By download speed (fastest first) */
    DOWNLOAD_SPEED
}

// =============================================================================
// Torrent Detail Screen
// =============================================================================

/**
 * State for the torrent detail screen.
 */
sealed class TorrentDetailUiState {
    /**
     * Loading torrent details.
     */
    data object Loading : TorrentDetailUiState()

    /**
     * Torrent details loaded.
     */
    data class Loaded(
        val torrent: TorrentDetailUi,
        val selectedTab: DetailTab,
        val hasPendingFileChanges: Boolean = false
    ) : TorrentDetailUiState()

    /**
     * Torrent not found or error loading.
     */
    data class Error(val message: String) : TorrentDetailUiState()
}

/**
 * Tabs in the torrent detail screen.
 */
enum class DetailTab {
    DETAILS,
    STATUS,
    FILES,
    TRACKERS,
    PEERS,
    PIECES
}

/**
 * UI model for torrent details.
 * Combines engine data with derived/formatted values.
 */
data class TorrentDetailUi(
    val infoHash: String,
    val name: String,
    val status: String,
    val progress: Double,
    val downloadSpeed: Long,
    val uploadSpeed: Long,
    val downloaded: Long,
    val uploaded: Long,
    val size: Long,
    val peersConnected: Int,
    val peersTotal: Int?,
    val seedersConnected: Int?,
    val seedersTotal: Int?,
    val leechersConnected: Int?,
    val leechersTotal: Int?,
    val eta: Long?,
    val shareRatio: Double,
    val piecesCompleted: Int?,
    val piecesTotal: Int?,
    val pieceSize: Long?,
    val pieceBitfield: BitSet?, // Which pieces are complete (verified)
    // Active piece states for download visualization (O(1) lookup per piece)
    val activePiecesPartial: Set<Int>? = null,   // Has unrequested blocks
    val activePiecesRequested: Set<Int>? = null, // All blocks requested, awaiting data
    val activePiecesResponded: Set<Int>? = null, // All blocks received, awaiting verification
    val files: List<TorrentFileUi>,
    val trackers: List<TrackerUi>,
    val peers: List<PeerUi>,
    // Peer discovery status (for TrackersTab)
    val dhtEnabled: Boolean = true,   // Engine always has DHT enabled
    val lsdEnabled: Boolean = false,  // LSD not implemented
    val pexEnabled: Boolean = true,   // PeX enabled per-connection
    // Details tab fields
    val addedAt: Long? = null,        // Epoch milliseconds when torrent was added
    val completedAt: Long? = null,    // Epoch milliseconds when completed, null if in progress
    val magnetUrl: String? = null,    // Full magnet URI with trackers
    val rootKey: String? = null,      // Storage root key for file access
    // Optional metadata from .torrent file (not available for magnets)
    val comment: String? = null,
    val createdBy: String? = null,
    val creationDate: Long? = null,   // Unix timestamp (seconds since epoch)
    val isPrivate: Boolean = false
)

/**
 * File download priority levels.
 */
enum class FilePriority(val displayName: String) {
    HIGH("High"),
    NORMAL("Normal"),
    SKIP("Don't Download")
}

/**
 * UI model for a file within a torrent.
 */
data class TorrentFileUi(
    val index: Int,
    val path: String,
    val name: String,
    val size: Long,
    val downloaded: Long,
    val progress: Double,
    val isSelected: Boolean,
    val priority: FilePriority = FilePriority.NORMAL
)

/**
 * UI model for a tracker.
 */
data class TrackerUi(
    val url: String,
    val status: TrackerStatus,
    val message: String?,
    val peers: Int?,              // seeders + leechers (theoretical swarm size)
    val peersReceived: Int? = null, // actual peers returned in last announce
    val connectionFamily: String? = null // 'ipv4' | 'ipv6' | null
)

/**
 * Tracker status.
 */
enum class TrackerStatus {
    OK,
    UPDATING,
    ERROR,
    DISABLED
}

/**
 * UI model for a peer.
 */
data class PeerUi(
    val address: String,
    val client: String?,
    val downloadSpeed: Long,
    val uploadSpeed: Long,
    val progress: Double,
    val flags: String?,
    val state: String  // "connecting" or "connected"
)

/**
 * DHT/LSD/PeX status for trackers tab.
 */
data class DhtStatus(
    val dhtEnabled: Boolean,
    val dhtNodes: Int?,
    val lsdEnabled: Boolean,
    val pexEnabled: Boolean
)

// =============================================================================
// Extension functions
// =============================================================================

/**
 * Filter torrents by status.
 */
fun List<TorrentSummary>.filterByStatus(filter: TorrentFilter): List<TorrentSummary> {
    return when (filter) {
        TorrentFilter.ALL -> this
        TorrentFilter.ACTIVE -> this.filter { torrent ->
            torrent.status in listOf("downloading", "downloading_metadata", "checking")
        }
        TorrentFilter.FINISHED -> this.filter { torrent ->
            torrent.status == "seeding" ||
            (torrent.status == "stopped" && torrent.progress >= 0.999)
        }
    }
}

/**
 * Sort torrents by the specified order.
 */
fun List<TorrentSummary>.sortByOrder(order: TorrentSortOrder): List<TorrentSummary> {
    return when (order) {
        TorrentSortOrder.NAME -> this.sortedBy { it.name.lowercase() }
        TorrentSortOrder.DATE_ADDED -> this.sortedByDescending { it.addedAt }
        // Secondary sort by date added keeps stopped torrents stable
        TorrentSortOrder.DOWNLOAD_SPEED -> this.sortedWith(
            compareByDescending<TorrentSummary> { it.downloadSpeed }
                .thenByDescending { it.addedAt }
        )
    }
}

/**
 * Check if a torrent is considered "active" (downloading or seeding with speed).
 */
fun TorrentSummary.isActive(): Boolean {
    return status in listOf("downloading", "downloading_metadata", "seeding") &&
           (downloadSpeed > 0 || uploadSpeed > 0)
}

/**
 * Check if a torrent is paused.
 */
fun TorrentSummary.isPaused(): Boolean {
    return status == "stopped"
}

/**
 * Check if a torrent is completed.
 */
fun TorrentSummary.isCompleted(): Boolean {
    return progress >= 0.999
}

/**
 * Convert FileInfo to TorrentFileUi.
 */
fun FileInfo.toUi(isSelected: Boolean = true, priority: FilePriority = FilePriority.NORMAL): TorrentFileUi {
    val name = path.substringAfterLast('/')
    return TorrentFileUi(
        index = index,
        path = path,
        name = name,
        size = size,
        downloaded = downloaded,
        progress = progress,
        isSelected = isSelected,
        priority = priority
    )
}
