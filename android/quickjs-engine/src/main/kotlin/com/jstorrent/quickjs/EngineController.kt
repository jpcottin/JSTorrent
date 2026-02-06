package com.jstorrent.quickjs

import android.content.Context
import android.net.Uri
import android.util.Log
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.file.FileManagerImpl
import com.jstorrent.quickjs.bindings.EngineErrorListener
import com.jstorrent.quickjs.bindings.EngineStateListener
import com.jstorrent.quickjs.bindings.FileBindings
import com.jstorrent.quickjs.bindings.NativeBindings
import com.jstorrent.quickjs.bindings.PolyfillBindings
import com.jstorrent.quickjs.bindings.TcpBindings
import com.jstorrent.quickjs.model.EngineConfig
import com.jstorrent.quickjs.model.EngineState
import com.jstorrent.quickjs.model.FileInfo
import com.jstorrent.quickjs.model.FileListResponse
import com.jstorrent.quickjs.model.TorrentInfo
import com.jstorrent.quickjs.model.TorrentListResponse
import com.jstorrent.quickjs.model.TrackerInfo
import com.jstorrent.quickjs.model.TrackerListResponse
import com.jstorrent.quickjs.model.PeerInfo
import com.jstorrent.quickjs.model.PeerListResponse
import com.jstorrent.quickjs.model.PieceInfo
import com.jstorrent.quickjs.model.TorrentDetails
import com.jstorrent.quickjs.model.DhtStats
import com.jstorrent.quickjs.model.EngineStats
import com.jstorrent.quickjs.model.JsThreadStats
import com.jstorrent.quickjs.model.SpeedSamplesResult
import com.jstorrent.quickjs.model.UpnpStatus
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.json.JSONObject
import java.io.Closeable

private const val TAG = "EngineController"

/**
 * Result of adding a torrent via the engine.
 */
data class AddTorrentResult(
    val ok: Boolean,
    val infoHash: String?,
    val isDuplicate: Boolean
)
private const val SHUTDOWN_TIMEOUT_MS = 3000L

/**
 * High-level controller for the JSTorrent engine.
 *
 * Wraps QuickJsEngine and NativeBindings, exposing a Kotlin-friendly API
 * for controlling torrents. State updates are exposed via StateFlow.
 *
 * Usage:
 * ```kotlin
 * val controller = EngineController(context, scope)
 * controller.loadEngine(config)
 * controller.addTorrent("magnet:?xt=...")
 * controller.state.collect { state -> updateUI(state) }
 * controller.close()
 * ```
 *
 * @param context Android context
 * @param scope Coroutine scope for I/O operations
 * @param fileManager Optional FileManager for file I/O (defaults to FileManagerImpl)
 * @param rootResolver Optional resolver for rootKey → SAF URI (defaults to app-private fallback)
 */
