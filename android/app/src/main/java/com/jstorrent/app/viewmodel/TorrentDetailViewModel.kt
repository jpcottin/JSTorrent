package com.jstorrent.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jstorrent.app.model.DetailTab
import com.jstorrent.app.model.DhtStatus
import com.jstorrent.app.model.FilePriority
import com.jstorrent.app.model.PeerUi
import com.jstorrent.app.model.TorrentDetailUi
import com.jstorrent.app.model.TorrentDetailUiState
import com.jstorrent.app.model.TorrentFileUi
import com.jstorrent.app.model.TrackerStatus
import com.jstorrent.app.model.TrackerUi
import com.jstorrent.app.model.toUi
import com.jstorrent.quickjs.model.ActivePieceStates
import com.jstorrent.quickjs.model.PieceInfo
import com.jstorrent.quickjs.model.PiecesData
import com.jstorrent.quickjs.model.TorrentDetails
import com.jstorrent.quickjs.model.TorrentSummary
import com.jstorrent.quickjs.model.FileInfo
import com.jstorrent.quickjs.model.PeerInfo
import com.jstorrent.quickjs.model.TrackerInfo
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.util.BitSet

/**
 * File state for tracking selection and priority.
 */
data class FileState(
    val isSelected: Boolean = true,
    val priority: FilePriority = FilePriority.NORMAL
)

/**
 * ViewModel for the torrent detail screen.
 * Manages torrent details, files, peers, and trackers.
 *
 * Stage 2 of lazy engine startup: Opening detail view starts the engine on demand.
 *
 * @param trackerRefreshEnabled Set to false in tests to disable the infinite
 *   tracker refresh loop that causes advanceUntilIdle() to hang.
 */
