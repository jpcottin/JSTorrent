package com.jstorrent.app.viewmodel

import com.jstorrent.quickjs.model.EngineState
import com.jstorrent.quickjs.model.FileInfo
import com.jstorrent.quickjs.model.FileListResponse
import com.jstorrent.quickjs.model.PeerInfo
import com.jstorrent.quickjs.model.PieceInfo
import com.jstorrent.quickjs.model.PiecesData
import com.jstorrent.quickjs.model.TorrentDetails
import com.jstorrent.quickjs.model.TorrentSummary
import com.jstorrent.quickjs.model.TrackerInfo
import com.jstorrent.quickjs.model.DhtStats
import com.jstorrent.quickjs.model.SpeedSamplesResult
import com.jstorrent.quickjs.model.JsThreadStats
import com.jstorrent.quickjs.model.EngineStats
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Fake TorrentRepository for testing.
 * Allows tests to control the state and verify interactions.
 */
class FakeTorrentRepository : TorrentRepository {

    private val _state = MutableStateFlow<EngineState?>(null)
    override val state: StateFlow<EngineState?> = _state.asStateFlow()

    private val _isLoaded = MutableStateFlow(false)
    override val isLoaded: StateFlow<Boolean> = _isLoaded.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    override val lastError: StateFlow<String?> = _lastError.asStateFlow()

    // Track method calls for verification
    val addedTorrents = mutableListOf<String>()
    val pausedTorrents = mutableListOf<String>()
    val resumedTorrents = mutableListOf<String>()
    val removedTorrents = mutableListOf<Pair<String, Boolean>>()
    val recheckedTorrents = mutableListOf<String>()
    var pauseAllCalled = false
    var resumeAllCalled = false

    // Data for subscription state (simulates data pushed via subscriptions)
    var filesData: Map<String, FileListResponse> = emptyMap()
    var trackersData: Map<String, List<TrackerInfo>> = emptyMap()
    var peersData: Map<String, List<PeerInfo>> = emptyMap()
    var piecesData: Map<String, PieceInfo> = emptyMap()
    var detailsData: Map<String, TorrentDetails> = emptyMap()
    var dhtStatsData: DhtStats? = null

    // ==========================================================================
    // Test control methods
    // ==========================================================================

    fun setLoaded(loaded: Boolean) {
        _isLoaded.value = loaded
    }

    fun setError(error: String?) {
        _lastError.value = error
    }

    fun setTorrents(torrents: List<TorrentSummary>) {
        // Include subscription data in the state (simulating subscription push)
        val piecesDataMap = piecesData.mapValues { (_, pieceInfo) ->
            PiecesData(
                piecesTotal = pieceInfo.piecesTotal,
                piecesCompleted = pieceInfo.piecesCompleted,
                pieceSize = pieceInfo.pieceSize,
                lastPieceSize = pieceInfo.lastPieceSize,
                bitfield = pieceInfo.bitfield
            )
        }
        _state.value = EngineState(
            torrents = torrents,
            files = filesData.ifEmpty { null },
            trackers = trackersData.ifEmpty { null },
            peers = peersData.ifEmpty { null },
            pieces = piecesDataMap.ifEmpty { null },
            details = detailsData.ifEmpty { null }
        )
    }

    /**
     * Update state with current data (call after modifying filesData, etc.)
     */
    fun refreshState() {
        _state.value?.torrents?.let { torrents ->
            setTorrents(torrents)
        }
    }

    fun reset() {
        _state.value = null
        _isLoaded.value = false
        _lastError.value = null
        addedTorrents.clear()
        pausedTorrents.clear()
        resumedTorrents.clear()
        removedTorrents.clear()
        recheckedTorrents.clear()
        pauseAllCalled = false
        resumeAllCalled = false
        suspendEngineCalled = false
        resumeEngineCalled = false
        filesData = emptyMap()
        trackersData = emptyMap()
        peersData = emptyMap()
        piecesData = emptyMap()
        detailsData = emptyMap()
        dhtStatsData = null
        // Reset subscription tracking
        subscriptions.clear()
        unsubscriptions.clear()
        unsubscribeAllCalls.clear()
        pauseSubscriptionsCalled = false
        resumeSubscriptionsCalled = false
    }

    // ==========================================================================
    // TorrentRepository implementation
    // ==========================================================================

    override fun addTorrent(magnetOrBase64: String) {
        addedTorrents.add(magnetOrBase64)
    }

    override fun pauseTorrent(infoHash: String) {
        pausedTorrents.add(infoHash)
        // Update state to reflect pause
        _state.value?.let { currentState ->
            val updatedTorrents = currentState.torrents.map { torrent ->
                if (torrent.infoHash == infoHash) {
                    torrent.copy(status = "stopped", downloadSpeed = 0, uploadSpeed = 0)
                } else {
                    torrent
                }
            }
            _state.value = EngineState(updatedTorrents)
        }
    }

