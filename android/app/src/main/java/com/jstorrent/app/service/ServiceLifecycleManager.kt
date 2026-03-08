package com.jstorrent.app.service

import android.content.Context
import android.util.Log
import androidx.annotation.VisibleForTesting
import com.jstorrent.app.cache.TorrentSummaryCache
import com.jstorrent.app.debug.MEMORY_TAG
import com.jstorrent.app.settings.SettingsStore
import com.jstorrent.quickjs.model.TorrentSummary
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow

private const val TAG = "ServiceLifecycleMgr"

/**
 * Decides when ForegroundNotificationService should run.
 *
 * Service runs when: background downloads enabled AND active downloads/seeding AND user not in app
 * Service stops when: background downloads disabled OR idle OR user in app
 *
 * Engine shutdown for battery saving:
 * - When background downloads are disabled and user leaves the app
 * - When service stops due to idle (no active downloads/seeding) while in background
 *
 * Stage 4 (Lazy Engine Startup): Background service coordination:
 * - If engine not started but cache has active incomplete torrents AND background downloads
 *   are enabled, request engine start so downloads can continue in background.
 * - Otherwise, don't start engine just because activity is foregrounded.
 *
 * The engine is reinitialized when the user returns to the app.
 */
class ServiceLifecycleManager(
    private val context: Context,
    private val settingsStore: SettingsStore,
    private val torrentSummaryCache: TorrentSummaryCache? = null,
    private val onShutdownForBackground: () -> Unit = {},
    private val onRestoreFromBackground: () -> Unit = {},
    private val onStartEngineForBackground: () -> Unit = {}
) {

    private val _isActivityForeground = MutableStateFlow(false)
    val isActivityForeground: StateFlow<Boolean> = _isActivityForeground

    private var startedActivityCount = 0
    private var hasActiveWork = false
    // Sync with actual service state on init to handle crashes/restarts
    private var serviceRunning = ForegroundNotificationService.instance != null
    private var engineShutdownForBackground = false
    private var hasEverBeenForeground = false  // Track if activity has ever been visible
    private var userRequestedQuit = false  // Prevents auto-restart after explicit quit
    private var engineHasReportedState = false  // True once engine has reported torrent state
    private var activePlaybackSessions = 0  // Active streaming player sessions keeping the engine alive

    // Track if we've called startForegroundService() but the service hasn't started yet.
    // We must NOT call stopService() in this state or Android crashes with
    // ForegroundServiceDidNotStartInTimeException.
    private var serviceStartPending = false

    /**
     * Called from Activity.onStart()
     */
    fun onActivityStart() {
        startedActivityCount++
        Log.d(TAG, "Activity started (foreground)")
        Log.i(MEMORY_TAG, "[MARK] app_foreground")
        _isActivityForeground.value = true
        hasEverBeenForeground = true
        userRequestedQuit = false  // Reset quit flag when user returns to app

        // If service start is pending (startForegroundService called but onCreate not yet run),
        // we CANNOT call stopService() or Android crashes. The service will check
        // shouldStopImmediately() in onStartCommand and stop itself.
        if (serviceStartPending) {
            Log.d(TAG, "Service start pending - will stop itself after onCreate")
        }

        // Clean up any fully-started orphaned service.
        // Only safe to stop if the service has actually started (instance != null).
        if (ForegroundNotificationService.instance != null) {
            Log.i(TAG, "Cleaning up orphaned foreground service")
            ForegroundNotificationService.stop(context)
            serviceRunning = false
        }

        updateServiceState()
    }

    /**
     * Called from Activity.onStop()
     */
    fun onActivityStop() {
        startedActivityCount = (startedActivityCount - 1).coerceAtLeast(0)
        Log.d(TAG, "Activity stopped (background)")
        Log.i(MEMORY_TAG, "[MARK] app_background")
        _isActivityForeground.value = startedActivityCount > 0
        updateServiceState()
    }

    /**
     * Called when torrent state changes.
     * Determines if there's active work based on torrent statuses and settings.
     *
     * Note: Error state torrents are NOT considered active work - they are effectively stopped
     * and should not prevent the engine from suspending or the foreground service from stopping.
     */
    fun onTorrentStateChanged(torrents: List<TorrentSummary>) {
        engineHasReportedState = true  // Engine is running and reporting state
        val seedInBackground = settingsStore.whenDownloadsComplete == "keep_seeding"

        hasActiveWork = torrents.any { torrent ->
            val isDownloading = torrent.status in listOf(
                "downloading",
                "downloading_metadata",
                "checking"
            )
            val isSeeding = torrent.status == "seeding" && seedInBackground
            isDownloading || isSeeding
        }

        Log.d(TAG, "Torrent state changed: hasActiveWork=$hasActiveWork, " +
            "torrents=${torrents.size}, seedInBackground=$seedInBackground")
        updateServiceState()
    }

    /**
     * Called when the native streaming player starts or resumes a playback session.
     *
     * Active playback should keep the engine alive even if background downloads are disabled,
     * otherwise screen-off, Home, or PiP transitions can tear down the torrent mid-stream.
     */
    fun onPlaybackSessionStarted() {
        activePlaybackSessions++
        Log.d(TAG, "Playback session started: activePlaybackSessions=$activePlaybackSessions")
        updateServiceState()
    }

    /**
     * Called when the native streaming player closes its playback session.
     */
    fun onPlaybackSessionStopped() {
        if (activePlaybackSessions > 0) {
            activePlaybackSessions--
        }
        Log.d(TAG, "Playback session stopped: activePlaybackSessions=$activePlaybackSessions")
        updateServiceState()
    }

    /**
     * Manually set activity foreground state.
     * Used for testing to simulate foreground/background transitions.
     */
    fun setActivityForeground(foreground: Boolean) {
        Log.d(TAG, "Manual foreground set: $foreground")
        _isActivityForeground.value = foreground
        updateServiceState()
    }

    private fun updateServiceState() {
        // Don't restart service if user explicitly quit
        if (userRequestedQuit) {
            Log.d(TAG, "Skipping service update - user requested quit")
            return
        }

        val backgroundEnabled = settingsStore.backgroundDownloadsEnabled
        val goingToBackground = !_isActivityForeground.value
        val hasActivePlaybackSession = activePlaybackSessions > 0

        // Stage 4: Check cache for active incomplete torrents when engine isn't running yet.
        // Once the engine has reported state, we trust its hasActiveWork determination
        // (which correctly excludes error-state torrents) rather than the cache
        // (which doesn't know about runtime error state).
        val cacheHasActiveWork = if (engineHasReportedState) {
            false  // Engine is running, trust hasActiveWork from onTorrentStateChanged
        } else {
            torrentSummaryCache?.hasActiveIncompleteTorrents() ?: false
        }

        // Handle engine shutdown/restore for battery saving
        // Shut down engine when going to background if there's no reason to keep it running:
        // - Background downloads disabled, OR
        // - No active work (nothing downloading or seeding from either engine or cache)
        // This completely stops the engine tick loop to prevent battery drain
        val shouldShutdownEngine = goingToBackground &&
            !hasActivePlaybackSession &&
            (!backgroundEnabled || (!hasActiveWork && !cacheHasActiveWork)) &&
            !engineShutdownForBackground &&
            hasEverBeenForeground

        if (shouldShutdownEngine) {
            val reason = if (!backgroundEnabled) "background downloads disabled" else "no active work"
            Log.i(TAG, "Shutting down engine ($reason) to save battery")
            onShutdownForBackground()
            engineShutdownForBackground = true
            engineHasReportedState = false  // Reset so cache is checked on next engine start
        } else if (_isActivityForeground.value && engineShutdownForBackground) {
            Log.i(TAG, "Restoring engine after background shutdown")
            onRestoreFromBackground()
            engineShutdownForBackground = false
        }

        // Stage 4: Start engine in background if cache shows active incomplete torrents
        // This handles the lazy engine startup case where user backgrounds the app
        // but has active downloads that need to continue.
        if (goingToBackground &&
            backgroundEnabled &&
            !hasActiveWork &&
            cacheHasActiveWork &&
            hasEverBeenForeground &&
            !engineShutdownForBackground
        ) {
            Log.i(TAG, "Starting engine for background work (cache has active incomplete torrents)")
            onStartEngineForBackground()
            // hasActiveWork will be updated when engine reports state via onTorrentStateChanged
        }

        // Determine if service should run:
        // - Background downloads enabled OR an active playback session needs the engine alive
        // - Either engine reports active work OR cache shows active incomplete torrents OR player is streaming
        // - User is not in the app
        // - Activity has been foreground at least once
        val hasAnyActiveWork = hasActiveWork || cacheHasActiveWork || hasActivePlaybackSession
        val shouldRun =
            (backgroundEnabled || hasActivePlaybackSession) &&
                hasAnyActiveWork &&
                goingToBackground &&
                hasEverBeenForeground

        if (shouldRun && !serviceRunning) {
            Log.i(TAG, "Starting service: active work in background")
            serviceStartPending = true
            ForegroundNotificationService.start(context)
            serviceRunning = true
        } else if (!shouldRun && serviceRunning) {
            val reason = when {
                !backgroundEnabled -> "background downloads disabled"
                !hasAnyActiveWork -> "idle"
                _isActivityForeground.value -> "user in app"
                else -> "unknown"
            }
            // CRITICAL: Only call stopService() if the service has actually started.
            // If serviceStartPending is true, the service is between startForegroundService()
            // and onCreate() - calling stopService() here causes Android to crash with
            // ForegroundServiceDidNotStartInTimeException. The service will check
            // shouldStopImmediately() and stop itself after satisfying the startForeground requirement.
            if (serviceStartPending) {
                Log.i(TAG, "Service start pending, will stop after onCreate (reason: $reason)")
                // Service will stop itself - see shouldStopImmediately()
            } else if (ForegroundNotificationService.instance != null) {
                Log.i(TAG, "Stopping service: $reason")
                ForegroundNotificationService.stop(context)
            }
            serviceRunning = false
            // Note: Engine shutdown is handled above by shouldShutdownEngine
        }
    }

    /**
     * Called by ForegroundNotificationService.onCreate() to signal it has started.
     * Clears the serviceStartPending flag.
     */
    fun onServiceCreated() {
        serviceStartPending = false
    }

    /**
     * Check if the service should stop immediately after starting.
     * This handles the race condition where the activity returned to foreground
     * while the service was starting (between startForegroundService and onCreate).
     */
    fun shouldServiceStopImmediately(): Boolean {
        // If activity is in foreground, service should not be running
        return _isActivityForeground.value
    }

    /**
     * Reset the service tracking state.
     * Used when service is stopped externally (e.g., via notification quit action).
     */
    fun onServiceStopped() {
        serviceRunning = false
        serviceStartPending = false
    }

    /**
     * Reset all mutable state to construction defaults.
     * Must be called AFTER physical cleanup (service stopped, engine shut down)
     * so the flags match reality.
     */
    @VisibleForTesting
    fun resetForTesting() {
        _isActivityForeground.value = false
        startedActivityCount = 0
        hasActiveWork = false
        serviceRunning = ForegroundNotificationService.instance != null
        engineShutdownForBackground = false
        hasEverBeenForeground = false
        userRequestedQuit = false
        engineHasReportedState = false
        activePlaybackSessions = 0
        serviceStartPending = false
    }

    /**
     * Called when user explicitly quits the app.
     * Prevents auto-restart of the service until the user returns to the app.
     */
    fun onUserQuit() {
        Log.i(TAG, "User requested quit - preventing service restart")
        userRequestedQuit = true
        if (serviceRunning) {
            ForegroundNotificationService.stop(context)
            serviceRunning = false
        }
    }
}
