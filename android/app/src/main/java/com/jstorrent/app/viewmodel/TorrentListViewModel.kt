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

    // Subscription handle for torrent list updates.
    // The tracker handles ref-counting and pending state, so we can subscribe immediately.
    private var torrentsSubscription: SubscriptionHandle? = null

    // Pending action state - torrents that have been tapped but engine hasn't responded yet
    // This provides immediate visual feedback when user taps play/pause while engine is starting
    // NOTE: Must be declared BEFORE init block since the coroutine accesses these
    private val _pendingTorrents = MutableStateFlow<Set<String>>(emptySet())
    val pendingTorrents: StateFlow<Set<String>> = _pendingTorrents.asStateFlow()

    // Pending removal state - torrents being removed, shows "Removing" status with faded appearance
    private val _pendingRemovalTorrents = MutableStateFlow<Set<String>>(emptySet())
    val pendingRemovalTorrents: StateFlow<Set<String>> = _pendingRemovalTorrents.asStateFlow()

    // Pending new torrents - placeholder entries shown immediately when adding a torrent
    // before the engine has started and parsed the data. Cleared when engine torrent count
    // exceeds the baseline (meaning the real torrent has appeared in engine state).
    private val _pendingNewTorrents = MutableStateFlow<List<TorrentSummary>>(emptyList())
    // Torrent count baseline when pending entries were added. Used to detect when the
    // engine has actually processed the new torrent (count increases above this baseline).
    private var _pendingBaseTorrentCount = 0

    // Highlighted torrent (for duplicate detection feedback)
    private val _highlightedTorrent = MutableStateFlow<String?>(null)
    val highlightedTorrent: StateFlow<String?> = _highlightedTorrent.asStateFlow()

    init {
        // Load cache asynchronously on initialization
        cache?.let { summaryCache ->
            viewModelScope.launch {
                summaryCache.load()
            }
        }

        // Subscribe to torrent list immediately.
        // SubscriptionTracker handles the case where engine isn't loaded yet - it will
        // replay the subscription when the controller becomes available.
        torrentsSubscription = repository.subscribe("torrents", "", 1000)

        // Surface duplicate torrent events as highlight state
        viewModelScope.launch {
            repository.duplicateTorrentEvent.collect { infoHash ->
                _highlightedTorrent.value = infoHash
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
                    // Clear pending new torrent placeholders only when the engine's
                    // torrent count exceeds the baseline from before we added them.
                    // This prevents flicker: pending shows → engine reports old state
                    // (no new torrent yet) → pending would be cleared → gap → real torrent appears.
                    if (_pendingNewTorrents.value.isNotEmpty() &&
                        state.torrents.size > _pendingBaseTorrentCount) {
                        _pendingNewTorrents.value = emptyList()
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
        _sortOrder,
        _pendingNewTorrents
    ) { dataSource, filter, sortOrder, pendingNew ->
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
            "cacheIsLoaded=${dataSource.cacheIsLoaded}, error=${dataSource.error}, " +
            "pendingNew=${pendingNew.size}")
        val baseState = when {
            // Error state (only show if engine hasn't loaded yet)
            dataSource.error != null && !dataSource.isLoaded -> {
                android.util.Log.d("TorrentListVM", "-> Error state")
                TorrentListUiState.Error(dataSource.error)
            }

            // Engine is loaded AND has sent state with torrents - use live state
            dataSource.isLoaded && dataSource.state != null && engineTorrents.isNotEmpty() -> {
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

            // Engine is loaded but no state received yet AND cache has data - prefer cache during subscription transitions
            // This prevents flicker when navigating back from detail view (subscription gap)
            // Note: only applies when state is null (no state sent yet), not when state is empty (deliberately empty)
            dataSource.isLoaded && dataSource.state == null && dataSource.cachedSummaries.isNotEmpty() -> {
                val torrents = dataSource.cachedSummaries.map { cached ->
                    with(cache!!) { cached.toTorrentSummary() }
                }
                val filteredTorrents = torrents
                    .filterByStatus(filter)
                    .sortWithLastActive()
                android.util.Log.d("TorrentListVM", "-> Engine loaded but no state yet, showing cache, ${filteredTorrents.size} torrents")
                TorrentListUiState.Loaded(
                    torrents = filteredTorrents,
                    filter = filter,
                    sortOrder = sortOrder,
                    isLive = false  // Show as not-live until engine sends state with torrents
                )
            }

            // Engine is loaded, no state or empty torrents, no cache - show empty list (truly empty)
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

        // Prepend pending new torrent placeholders so they appear immediately
        if (pendingNew.isNotEmpty()) {
            when (baseState) {
                is TorrentListUiState.Loaded ->
                    baseState.copy(torrents = pendingNew + baseState.torrents)
                is TorrentListUiState.Loading ->
                    TorrentListUiState.Loaded(
                        torrents = pendingNew,
                        filter = filter,
                        sortOrder = sortOrder,
                        isLive = false
                    )
                else -> baseState
            }
        } else {
            baseState
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
     * Add a pending placeholder torrent to the list for immediate UI feedback.
     * Called before the engine starts, so the user sees the entry right away.
     * Cleared automatically when the engine reports its first state update.
     */
    fun addPendingNewTorrent(displayName: String) {
        // Capture current engine torrent count as baseline. The pending placeholder
        // stays visible until the engine reports more torrents than this baseline,
        // meaning the new torrent has been processed and appears in engine state.
        if (_pendingNewTorrents.value.isEmpty()) {
            _pendingBaseTorrentCount = repository.state.value?.torrents?.size ?: 0
        }
        val placeholder = TorrentSummary(
            infoHash = "__pending_${System.nanoTime()}",
            name = displayName,
            progress = 0.0,
            downloadSpeed = 0L,
            uploadSpeed = 0L,
            status = "downloading_metadata",
            userState = "active",
            hasMetadata = false,
            addedAt = System.currentTimeMillis()
        )
        _pendingNewTorrents.value = _pendingNewTorrents.value + placeholder
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
     * Clear the highlighted torrent state (called after animation completes).
     */
    fun clearHighlight() {
        _highlightedTorrent.value = null
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
        // Also remove from in-memory cache to prevent stale data when falling back to cache
        cache?.removeFromCache(setOf(infoHash))
        onEnsureEngineStarted()
        repository.removeTorrent(infoHash, deleteFiles)
    }

    /**
     * Mark a torrent as pending removal without actually removing it.
     * Used when removal is initiated from another screen (e.g., detail view)
     * so the list shows the "Removing" treatment when navigating back.
     */
    fun markPendingRemoval(infoHash: String) {
        _pendingRemovalTorrents.value = _pendingRemovalTorrents.value + infoHash
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
     *
     * Note: We keep the subscription active during pause for fast resume.
     * The subscription will be automatically paused by SubscriptionTracker
     * if all subscriptions are closed (e.g., when ViewModel is cleared).
     */
    fun onScreenPaused() {
        // No-op: subscription stays active for fast resume
        // Visibility is now managed automatically by SubscriptionTracker
    }

    /**
     * Called when the screen is resumed (navigated back or foregrounded).
     *
     * Note: Subscription is created in init and stays active, so no re-subscribe needed.
     * If the subscription was somehow closed (shouldn't happen), recreate it.
     */
    fun onScreenResumed() {
        // Recreate subscription if it was closed (defensive)
        if (torrentsSubscription?.isClosed == true) {
            torrentsSubscription = repository.subscribe("torrents", "", 1000)
        }
    }

    /**
     * Clean up subscriptions when ViewModel is cleared.
     */
    override fun onCleared() {
        super.onCleared()
        torrentsSubscription?.close()
        torrentsSubscription = null
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
        val hashesToPause = _selectedTorrents.value
        if (hashesToPause.isEmpty()) return

        onEnsureEngineStarted()
        hashesToPause.forEach { hash ->
            repository.pauseTorrent(hash)
        }
        clearSelection()
    }

    /**
     * Resume all selected torrents.
     * Stage 2: Starts engine on demand if not running.
     */
    fun resumeSelected() {
        val hashesToResume = _selectedTorrents.value
        if (hashesToResume.isEmpty()) return

        onEnsureEngineStarted()
        hashesToResume.forEach { hash ->
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
        // Capture selected torrents once to avoid race conditions where selection
        // could be cleared between reading for pending state and the removal loop
        val hashesToRemove = _selectedTorrents.value
        if (hashesToRemove.isEmpty()) return

        _pendingRemovalTorrents.value = _pendingRemovalTorrents.value + hashesToRemove
        // Also remove from in-memory cache to prevent stale data when falling back to cache
        cache?.removeFromCache(hashesToRemove)
        onEnsureEngineStarted()
        hashesToRemove.forEach { hash ->
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
                    repository = app.engineServiceRepository,
                    cache = app.torrentSummaryCache,
                    onEnsureEngineStarted = { app.ensureEngineStarted() },
                    onTorrentAdded = { metricsStore.incrementTorrentsAdded() }
                ) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
    }
}
