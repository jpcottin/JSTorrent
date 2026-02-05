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
 * ## Command Architecture
 *
 * Commands use [withEngine] to ensure the engine is started before executing.
 * This guarantees a non-null controller and eliminates silent no-ops.
 *
 * There's still a window after QuickJS context creation but before engine.init()
 * completes where the JS engine isn't ready. JS-side queueing (via executeOrQueue
 * in controller.ts) handles this - commands wait for the actual engine instance.
 *
 * ## Subscription Architecture
 *
 * Subscriptions use reference counting via [SubscriptionTracker]:
 * - Each [subscribe] call returns a unique [SubscriptionHandle]
 * - Multiple handles can exist for the same topic (type + hash)
 * - The actual JS subscription is created when first handle is created
 * - The actual JS subscription is removed when last handle is closed
 * - Handles persist across engine restarts - subscriptions are replayed to new controllers
 *
 * Subscriptions use `controller?.` because they can be created before the engine
 * exists. The SubscriptionTracker handles replaying them when a controller appears.
 */
class EngineServiceRepository(
    private val application: Application
) : TorrentRepository {

    companion object {
        private const val TAG = "EngineServiceRepo"
    }

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

    // Subscription tracker with reference counting.
    // Handles survive engine restarts - they are replayed when a new controller connects.
    private val subscriptionTracker = SubscriptionTracker(
        onSubscribe = { type, hash, intervalMs ->
            Log.d(TAG, "SubscriptionTracker.onSubscribe: $type for ${hashDisplay(hash)}")
            controller?.subscribe(type, hash, intervalMs)
        },
        onUnsubscribe = { type, hash ->
            Log.d(TAG, "SubscriptionTracker.onUnsubscribe: $type for ${hashDisplay(hash)}")
            controller?.unsubscribe(type, hash)
        },
        onPause = {
            Log.d(TAG, "SubscriptionTracker.onPause")
            controller?.pauseSubscriptions()
        },
        onResume = {
            Log.d(TAG, "SubscriptionTracker.onResume")
            controller?.resumeSubscriptions()
        }
    )

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

                    // Replay subscriptions to the new controller.
                    // This handles both:
                    // 1. Subscriptions created before engine loaded
                    // 2. Engine restarted (new controller) - need to restore subscription state
                    Log.d(TAG, "New controller connected, replaying subscriptions")
                    subscriptionTracker.replayTo(
                        subscribe = { type, hash, intervalMs ->
                            currentController.subscribe(type, hash, intervalMs)
                        },
                        resume = {
                            currentController.resumeSubscriptions()
                        }
                    )
                    // NOTE: Command queueing (add, remove, pause, resume) happens on JS side,
                    // not here. See controller.ts executeOrQueue() and the class doc above.
                }

                delay(50)
            }
        }
    }

    // =========================================================================
    // Commands
    //
    // All commands use withEngine() to ensure the engine is started before
    // executing. JS-side queueing (controller.ts executeOrQueue) handles the
    // window between engine creation and engine.init() completion.
    // =========================================================================

    /**
     * Execute a command with guaranteed non-null engine controller.
     * Starts the engine if not already running, then executes the block.
     */
    private inline fun withEngine(crossinline block: suspend (EngineController) -> Unit) {
        scope.launch { block(app.ensureEngine()) }
    }

    override fun addTorrent(magnetOrBase64: String) {
        // When engine is suspended (WiFi-only/VPN-only), new torrents won't start
        // networking automatically - torrent.start() checks engine.isSuspended.
        withEngine { it.addTorrentAsync(magnetOrBase64) }
    }

    override fun pauseTorrent(infoHash: String) {
        withEngine { it.pauseTorrentAsync(infoHash) }
    }

    override fun resumeTorrent(infoHash: String) {
        withEngine { it.resumeTorrentAsync(infoHash) }
    }

    override fun removeTorrent(infoHash: String, deleteFiles: Boolean) {
        withEngine { it.removeTorrentAsync(infoHash, deleteFiles) }
    }

    override fun recheckTorrent(infoHash: String) {
        withEngine { it.recheckTorrentAsync(infoHash) }
    }

    override suspend fun replaceAndAddTorrent(magnetOrBase64: String, infoHash: String?) {
        val engine = app.ensureEngine()
        if (infoHash != null) {
            engine.removeTorrentAsync(infoHash, deleteFiles = true)
        }
        engine.addTorrentAsync(magnetOrBase64)
    }

    override fun pauseAll() {
        val torrents = state.value?.torrents ?: return
        withEngine { engine ->
            torrents.forEach { torrent ->
                if (torrent.status != "stopped") {
                    engine.pauseTorrentAsync(torrent.infoHash)
                }
            }
        }
    }

    override fun resumeAll() {
        val torrents = state.value?.torrents ?: return
        withEngine { engine ->
            torrents.forEach { torrent ->
                if (torrent.status == "stopped") {
                    engine.resumeTorrentAsync(torrent.infoHash)
                }
            }
        }
    }

    override fun suspendEngine() {
        withEngine { engine ->
            engine.suspendEngineAsync()
            Log.i(TAG, "Engine suspended")
        }
    }

    override fun resumeEngine() {
        withEngine { engine ->
            engine.resumeEngineAsync()
            Log.i(TAG, "Engine resumed")
        }
    }

    override fun setFilePriorities(infoHash: String, priorities: Map<Int, Int>) {
        withEngine { it.setFilePrioritiesAsync(infoHash, priorities) }
    }

    override suspend fun getDhtStats(): DhtStats? {
        return app.ensureEngine().getDhtStatsAsync()
    }

    override suspend fun getSpeedSamples(
        direction: String,
        categories: String,
        fromTime: Long,
        toTime: Long,
        maxPoints: Int
    ): SpeedSamplesResult? {
        return app.ensureEngine().getSpeedSamplesAsync(direction, categories, fromTime, toTime, maxPoints)
    }

    override fun getJsThreadStats(): JsThreadStats? {
        return app.ensureEngine().getJsThreadStats()
    }

    override suspend fun getEngineStats(): EngineStats? {
        return app.ensureEngine().getEngineStatsAsync()
    }

    // =========================================================================
    // Subscription API
    // =========================================================================

    /**
     * Subscribe to data updates and return a handle to release the subscription.
     *
     * The subscription is tracked Kotlin-side via [SubscriptionTracker] with ref-counting.
     * Multiple handles can exist for the same topic - the actual JS subscription is only
     * removed when all handles are closed.
     *
     * Subscriptions can be created before the engine is loaded. They will be replayed
     * to the controller when it becomes available.
     */
    override fun subscribe(type: String, hash: String, intervalMs: Int): SubscriptionHandle {
        return subscriptionTracker.subscribe(type, hash, intervalMs)
    }

    private fun hashDisplay(hash: String): String =
        if (hash.isEmpty()) "all" else "${hash.take(8)}..."
}
