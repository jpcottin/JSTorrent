package com.jstorrent.app

import android.app.ActivityManager
import android.app.Application
import android.app.NotificationChannel
import android.app.NotificationManager
import android.net.Uri
import android.os.Debug
import android.os.Process
import android.util.Log
import androidx.appcompat.app.AppCompatDelegate
import androidx.core.os.LocaleListCompat
import com.jstorrent.app.cache.TorrentSummaryCache
import com.jstorrent.app.debug.MEMORY_TAG
import com.jstorrent.app.debug.formatMemorySummary
import com.jstorrent.app.debug.trimLevelName
import com.jstorrent.app.network.NetworkRestrictionEnforcer
import com.jstorrent.app.notification.TorrentNotificationManager
import com.jstorrent.app.viewmodel.EngineServiceRepository
import com.jstorrent.app.network.NetworkStateProvider
import com.jstorrent.app.service.ServiceLifecycleManager
import com.jstorrent.app.settings.MetricsStore
import com.jstorrent.app.settings.SettingsStore
import com.jstorrent.app.storage.RootStore
import com.jstorrent.quickjs.model.TorrentSummary
import com.jstorrent.quickjs.EngineController
import com.jstorrent.quickjs.model.AndroidProcessMemoryStats
import com.jstorrent.quickjs.model.AppMemorySnapshot
import com.jstorrent.quickjs.storage.AndroidConfigHub
import com.jstorrent.quickjs.storage.SqliteKVStore
import com.jstorrent.quickjs.model.ContentRoot
import com.jstorrent.quickjs.model.EngineConfig
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

private const val TAG = "JSTorrentApplication"
private const val MEMORY_LOG_INTERVAL_MS = 30_000L

/**
 * Application class for JSTorrent.
 *
 * Creates notification channels on startup. This ensures channels exist
 * before any service tries to use them.
 *
 * Also hosts the engine controller which lives for the process lifetime.
 */
class JSTorrentApplication : Application() {

    /**
     * Centralized notification channel IDs.
     */
    object NotificationChannels {
        /** Foreground service notification - low priority, silent, persistent */
        const val SERVICE = "jstorrent_service"

        /** Download complete notifications - default priority, plays sound */
        const val COMPLETE = "jstorrent_complete"

        /** Error notifications - high priority */
        const val ERRORS = "jstorrent_errors"
    }

    // Torrent summary cache for lazy engine startup (Stage 1)
    // Provides cached torrent list without starting the engine
    val torrentSummaryCache: TorrentSummaryCache by lazy {
        TorrentSummaryCache(this)
    }

    // Shared SettingsStore instance - use this instead of creating new instances
    // This ensures all components see the same settings values
    val settingsStore: SettingsStore by lazy {
        SettingsStore(this)
    }

    // Notification manager for torrent completion/error events
    private val torrentNotificationManager: TorrentNotificationManager by lazy {
        TorrentNotificationManager(this)
    }

    // Metrics tracking
    private val metricsStore: MetricsStore by lazy {
        MetricsStore(this)
    }

    // Shared EngineServiceRepository instance - use this instead of creating new instances
    // Critical: All ViewModels must share the same repository so the SubscriptionTracker
    // correctly tracks all subscriptions. Otherwise, when one ViewModel is cleared,
    // its tracker calls pauseSubscriptions() even though other ViewModels still have
    // active subscriptions.
    val engineServiceRepository: EngineServiceRepository by lazy {
        EngineServiceRepository(this)
    }

    // Network restriction status - always available, even before engine starts
    // Values: "waiting_wifi", "waiting_vpn", or null (no restriction)
    private val _restrictionStatus = MutableStateFlow<String?>(null)
    val restrictionStatus: StateFlow<String?> = _restrictionStatus.asStateFlow()

    // Job for network state observation - lives for app lifetime
    private var networkStateObservationJob: Job? = null

    // Shared SQLite KV store for config and session storage
    private val sqliteKVStore: SqliteKVStore by lazy {
        SqliteKVStore(this)
    }

    // AndroidConfigHub - unified configuration for Kotlin and JS
    // Handles persistence and JS engine notification automatically
    private val _configHub: AndroidConfigHub by lazy {
        AndroidConfigHub(sqliteKVStore) {
            // Lazy provider for ConfigBridge - engine may not be running yet
            _engineController?.getConfigBridge()
        }
    }