class TorrentDetailViewModel(
    private val repository: TorrentRepository,
    private val infoHash: String,
    private val onEnsureEngineStarted: () -> Unit = {},
    private val trackerRefreshEnabled: Boolean = true
) : ViewModel() {

    init {
        // Stage 2: Opening detail view is a trigger point for engine start
        onEnsureEngineStarted()
    }

    /**
     * Ensure the engine is started.
     * Call this when the screen resumes after being backgrounded, since the engine
     * may have been shut down for battery saving while the Activity was stopped.
     */
    fun ensureEngineStarted() {
        onEnsureEngineStarted()
    }

    // Selected tab - default to STATUS (most relevant when opening a torrent)
    private val _selectedTab = MutableStateFlow(DetailTab.STATUS)
    val selectedTab: StateFlow<DetailTab> = _selectedTab

    // Applied file state (committed to engine) - file index -> FileState
    private val _appliedFileState = MutableStateFlow<Map<Int, FileState>>(emptyMap())

    // Pending file state (uncommitted changes) - file index -> FileState
    // When null, no pending changes exist
    private val _pendingFileState = MutableStateFlow<Map<Int, FileState>?>(null)

    // Computed: whether there are pending changes
    val hasPendingFileChanges: StateFlow<Boolean> = _pendingFileState
        .map { it != null }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    // Cached files (fetched asynchronously)
    private val _cachedFiles = MutableStateFlow<List<FileInfo>>(emptyList())

    // Cached trackers (fetched asynchronously)
    private val _cachedTrackers = MutableStateFlow<List<TrackerInfo>>(emptyList())

    // Cached peers (fetched asynchronously)
    private val _cachedPeers = MutableStateFlow<List<PeerInfo>>(emptyList())

    // Cached piece info (fetched asynchronously)
    private val _cachedPieces = MutableStateFlow<PieceInfo?>(null)

    // Cached torrent details (fetched asynchronously)
    private val _cachedDetails = MutableStateFlow<TorrentDetails?>(null)

    // Local bitfield maintained from initial fetch + diffs
    private val _pieceBitfield = MutableStateFlow<BitSet?>(null)

    // Track when removal has been initiated to avoid showing error during navigation
    private val _isRemoving = MutableStateFlow(false)

    // Track screen visibility for lifecycle-aware subscriptions
    private val _isScreenVisible = MutableStateFlow(true)

    // Track current subscription type to avoid redundant subscribe calls
    private var currentSubscriptionType: String? = null

    // Note: trackerRefreshEnabled parameter is now unused (subscriptions replace polling)
    // Kept for API compatibility with existing tests

    init {
        // Subscribe to "files" initially for STATUS tab (needed for size/ETA)
        // This happens when the engine is loaded
        viewModelScope.launch {
            repository.isLoaded.collect { isLoaded ->
                if (isLoaded && _isScreenVisible.value) {
                    subscribeForTab(_selectedTab.value)
                }
            }
        }

        // Populate cached flows from subscription data in state.
        // This replaces the old RPC-based fetching.
        viewModelScope.launch {
            repository.state.collect { state ->
                if (state?.torrents?.any { it.infoHash == infoHash } != true) return@collect

                // Populate cached flows from subscription data
                state.files?.get(infoHash)?.let { files ->
                    _cachedFiles.value = files
                }
                state.trackers?.get(infoHash)?.let { trackers ->
                    _cachedTrackers.value = trackers
                }
                state.peers?.get(infoHash)?.let { peers ->
                    _cachedPeers.value = peers
                }
                state.pieces?.get(infoHash)?.let { piecesData ->
                    // Convert PiecesData to PieceInfo for compatibility
                    _cachedPieces.value = PieceInfo(
                        piecesTotal = piecesData.piecesTotal,
                        piecesCompleted = piecesData.piecesCompleted,
                        pieceSize = piecesData.pieceSize,
                        lastPieceSize = piecesData.lastPieceSize,
                        bitfield = piecesData.bitfield
                    )
                    // Update bitfield from subscription data
                    if (piecesData.piecesTotal > 0) {
                        val newBitfield = decodeBitfield(piecesData.bitfield, piecesData.piecesTotal)
                        // Apply recent changes (pieces completed since last push)
                        piecesData.recentChanges.forEach { pieceIndex ->
                            newBitfield.set(pieceIndex)
                        }
                        _pieceBitfield.value?.let { existing -> newBitfield.or(existing) }
                        _pieceBitfield.value = newBitfield
                    }
                }
                state.details?.get(infoHash)?.let { details ->
                    _cachedDetails.value = details
                }

                // Apply piece diffs from legacy global state (for backward compatibility)
                applyPieceDiffs(state)
            }
        }

        // Tab-reactive subscription management.
        // When tab changes, subscribe to the appropriate data type.
        viewModelScope.launch {
            combine(_selectedTab, _isScreenVisible) { tab, visible -> tab to visible }
                .collect { (tab, visible) ->
                    if (visible && repository.isLoaded.value) {
                        subscribeForTab(tab)
                    }
                }
        }
    }

    /**
     * Subscribe to the appropriate data type for the given tab.
     * Unsubscribes from previous subscription first.
     */
    private fun subscribeForTab(tab: DetailTab) {
        val (type, intervalMs) = when (tab) {
            DetailTab.STATUS -> "files" to 2000    // Need files for size/ETA
            DetailTab.FILES -> "files" to 2000
            DetailTab.TRACKERS -> "trackers" to 5000
            DetailTab.PEERS -> "peers" to 1000
            DetailTab.PIECES -> "pieces" to 500
            DetailTab.DETAILS -> "details" to 10000  // Details rarely change
        }

        // Only change subscription if type changed
        if (currentSubscriptionType != type) {
            repository.unsubscribeAll(infoHash)
            repository.subscribe(type, infoHash, intervalMs)
            currentSubscriptionType = type
        }
    }

    /**
     * Called when the screen is paused (navigated away or backgrounded).
     * Pauses subscription pushes to save resources.
     */
    fun onScreenPaused() {
        _isScreenVisible.value = false
        repository.pauseSubscriptions()
    }

    /**
     * Called when the screen is resumed (navigated back or foregrounded).
     * Resumes subscription pushes and re-subscribes if needed.
     */
    fun onScreenResumed() {
        _isScreenVisible.value = true
        repository.resumeSubscriptions()
        // Re-subscribe in case engine was restarted while paused
        if (repository.isLoaded.value) {
            subscribeForTab(_selectedTab.value)
        }
    }

    /**
     * Clean up subscriptions when ViewModel is cleared.
     */
    override fun onCleared() {
        super.onCleared()
        repository.unsubscribeAll(infoHash)
    }

    /**
     * Apply piece diffs from state update to local bitfield.
     * IMPORTANT: Clone the BitSet before mutation so StateFlow detects the change.
     */
    private fun applyPieceDiffs(state: com.jstorrent.quickjs.model.EngineState) {
        val diffs = state.pieceChanges?.get(infoHash)
        if (!diffs.isNullOrEmpty()) {
            val existingBitfield = _pieceBitfield.value
            val newBitfield = if (existingBitfield != null) {
                (existingBitfield.clone() as BitSet)
            } else {
                BitSet()
            }
            diffs.forEach { pieceIndex -> newBitfield.set(pieceIndex) }
            _pieceBitfield.value = newBitfield
            // Update completed count
            _cachedPieces.value?.let { pieces ->
                _cachedPieces.value = pieces.copy(
                    piecesCompleted = newBitfield.cardinality()
                )
            }
        }
    }

    // Combined UI state
    val uiState: StateFlow<TorrentDetailUiState> = combine(
        repository.isLoaded,
        repository.state,
        repository.lastError,
        _selectedTab,
        _appliedFileState,
        _pendingFileState,
        _cachedFiles,
        _cachedTrackers,
        _cachedPeers,
        _cachedPieces,
        _pieceBitfield,
        _cachedDetails,
        _isRemoving
    ) { values ->
        val isLoaded = values[0] as Boolean
        val state = values[1] as? com.jstorrent.quickjs.model.EngineState
        val error = values[2] as? String
        val tab = values[3] as DetailTab
        @Suppress("UNCHECKED_CAST")
        val appliedState = values[4] as Map<Int, FileState>
        @Suppress("UNCHECKED_CAST")
        val pendingState = values[5] as? Map<Int, FileState>
        @Suppress("UNCHECKED_CAST")
        val files = values[6] as List<FileInfo>
        @Suppress("UNCHECKED_CAST")
        val trackers = values[7] as List<TrackerInfo>
        @Suppress("UNCHECKED_CAST")
        val peers = values[8] as List<PeerInfo>
        val pieces = values[9] as? PieceInfo
        var bitfield = values[10] as? BitSet
        val details = values[11] as? TorrentDetails
        val isRemoving = values[12] as Boolean

        // Apply piece diffs synchronously here to avoid race condition with activePieceStates.
        // Previously, pieceChanges was processed in a separate collector, causing a frame
        // where activePiecesResponded was cleared but bitfield wasn't updated yet (flickering).
        val diffs = state?.pieceChanges?.get(infoHash)
        if (!diffs.isNullOrEmpty() && bitfield != null) {
            // Clone to avoid mutating the original
            bitfield = (bitfield.clone() as BitSet).apply {
                diffs.forEach { pieceIndex -> set(pieceIndex) }
            }
        }

        // Use pending state if available, otherwise use applied state
        val effectiveFileState = pendingState ?: appliedState

        // Decode active piece states from hex-encoded binary
        val activePieceStates = state?.activePieceStates?.get(infoHash)?.let {
            ActivePieceStates.fromHex(it)
        }

        when {
            error != null && !isLoaded -> TorrentDetailUiState.Error(error)
            !isLoaded -> TorrentDetailUiState.Loading
            else -> {
                val torrent = state?.torrents?.find { it.infoHash == infoHash }
                if (torrent == null) {
                    // If we're in the process of removing, show Loading instead of Error
                    // to avoid jarring "Error" title during navigation transition
                    if (isRemoving) {
                        TorrentDetailUiState.Loading
                    } else {
                        TorrentDetailUiState.Error("Torrent not found")
                    }
                } else {
                    TorrentDetailUiState.Loaded(
                        torrent = createTorrentDetailUi(torrent, effectiveFileState, files, trackers, peers, pieces, bitfield, details, activePieceStates),
                        selectedTab = tab,
                        hasPendingFileChanges = pendingState != null
                    )
                }
            }
        }
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.Eagerly,
        initialValue = TorrentDetailUiState.Loading
    )

    /**
     * Set the selected tab.
     */
    fun setSelectedTab(tab: DetailTab) {
        _selectedTab.value = tab
    }

    /**
     * Toggle file selection for a specific file (batched - requires apply).
     */
    fun toggleFileSelection(fileIndex: Int) {
        val baseState = _pendingFileState.value ?: _appliedFileState.value
        // If no pending/applied state, derive from engine's actual priority
        val currentState = baseState[fileIndex] ?: run {
            val enginePriority = _cachedFiles.value.find { it.index == fileIndex }?.priority ?: 0
            FileState(isSelected = enginePriority != 1) // priority 1 = skipped
        }
        val newState = currentState.copy(isSelected = !currentState.isSelected)

        val newPending = baseState.toMutableMap()
        newPending[fileIndex] = newState
        _pendingFileState.value = newPending
    }

    /**
     * Set file priority (batched - requires apply).
     */
    fun setFilePriority(fileIndex: Int, priority: FilePriority) {
        val baseState = _pendingFileState.value ?: _appliedFileState.value
        // If no pending/applied state, derive from engine's actual priority
        val currentState = baseState[fileIndex] ?: run {
            val enginePriority = _cachedFiles.value.find { it.index == fileIndex }?.priority ?: 0
            FileState(isSelected = enginePriority != 1)
        }

        // SKIP priority also deselects the file
        val isSelected = if (priority == FilePriority.SKIP) false else currentState.isSelected
        val newState = currentState.copy(isSelected = isSelected, priority = priority)

        val newPending = baseState.toMutableMap()
        newPending[fileIndex] = newState
        _pendingFileState.value = newPending
    }

    /**
     * Select all files in the torrent (batched - requires apply).
     */
    fun selectAllFiles() {
        val files = _cachedFiles.value
        val baseState = _pendingFileState.value ?: _appliedFileState.value
        val newPending = baseState.toMutableMap()
        files.forEach { file ->
            val current = newPending[file.index] ?: FileState()
            newPending[file.index] = current.copy(isSelected = true)
        }
        _pendingFileState.value = newPending
    }

    /**
     * Deselect all files in the torrent (batched - requires apply).
     */
    fun deselectAllFiles() {
        val files = _cachedFiles.value
        val baseState = _pendingFileState.value ?: _appliedFileState.value
        val newPending = baseState.toMutableMap()
        files.forEach { file ->
            val current = newPending[file.index] ?: FileState()
            newPending[file.index] = current.copy(isSelected = false)
        }
        _pendingFileState.value = newPending
    }

    /**
     * Apply pending file changes to the engine.
     */
    fun applyFileChanges() {
        val pending = _pendingFileState.value ?: return
        _appliedFileState.value = pending
        _pendingFileState.value = null

        // Convert to engine values: 0=Normal, 1=Skip, 2=High
        // isSelected=false means skip, regardless of priority setting
        val priorities = pending.mapValues { (_, state) ->
            if (!state.isSelected) {
                1 // Skip
            } else {
                when (state.priority) {
                    FilePriority.HIGH -> 2
                    FilePriority.SKIP -> 1
                    FilePriority.NORMAL -> 0
                }
            }
        }

        repository.setFilePriorities(infoHash, priorities)
    }

    /**
     * Cancel pending file changes.
     */
    fun cancelFileChanges() {
        _pendingFileState.value = null
    }

    /**
     * Pause the current torrent.
     */
    fun pause() {
        repository.pauseTorrent(infoHash)
    }

    /**
     * Resume the current torrent.
     */
    fun resume() {
        repository.resumeTorrent(infoHash)
    }

    /**
     * Remove the current torrent.
     */
    fun remove(deleteFiles: Boolean = false) {
        _isRemoving.value = true
        repository.removeTorrent(infoHash, deleteFiles)
    }

    /**
     * Check if the torrent is currently paused.
     */
    fun isPaused(): Boolean {
        val state = uiState.value
        return if (state is TorrentDetailUiState.Loaded) {
            state.torrent.status == "stopped"
        } else {
            false
        }
    }

    /**
     * Re-sync pieces state from the engine.
     * Call this when the app resumes from background to ensure the bitfield
     * reflects any progress made while incremental updates were missed.
     */
    fun resyncPieces() {
        // With subscriptions, re-subscribing will push fresh data.
        // Force a re-subscription to get the latest piece state.
        if (_selectedTab.value == DetailTab.PIECES) {
            currentSubscriptionType = null  // Force re-subscription
            subscribeForTab(DetailTab.PIECES)
        }
    }

    /**
     * Create the full detail UI model from torrent summary.
     */
    private fun createTorrentDetailUi(
        summary: TorrentSummary,
        fileState: Map<Int, FileState>,
        files: List<FileInfo>,
        trackers: List<TrackerInfo>,
        peers: List<PeerInfo>,
        pieces: PieceInfo?,
        bitfield: BitSet?,
        details: TorrentDetails?,
        activePieceStates: ActivePieceStates?
    ): TorrentDetailUi {
        val fileUis = files.map { file ->
            // Use pending state if exists, otherwise use engine's actual priority
            val pendingState = fileState[file.index]
            val priority = pendingState?.priority ?: enginePriorityToFilePriority(file.priority)
            val isSelected = pendingState?.isSelected ?: (file.priority != 1) // Not selected if skipped
            file.toUi(isSelected, priority)
        }

        // Map tracker info to UI models
        val trackerUis = trackers.map { tracker ->
            TrackerUi(
                url = tracker.url,
                status = mapTrackerStatus(tracker.status),
                message = tracker.lastError,
                peers = (tracker.seeders ?: 0) + (tracker.leechers ?: 0),
                peersReceived = tracker.lastPeersReceived,
                connectionFamily = tracker.connectionFamily
            )
        }

        // Map peer info to UI models
        val peerUis = peers.map { peer ->
            PeerUi(
                address = "${peer.ip}:${peer.port}",
                client = peer.clientName,
                downloadSpeed = peer.downloadSpeed,
                uploadSpeed = peer.uploadSpeed,
                progress = peer.progress,
                flags = formatPeerFlags(peer),
                state = peer.state
            )
        }

        // Calculate totals from files
        val totalSize = files.sumOf { it.size }
        val downloaded = files.sumOf { it.downloaded }

        // Calculate share ratio
        val shareRatio = if (downloaded > 0) summary.uploaded.toDouble() / downloaded else 0.0

        return TorrentDetailUi(
            infoHash = summary.infoHash,
            name = summary.name,
            status = summary.status,
            progress = summary.progress,
            downloadSpeed = summary.downloadSpeed,
            uploadSpeed = summary.uploadSpeed,
            downloaded = downloaded,
            uploaded = summary.uploaded,
            size = totalSize,
            peersConnected = peers.count { it.state == "connected" },
            peersTotal = if (summary.swarmPeers > 0) summary.swarmPeers else null,
            seedersConnected = null,
            seedersTotal = null,
            leechersConnected = null,
            leechersTotal = null,
            eta = calculateEta(summary.downloadSpeed, totalSize - downloaded),
            shareRatio = shareRatio,
            // Derive piecesCompleted from bitfield when available - this ensures the count
            // stays in sync after diffs are applied in the combine block
            piecesCompleted = bitfield?.cardinality() ?: pieces?.piecesCompleted,
            piecesTotal = pieces?.piecesTotal,
            pieceSize = pieces?.pieceSize,
            pieceBitfield = bitfield,
            activePiecesPartial = activePieceStates?.partial?.toSet(),
            activePiecesRequested = activePieceStates?.requested?.toSet(),
            activePiecesResponded = activePieceStates?.responded?.toSet(),
            files = fileUis,
            trackers = trackerUis,
            peers = peerUis,
            addedAt = details?.addedAt,
            completedAt = details?.completedAt,
            magnetUrl = details?.magnetUrl,
            rootKey = details?.rootKey,
            comment = details?.comment,
            createdBy = details?.createdBy,
            creationDate = details?.creationDate,
            isPrivate = details?.isPrivate ?: false
        )
    }

    /**
     * Map engine tracker status to UI status.
     */
    private fun mapTrackerStatus(status: String): TrackerStatus {
        return when (status) {
            "ok" -> TrackerStatus.OK
            "announcing" -> TrackerStatus.UPDATING
            "error" -> TrackerStatus.ERROR
            else -> TrackerStatus.DISABLED // 'idle' = not contacted yet
        }
    }

    /**
     * Format peer flags (choking/interested states) matching extension display.
     * E = encrypted (MSE/PE), I = incoming connection
     * d/D = download (lowercase = peer choking us), u/U = upload (lowercase = we choking them)
     * Returns null for connecting peers (no connection yet).
     */
    private fun formatPeerFlags(peer: PeerInfo): String? {
        if (peer.state == "connecting") return null

        val flags = buildList {
            if (peer.isEncrypted) add("E")
            if (peer.isIncoming) add("I")
            // Download: are we interested and are they choking us?
            if (peer.amInterested) {
                add(if (peer.peerChoking) "d" else "D")
            }
            // Upload: are they interested and are we choking them?
            if (peer.peerInterested) {
                add(if (peer.amChoking) "u" else "U")
            }
        }

        return if (flags.isEmpty()) null else flags.joinToString(" ")
    }

    /**
     * Calculate ETA based on download speed and remaining bytes.
     */
    private fun calculateEta(speed: Long, remaining: Long): Long? {
        return if (speed > 0 && remaining > 0) {
            remaining / speed
        } else if (remaining == 0L) {
            0
        } else {
            null // Infinite/unknown
        }
    }

    /**
     * Decode hex-encoded bitfield to BitSet.
     * BitTorrent bitfield: MSB first, bit 0 of byte 0 = piece 0.
     */
    private fun decodeBitfield(hex: String, piecesTotal: Int): BitSet {
        val bitset = BitSet(piecesTotal)
        if (hex.isEmpty()) return bitset

        val bytes = hex.chunked(2).map { it.toInt(16).toByte() }
        for (pieceIndex in 0 until piecesTotal) {
            val byteIndex = pieceIndex / 8
            if (byteIndex >= bytes.size) break
            val bitIndex = 7 - (pieceIndex % 8) // MSB first
            val byte = bytes[byteIndex].toInt() and 0xFF
            if ((byte shr bitIndex) and 1 == 1) {
                bitset.set(pieceIndex)
            }
        }
        return bitset
    }

    /**
     * Convert engine priority (0=Normal, 1=Skip, 2=High) to FilePriority enum.
     */
    private fun enginePriorityToFilePriority(enginePriority: Int): FilePriority {
        return when (enginePriority) {
            1 -> FilePriority.SKIP
            2 -> FilePriority.HIGH
            else -> FilePriority.NORMAL
        }
    }

    /**
     * Factory for creating TorrentDetailViewModel with dependencies.
     */
    class Factory(
        private val application: android.app.Application,
        private val infoHash: String
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            if (modelClass.isAssignableFrom(TorrentDetailViewModel::class.java)) {
                val app = application as com.jstorrent.app.JSTorrentApplication
                return TorrentDetailViewModel(
                    repository = EngineServiceRepository(application),
                    infoHash = infoHash,
                    onEnsureEngineStarted = { app.ensureEngineStarted() }
                ) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
    }
}
