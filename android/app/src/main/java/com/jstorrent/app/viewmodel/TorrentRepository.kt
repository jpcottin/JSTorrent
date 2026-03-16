package com.jstorrent.app.viewmodel

import com.jstorrent.quickjs.model.EngineState
import com.jstorrent.quickjs.model.DhtStats
import com.jstorrent.quickjs.model.EngineStats
import com.jstorrent.quickjs.model.JsThreadStats
import com.jstorrent.quickjs.model.SpeedSamplesResult
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow

/**
 * Interface for accessing torrent engine functionality.
 * Abstracts the EngineController for testability.
 */
interface TorrentRepository {
    /**
     * Flow of engine state updates (torrents list).
     */
    val state: StateFlow<EngineState?>

    /**
     * Flow indicating whether the engine is loaded.
     */
    val isLoaded: StateFlow<Boolean>

    /**
     * Flow of last error message.
     */
    val lastError: StateFlow<String?>

    /**
     * One-shot events emitted when a duplicate torrent is added.
     * Emits the infoHash of the existing torrent.
     */
    val duplicateTorrentEvent: SharedFlow<String>

    /**
     * Add a torrent from magnet link or base64-encoded .torrent file.
     */
    fun addTorrent(magnetOrBase64: String)

    /**
     * Add a torrent with options (e.g., userState for file selection flow).
     * @param optionsJson JSON string with options, e.g. {"userState":"awaitingFileSelection"}
     */
    fun addTorrentWithOptions(magnetOrBase64: String, optionsJson: String)

    /**
     * Assign a storage root to a specific torrent.
     * Used in the file selection flow before activating a torrent.
     */
    fun setTorrentRoot(infoHash: String, rootKey: String)

    /**
     * Pause a torrent by info hash.
     */
    fun pauseTorrent(infoHash: String)

    /**
     * Resume a paused torrent.
     */
    fun resumeTorrent(infoHash: String)

    /**
     * Remove a torrent.
     * @param infoHash The torrent's info hash
     * @param deleteFiles If true, also delete downloaded files
     */
    fun removeTorrent(infoHash: String, deleteFiles: Boolean = false)

    /**
     * Recheck (verify) torrent data.
     * @param infoHash The torrent's info hash
     */
    fun recheckTorrent(infoHash: String)

    /**
     * Reset torrent state (progress, stats) without removing it.
     * The torrent will be stopped after reset.
     * @param infoHash The torrent's info hash
     */
    fun resetTorrent(infoHash: String)

    /**
     * Replace an existing torrent (if present) and add fresh.
     * Awaits removal completion before adding to avoid race conditions.
     * @param magnetOrBase64 Magnet link or base64-encoded .torrent
     * @param infoHash The info hash to remove (if known), or null to extract from magnet
     */
    suspend fun replaceAndAddTorrent(magnetOrBase64: String, infoHash: String?)

    /**
     * Pause all torrents (changes userState to stopped).
     * Use for user-initiated "pause all" or shutdown.
     */
    fun pauseAll()

    /**
     * Resume all torrents (changes userState to active for stopped torrents).
     * Use for user-initiated "resume all".
     */
    fun resumeAll()

    /**
     * Suspend the engine - stop all network activity globally.
     * Preserves each torrent's userState (doesn't mark them as stopped).
     * New torrents added while suspended won't start networking.
     * Use for WiFi-only / VPN-only mode when network conditions aren't met.
     */
    fun suspendEngine()

    /**
     * Resume the engine - restart network activity.
     * Only torrents with userState 'active' will start networking.
     * Use when network conditions are restored (WiFi/VPN connected).
     */
    fun resumeEngine()

    /**
     * Move a torrent to the top of the queue.
     */
    fun queueMoveToTop(infoHash: String)

    /**
     * Move a torrent to the bottom of the queue.
     */
    fun queueMoveToBottom(infoHash: String)

    /**
     * Force start a torrent, bypassing queue limits.
     */
    fun forceStart(infoHash: String)

    /**
     * Set file priorities for a torrent.
     * @param infoHash The torrent's info hash
     * @param priorities Map of file index to priority (0=Normal, 1=Skip, 2=High)
     */
    fun setFilePriorities(infoHash: String, priorities: Map<Int, Int>)

    /**
     * Get DHT statistics (suspend query).
     * Returns null if DHT is not initialized.
     */
    suspend fun getDhtStats(): DhtStats?

    /**
     * Get speed samples from the bandwidth tracker for graphing.
     *
     * @param direction "down" or "up"
     * @param categories "all" or JSON array of categories
     * @param fromTime Start timestamp in ms since epoch
     * @param toTime End timestamp in ms since epoch
     * @param maxPoints Maximum number of data points to return
     * @return SpeedSamplesResult with samples and bucket metadata, or null on error
     */
    suspend fun getSpeedSamples(
        direction: String,
        categories: String = "all",
        fromTime: Long,
        toTime: Long,
        maxPoints: Int = 300
    ): SpeedSamplesResult?

    /**
     * Get JS thread health statistics.
     * Returns current/max latency and callback queue depth.
     */
    fun getJsThreadStats(): JsThreadStats?

    /**
     * Get engine statistics for health monitoring.
     * Returns tick duration, active pieces, and connected peers from JS engine.
     */
    suspend fun getEngineStats(): EngineStats?

    // =========================================================================
    // Subscription API
    // =========================================================================

    /**
     * Subscribe to data updates for a torrent (or torrent list).
     *
     * Returns a [SubscriptionHandle] that must be closed when updates are no longer needed.
     * Multiple handles can exist for the same topic; the underlying subscription is only
     * removed when all handles for that topic are closed.
     *
     * Subscriptions can be created before the engine is loaded - they will be replayed
     * when the engine becomes available.
     *
     * Visibility (pause/resume) is handled automatically:
     * - First subscription resumes the push loop
     * - Last subscription closing pauses the push loop
     *
     * @param type Subscription type: "torrents", "torrent", "peers", "files", "trackers", "pieces", "details"
     * @param hash Torrent info hash, or "" for torrent list
     * @param intervalMs Push interval in milliseconds
     * @return Handle to release the subscription when done
     */
    fun subscribe(type: String, hash: String, intervalMs: Int): SubscriptionHandle
}
