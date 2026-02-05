package com.jstorrent.app.viewmodel

import com.jstorrent.quickjs.model.EngineState
import com.jstorrent.quickjs.model.DhtStats
import com.jstorrent.quickjs.model.EngineStats
import com.jstorrent.quickjs.model.JsThreadStats
import com.jstorrent.quickjs.model.SpeedSamplesResult
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
     * Add a torrent from magnet link or base64-encoded .torrent file.
     */
    fun addTorrent(magnetOrBase64: String)

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
     * @param type Subscription type: "torrents", "peers", "files", "trackers", "pieces", "details"
     * @param hash Torrent info hash, or "" for torrent list
     * @param intervalMs Push interval in milliseconds
     */
    fun subscribe(type: String, hash: String, intervalMs: Int)

    /**
     * Unsubscribe from a specific data type for a torrent.
     *
     * @param type Subscription type
     * @param hash Torrent info hash, or "" for torrent list
     */
    fun unsubscribe(type: String, hash: String)

    /**
     * Unsubscribe from all data types for a torrent.
     * Use when navigating away from torrent detail view.
     *
     * @param hash Torrent info hash
     */
    fun unsubscribeAll(hash: String)

    /**
     * Pause all subscription pushes.
     * Call when screen is not visible to save resources.
     */
    fun pauseSubscriptions()

    /**
     * Resume subscription pushes.
     * Call when screen becomes visible again.
     */
    fun resumeSubscriptions()
}
