package com.jstorrent.app.viewmodel

import android.app.Application
import android.util.Log
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.quickjs.EngineController
import com.jstorrent.quickjs.model.EngineState
import com.jstorrent.quickjs.model.DhtStats
import com.jstorrent.quickjs.model.EngineStats
import com.jstorrent.quickjs.model.JsThreadStats
import com.jstorrent.quickjs.model.SpeedSamplesResult
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * TorrentRepository implementation that accesses the engine.
 *
 * Connects to the EngineController directly from the Application.
 * The engine lives for the process lifetime in JSTorrentApplication,
 * independent of whether ForegroundNotificationService is running (service only runs
 * when there's background work to do).
 *
 * Uses bridged StateFlows to handle the race condition where the ViewModel
 * may be created before the engine is initialized.
 *
 * ## Command Queueing Architecture
 *
 * IMPORTANT: All command queueing happens on the JS side, NOT here in Kotlin.
 *
 * Why JS-side queueing:
 * - The Kotlin controller may exist (ensureEngineStarted() returned) before
 *   the JS engine is actually ready to process commands
 * - There's a window after QuickJS context creation but before engine.init() completes
 * - JS-side queueing (via executeOrQueue in controller.ts) ensures commands wait
 *   for the actual engine instance to exist
 *
 * What this means for Kotlin code:
 * - Use simple `controller?.fooAsync()` calls - if controller is null, the call
 *   is a no-op (engine not started yet, user action triggers ensureEngineStarted)
 * - Do NOT implement Kotlin-side command queues - they fight with JS-side queuing
 *   and create confusing dual-queue behavior
 * - The only exception is subscription visibility count (registerUpdateConsumer/unregisterUpdateConsumer)
 *   which tracks UI lifecycle state, not engine commands
 */
class EngineServiceRepository(
    private val application: Application
) : TorrentRepository {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    private val app: JSTorrentApplication
        get() = application as JSTorrentApplication

    private val controller: EngineController?
        get() = app.engineController

    // Bridged state flows that forward from the engine controller
    private val _state = MutableStateFlow<EngineState?>(null)
    private val _isLoaded = MutableStateFlow(false)
    private val _lastError = MutableStateFlow<String?>(null)

    override val state: StateFlow<EngineState?> = _state.asStateFlow()
    override val isLoaded: StateFlow<Boolean> = _isLoaded.asStateFlow()
    override val lastError: StateFlow<String?> = _lastError.asStateFlow()

    // Track the controller we're connected to and collection jobs
    private var connectedController: EngineController? = null
    private var collectionJobs: List<Job> = emptyList()

    // Track pending subscription visibility count for when controller isn't available yet.
    // This handles the race condition where screens call registerUpdateConsumer() before
    // the engine is loaded. When the controller becomes available, we replay the count.
    // NOTE: This is the ONLY Kotlin-side queue - it tracks UI lifecycle state, not commands.
    // All command queueing happens on the JS side (see controller.ts executeOrQueue).
    private var pendingVisibilityCount = 0
    private val visibilityLock = Any()

    init {
        // Continuously monitor for engine controller availability
        // Reconnects when engine is restarted
        scope.launch {
            while (true) {
                val currentController = app.engineController

                // Check if we need to disconnect from old controller
                if (connectedController != null && currentController !== connectedController) {
                    // Controller changed - cancel old collections and reset state
                    collectionJobs.forEach { it.cancel() }
                    collectionJobs = emptyList()
                    connectedController = null
                    _isLoaded.value = false
                    _state.value = null
                    _lastError.value = null
                }

                // Check if we need to connect to new controller
                if (currentController != null && currentController !== connectedController) {
                    connectedController = currentController
                    collectionJobs = listOf(
                        launch { currentController.state.collect { _state.value = it } },
                        launch { currentController.isLoaded.collect { _isLoaded.value = it } },
                        launch { currentController.lastError.collect { _lastError.value = it } }
                    )

                    // Replay pending visibility count that was tracked before controller was available.
                    // This handles the case where screens called registerUpdateConsumer() before engine loaded.
                    val countToReplay = synchronized(visibilityLock) {
                        val count = pendingVisibilityCount
                        pendingVisibilityCount = 0
                        count
                    }
                    repeat(countToReplay) {
                        currentController.registerUpdateConsumer()
                    }
                    // NOTE: Command queueing (add, remove, pause, resume) happens on JS side,
                    // not here. See controller.ts executeOrQueue() and the class doc above.
                }

                delay(50)
            }
        }
    }

    // =========================================================================
    // Commands - All use JS-side queueing via controller.ts executeOrQueue()
    // DO NOT add Kotlin-side queues here - see class doc for why
    // =========================================================================

    override fun addTorrent(magnetOrBase64: String) {
        // No special handling needed for WiFi-only / VPN-only mode.
        // When engine is suspended, new torrents won't start networking automatically.
        // The torrent.start() method checks engine.isSuspended and returns early if true.
        scope.launch {
            controller?.addTorrentAsync(magnetOrBase64)
        }
    }

    override fun pauseTorrent(infoHash: String) {
        scope.launch { controller?.pauseTorrentAsync(infoHash) }
    }

    override fun resumeTorrent(infoHash: String) {
        scope.launch { controller?.resumeTorrentAsync(infoHash) }
    }

    override fun removeTorrent(infoHash: String, deleteFiles: Boolean) {
        // NOTE: If controller is null, this is a no-op. The ViewModel layer calls
        // onEnsureEngineStarted() before this, which starts the engine synchronously.
        // If the JS engine isn't quite ready yet, JS-side queueing handles it.
        // See controller.ts __jstorrent_cmd_remove for the JS-side queue.
        scope.launch { controller?.removeTorrentAsync(infoHash, deleteFiles) }
    }

    override fun recheckTorrent(infoHash: String) {
        scope.launch { controller?.recheckTorrentAsync(infoHash) }
    }

    override suspend fun replaceAndAddTorrent(magnetOrBase64: String, infoHash: String?) {
        // Remove existing torrent first (if infoHash provided) and wait for completion
        if (infoHash != null) {
            controller?.removeTorrentAsync(infoHash, deleteFiles = true)
        }
        // Then add the new torrent
        // No special handling needed for WiFi-only / VPN-only mode - see addTorrent() comment.
        controller?.addTorrentAsync(magnetOrBase64)
    }

    override fun pauseAll() {
        // Get current torrent list and pause each one (fire-and-forget)
        val torrents = state.value?.torrents ?: return
        scope.launch {
            torrents.forEach { torrent ->
                if (torrent.status != "stopped") {
                    controller?.pauseTorrentAsync(torrent.infoHash)
                }
            }
        }
    }

    override fun resumeAll() {
        // Get current torrent list and resume each one (fire-and-forget)
        val torrents = state.value?.torrents ?: return
        scope.launch {
            torrents.forEach { torrent ->
                if (torrent.status == "stopped") {
                    controller?.resumeTorrentAsync(torrent.infoHash)
                }
            }
        }
    }

    override fun suspendEngine() {
        // Suspend engine-level network activity (preserves userState)
        // New torrents added while suspended won't start networking.
        scope.launch {
            controller?.suspendEngineAsync()
            Log.i("EngineServiceRepo", "Engine suspended")
        }
    }

    override fun resumeEngine() {
        // Resume engine-level network activity
        // Only torrents with userState='active' will start networking.
        scope.launch {
            controller?.resumeEngineAsync()
            Log.i("EngineServiceRepo", "Engine resumed")
        }
    }

    override fun setFilePriorities(infoHash: String, priorities: Map<Int, Int>) {
        scope.launch { controller?.setFilePrioritiesAsync(infoHash, priorities) }
    }

    override suspend fun getDhtStats(): DhtStats? {
        return controller?.getDhtStatsAsync()
    }

    override suspend fun getSpeedSamples(
        direction: String,
        categories: String,
        fromTime: Long,
        toTime: Long,
        maxPoints: Int
    ): SpeedSamplesResult? {
        return controller?.getSpeedSamplesAsync(direction, categories, fromTime, toTime, maxPoints)
    }

    override fun getJsThreadStats(): JsThreadStats? {
        return controller?.getJsThreadStats()
    }

    override suspend fun getEngineStats(): EngineStats? {
        return controller?.getEngineStatsAsync()
    }

    // =========================================================================
    // Subscription API
    // =========================================================================

    override fun subscribe(type: String, hash: String, intervalMs: Int) {
        controller?.subscribe(type, hash, intervalMs)
    }

    override fun unsubscribe(type: String, hash: String) {
        controller?.unsubscribe(type, hash)
    }

    override fun unsubscribeAll(hash: String) {
        controller?.unsubscribeAll(hash)
    }

    override fun unregisterUpdateConsumer() {
        val ctrl = controller
        if (ctrl != null) {
            ctrl.unregisterUpdateConsumer()
        } else {
            // Controller not available yet - track pending state for later replay
            synchronized(visibilityLock) {
                pendingVisibilityCount = maxOf(0, pendingVisibilityCount - 1)
            }
        }
    }

    override fun registerUpdateConsumer() {
        val ctrl = controller
        if (ctrl != null) {
            ctrl.registerUpdateConsumer()
        } else {
            // Controller not available yet - track pending state for later replay
            synchronized(visibilityLock) {
                pendingVisibilityCount++
            }
        }
    }
}