    override fun resumeTorrent(infoHash: String) {
        resumedTorrents.add(infoHash)
        // Update state to reflect resume
        _state.value?.let { currentState ->
            val updatedTorrents = currentState.torrents.map { torrent ->
                if (torrent.infoHash == infoHash) {
                    torrent.copy(status = "downloading")
                } else {
                    torrent
                }
            }
            _state.value = EngineState(updatedTorrents)
        }
    }

    override fun removeTorrent(infoHash: String, deleteFiles: Boolean) {
        removedTorrents.add(Pair(infoHash, deleteFiles))
        // Update state to reflect removal
        _state.value?.let { currentState ->
            val updatedTorrents = currentState.torrents.filter { it.infoHash != infoHash }
            _state.value = EngineState(updatedTorrents)
        }
    }

    override fun recheckTorrent(infoHash: String) {
        recheckedTorrents.add(infoHash)
        // Update state to reflect checking status
        _state.value?.let { currentState ->
            val updatedTorrents = currentState.torrents.map { torrent ->
                if (torrent.infoHash == infoHash) {
                    torrent.copy(status = "checking")
                } else {
                    torrent
                }
            }
            _state.value = EngineState(updatedTorrents)
        }
    }

    override suspend fun replaceAndAddTorrent(magnetOrBase64: String, infoHash: String?) {
        // Remove first if infoHash provided
        if (infoHash != null) {
            removeTorrent(infoHash, deleteFiles = true)
        }
        // Then add
        addTorrent(magnetOrBase64)
    }

    override fun pauseAll() {
        pauseAllCalled = true
        _state.value?.let { currentState ->
            val updatedTorrents = currentState.torrents.map { torrent ->
                torrent.copy(status = "stopped", downloadSpeed = 0, uploadSpeed = 0)
            }
            _state.value = EngineState(updatedTorrents)
        }
    }

    override fun resumeAll() {
        resumeAllCalled = true
        _state.value?.let { currentState ->
            val updatedTorrents = currentState.torrents.map { torrent ->
                if (torrent.status == "stopped") {
                    torrent.copy(status = "downloading")
                } else {
                    torrent
                }
            }
            _state.value = EngineState(updatedTorrents)
        }
    }

    // Track engine suspend/resume calls
    var suspendEngineCalled = false
    var resumeEngineCalled = false

    override fun suspendEngine() {
        suspendEngineCalled = true
    }

    override fun resumeEngine() {
        resumeEngineCalled = true
    }

    override fun setFilePriorities(infoHash: String, priorities: Map<Int, Int>) {
        // No-op for testing - just record if needed
    }

    override suspend fun getDhtStats(): DhtStats? {
        return dhtStatsData
    }

    override suspend fun getSpeedSamples(
        direction: String,
        categories: String,
        fromTime: Long,
        toTime: Long,
        maxPoints: Int
    ): SpeedSamplesResult? {
        // Return empty samples for testing
        return SpeedSamplesResult(
            samples = emptyList(),
            bucketMs = 1000,
            latestBucketTime = System.currentTimeMillis()
        )
    }

    override fun getJsThreadStats(): JsThreadStats? {
        // Return null for testing - no JS thread stats in fake
        return null
    }

    override suspend fun getEngineStats(): EngineStats? {
        // Return null for testing - no engine stats in fake
        return null
    }

    // ==========================================================================
    // Subscription API
    // ==========================================================================

    // Track subscription calls for verification
    val subscriptions = mutableListOf<Triple<String, String, Int>>()  // (type, hash, intervalMs)
    val unsubscriptions = mutableListOf<Pair<String, String>>()  // (type, hash)
    val unsubscribeAllCalls = mutableListOf<String>()  // hash
    var pauseSubscriptionsCalled = false
    var resumeSubscriptionsCalled = false

    override fun subscribe(type: String, hash: String, intervalMs: Int) {
        subscriptions.add(Triple(type, hash, intervalMs))
    }

    override fun unsubscribe(type: String, hash: String) {
        unsubscriptions.add(Pair(type, hash))
    }

    override fun unsubscribeAll(hash: String) {
        unsubscribeAllCalls.add(hash)
    }

    override fun pauseSubscriptions() {
        pauseSubscriptionsCalled = true
    }

    override fun resumeSubscriptions() {
        resumeSubscriptionsCalled = true
    }
}

// ==========================================================================
// Test data helpers
// ==========================================================================

fun createTestTorrent(
    infoHash: String = "abc123",
    name: String = "Test Torrent",
    progress: Double = 0.5,
    downloadSpeed: Long = 1000000,
    uploadSpeed: Long = 50000,
    status: String = "downloading"
) = TorrentSummary(
    infoHash = infoHash,
    name = name,
    progress = progress,
    downloadSpeed = downloadSpeed,
    uploadSpeed = uploadSpeed,
    status = status
)