class EngineController(
    private val context: Context,
    private val scope: CoroutineScope,
    private val fileManager: FileManager = FileManagerImpl(context),
    private val rootResolver: (String) -> Uri? = { null },
) : Closeable {

    private val json = Json {
        ignoreUnknownKeys = true
        encodeDefaults = true
    }

    private var engine: QuickJsEngine? = null
    private var bindings: NativeBindings? = null
    private var configBridge: ConfigBridge? = null

    // Note: Subscription visibility reference counting is now handled by SubscriptionTracker
    // in EngineServiceRepository. EngineController just provides simple pauseSubscriptions()
    // and resumeSubscriptions() pass-throughs to JS.

    // State exposed to UI
    private val _state = MutableStateFlow<EngineState?>(null)
    val state: StateFlow<EngineState?> = _state.asStateFlow()

    private val _isLoaded = MutableStateFlow(false)
    val isLoaded: StateFlow<Boolean> = _isLoaded.asStateFlow()

    private val _lastError = MutableStateFlow<String?>(null)
    val lastError: StateFlow<String?> = _lastError.asStateFlow()

    // Host-driven tick loop state
    private var tickRunnable: Runnable? = null
    private var tickEnabled = false

    // Tick timing stats (aggregated over 5-second window)
    private var tickCount = 0L
    private var tickTotalJsMs = 0L
    private var tickTotalPumpMs = 0L
    private var tickTotalMs = 0L
    private var tickMaxMs = 0L
    private var tickLastLogTime = 0L
    private var ticksWithWork = 0L

    // Throughput stats (aggregated over window)
    private var totalBlocksRecv = 0L
    private var totalBlocksSent = 0L

    // Snapshot stats (latest values, not aggregated)
    private var lastActivePieces = 0
    private var lastConnectedPeers = 0
    private var lastPipelineFilled = 0
    private var lastPipelineMax = 0
    private var lastPendingHashes = 0
    private var lastBufferedBytes = 0

    // Handler Q high water mark tracking (per log window)
    private var tickMaxHandlerQ = 0
    private var tickMaxPumpMs = 0L

    private val TICK_LOG_INTERVAL_MS = 5000L
    // Continuous tick mode parameters
    private val MIN_TICK_INTERVAL_MS = 1L   // Minimum time between ticks (prevent CPU spinning)
    private val IDLE_DELAY_MS = 20L         // Delay when no work pending

    /**
     * Check if the engine is healthy and responsive.
     * Returns false if engine is not loaded or has been closed.
     */
    val isHealthy: Boolean
        get() = engine != null && _isLoaded.value

    /**
     * Load the engine bundle and initialize with configuration.
     *
     * @param config Engine configuration including content roots
     * @throws IllegalStateException if already loaded
     */
    fun loadEngine(config: EngineConfig) {
        check(engine == null) { "Engine already loaded" }

        Log.i(TAG, "Loading engine...")

        // Create QuickJS engine
        val eng = QuickJsEngine()
        engine = eng

        // Start JS thread health monitoring
        eng.jsThread.startHealthCheck()

        // Register native bindings
        val b = NativeBindings(context, eng.jsThread, scope, fileManager, rootResolver).apply {
            stateListener = object : EngineStateListener {
                override fun onStateUpdate(stateJson: String) {
                    handleStateUpdate(stateJson)
                }
            }
            errorListener = object : EngineErrorListener {
                override fun onError(errorJson: String) {
                    handleError(errorJson)
                }
            }
        }
        bindings = b

        // Register bindings on JS thread
        eng.postAndWait {
            b.registerAll(eng.context)
        }

        // Load bundle from assets
        val bundleJs = context.assets.open("engine.bundle.js").bufferedReader().use { it.readText() }
        Log.i(TAG, "Bundle loaded: ${bundleJs.length / 1024} KB")

        // Evaluate bundle
        eng.evaluate(bundleJs, "engine.bundle.js")
        Log.i(TAG, "Bundle evaluated")

        // Initialize engine with config
        val configJson = json.encodeToString(config)
        eng.evaluate("globalThis.jstorrent.init($configJson)", "init.js")

        // Execute pending jobs to complete async initialization
        // The init() call starts async work that needs microtasks to be pumped
        eng.executeAllPendingJobs()
        Log.i(TAG, "Engine initialized with ${config.contentRoots.size} content roots")

        // Create ConfigBridge for config management
        configBridge = ConfigBridge(eng)

        // Sync initial roots via ConfigBridge
        config.contentRoots.let { roots ->
            if (roots.isNotEmpty()) {
                configBridge?.syncRoots(roots, config.defaultContentRoot)
            }
        }

        _isLoaded.value = true
    }

    /**
     * Get the ConfigBridge for managing engine configuration.
     * Returns null if engine is not loaded.
     */
    fun getConfigBridge(): ConfigBridge? = configBridge

    /**
     * Add a torrent from magnet link or base64-encoded .torrent file.
     *
     * Result is async - observe state flow for updates.
     */
    fun addTorrent(magnetOrBase64: String) {
        val eng = requireEngine()
        val escaped = magnetOrBase64.replace("\\", "\\\\").replace("'", "\\'")
        eng.callGlobalFunction("__jstorrent_cmd_add_torrent", escaped)
        Log.i(TAG, "addTorrent called")
    }

    /**
     * Pause a torrent by info hash.
     */
    fun pauseTorrent(infoHash: String) {
        val eng = requireEngine()
        eng.callGlobalFunction("__jstorrent_cmd_pause", infoHash)
        Log.i(TAG, "pauseTorrent: $infoHash")
    }

    /**
     * Resume a paused torrent.
     */
    fun resumeTorrent(infoHash: String) {
        val eng = requireEngine()
        eng.callGlobalFunction("__jstorrent_cmd_resume", infoHash)
        Log.i(TAG, "resumeTorrent: $infoHash")
    }

    /**
     * Remove a torrent.
     *
     * @param infoHash The torrent's info hash
     * @param deleteFiles If true, also delete downloaded files
     */
    fun removeTorrent(infoHash: String, deleteFiles: Boolean = false) {
        val eng = requireEngine()
        eng.callGlobalFunction(
            "__jstorrent_cmd_remove",
            infoHash,
            deleteFiles.toString()
        )
        Log.i(TAG, "removeTorrent: $infoHash (deleteFiles=$deleteFiles)")
    }

    /**
     * Set file priorities for a torrent.
     *
     * @param infoHash The torrent's info hash
     * @param priorities Map of file index to priority (0=Normal, 1=Skip, 2=High)
     */
    fun setFilePriorities(infoHash: String, priorities: Map<Int, Int>) {
        val eng = requireEngine()
        val prioritiesJson = json.encodeToString(priorities.mapKeys { it.key.toString() })
        eng.callGlobalFunction(
            "__jstorrent_cmd_set_file_priorities",
            infoHash,
            prioritiesJson
        )
        Log.i(TAG, "setFilePriorities: $infoHash (${priorities.size} files)")
    }

    /**
     * Add a test torrent with hardcoded peer hint for debugging.
     * Uses a local qBittorrent seeder at 192.168.1.112:6082.
     */
    fun addTestTorrent() {
        val eng = requireEngine()
        eng.callGlobalFunction("__jstorrent_cmd_add_test_torrent")
        Log.i(TAG, "addTestTorrent called")
    }

    // =========================================================================
    // Root Management (Deprecated - use ConfigBridge.syncRoots instead)
    // =========================================================================

    /**
     * Add a storage root at runtime.
     * Call this when user selects a new SAF folder.
     *
     * @param key Unique identifier for the root (SHA256 prefix)
     * @param label Human-readable name
     * @param uri SAF tree URI
     *
     * @deprecated Use [getConfigBridge].[syncRoots] instead for unified config management.
     */
    @Deprecated(
        message = "Use ConfigBridge.syncRoots() instead",
        replaceWith = ReplaceWith("getConfigBridge()?.syncRoots(roots, defaultKey)")
    )
    fun addRoot(key: String, label: String, uri: String) {
        val eng = requireEngine()
        eng.callGlobalFunction(
            "__jstorrent_cmd_add_root",
            key.escapeJs(),
            label.escapeJs(),
            uri.escapeJs()
        )
        Log.i(TAG, "Added root to engine: $key -> $label")
    }

    /**
     * Set the default storage root.
     * New torrents will use this root unless explicitly assigned.
     *
     * @deprecated Use [getConfigBridge].[syncRoots] instead for unified config management.
     */
    @Deprecated(
        message = "Use ConfigBridge.syncRoots() instead",
        replaceWith = ReplaceWith("getConfigBridge()?.syncRoots(roots, defaultKey)")
    )
    fun setDefaultRoot(key: String) {
        val eng = requireEngine()
        eng.callGlobalFunction("__jstorrent_cmd_set_default_root", key.escapeJs())
        Log.i(TAG, "Set default root: $key")
    }

    /**
     * Remove a storage root.
     *
     * @deprecated Use [getConfigBridge].[syncRoots] instead for unified config management.
     */
    @Deprecated(
        message = "Use ConfigBridge.syncRoots() instead",
        replaceWith = ReplaceWith("getConfigBridge()?.syncRoots(roots, defaultKey)")
    )
    fun removeRoot(key: String) {
        val eng = requireEngine()
        eng.callGlobalFunction("__jstorrent_cmd_remove_root", key.escapeJs())
        Log.i(TAG, "Removed root: $key")
    }

    private fun String.escapeJs(): String {
        return this.replace("\\", "\\\\").replace("'", "\\'")
    }

    /**
     * Get the full torrent list with detailed info.
     *
     * For frequent updates, prefer observing [state] instead.
     */
    fun getTorrentList(): List<TorrentInfo> {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunction("__jstorrent_query_torrent_list") as? String
            ?: return emptyList()
        return try {
            json.decodeFromString<TorrentListResponse>(resultJson).torrents
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse torrent list", e)
            emptyList()
        }
    }

    /**
     * Get file list for a specific torrent.
     */
    fun getFiles(infoHash: String): List<FileInfo> {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunction("__jstorrent_query_files", infoHash) as? String
            ?: return emptyList()
        return try {
            json.decodeFromString<FileListResponse>(resultJson).files
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse file list", e)
            emptyList()
        }
    }

    /**
     * Get tracker list for a specific torrent.
     */
    fun getTrackers(infoHash: String): List<TrackerInfo> {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunction("__jstorrent_query_trackers", infoHash) as? String
            ?: return emptyList()
        return try {
            json.decodeFromString<TrackerListResponse>(resultJson).trackers
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse tracker list", e)
            emptyList()
        }
    }

    /**
     * Get peer list for a specific torrent.
     */
    fun getPeers(infoHash: String): List<PeerInfo> {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunction("__jstorrent_query_peers", infoHash) as? String
            ?: return emptyList()
        return try {
            json.decodeFromString<PeerListResponse>(resultJson).peers
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse peer list", e)
            emptyList()
        }
    }

    /**
     * Get piece info for a specific torrent.
     * Returns piece counts and hex-encoded bitfield.
     */
    fun getPieces(infoHash: String): PieceInfo? {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunction("__jstorrent_query_pieces", infoHash) as? String
            ?: return null
        return try {
            json.decodeFromString<PieceInfo>(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse piece info", e)
            null
        }
    }

    /**
     * Get detailed torrent metadata for the Details tab.
     * Returns timestamps, size info, and magnet URL.
     */
    fun getDetails(infoHash: String): TorrentDetails? {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunction("__jstorrent_query_details", infoHash) as? String
            ?: return null
        return try {
            json.decodeFromString<TorrentDetails>(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse torrent details", e)
            null
        }
    }

    // =========================================================================
    // Debug API
    // =========================================================================

    /**
     * Set log level for debugging.
     * Valid levels: "debug", "info", "warn", "error"
     * Optionally filter by components.
     */
    fun setLogLevel(level: String, components: List<String>? = null) {
        val eng = requireEngine()
        val componentsJson = components?.let { json.encodeToString(it) }
        if (componentsJson != null) {
            eng.callGlobalFunction("__jstorrent_cmd_set_log_level", level, componentsJson)
        } else {
            eng.callGlobalFunction("__jstorrent_cmd_set_log_level", level)
        }
        Log.i(TAG, "setLogLevel: $level${components?.let { ", components: $it" } ?: ""}")
    }

    /**
     * Get detailed swarm debug info for a torrent.
     * Returns JSON with all peers and their connection states.
     */
    fun getSwarmDebug(infoHash: String): String {
        val eng = requireEngine()
        return eng.callGlobalFunction("__jstorrent_query_swarm_debug", infoHash) as? String
            ?: """{"error": "No result"}"""
    }

    /**
     * Evaluate arbitrary JavaScript code (for debugging).
     * Use with caution - this can execute any code in the engine context.
     */
    fun evaluate(script: String): Any? {
        return requireEngine().evaluate(script)
    }

    /**
     * Evaluate arbitrary JavaScript code (suspend version for debugging).
     * Use with caution - this can execute any code in the engine context.
     */
    suspend fun evaluateAsync(script: String): Any? {
        return requireEngine().evaluateAsync(script)
    }

    /**
     * Get the maximum JS thread latency observed since engine start.
     * Useful for diagnosing thread overload conditions.
     */
    fun getMaxJsThreadLatencyMs(): Long {
        return engine?.jsThread?.getMaxLatencyMs() ?: 0L
    }

    /**
     * Get comprehensive JS thread health statistics.
     * Includes current/max latency and callback queue depths for TCP and disk I/O.
     */
    fun getJsThreadStats(): JsThreadStats {
        val jsThread = engine?.jsThread
        return JsThreadStats(
            currentLatencyMs = jsThread?.getCurrentLatencyMs() ?: 0L,
            maxLatencyMs = jsThread?.getMaxLatencyMs() ?: 0L,
            handlerQueueDepth = jsThread?.getHandlerQueueDepth() ?: 0,
            handlerMaxQueueDepth = jsThread?.getMaxHandlerQueueDepth() ?: 0,
            tcpQueueDepth = TcpBindings.getQueueDepth(),
            tcpMaxQueueDepth = TcpBindings.getMaxQueueDepth(),
            diskQueueDepth = FileBindings.getQueueDepth(),
            diskMaxQueueDepth = FileBindings.getMaxQueueDepth()
        )
    }

    // =========================================================================
    // Async Command API - safe to call from Main thread
    // =========================================================================

    /**
     * Add a torrent (suspend version).
     * Awaits until the torrent is fully added to the engine.
     * Returns parsed result with duplicate detection info.
     */
    suspend fun addTorrentAsync(magnetOrBase64: String): AddTorrentResult {
        val eng = requireEngine()
        val result = eng.callGlobalFunctionAwaitPromise("__jstorrent_cmd_add_torrent", magnetOrBase64)
        Log.i(TAG, "addTorrentAsync completed: $result")
        if (result == null) {
            return AddTorrentResult(ok = false, infoHash = null, isDuplicate = false)
        }
        return try {
            val json = JSONObject(result)
            AddTorrentResult(
                ok = json.optBoolean("ok", false),
                infoHash = json.optString("infoHash", null),
                isDuplicate = json.optBoolean("isDuplicate", false)
            )
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse addTorrent response: $result", e)
            AddTorrentResult(ok = false, infoHash = null, isDuplicate = false)
        }
    }

    /**
     * Pause a torrent (suspend version).
     */
    suspend fun pauseTorrentAsync(infoHash: String) {
        requireEngine().callGlobalFunctionAsync("__jstorrent_cmd_pause", infoHash)
        Log.i(TAG, "pauseTorrentAsync: $infoHash")
    }

    /**
     * Resume a torrent (suspend version).
     */
    suspend fun resumeTorrentAsync(infoHash: String) {
        requireEngine().callGlobalFunctionAsync("__jstorrent_cmd_resume", infoHash)
        Log.i(TAG, "resumeTorrentAsync: $infoHash")
    }

    /**
     * Remove a torrent (suspend version).
     * Awaits until the torrent is fully removed from the engine.
     */
    suspend fun removeTorrentAsync(infoHash: String, deleteFiles: Boolean = false): String? {
        val eng = requireEngine()
        val result = eng.callGlobalFunctionAwaitPromise(
            "__jstorrent_cmd_remove",
            infoHash,
            deleteFiles.toString()
        )
        Log.i(TAG, "removeTorrentAsync completed: $infoHash (deleteFiles=$deleteFiles)")
        return result
    }

    /**
     * Recheck (verify) torrent data (suspend version).
     * Awaits until the recheck is complete.
     */
    suspend fun recheckTorrentAsync(infoHash: String): String? {
        val eng = requireEngine()
        val result = eng.callGlobalFunctionAwaitPromise(
            "__jstorrent_cmd_recheck",
            infoHash
        )
        Log.i(TAG, "recheckTorrentAsync completed: $infoHash")
        return result
    }

    /**
     * Set file priorities for a torrent (suspend version).
     *
     * @param infoHash The torrent's info hash
     * @param priorities Map of file index to priority (0=Normal, 1=Skip, 2=High)
     */
    suspend fun setFilePrioritiesAsync(infoHash: String, priorities: Map<Int, Int>) {
        val eng = requireEngine()
        val prioritiesJson = json.encodeToString(priorities.mapKeys { it.key.toString() })
        eng.callGlobalFunctionAsync(
            "__jstorrent_cmd_set_file_priorities",
            infoHash,
            prioritiesJson
        )
        Log.i(TAG, "setFilePrioritiesAsync: $infoHash (${priorities.size} files)")
    }

    /**
     * Add test torrent (suspend version).
     */
    suspend fun addTestTorrentAsync() {
        requireEngine().callGlobalFunctionAsync("__jstorrent_cmd_add_test_torrent")
        Log.i(TAG, "addTestTorrentAsync called")
    }

    // =========================================================================
    // Engine Suspend/Resume - for WiFi-only / VPN-only mode
    // =========================================================================

    /**
     * Suspend the engine - stop all network activity globally.
     * Torrents preserve their userState but stop networking.
     * New torrents added while suspended won't start networking.
     * Use for WiFi-only / VPN-only mode when network conditions aren't met.
     */
    suspend fun suspendEngineAsync() {
        requireEngine().callGlobalFunctionAsync("__jstorrent_cmd_suspend")
        Log.i(TAG, "Engine suspended")
    }

    /**
     * Resume the engine - restart network activity.
     * Only torrents with userState 'active' will start networking.
     * Call when network conditions are restored (WiFi/VPN connected).
     */
    suspend fun resumeEngineAsync() {
        requireEngine().callGlobalFunctionAsync("__jstorrent_cmd_resume_engine")
        Log.i(TAG, "Engine resumed")
    }

    /**
     * Check if the engine is currently suspended.
     */
    fun isEngineSuspended(): Boolean {
        val eng = engine ?: return false
        val resultJson = eng.callGlobalFunction("__jstorrent_query_suspended") as? String
            ?: return false
        return try {
            // Parse { "suspended": true/false }
            resultJson.contains("true")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse suspended state", e)
            false
        }
    }

    // =========================================================================
    // Async Root Management - safe to call from Main thread
    // =========================================================================

    /**
     * Add a storage root (suspend version).
     */
    suspend fun addRootAsync(key: String, label: String, uri: String) {
        requireEngine().callGlobalFunctionAsync(
            "__jstorrent_cmd_add_root",
            key.escapeJs(),
            label.escapeJs(),
            uri.escapeJs()
        )
        Log.i(TAG, "Added root to engine (async): $key -> $label")
    }

    /**
     * Set default storage root (suspend version).
     */
    suspend fun setDefaultRootAsync(key: String) {
        requireEngine().callGlobalFunctionAsync("__jstorrent_cmd_set_default_root", key.escapeJs())
        Log.i(TAG, "Set default root (async): $key")
    }

    /**
     * Remove a storage root (suspend version).
     */
    suspend fun removeRootAsync(key: String) {
        requireEngine().callGlobalFunctionAsync("__jstorrent_cmd_remove_root", key.escapeJs())
        Log.i(TAG, "Removed root (async): $key")
    }

    // =========================================================================
    // Async Query API - safe to call from Main thread
    // =========================================================================

    /**
     * Get torrent list (suspend version).
     */
    suspend fun getTorrentListAsync(): List<TorrentInfo> {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync("__jstorrent_query_torrent_list") as? String
            ?: return emptyList()
        return try {
            json.decodeFromString<TorrentListResponse>(resultJson).torrents
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse torrent list", e)
            emptyList()
        }
    }

    /**
     * Get files for a torrent (suspend version).
     */
    suspend fun getFilesAsync(infoHash: String): List<FileInfo> {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync("__jstorrent_query_files", infoHash) as? String
            ?: return emptyList()
        return try {
            json.decodeFromString<FileListResponse>(resultJson).files
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse file list", e)
            emptyList()
        }
    }

    /**
     * Get trackers for a torrent (suspend version).
     */
    suspend fun getTrackersAsync(infoHash: String): List<TrackerInfo> {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync("__jstorrent_query_trackers", infoHash) as? String
            ?: return emptyList()
        return try {
            json.decodeFromString<TrackerListResponse>(resultJson).trackers
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse tracker list", e)
            emptyList()
        }
    }

    /**
     * Get peers for a torrent (suspend version).
     */
    suspend fun getPeersAsync(infoHash: String): List<PeerInfo> {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync("__jstorrent_query_peers", infoHash) as? String
            ?: return emptyList()
        return try {
            json.decodeFromString<PeerListResponse>(resultJson).peers
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse peer list", e)
            emptyList()
        }
    }

    /**
     * Get piece info for a torrent (suspend version).
     */
    suspend fun getPiecesAsync(infoHash: String): PieceInfo? {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync("__jstorrent_query_pieces", infoHash) as? String
            ?: return null
        return try {
            json.decodeFromString<PieceInfo>(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse piece info", e)
            null
        }
    }

    /**
     * Get detailed torrent metadata (suspend version).
     */
    suspend fun getDetailsAsync(infoHash: String): TorrentDetails? {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync("__jstorrent_query_details", infoHash) as? String
            ?: return null
        return try {
            json.decodeFromString<TorrentDetails>(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse torrent details", e)
            null
        }
    }

    /**
     * Get DHT statistics (suspend version).
     * Returns null if DHT is not initialized.
     */
    suspend fun getDhtStatsAsync(): DhtStats? {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync("__jstorrent_query_dht_stats") as? String
            ?: return null
        // Handle "null" string response
        if (resultJson == "null") return null
        return try {
            json.decodeFromString<DhtStats>(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse DHT stats", e)
            null
        }
    }

    /**
     * Get UPnP status (synchronous version).
     * Returns status and external IP if mapped.
     */
    fun getUpnpStatus(): UpnpStatus? {
        val eng = engine ?: return null
        val resultJson = eng.callGlobalFunction("__jstorrent_query_upnp_status") as? String
            ?: return null
        return try {
            json.decodeFromString<UpnpStatus>(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse UPnP status", e)
            null
        }
    }

    /**
     * Get UPnP status (suspend version).
     * Returns status and external IP if mapped.
     */
    suspend fun getUpnpStatusAsync(): UpnpStatus? {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync("__jstorrent_query_upnp_status") as? String
            ?: return null
        return try {
            json.decodeFromString<UpnpStatus>(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse UPnP status", e)
            null
        }
    }

    /**
     * Get speed samples from the bandwidth tracker for graphing (suspend version).
     *
     * @param direction "down" or "up"
     * @param categories "all" or JSON array of categories (e.g., '["peer:protocol"]')
     * @param fromTime Start timestamp in ms since epoch
     * @param toTime End timestamp in ms since epoch
     * @param maxPoints Maximum number of data points to return (default 300)
     * @return SpeedSamplesResult with samples and bucket metadata, or null on error
     */
    suspend fun getSpeedSamplesAsync(
        direction: String,
        categories: String = "all",
        fromTime: Long,
        toTime: Long,
        maxPoints: Int = 300
    ): SpeedSamplesResult? {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync(
            "__jstorrent_query_speed_samples",
            direction,
            categories,
            fromTime.toString(),
            toTime.toString(),
            maxPoints.toString()
        ) as? String ?: return null
        return try {
            json.decodeFromString<SpeedSamplesResult>(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse speed samples", e)
            null
        }
    }

    /**
     * Get engine statistics for health monitoring (suspend version).
     * Fetches tick stats, active pieces, and connected peers from JS engine.
     */
    suspend fun getEngineStatsAsync(): EngineStats? {
        val eng = requireEngine()
        val resultJson = eng.callGlobalFunctionAsync(
            "__jstorrent_query_engine_stats"
        ) as? String ?: return null
        return try {
            json.decodeFromString<EngineStats>(resultJson)
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse engine stats", e)
            null
        }
    }

    // ============================================================
    // SUBSCRIPTION API
    // ============================================================

    /**
     * Subscribe to data updates for a torrent (or torrent list).
     *
     * @param type Subscription type: "torrents", "peers", "files", "trackers", "pieces", "details"
     * @param hash Torrent info hash, or "" for torrent list
     * @param intervalMs Push interval in milliseconds
     */
    fun subscribe(type: String, hash: String, intervalMs: Int) {
        val eng = engine ?: return
        eng.jsThread.post {
            eng.context.callGlobalFunction("__jstorrent_subscribe", type, hash, intervalMs.toString())
        }
        Log.d(TAG, "subscribe: $type for ${if (hash.isEmpty()) "all" else hash.take(8)}...")
    }

    /**
     * Unsubscribe from a specific data type for a torrent.
     *
     * @param type Subscription type
     * @param hash Torrent info hash, or "" for torrent list
     */
    fun unsubscribe(type: String, hash: String) {
        val eng = engine ?: return
        eng.jsThread.post {
            eng.context.callGlobalFunction("__jstorrent_unsubscribe", type, hash)
        }
        Log.d(TAG, "unsubscribe: $type for ${if (hash.isEmpty()) "all" else hash.take(8)}...")
    }

    /**
     * Unsubscribe from all data types for a torrent.
     * Use when navigating away from torrent detail view.
     *
     * @param hash Torrent info hash
     */
    fun unsubscribeAll(hash: String) {
        val eng = engine ?: return
        eng.jsThread.post {
            eng.context.callGlobalFunction("__jstorrent_unsubscribe_all", hash)
        }
        Log.d(TAG, "unsubscribeAll: ${hash.take(8)}...")
    }

    /**
     * Pause subscription pushes.
     *
     * Called by SubscriptionTracker when the last subscription is closed.
     * Reference counting is handled in SubscriptionTracker, not here.
     */
    fun pauseSubscriptions() {
        val eng = engine ?: return
        Log.d(TAG, "pauseSubscriptions")
        eng.jsThread.post {
            eng.context.callGlobalFunction("__jstorrent_pause_subscriptions")
        }
    }

    /**
     * Resume subscription pushes.
     *
     * Called by SubscriptionTracker when the first subscription is created.
     * Reference counting is handled in SubscriptionTracker, not here.
     */
    fun resumeSubscriptions() {
        val eng = engine ?: return
        Log.d(TAG, "resumeSubscriptions")
        eng.jsThread.post {
            eng.context.callGlobalFunction("__jstorrent_resume_subscriptions")
        }
    }

    // ============================================================
    // HOST-DRIVEN TICK LOOP
    // ============================================================
    //
    // SYNC WITH: packages/engine/src/core/bt-engine.ts (startEngineTick)
    //
    // Both implementations use adaptive timing with similar parameters:
    //
    // - Extension (JS-driven, bt-engine.ts): setTimeout with calculateTickDelay()
    //   - MIN_TICK_INTERVAL_MS (1ms) when bufferedBytes > 0 or activePieces > 0
    //   - IDLE_TICK_INTERVAL_MS (20ms) when peers connected but idle
    //   - MAX_TICK_INTERVAL_MS (100ms) when no peers
    //
    // - Android (host-driven, here): postDelayed with delay hints from JS
    //   - MIN_TICK_INTERVAL_MS (1ms) when work pending
    //   - IDLE_DELAY_MS (20ms) when idle
    //   - Proportional delay when hasher backed up (pendingHashes * 0.4, max 100ms)
    //
    // Both call the same __jstorrent_engine_tick() / tick() which processes:
    // 1. GATHER - drain TCP buffers
    // 2. PROCESS - piece health cleanup
    // 3. REQUEST - fill peer pipelines
    // 4. OUTPUT - flush sends
    //
    // If you change timing behavior here, consider whether bt-engine.ts needs
    // the same change for extension parity.
    // ============================================================

    /**
     * Start host-driven tick loop with continuous mode.
     *
     * This switches from JS-owned setInterval to Kotlin-owned tick scheduling.
     * Benefits:
     * - Full visibility into tick timing (JS execution + job pump)
     * - No Handler queue latency between tick and job pump
     * - Continuous processing when work is pending (minimal dead time)
     * - Automatic backoff when idle
     *
     * The tick runs directly on the JS thread:
     * 1. Call __jstorrent_engine_tick (JS work)
     * 2. Pump all pending jobs (microtasks)
     * 3. Check for pending work
     * 4. Schedule next tick: immediate if work pending, delayed if idle
     */
    fun startHostDrivenTick() {
        if (tickEnabled) {
            Log.w(TAG, "Host-driven tick already running")
            return
        }

        val eng = engine ?: run {
            Log.e(TAG, "Cannot start tick: engine not loaded")
            return
        }

        // Switch JS to host-driven mode (stops JS setInterval)
        eng.jsThread.post {
            eng.context.callGlobalFunction("__jstorrent_set_tick_mode", "host")
        }

        tickEnabled = true
        tickCount = 0
        tickTotalJsMs = 0
        tickTotalPumpMs = 0
        tickTotalMs = 0
        tickMaxMs = 0
        ticksWithWork = 0
        tickLastLogTime = System.currentTimeMillis()
        totalBlocksRecv = 0
        totalBlocksSent = 0

        Log.i(TAG, "Starting continuous tick loop (min=${MIN_TICK_INTERVAL_MS}ms, idle=${IDLE_DELAY_MS}ms)")

        tickRunnable = object : Runnable {
            override fun run() {
                if (!tickEnabled) return

                val tickStart = System.currentTimeMillis()

                // 1. Call JS tick - returns packed binary with stats
                // Format: 10 x i32 LE = 40 bytes
                val jsStart = System.currentTimeMillis()
                var delayHint = IDLE_DELAY_MS.toInt()
                var blocksRecv = 0
                var blocksSent = 0
                var jsElapsedMs = 0
                var activePieces = 0
                var connectedPeers = 0
                var bufferedBytes = 0
                var pipelineFilled = 0
                var pipelineMax = 0
                var pendingHashes = 0

                try {
                    val result = eng.context.callGlobalFunction("__jstorrent_engine_tick")
                    when (result) {
                        is ByteArray -> {
                            if (result.size >= 40) {
                                val buf = java.nio.ByteBuffer.wrap(result).order(java.nio.ByteOrder.LITTLE_ENDIAN)
                                delayHint = buf.int
                                blocksRecv = buf.int
                                blocksSent = buf.int
                                jsElapsedMs = buf.int
                                activePieces = buf.int
                                connectedPeers = buf.int
                                bufferedBytes = buf.int
                                pipelineFilled = buf.int
                                pipelineMax = buf.int
                                pendingHashes = buf.int
                            }
                        }
                        is Number -> delayHint = result.toInt()  // Fallback for old format
                        else -> {}
                    }
                } catch (e: Exception) {
                    Log.e(TAG, "Tick JS error", e)
                }
                val jsEnd = System.currentTimeMillis()
                val jsMs = jsEnd - jsStart

                // 2. Pump all pending jobs synchronously (no queue delay!)
                val pumpStart = System.currentTimeMillis()
                eng.context.executeAllPendingJobs()
                val pumpEnd = System.currentTimeMillis()
                val pumpMs = pumpEnd - pumpStart

                val totalMs = pumpEnd - tickStart

                // Track handler Q depth at tick boundary
                val handlerQ = eng.jsThread.getHandlerQueueDepth()
                if (handlerQ > tickMaxHandlerQ) {
                    tickMaxHandlerQ = handlerQ
                }
                if (pumpMs > tickMaxPumpMs) {
                    tickMaxPumpMs = pumpMs
                }

                // Warn on high handler Q or long pump (potential cascade)
                if (handlerQ > 50 || pumpMs > 200) {
                    Log.w(TAG, "Tick bottleneck: handlerQ=$handlerQ, totalMs=$totalMs (js=$jsMs pump=$pumpMs), " +
                        "pendingTcp=${TcpBindings.getPendingTcpEventCount()}, " +
                        "pendingHash=${PolyfillBindings.getPendingHashEventCount()}, " +
                        "pendingDisk=${FileBindings.getPendingDiskEventCount()}")
                }

                // Update timing stats
                tickCount++
                tickTotalJsMs += jsMs
                tickTotalPumpMs += pumpMs
                tickTotalMs += totalMs
                if (totalMs > tickMaxMs) {
                    tickMaxMs = totalMs
                }
                if (delayHint == 0) {
                    ticksWithWork++
                }

                // Update throughput stats
                totalBlocksRecv += blocksRecv
                totalBlocksSent += blocksSent

                // Update snapshot stats (latest values)
                lastActivePieces = activePieces
                lastConnectedPeers = connectedPeers
                lastPipelineFilled = pipelineFilled
                lastPipelineMax = pipelineMax
                lastPendingHashes = pendingHashes
                lastBufferedBytes = bufferedBytes

                // Log every 5 seconds
                val now = System.currentTimeMillis()
                if (now - tickLastLogTime >= TICK_LOG_INTERVAL_MS && tickCount > 0) {
                    val avgJs = tickTotalJsMs.toFloat() / tickCount
                    val avgPump = tickTotalPumpMs.toFloat() / tickCount
                    val avgTotal = tickTotalMs.toFloat() / tickCount
                    val workPercent = (ticksWithWork.toFloat() / tickCount * 100).toInt()
                    val avgBlocksRecv = totalBlocksRecv.toFloat() / tickCount
                    val avgBlocksSent = totalBlocksSent.toFloat() / tickCount
                    val pipelineUtil = if (lastPipelineMax > 0) (lastPipelineFilled.toFloat() / lastPipelineMax * 100).toInt() else 0

                    val (tcpConn, tcpClose, tcpSecured) = TcpBindings.getAndResetCallbackCounts()
                    val handlerQNow = eng.jsThread.getHandlerQueueDepth()
                    val handlerQMax = eng.jsThread.getMaxHandlerQueueDepth()

                    Log.i(TAG, "Tick: ${tickCount} ticks, avg %.1fms (js=%.1fms pump=%.1fms/max${tickMaxPumpMs}ms), max ${tickMaxMs}ms, work=${workPercent}%% | ".format(avgTotal, avgJs, avgPump) +
                        "${lastConnectedPeers} peers, ${lastActivePieces} active | " +
                        "BLOCKS:recv=%.1f/sent=%.1f, PIPE:${pipelineUtil}%% of ${lastPipelineMax}, hash=${lastPendingHashes}, buf=${lastBufferedBytes / 1024}KB | ".format(avgBlocksRecv, avgBlocksSent) +
                        "HandlerQ:${handlerQNow}/${handlerQMax}(tickMax=${tickMaxHandlerQ}), TCP:conn=${tcpConn}/close=${tcpClose}/sec=${tcpSecured}")

                    // Reset aggregated stats
                    tickCount = 0
                    tickTotalJsMs = 0
                    tickTotalPumpMs = 0
                    tickTotalMs = 0
                    tickMaxMs = 0
                    tickMaxPumpMs = 0
                    tickMaxHandlerQ = 0
                    ticksWithWork = 0
                    totalBlocksRecv = 0
                    totalBlocksSent = 0
                    tickLastLogTime = now
                }

                // 3. Schedule next tick using delay hint from JS
                if (tickEnabled) {
                    val elapsed = System.currentTimeMillis() - tickStart
                    val effectiveDelay = maxOf(MIN_TICK_INTERVAL_MS, delayHint.toLong()) - elapsed
                    if (effectiveDelay <= 0) {
                        eng.jsThread.handler.post(this)
                    } else {
                        eng.jsThread.handler.postDelayed(this, effectiveDelay)
                    }
                }
            }
        }

        // Start the tick loop on JS thread
        eng.jsThread.handler.post(tickRunnable ?: return)
    }

    /**
     * Stop host-driven tick loop.
     * Switches back to JS-owned setInterval.
     */
    fun stopHostDrivenTick() {
        if (!tickEnabled) return

        tickEnabled = false
        tickRunnable?.let { runnable ->
            engine?.jsThread?.handler?.removeCallbacks(runnable)
        }
        tickRunnable = null

        // Switch JS back to JS-driven mode
        engine?.jsThread?.post {
            engine?.context?.callGlobalFunction("__jstorrent_set_tick_mode", "js")
        }

        Log.i(TAG, "Host-driven tick stopped")
    }

    // ============================================================
    // FFI RTT BENCHMARKS
    // ============================================================

    /**
     * Run full FFI RTT benchmark suite and return results as a map.
     * Tests various scenarios to understand FFI overhead.
     * MUST be called from a thread that can block (not Main thread).
     *
     * @return Map of test name to average RTT in microseconds
     */
    fun runRttBenchmark(): Map<String, Double> {
        val eng = engine ?: return emptyMap()
        val iterations = 1000
        val latch = java.util.concurrent.CountDownLatch(1)
        val results = java.util.concurrent.ConcurrentHashMap<String, Double>()

        // Run all benchmarks on JS thread
        eng.jsThread.handler.post {
            try {
                // Noop benchmark
                repeat(10) { eng.context.callGlobalFunction("__jstorrent_noop") }
                var start = System.nanoTime()
                repeat(iterations) { eng.context.callGlobalFunction("__jstorrent_noop") }
                results["noop"] = (System.nanoTime() - start).toDouble() / iterations / 1000.0

                // Binary in benchmarks (need placeholder arg for binary position)
                for ((name, size) in listOf("1kb" to 1024, "16kb" to 16384, "64kb" to 65536, "256kb" to 262144)) {
                    val data = ByteArray(size)
                    repeat(10) { eng.context.callGlobalFunctionWithBinary("__jstorrent_noop_binary", data, 0, null) }
                    start = System.nanoTime()
                    repeat(iterations) { eng.context.callGlobalFunctionWithBinary("__jstorrent_noop_binary", data, 0, null) }
                    results["binary_in_$name"] = (System.nanoTime() - start).toDouble() / iterations / 1000.0
                }

                // Binary echo benchmarks
                for ((name, size) in listOf("1kb" to 1024, "16kb" to 16384, "64kb" to 65536, "256kb" to 262144)) {
                    val data = ByteArray(size)
                    repeat(10) { eng.context.callGlobalFunctionWithBinary("__jstorrent_echo_binary", data, 0, null) }
                    start = System.nanoTime()
                    repeat(iterations) { eng.context.callGlobalFunctionWithBinary("__jstorrent_echo_binary", data, 0, null) }
                    results["binary_echo_$name"] = (System.nanoTime() - start).toDouble() / iterations / 1000.0
                }
            } catch (e: Exception) {
                Log.e(TAG, "RTT benchmark error on JS thread", e)
            } finally {
                latch.countDown()
            }
        }

        // Wait for JS thread to complete (blocking)
        latch.await()

        // Log results
        Log.i(TAG, "=== FFI RTT Benchmark Results (microseconds) ===")
        for ((name, rtt) in results.entries.sortedBy { it.key }) {
            Log.i(TAG, "  $name: %.1f µs (%.2f ms)".format(rtt, rtt / 1000.0))
        }
        Log.i(TAG, "================================================")

        return results
    }

    /**
     * Gracefully shutdown the JS engine (saves DHT state, stops torrents).
     * Call this before close() for clean shutdown, or let close() handle it.
     */
    suspend fun shutdownAsync() {
        val eng = engine ?: return
        Log.i(TAG, "Calling JS engine shutdown...")
        try {
            eng.callGlobalFunctionAsync("__jstorrent_cmd_shutdown")
            Log.i(TAG, "JS engine shutdown complete")
        } catch (e: Exception) {
            Log.e(TAG, "JS engine shutdown failed", e)
        }
    }

    /**
     * Shutdown the engine and release resources.
     * Calls JS shutdown first to save DHT state.
     */
    override fun close() {
        Log.i(TAG, "Shutting down engine...")

        // Stop host-driven tick if running
        stopHostDrivenTick()

        // Gracefully shutdown JS engine (saves DHT state, stops torrents)
        // Use timeout to prevent ANR if JS thread is stuck
        engine?.let { eng ->
            try {
                runBlocking {
                    val completed = withTimeoutOrNull(SHUTDOWN_TIMEOUT_MS) {
                        eng.callGlobalFunctionAsync("__jstorrent_cmd_shutdown")
                    }
                    if (completed == null) {
                        Log.w(TAG, "JS shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms, forcing close")
                    }
                }
                Log.i(TAG, "JS engine shutdown complete")
            } catch (e: Exception) {
                Log.e(TAG, "JS engine shutdown failed (continuing with close)", e)
            }
        }

        configBridge = null

        bindings?.shutdown()
        bindings = null

        engine?.close()
        engine = null

        _isLoaded.value = false
        _state.value = null

        // Note: Subscription state is managed by SubscriptionTracker in EngineServiceRepository,
        // which handles replay to the new controller when the engine restarts.

        Log.i(TAG, "Engine shut down")
    }

    private fun requireEngine(): QuickJsEngine =
        engine ?: throw IllegalStateException("Engine not loaded. Call loadEngine() first.")

    private fun handleStateUpdate(stateJson: String) {
        try {
            val state = json.decodeFromString<EngineState>(stateJson)
            _state.value = state
        } catch (e: Exception) {
            Log.e(TAG, "Failed to parse state update", e)
        }
    }

    private fun handleError(errorJson: String) {
        Log.e(TAG, "Engine error: $errorJson")
        _lastError.value = errorJson
    }
}