    /**
     * Get the shared AndroidConfigHub instance.
     * Use this for all engine settings - it handles persistence and JS notification.
     */
    fun getConfigHub(): AndroidConfigHub = _configHub

    /**
     * Compute the current restriction status based on network state and settings.
     * Returns "waiting_wifi", "waiting_vpn", or null.
     */
    private fun computeRestrictionStatus(isUnmetered: Boolean, isVpn: Boolean): String? {
        if (settingsStore.wifiOnlyEnabled && !isUnmetered) {
            return "waiting_wifi"
        }
        if (settingsStore.vpnOnlyEnabled && !isVpn) {
            return "waiting_vpn"
        }
        return null
    }

    /**
     * Start observing network state changes to update restriction status.
     * Called from onCreate() so status is always available.
     */
    private fun startNetworkStateObservation() {
        val networkProvider = NetworkStateProvider.getInstance()

        // Set initial status immediately
        _restrictionStatus.value = computeRestrictionStatus(
            isUnmetered = networkProvider.isUnmetered.value,
            isVpn = networkProvider.isVpnConnected.value
        )

        // Observe ongoing changes
        networkStateObservationJob = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate).launch {
            combine(
                networkProvider.isUnmetered,
                networkProvider.isVpnConnected
            ) { isUnmetered, isVpn ->
                computeRestrictionStatus(isUnmetered, isVpn)
            }.collect { status ->
                _restrictionStatus.value = status
            }
        }
    }

    /**
     * Called when WiFi-only or VPN-only settings change.
     * Re-computes restriction status with current network state.
     */
    fun onNetworkRestrictionSettingChanged() {
        val networkProvider = NetworkStateProvider.getInstanceOrNull() ?: return
        _restrictionStatus.value = computeRestrictionStatus(
            isUnmetered = networkProvider.isUnmetered.value,
            isVpn = networkProvider.isVpnConnected.value
        )
    }

    // Service lifecycle management
    lateinit var serviceLifecycleManager: ServiceLifecycleManager
        private set

    override fun onCreate() {
        super.onCreate()

        // Apply saved locale before any UI is created (needed for API < 33)
        val savedLocale = settingsStore.appLocale
        if (savedLocale.isNotEmpty()) {
            AppCompatDelegate.setApplicationLocales(
                LocaleListCompat.forLanguageTags(savedLocale)
            )
        }

        // Apply saved theme before any UI is created
        val savedTheme = settingsStore.appTheme
        if (savedTheme.isNotEmpty()) {
            AppCompatDelegate.setDefaultNightMode(
                when (savedTheme) {
                    "light" -> AppCompatDelegate.MODE_NIGHT_NO
                    "dark" -> AppCompatDelegate.MODE_NIGHT_YES
                    else -> AppCompatDelegate.MODE_NIGHT_FOLLOW_SYSTEM
                }
            )
        }

        createNotificationChannels()
        deleteLegacyChannels()

        // Initialize network state provider for WiFi-only/VPN-only mode checking
        NetworkStateProvider.initialize(this)

        // Start observing network state for restriction status (always available, even before engine)
        startNetworkStateObservation()

        // Initialize service lifecycle manager with shutdown/restore callbacks
        // When background downloads are disabled, we completely shut down the engine
        // to prevent the 100ms tick loop from draining battery
        // Stage 4: Also pass cache for checking active torrents when engine not running
        serviceLifecycleManager = ServiceLifecycleManager(
            context = this,
            settingsStore = settingsStore,  // Use shared instance
            torrentSummaryCache = torrentSummaryCache,
            onShutdownForBackground = { shutdownEngineForBackground() },
            onRestoreFromBackground = { restoreEngineFromBackground() },
            onStartEngineForBackground = { startEngineForBackground() }
        )
    }

    override fun onTrimMemory(level: Int) {
        super.onTrimMemory(level)
        lastTrimLevel = level
        lastTrimAtMs = System.currentTimeMillis()
        val foreground = if (::serviceLifecycleManager.isInitialized) {
            serviceLifecycleManager.isActivityForeground.value
        } else {
            false
        }
        Log.w(MEMORY_TAG, "[TRIM] level=$level (${trimLevelName(level)}) foreground=$foreground")
    }

    /**
     * Completely shut down the engine when going to background.
     * This stops the 100ms tick loop and all intervals to prevent battery drain.
     * Called when background downloads are disabled and user leaves the app.
     */
    private fun shutdownEngineForBackground() {
        if (_engineController == null) {
            Log.d(TAG, "Engine not initialized, nothing to shut down")
            return
        }
        Log.i(TAG, "Shutting down engine for background (battery saving)")
        shutdownEngine()
    }

    /**
     * Restore the engine after coming back from background.
     * The engine will be lazily reinitialized when the Activity calls ensureEngine().
     * We don't reinitialize here because the Activity hasn't started yet.
     */
    private fun restoreEngineFromBackground() {
        // The engine will be reinitialized by the Activity when it calls ensureEngine()
        // in onStart(). We just log here for debugging.
        Log.i(TAG, "Engine restore requested - will reinitialize on Activity start")
    }

    /**
     * Start the engine in background when there are active incomplete torrents.
     * Stage 4: Called by ServiceLifecycleManager when user backgrounds the app
     * but cache shows active downloads that should continue.
     */
    private fun startEngineForBackground() {
        if (_engineController != null) {
            Log.d(TAG, "Engine already running, no need to start for background")
            return
        }
        Log.i(TAG, "Starting engine for background downloads")
        initializeEngine()
    }

    private fun createNotificationChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        // Service channel (foreground service)
        manager.createNotificationChannel(
            NotificationChannel(
                NotificationChannels.SERVICE,
                "JSTorrent Service",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Shows when JSTorrent is running"
                setShowBadge(false)
            }
        )

        // Download complete channel
        manager.createNotificationChannel(
            NotificationChannel(
                NotificationChannels.COMPLETE,
                "Download Complete",
                NotificationManager.IMPORTANCE_DEFAULT
            ).apply {
                description = "Notifications when downloads complete"
                enableVibration(true)
                setShowBadge(true)
            }
        )

        // Errors channel
        manager.createNotificationChannel(
            NotificationChannel(
                NotificationChannels.ERRORS,
                "Errors",
                NotificationManager.IMPORTANCE_HIGH
            ).apply {
                description = "Storage full, connection issues"
                enableVibration(true)
            }
        )
    }

    /**
     * Delete legacy notification channels from previous versions.
     */
    private fun deleteLegacyChannels() {
        val manager = getSystemService(NotificationManager::class.java)

        // Legacy channel IDs that are no longer used
        val legacyChannels = listOf(
            "jstorrent_engine",           // Old ForegroundNotificationService channel
            "jstorrent_download_complete" // Old TorrentNotificationManager channel
        )

        for (channelId in legacyChannels) {
            manager.deleteNotificationChannel(channelId)
        }
    }

    // =========================================================================
    // Engine Controller - lives for process lifetime
    // =========================================================================

    // Stage 5: @Volatile ensures visibility across threads for race condition safety
    @Volatile
    private var _engineController: EngineController? = null

    // Stage 5: Lock object for thread-safe engine initialization
    private val engineLock = Any()

    val engineController: EngineController?
        get() = _engineController

    // Scope for engine - lives for process lifetime
    private val engineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    // Job for torrent state observation - must be canceled on engine shutdown
    private var torrentStateObservationJob: Job? = null
    private var periodicMemoryLoggingJob: Job? = null

    @Volatile
    private var lastTrimLevel: Int? = null

    @Volatile
    private var lastTrimAtMs: Long? = null

    // State tracking for completion/error notifications
    private data class TorrentStateSnapshot(val progress: Double, val status: String)
    private val previousTorrentStates = mutableMapOf<String, TorrentStateSnapshot>()

    // Network restriction enforcer - enforces WiFi-only/VPN-only policies
    // Lives here (not in ForegroundNotificationService) so it works when app is in foreground
    @Volatile
    private var _networkRestrictionEnforcer: NetworkRestrictionEnforcer? = null

    val networkRestrictionEnforcer: NetworkRestrictionEnforcer?
        get() = _networkRestrictionEnforcer

    /**
     * Initialize the engine. Called from Activity on first launch.
     * Idempotent and thread-safe - safe to call multiple times from multiple threads.
     *
     * Stage 5: Uses synchronized block to prevent race conditions where multiple
     * threads could both see _engineController as null and try to initialize.
     */
    fun initializeEngine(storageMode: String? = null): EngineController {
        // Quick check without lock (volatile read)
        _engineController?.let { return it }

        // Double-checked locking pattern for thread-safe initialization
        synchronized(engineLock) {
            // Check again inside lock (another thread may have initialized)
            _engineController?.let { return it }

            Log.i(TAG, "Initializing engine...")

            val rootStore = RootStore(this)

            // Create rootResolver that queries RootStore dynamically
            val rootResolver: (String) -> Uri? = { key ->
                rootStore.reload()
                rootStore.resolveKey(key)
            }

            val controller = EngineController(
                context = this,
                scope = engineScope,
                rootResolver = rootResolver
            )

            // Build config from RootStore
            val roots = rootStore.listRoots()
            val defaultKey = _configHub.defaultRootKey?.takeIf { key ->
                roots.any { it.key == key }
            } ?: roots.firstOrNull()?.key

            // Create network restriction enforcer before engine init
            // This determines if engine should start suspended
            val networkProvider = NetworkStateProvider.getInstance()
            val enforcer = NetworkRestrictionEnforcer(
                settingsStore = settingsStore,
                networkStateProvider = networkProvider,
                scope = engineScope,
                onSuspend = { controller.suspendEngineAsync() },
                onResume = { controller.resumeEngineAsync() }
            )
            _networkRestrictionEnforcer = enforcer

            // Check if downloads should be blocked due to WiFi-only or VPN-only mode
            // If blocked, engine should remain suspended after init
            val shouldRemainSuspended = enforcer.shouldBlockDownloads()
            if (shouldRemainSuspended) {
                Log.i(TAG, "Engine will remain suspended due to network restrictions (WiFi-only or VPN-only mode)")
            }

            val config = EngineConfig(
                contentRoots = roots.map { root ->
                    ContentRoot(key = root.key, label = root.displayName, path = root.uri, diskId = root.volumeId)
                },
                defaultContentRoot = defaultKey,
                storageMode = if (storageMode == "null") "null" else null,
                shouldRemainSuspended = shouldRemainSuspended
            )

            controller.loadEngine(config)
            _engineController = controller
            Log.i(TAG, "Engine loaded successfully")

            // Start host-driven tick loop for better timing visibility
            controller.startHostDrivenTick()

            // Start observing torrent state for service lifecycle decisions
            startTorrentStateObservation(controller)

            // Apply saved settings
            applyEngineSettings(controller)

            // Start network restriction enforcement
            enforcer.start()

            return controller
        }
    }

    val isEngineInitialized: Boolean
        get() = _engineController != null

    /**
     * Lazily start the engine on demand (Stage 2: Deferred Engine Initialization).
     *
     * This is the primary entry point for starting the engine. It should be called when:
     * - User taps play/resume on a torrent
     * - User opens torrent detail view
     * - User adds a new torrent (magnet link, .torrent file)
     * - Background download setting is enabled and there's pending work
     *
     * Idempotent - safe to call multiple times.
     *
     * @param storageMode Optional storage mode for testing
     * @return The engine controller (newly created or existing)
     */
    fun ensureEngineStarted(storageMode: String? = null): EngineController {
        return ensureEngine(storageMode)
    }

    /**
     * Shutdown engine. Called on explicit quit or for testing.
     * Stage 5: Thread-safe shutdown using synchronized block.
     */
    fun shutdownEngine() {
        synchronized(engineLock) {
            // Stop network restriction enforcement
            _networkRestrictionEnforcer?.stop()
            _networkRestrictionEnforcer = null

            torrentStateObservationJob?.cancel()
            torrentStateObservationJob = null
            periodicMemoryLoggingJob?.cancel()
            periodicMemoryLoggingJob = null

            // Reset completion tracking for next engine start
            previousTorrentStates.clear()

            _engineController?.close()
            _engineController = null
        }
    }

    /**
     * Ensure the engine is healthy. If engine crashed or was closed,
     * reinitialize it.
     *
     * Stage 5: Thread-safe health check and reinitialization.
     *
     * @param storageMode Optional storage mode for testing
     * @return The healthy engine controller
     */
    fun ensureEngine(storageMode: String? = null): EngineController {
        // Quick check without lock - if healthy, return immediately
        _engineController?.let { controller ->
            if (controller.isHealthy) {
                return controller
            }
        }

        // Need to check/reinitialize under lock
        synchronized(engineLock) {
            _engineController?.let { controller ->
                if (controller.isHealthy) {
                    return controller
                }
                Log.w(TAG, "Engine unhealthy, reinitializing...")
                try {
                    controller.close()
                } catch (e: Exception) {
                    Log.e(TAG, "Error closing unhealthy engine", e)
                }
                _engineController = null
            }
        }
        return initializeEngine(storageMode)
    }

    /**
     * Observe torrent state changes and notify the service lifecycle manager.
     * Cancels any existing observation to prevent leaking old EngineController instances.
     *
     * Also detects completion/error transitions and fires notifications.
     * This MUST happen here (not in ForegroundNotificationService) because
     * onTorrentStateChanged may stop the service before its polling loop runs.
     */
    private fun startTorrentStateObservation(controller: EngineController) {
        torrentStateObservationJob?.cancel()
        torrentStateObservationJob = engineScope.launch {
            controller.state.collect { state ->
                val torrents = state?.torrents ?: emptyList()
                // Check for completion/error BEFORE notifying lifecycle manager,
                // which may stop the foreground service
                checkTorrentStateTransitions(torrents)
                serviceLifecycleManager.onTorrentStateChanged(torrents)
                updatePeriodicMemoryLogging(torrents)
            }
        }
    }

    private fun updatePeriodicMemoryLogging(torrents: List<TorrentSummary>) {
        val shouldLog = torrents.any {
            it.status == "downloading" || it.status == "downloading_metadata" || it.status == "checking"
        }

        if (shouldLog && periodicMemoryLoggingJob == null) {
            Log.i(MEMORY_TAG, "[MARK] periodic memory logging enabled")
            periodicMemoryLoggingJob = engineScope.launch {
                while (true) {
                    try {
                        val snapshot = captureMemorySnapshot()
                        Log.i(MEMORY_TAG, formatMemorySummary(snapshot, reason = "periodic"))
                    } catch (e: Exception) {
                        Log.e(MEMORY_TAG, "Periodic memory snapshot failed: ${e.message}", e)
                    }
                    delay(MEMORY_LOG_INTERVAL_MS)
                }
            }
        } else if (!shouldLog && periodicMemoryLoggingJob != null) {
            Log.i(MEMORY_TAG, "[MARK] periodic memory logging disabled")
            periodicMemoryLoggingJob?.cancel()
            periodicMemoryLoggingJob = null
        }
    }

    fun getLastTrimInfo(): Pair<Int?, Long?> = Pair(lastTrimLevel, lastTrimAtMs)

    suspend fun captureMemorySnapshot(): AppMemorySnapshot {
        val controller = _engineController
        val activityManager = getSystemService(ActivityManager::class.java)
        val processInfo = activityManager
            ?.getProcessMemoryInfo(intArrayOf(Process.myPid()))
            ?.firstOrNull()
        val systemInfo = ActivityManager.MemoryInfo()
        activityManager?.getMemoryInfo(systemInfo)

        val runtime = Runtime.getRuntime()
        val process = AndroidProcessMemoryStats(
            totalPssKb = processInfo?.totalPss ?: 0,
            totalPrivateDirtyKb = processInfo?.totalPrivateDirty ?: 0,
            nativeHeapAllocatedBytes = Debug.getNativeHeapAllocatedSize(),
            dalvikPssKb = processInfo?.dalvikPss ?: 0,
            nativePssKb = processInfo?.nativePss ?: 0,
            otherPssKb = processInfo?.otherPss ?: 0,
            jvmUsedBytes = runtime.totalMemory() - runtime.freeMemory(),
            jvmFreeBytes = runtime.freeMemory(),
            jvmMaxBytes = runtime.maxMemory(),
            systemAvailMemBytes = systemInfo.availMem,
            systemLowMemory = systemInfo.lowMemory,
            systemThresholdBytes = systemInfo.threshold
        )

        val quickJs = controller?.getQuickJsMemoryUsageAsync()
        val engine = controller?.getEngineMemoryStatsAsync()

        return AppMemorySnapshot(
            timestampMs = System.currentTimeMillis(),
            appInForeground = if (::serviceLifecycleManager.isInitialized) {
                serviceLifecycleManager.isActivityForeground.value
            } else {
                false
            },
            lastTrimLevel = lastTrimLevel,
            lastTrimAtMs = lastTrimAtMs,
            process = process,
            quickJs = quickJs,
            engine = engine
        )
    }

    /**
     * Detect torrent completion and error transitions, firing notifications.
     */
    private fun checkTorrentStateTransitions(torrents: List<TorrentSummary>) {
        for (torrent in torrents) {
            val prev = previousTorrentStates[torrent.infoHash]

            // Only fire on actual transitions (prev != null), not when a torrent
            // first appears. This avoids false notifications for torrents that were
            // already complete when the engine loaded session data.
            if (prev != null) {
                // Detect completion: was incomplete, now complete
                if (torrent.progress >= 1.0 && prev.progress < 1.0) {
                    metricsStore.incrementCompletedDownloads()
                    showCompletionNotification(torrent)
                }

                // Detect error: wasn't error, now is
                if (torrent.status == "error" && prev.status != "error") {
                    showErrorNotification(torrent)
                }
            }

            previousTorrentStates[torrent.infoHash] = TorrentStateSnapshot(
                progress = torrent.progress,
                status = torrent.status
            )
        }

        // Clean up removed torrents
        val currentHashes = torrents.map { it.infoHash }.toSet()
        previousTorrentStates.keys.removeAll { it !in currentHashes }
    }

    private fun showCompletionNotification(torrent: TorrentSummary) {
        Log.i(TAG, "Torrent completed: ${torrent.name}")

        engineScope.launch {
            val size = try {
                _engineController?.getTorrentListAsync()
                    ?.find { it.infoHash == torrent.infoHash }
                    ?.size ?: 0L
            } catch (e: Exception) {
                0L
            }

            val folderUri = getDefaultFolderUri()

            torrentNotificationManager.showDownloadComplete(
                torrentName = torrent.name,
                infoHash = torrent.infoHash,
                sizeBytes = size,
                folderUri = folderUri
            )
        }
    }

    private fun showErrorNotification(torrent: TorrentSummary) {
        Log.w(TAG, "Torrent error: ${torrent.name}")
        torrentNotificationManager.showError(
            torrentName = torrent.name,
            infoHash = torrent.infoHash,
            errorMessage = torrent.errorMessage ?: "Download error"
        )
    }

    private fun getDefaultFolderUri(): Uri? {
        val rootStore = RootStore(this)
        val defaultKey = _configHub.defaultRootKey
        if (defaultKey != null) {
            return rootStore.resolveKey(defaultKey)
        }
        val roots = rootStore.listRoots()
        return roots.firstOrNull()?.let { Uri.parse(it.uri) }
    }

    private fun applyEngineSettings(controller: EngineController) {
        val configBridge = controller.getConfigBridge() ?: return

        // Use the shared configHub for consistent settings
        val configHub = _configHub

        // Use 0 for unlimited, otherwise use the configured limit
        val effectiveDownloadLimit = if (configHub.downloadSpeedUnlimited) 0 else configHub.downloadSpeedLimit
        val effectiveUploadLimit = if (configHub.uploadSpeedUnlimited) 0 else configHub.uploadSpeedLimit

        configBridge.setDownloadSpeedLimit(effectiveDownloadLimit)
        configBridge.setUploadSpeedLimit(effectiveUploadLimit)

        configBridge.setDhtEnabled(configHub.dhtEnabled)
        configBridge.setPexEnabled(configHub.pexEnabled)
        configBridge.setUpnpEnabled(configHub.upnpEnabled)
        configBridge.setEncryptionPolicy(configHub.encryptionPolicy)

        // Queue limits
        configBridge.batchUpdate(mapOf(
            "activeDownloads" to configHub.activeDownloads,
            "activeSeeds" to configHub.activeSeeds,
            "activePieceMemoryLimitMiB" to configHub.activePieceMemoryLimitMiB
        ))

        Log.i(TAG, "Applied engine settings: download=${if (effectiveDownloadLimit == 0) "unlimited" else "${effectiveDownloadLimit}B/s"}, " +
            "upload=${if (effectiveUploadLimit == 0) "unlimited" else "${effectiveUploadLimit}B/s"}, " +
            "dht=${configHub.dhtEnabled}, pex=${configHub.pexEnabled}, " +
            "upnp=${configHub.upnpEnabled}, encryption=${configHub.encryptionPolicy}, " +
            "activeDownloads=${configHub.activeDownloads}, activeSeeds=${configHub.activeSeeds}, " +
            "activePieceMemoryLimitMiB=${configHub.activePieceMemoryLimitMiB}")
    }
}
