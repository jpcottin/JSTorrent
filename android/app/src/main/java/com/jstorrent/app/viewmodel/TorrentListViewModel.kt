package com.jstorrent.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jstorrent.app.cache.TorrentSummaryCache
import com.jstorrent.app.model.TorrentFilter
import com.jstorrent.app.model.TorrentListUiState
import com.jstorrent.app.model.TorrentSortOrder
import com.jstorrent.app.model.filterByStatus
import com.jstorrent.app.model.sortByOrder
import com.jstorrent.quickjs.model.TorrentSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * ViewModel for the torrent list screen.
 * Manages torrent list state, filtering, and sorting.
 *
 * Stage 1 of lazy engine startup: Uses TorrentSummaryCache as initial data source.
 * Stage 2 of lazy engine startup: Engine starts on demand when user takes action.
 * Engine state always wins when available.
 */
class TorrentListViewModel(
    private val repository: TorrentRepository,
    private val cache: TorrentSummaryCache? = null,
    private val onEnsureEngineStarted: () -> Unit = {},
    private val onTorrentAdded: () -> Unit = {}
) : ViewModel() {

    init {
        // Load cache asynchronously on initialization
        cache?.let { summaryCache ->
            viewModelScope.launch {
                summaryCache.load()
            }
        }

        // Subscribe to torrent list once engine is loaded
        viewModelScope.launch {
            repository.isLoaded.collect { isLoaded ->
                if (isLoaded) {
                    // Subscribe to torrent list with 1000ms push interval
                    repository.subscribe("torrents", "", 1000)
                }
            }
        }

        // Clear pending state when engine reports torrent state updates
        // This provides the "response" half of the immediate feedback loop
        viewModelScope.launch {
            repository.state.collect { state ->
                if (state != null) {
                    val engineInfoHashes = state.torrents.map { it.infoHash }.toSet()
                    // Clear play/pause pending for torrents that now appear in engine state
                    if (_pendingTorrents.value.isNotEmpty()) {
                        _pendingTorrents.value = _pendingTorrents.value - engineInfoHashes
                    }
                    // Clear removal pending for torrents that have disappeared from engine state
                    if (_pendingRemovalTorrents.value.isNotEmpty()) {
                        _pendingRemovalTorrents.value = _pendingRemovalTorrents.value.intersect(engineInfoHashes)
                    }
                }
            }
        }
    }

    // Filter and sort state
    private val _filter = MutableStateFlow(TorrentFilter.ALL)
    val filter: StateFlow<TorrentFilter> = _filter

    private val _sortOrder = MutableStateFlow(TorrentSortOrder.DATE_ADDED)
    val sortOrder: StateFlow<TorrentSortOrder> = _sortOrder

    // Selection state for multi-select mode
    private val _selectedTorrents = MutableStateFlow<Set<String>>(emptySet())
    val selectedTorrents: StateFlow<Set<String>> = _selectedTorrents.asStateFlow()

    // Pending action state - torrents that have been tapped but engine hasn't responded yet
    // This provides immediate visual feedback when user taps play/pause while engine is starting
    private val _pendingTorrents = MutableStateFlow<Set<String>>(emptySet())
    val pendingTorrents: StateFlow<Set<String>> = _pendingTorrents.asStateFlow()

    // Pending removal state - torrents being removed, shows "Removing" status with faded appearance
    private val _pendingRemovalTorrents = MutableStateFlow<Set<String>>(emptySet())
    val pendingRemovalTorrents: StateFlow<Set<String>> = _pendingRemovalTorrents.asStateFlow()

    // Track when each torrent was last actively downloading (for stable speed sorting)
    // When a torrent stops, it keeps its position based on when it was last active
    private val lastActiveAt = mutableMapOf<String, Long>()

    val isSelectionMode: StateFlow<Boolean> = _selectedTorrents.map { it.isNotEmpty() }
        .stateIn(viewModelScope, SharingStarted.Eagerly, false)

    // Flow of cached summaries (empty list if no cache provided)
    private val cachedSummariesFlow = cache?.summaries ?: flowOf(emptyList())
    // If no cache provided, treat as "not loaded" - must wait for engine
    private val cacheIsLoadedFlow = cache?.isLoaded ?: flowOf(false)

    // Combined data source flow - combines engine state with cache fallback
    private val dataSourceFlow = combine(
        repository.isLoaded,
        repository.state,
        repository.lastError,
        cachedSummariesFlow,
        cacheIsLoadedFlow
    ) { isLoaded, state, error, cachedSummaries, cacheIsLoaded ->
        DataSourceState(isLoaded, state, error, cachedSummaries, cacheIsLoaded)
    }

    // Combined UI state - engine state wins when available, falls back to cache
    val uiState: StateFlow<TorrentListUiState> = combine(
        dataSourceFlow,
        _filter,
        _sortOrder
    ) { dataSource, filter, sortOrder ->
        val engineTorrents = dataSource.state?.torrents ?: emptyList()

        // Update lastActiveAt for torrents that are currently downloading
        val now = System.currentTimeMillis()
        engineTorrents.forEach { torrent ->
            if (torrent.downloadSpeed > 0) {
                lastActiveAt[torrent.infoHash] = now
            }
        }

        // Custom sort function that uses lastActiveAt for speed sorting
        fun List<TorrentSummary>.sortWithLastActive(): List<TorrentSummary> {
            return when (sortOrder) {
                TorrentSortOrder.NAME -> this.sortedBy { it.name.lowercase() }
                TorrentSortOrder.DATE_ADDED -> this.sortedByDescending { it.addedAt }
                TorrentSortOrder.DOWNLOAD_SPEED -> this.sortedWith(
                    compareByDescending<TorrentSummary> { it.downloadSpeed }
                        .thenByDescending { lastActiveAt[it.infoHash] ?: 0L }
                        .thenByDescending { it.addedAt }
                )
            }
        }

        android.util.Log.d("TorrentListVM", "uiState: engineLoaded=${dataSource.isLoaded}, " +
            "engineTorrents=${engineTorrents.size}, " +
            "cachedSummaries=${dataSource.cachedSummaries.size}, " +
            "cacheIsLoaded=${dataSource.cacheIsLoaded}, error=${dataSource.error}")
        when {
            // Error state (only show if engine hasn't loaded yet)
            dataSource.error != null && !dataSource.isLoaded -> {
                android.util.Log.d("TorrentListVM", "-> Error state")
                TorrentListUiState.Error(dataSource.error)
            }

            // Engine is loaded AND has sent state - use live state
            dataSource.isLoaded && dataSource.state != null -> {
                val filteredTorrents = engineTorrents
                    .filterByStatus(filter)
                    .sortWithLastActive()
                android.util.Log.d("TorrentListVM", "-> Live state, ${filteredTorrents.size} torrents")
                TorrentListUiState.Loaded(
                    torrents = filteredTorrents,
                    filter = filter,
                    sortOrder = sortOrder,
                    isLive = true
                )
            }

            // Engine is loaded but hasn't sent state yet - show cache to prevent flicker
            dataSource.isLoaded && dataSource.cachedSummaries.isNotEmpty() -> {
                val torrents = dataSource.cachedSummaries.map { cached ->
                    with(cache!!) { cached.toTorrentSummary() }
                }
                val filteredTorrents = torrents
                    .filterByStatus(filter)
                    .sortWithLastActive()
                android.util.Log.d("TorrentListVM", "-> Engine starting, showing cache, ${filteredTorrents.size} torrents")
                TorrentListUiState.Loaded(
                    torrents = filteredTorrents,
                    filter = filter,
                    sortOrder = sortOrder,
                    isLive = false  // Still cached until engine sends state
                )
            }

            // Engine is loaded, no state yet, no cache - show empty list
            dataSource.isLoaded -> {
                android.util.Log.d("TorrentListVM", "-> Live state, empty")
                TorrentListUiState.Loaded(
                    torrents = emptyList(),
                    filter = filter,
                    sortOrder = sortOrder,
                    isLive = true
                )
            }

            // Engine not loaded but cache has data - show cached (not live)
            dataSource.cachedSummaries.isNotEmpty() -> {
                val torrents = dataSource.cachedSummaries.map { cached ->
                    with(cache!!) { cached.toTorrentSummary() }
                }
                val filteredTorrents = torrents
                    .filterByStatus(filter)
                    .sortWithLastActive()
                android.util.Log.d("TorrentListVM", "-> Cache state, ${filteredTorrents.size} torrents")
                TorrentListUiState.Loaded(
                    torrents = filteredTorrents,
                    filter = filter,
                    sortOrder = sortOrder,
                    isLive = false
                )
            }

            // Cache has loaded but is empty - show empty list (not live)
            dataSource.cacheIsLoaded -> {
                android.util.Log.d("TorrentListVM", "-> Cache loaded but EMPTY")
                TorrentListUiState.Loaded(
                    torrents = emptyList(),
                    filter = filter,
                    sortOrder = sortOrder,
                    isLive = false
                )
            }

            // Cache still loading - show loading spinner
            else -> {
                android.util.Log.d("TorrentListVM", "-> Loading state")
                TorrentListUiState.Loading
            }
        }
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.Eagerly,
        initialValue = TorrentListUiState.Loading
    )

    // Helper data class for combining engine + cache state
    private data class DataSourceState(
        val isLoaded: Boolean,
        val state: com.jstorrent.quickjs.model.EngineState?,
        val error: String?,
        val cachedSummaries: List<com.jstorrent.app.cache.CachedTorrentSummary>,
        val cacheIsLoaded: Boolean
    )

    /**
     * Aggregate download speed across all torrents (bytes/sec).
     * Updates every 500ms when engine state changes.
     */
    val aggregateDownloadSpeed: StateFlow<Long> = repository.state.map { state ->
        state?.torrents?.sumOf { it.downloadSpeed } ?: 0L
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.Eagerly,
        initialValue = 0L
    )

    /**
     * Aggregate upload speed across all torrents (bytes/sec).
     * Updates every 500ms when engine state changes.
     */
    val aggregateUploadSpeed: StateFlow<Long> = repository.state.map { state ->
        state?.torrents?.sumOf { it.uploadSpeed } ?: 0L
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.Eagerly,
        initialValue = 0L
    )

    /**
     * Engine error (e.g., JS initialization failure).
     * Exposed for UI to show toast notifications.
     */
    val engineError: StateFlow<String?> = repository.lastError

    /**
     * Filter counts for each filter type.
     * Exposed as StateFlow so Compose can observe and recompose when counts change.
     * Uses engine state when available, falls back to cached data when engine is off.
     */
    val filterCounts: StateFlow<Map<TorrentFilter, Int>> = combine(
        repository.state,
        repository.isLoaded,
        cachedSummariesFlow
    ) { state, isLoaded, cachedSummaries ->
        val torrents = when {
            isLoaded -> state?.torrents ?: emptyList()
            cachedSummaries.isNotEmpty() -> cachedSummaries.map { cached ->
                with(cache!!) { cached.toTorrentSummary() }
            }
            else -> emptyList()
        }
        TorrentFilter.entries.associateWith { filter ->
            torrents.filterByStatus(filter).size
        }
    }.stateIn(
        scope = viewModelScope,
        started = SharingStarted.Eagerly,
        initialValue = TorrentFilter.entries.associateWith { 0 }
    )

    /**
     * Set the filter for the torrent list.
     */
    fun setFilter(filter: TorrentFilter) {
        _filter.value = filter
    }

    /**
     * Set the sort order for the torrent list.
     */
    fun setSortOrder(sortOrder: TorrentSortOrder) {
        _sortOrder.value = sortOrder
    }

    /**
     * Add a torrent from magnet link or base64 data.
     * Stage 2: Starts engine on demand if not running.
     */
    fun addTorrent(magnetOrBase64: String) {
        if (magnetOrBase64.isBlank()) return
        onEnsureEngineStarted()
        repository.addTorrent(magnetOrBase64)
        onTorrentAdded()
    }

    /**
     * Replace an existing torrent (if present) and add/start fresh.
     * This removes any existing torrent with the same infohash before adding,
     * ensuring the torrent starts in active state.
     * Stage 2: Starts engine on demand if not running.
     */
    fun replaceAndStartTorrent(magnetOrBase64: String) {
        if (magnetOrBase64.isBlank()) return
        onEnsureEngineStarted()
        val infoHash = extractInfoHash(magnetOrBase64)
        // Use viewModelScope to properly sequence remove -> add
        viewModelScope.launch {
            repository.replaceAndAddTorrent(magnetOrBase64, infoHash)
        }
        onTorrentAdded()
    }

    companion object {
        /**
         * Extract infohash from a magnet link.
         * Returns null if not a valid magnet link.
         */
        fun extractInfoHash(magnetOrBase64: String): String? {
            val magnet = magnetOrBase64.trim()
            if (!magnet.startsWith("magnet:?", ignoreCase = true)) {
                return null
            }
            // Find xt=urn:btih: parameter
            val btihPrefix = "xt=urn:btih:"
            val startIdx = magnet.indexOf(btihPrefix, ignoreCase = true)
            if (startIdx < 0) return null
            val hashStart = startIdx + btihPrefix.length
            // Find end of hash (& or end of string)
            val hashEnd = magnet.indexOf('&', hashStart).let { if (it < 0) magnet.length else it }
            val hash = magnet.substring(hashStart, hashEnd)
            // Infohash should be 40 hex chars (SHA1) or 32 base32 chars
            return if (hash.length == 40 || hash.length == 32) hash.lowercase() else null
        }
    }

    /**
     * Pause a torrent by info hash.
     * Stage 2: Starts engine on demand if not running.
     * Immediately marks torrent as pending for instant UI feedback.
     */
    fun pauseTorrent(infoHash: String) {
        _pendingTorrents.value = _pendingTorrents.value + infoHash
        onEnsureEngineStarted()
        repository.pauseTorrent(infoHash)
    }

    /**
     * Resume a torrent by info hash.
     * Stage 2: Starts engine on demand if not running.
     * Immediately marks torrent as pending for instant UI feedback.
     */
    fun resumeTorrent(infoHash: String) {
        _pendingTorrents.value = _pendingTorrents.value + infoHash
        onEnsureEngineStarted()
        repository.resumeTorrent(infoHash)
    }

    /**
     * Remove a torrent by info hash.
     * Stage 2: Starts engine on demand if not running.
     * Immediately marks torrent as pending removal for instant UI feedback.
     */
    fun removeTorrent(infoHash: String, deleteFiles: Boolean = false) {
        _pendingRemovalTorrents.value = _pendingRemovalTorrents.value + infoHash
        onEnsureEngineStarted()
        repository.removeTorrent(infoHash, deleteFiles)
    }

    /**
     * Pause all torrents.
     * Stage 2: Starts engine on demand if not running.
     */
    fun pauseAll() {
        onEnsureEngineStarted()
        repository.pauseAll()
    }

    /**
     * Resume all torrents.
     * Stage 2: Starts engine on demand if not running.
     */
    fun resumeAll() {
        onEnsureEngineStarted()
        repository.resumeAll()
    }

    /**
     * Get the count of torrents matching a specific filter.
     * Useful for displaying badge counts on filter tabs.
     */
    fun getFilterCount(filter: TorrentFilter): Int {
        val state = uiState.value
        if (state !is TorrentListUiState.Loaded) return 0

        // We need unfiltered list, get from repository
        val allTorrents = repository.state.value?.torrents ?: return 0
        return allTorrents.filterByStatus(filter).size
    }

    /**
     * Check if a torrent is paused.
     */
    fun isPaused(torrent: TorrentSummary): Boolean {
        return torrent.status == "stopped"
    }

    /**
     * Refresh the cache from persisted session state.
     * Call this when the Activity resumes to pick up any changes that occurred
     * while the screen was off (e.g., background downloads completing).
     *
     * If any torrents are active (not paused), automatically starts the engine
     * so the user sees live state instead of stale cached "stopped" status.
     */
    fun refreshCache() {
        cache?.let { summaryCache ->
            viewModelScope.launch {
                val summaries = summaryCache.load()
                // If any torrents are active (userState == "active"), start the engine
                // so user sees live state instead of cached "stopped" status
                val hasActiveTorrents = summaries.any { it.userState == "active" }
                if (hasActiveTorrents) {
                    onEnsureEngineStarted()
                }
            }
        }
    }

    /**
     * Called when the screen is paused (navigated away or backgrounded).
     * Pauses subscription pushes to save resources.
     */
    fun onScreenPaused() {
        repository.pauseSubscriptions()
    }

    /**
     * Called when the screen is resumed (navigated back or foregrounded).
     * Resumes subscription pushes and re-subscribes to global state.
     */
    fun onScreenResumed() {
        repository.resumeSubscriptions()
        // Re-subscribe to ensure we're getting torrent list updates.
        // The detail view may have changed subscriptions while we were paused.
        if (repository.isLoaded.value) {
            repository.subscribe("torrents", "", 1000)
        }
    }

    /**
     * Clean up subscriptions when ViewModel is cleared.
     */
    override fun onCleared() {
        super.onCleared()
        repository.unsubscribe("torrents", "")
    }

    // =========================================================================
    // Selection mode methods
    // =========================================================================

    /**
     * Select a torrent (enters selection mode if not already).
     */
    fun selectTorrent(infoHash: String) {
        _selectedTorrents.value = _selectedTorrents.value + infoHash
    }

    /**
     * Toggle selection state for a torrent.
     */
    fun toggleSelection(infoHash: String) {
        _selectedTorrents.value = if (infoHash in _selectedTorrents.value) {
            _selectedTorrents.value - infoHash
        } else {
            _selectedTorrents.value + infoHash
        }
    }

    /**
     * Clear all selections (exits selection mode).
     */
    fun clearSelection() {
        _selectedTorrents.value = emptySet()
    }

    /**
     * Pause all selected torrents.
     * Stage 2: Starts engine on demand if not running.
     */
    fun pauseSelected() {
        onEnsureEngineStarted()
        _selectedTorrents.value.forEach { hash ->
            repository.pauseTorrent(hash)
        }
        clearSelection()
    }

    /**
     * Resume all selected torrents.
     * Stage 2: Starts engine on demand if not running.
     */
    fun resumeSelected() {
        onEnsureEngineStarted()
        _selectedTorrents.value.forEach { hash ->
            repository.resumeTorrent(hash)
        }
        clearSelection()
    }

    /**
     * Remove all selected torrents.
     * Stage 2: Starts engine on demand if not running.
     * Immediately marks torrents as pending removal for instant UI feedback.
     */
    fun removeSelected(deleteFiles: Boolean) {
        _pendingRemovalTorrents.value = _pendingRemovalTorrents.value + _selectedTorrents.value
        onEnsureEngineStarted()
        _selectedTorrents.value.forEach { hash ->
            repository.removeTorrent(hash, deleteFiles)
        }
        clearSelection()
    }

    /**
     * Factory for creating TorrentListViewModel with dependencies.
     */
    class Factory(
        private val application: android.app.Application
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            if (modelClass.isAssignableFrom(TorrentListViewModel::class.java)) {
                val app = application as com.jstorrent.app.JSTorrentApplication
                val metricsStore = com.jstorrent.app.settings.MetricsStore(application)
                return TorrentListViewModel(
                    repository = EngineServiceRepository(application),
                    cache = app.torrentSummaryCache,
                    onEnsureEngineStarted = { app.ensureEngineStarted() },
                    onTorrentAdded = { metricsStore.incrementTorrentsAdded() }
                ) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
    }
}
