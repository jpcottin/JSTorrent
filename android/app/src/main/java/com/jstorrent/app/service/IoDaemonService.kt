package com.jstorrent.app.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.net.wifi.WifiManager
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.util.Log
import androidx.core.app.NotificationCompat
import com.jstorrent.app.CompanionServerDepsImpl
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.app.MainActivity
import com.jstorrent.app.R
import com.jstorrent.app.auth.TokenStore
import com.jstorrent.app.power.DozeMonitor
import com.jstorrent.app.settings.SettingsStore
import com.jstorrent.app.storage.RootStore
import com.jstorrent.companion.server.CompanionHttpServer
import com.jstorrent.quickjs.storage.SqliteKVStore
import com.jstorrent.companion.server.DownloadRoot
import com.jstorrent.io.file.FileManagerImpl
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

private const val TAG = "IoDaemonService"
private const val NOTIFICATION_ID = 1
private const val CHANNEL_ID = "jstorrent_daemon"

class IoDaemonService : Service() {

    private lateinit var tokenStore: TokenStore
    private lateinit var rootStore: RootStore
    private lateinit var kvStore: SqliteKVStore
    private var httpServer: CompanionHttpServer? = null

    // Doze mode monitoring for debugging power state transitions
    private var dozeMonitor: DozeMonitor? = null

    // Wake locks to prevent deep sleep and WiFi throttling while extension has active downloads
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var hasActiveDownloads = false

    // Idle timeout for auto-close
    private val ioScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var idleTimeoutJob: Job? = null

    private val settingsStore: SettingsStore
        get() = (application as JSTorrentApplication).settingsStore

    override fun onCreate() {
        super.onCreate()
        Log.i(TAG, "Service created")

        tokenStore = TokenStore(this)
        rootStore = RootStore(this)
        kvStore = SqliteKVStore(this)
        createNotificationChannel()

        dozeMonitor = DozeMonitor(this)

        // Set singleton for static access
        instance = this
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        Log.i(TAG, "Service starting")

        // Must call startForeground immediately after startForegroundService (Android requirement)
        startForeground(NOTIFICATION_ID, createNotification("Starting..."))

        // Start HTTP server
        startServer()

        // Update notification
        updateNotification("Running in background")

        // If background mode is disabled, remove foreground status
        // Service continues running but will be killed when activity closes
        if (!tokenStore.backgroundModeEnabled) {
            stopForeground(STOP_FOREGROUND_REMOVE)
            Log.i(TAG, "Background mode disabled, removed foreground status")
        }

        // Start Doze monitoring for diagnostics
        dozeMonitor?.start()

        return START_STICKY
    }

    override fun onDestroy() {
        Log.i(TAG, "Service destroying")
        instance = null

        // Stop idle timeout
        idleTimeoutJob?.cancel()
        idleTimeoutJob = null

        // Stop Doze monitoring
        dozeMonitor?.stop()
        dozeMonitor = null

        // Release wake locks
        releaseWakeLocks()

        stopServer()
        ioScope.cancel()
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun startServer() {
        if (httpServer?.isRunning == true) {
            Log.w(TAG, "Server already running")
            return
        }

        val deps = CompanionServerDepsImpl(this, tokenStore, rootStore, kvStore)
        val fileManager = FileManagerImpl(this)
        httpServer = CompanionHttpServer(deps, fileManager).also { server ->
            // Wire power hint callback for wake lock management
            server.onPowerHintChanged = { hasActive ->
                onPowerHintChanged(hasActive)
            }

            // Wire connection count callback for idle timeout management
            server.onControlSessionCountChanged = { count ->
                onControlSessionCountChanged(count)
            }
        }

        try {
            httpServer?.start()
            Log.i(TAG, "HTTP server started on port ${httpServer?.port}")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to start server", e)
        }
    }

    private fun stopServer() {
        httpServer?.onPowerHintChanged = null
        httpServer?.onControlSessionCountChanged = null
        httpServer?.stop()
        httpServer = null
    }

    // =========================================================================
    // Power Hint — Wake Lock Management
    // =========================================================================

    /**
     * Called when the extension signals a change in active download count.
     * Acquires wake locks when downloads are active, releases when idle.
     */
    private fun onPowerHintChanged(hasActive: Boolean) {
        if (hasActive == hasActiveDownloads) return
        hasActiveDownloads = hasActive

        if (hasActive) {
            Log.i(TAG, "Extension reports active downloads - acquiring wake locks")
            acquireWakeLocks()
        } else {
            Log.i(TAG, "Extension reports no active downloads - releasing wake locks")
            releaseWakeLocks()
        }
    }

    @Suppress("DEPRECATION")
    private fun acquireWakeLocks() {
        if (wakeLock == null) {
            val powerManager = getSystemService(Context.POWER_SERVICE) as PowerManager
            wakeLock = powerManager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "JSTorrent::CompanionWakeLock"
            ).apply { acquire() }
            Log.i(TAG, "CPU wake lock acquired")
        }

        if (wifiLock == null) {
            val wifiManager = applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
            val wifiMode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                WifiManager.WIFI_MODE_FULL_LOW_LATENCY
            } else {
                WifiManager.WIFI_MODE_FULL_HIGH_PERF
            }
            wifiLock = wifiManager.createWifiLock(wifiMode, "JSTorrent::CompanionWifiLock").apply {
                acquire()
            }
            Log.i(TAG, "WiFi wake lock acquired")
        }
    }

    private fun releaseWakeLocks() {
        wakeLock?.let {
            if (it.isHeld) {
                it.release()
                Log.i(TAG, "CPU wake lock released")
            }
        }
        wakeLock = null

        wifiLock?.let {
            if (it.isHeld) {
                it.release()
                Log.i(TAG, "WiFi wake lock released")
            }
        }
        wifiLock = null
    }

    // =========================================================================
    // Idle Timeout — Auto-Close
    // =========================================================================

    /**
     * Called when the number of connected control sessions changes.
     * Starts/cancels idle timeout accordingly.
     */
    private fun onControlSessionCountChanged(sessionCount: Int) {
        if (sessionCount > 0) {
            // Extension connected — cancel any pending idle timeout
            cancelIdleTimeout()
        } else {
            // All extensions disconnected — start idle timeout if enabled
            startIdleTimeoutIfEnabled()
        }
    }

    private fun startIdleTimeoutIfEnabled() {
        if (!settingsStore.companionAutoCloseEnabled) return
        if (!tokenStore.backgroundModeEnabled) return

        val minutes = settingsStore.companionAutoCloseMinutes
        Log.i(TAG, "No active connections - auto-close in $minutes minutes")

        idleTimeoutJob?.cancel()
        idleTimeoutJob = ioScope.launch {
            delay(minutes * 60_000L)
            Log.i(TAG, "Idle timeout fired after $minutes minutes - stopping service")
            stop(this@IoDaemonService)
        }
    }

    private fun cancelIdleTimeout() {
        idleTimeoutJob?.let {
            it.cancel()
            Log.d(TAG, "Idle timeout cancelled - extension reconnected")
        }
        idleTimeoutJob = null
    }

    /**
     * Update auto-close settings at runtime.
     */
    fun setAutoCloseEnabled(enabled: Boolean) {
        settingsStore.companionAutoCloseEnabled = enabled
        if (!enabled) {
            cancelIdleTimeout()
        } else if (!hasActiveControlConnection()) {
            startIdleTimeoutIfEnabled()
        }
    }

    fun setAutoCloseMinutes(minutes: Int) {
        settingsStore.companionAutoCloseMinutes = minutes
        // Restart timeout with new duration if currently counting down
        if (idleTimeoutJob?.isActive == true) {
            startIdleTimeoutIfEnabled()
        }
    }

    // =========================================================================
    // Foreground Mode
    // =========================================================================

    /**
     * Toggle foreground mode at runtime.
     * When enabled, shows a persistent notification and service survives activity close.
     * When disabled, removes notification and service will be killed when activity closes.
     */
    fun setForegroundMode(enabled: Boolean) {
        if (enabled) {
            startForeground(NOTIFICATION_ID, createNotification("Running in background"))
            Log.i(TAG, "Foreground mode enabled")
        } else {
            stopForeground(STOP_FOREGROUND_REMOVE)
            cancelIdleTimeout()
            Log.i(TAG, "Foreground mode disabled")
        }
    }

    // =========================================================================
    // Control Plane
    // =========================================================================

    /**
     * Get the current server port (Ktor HTTP/control plane).
     */
    val port: Int
        get() = httpServer?.port ?: 7800

    /**
     * Get the IO WebSocket port (java-websocket high-throughput).
     * Returns 0 if not available.
     */
    val ioPort: Int
        get() = httpServer?.ioPort ?: -1

    /**
     * Check if the HTTP server is running and ready.
     */
    val isServerRunning: Boolean
        get() = httpServer?.isRunning == true

    /**
     * Broadcast ROOTS_CHANGED to all connected WebSocket clients.
     * Call this after AddRootActivity adds a new root.
     */
    fun broadcastRootsChanged() {
        val appRoots = rootStore.refreshAvailability()
        // Convert app DownloadRoot to companion-server DownloadRoot
        val roots = appRoots.map { root ->
            DownloadRoot(
                key = root.key,
                uri = root.uri,
                displayName = root.displayName,
                removable = root.removable,
                lastStatOk = root.lastStatOk,
                lastChecked = root.lastChecked
            )
        }
        httpServer?.broadcastRootsChanged(roots)
        Log.i(TAG, "Broadcast ROOTS_CHANGED with ${roots.size} roots")
    }

    /**
     * Broadcast a generic event to all connected WebSocket clients.
     */
    fun broadcastEvent(event: String, payload: JsonElement? = null) {
        httpServer?.broadcastEvent(event, payload)
        Log.i(TAG, "Broadcast event: $event")
    }

    /**
     * Check if any authenticated control session is connected.
     */
    fun hasActiveControlConnection(): Boolean =
        httpServer?.hasActiveControlConnection() ?: false

    /**
     * Close all connected WebSocket sessions.
     * Call this when the user unpairs to disconnect the extension.
     */
    suspend fun closeAllSessions() {
        httpServer?.closeAllSessions()
    }

    /**
     * Send a MagnetAdded event to the extension.
     */
    fun sendMagnetAdded(magnet: String) {
        val payload = buildJsonObject {
            put("link", JsonPrimitive(magnet))
        }
        broadcastEvent("MagnetAdded", payload)
    }

    /**
     * Send a TorrentAdded event to the extension.
     */
    fun sendTorrentAdded(name: String, contentsBase64: String) {
        val payload = buildJsonObject {
            put("name", JsonPrimitive(name))
            put("contentsBase64", JsonPrimitive(contentsBase64))
        }
        broadcastEvent("TorrentAdded", payload)
    }

    // =========================================================================
    // Notification
    // =========================================================================

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "JSTorrent System Bridge",
            NotificationManager.IMPORTANCE_LOW
        ).apply {
            description = "Shows when JSTorrent System Bridge is running in background"
            setShowBadge(false)
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager.createNotificationChannel(channel)
    }

    private fun createNotification(status: String): Notification {
        val pendingIntent = PendingIntent.getActivity(
            this,
            0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("System Bridge")
            .setContentText(status)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentIntent(pendingIntent)
            .setOngoing(true)
            .setSilent(true)
            .build()
    }

    private fun updateNotification(status: String) {
        val manager = getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, createNotification(status))
    }

    companion object {
        // Singleton for static access from AddRootActivity
        @Volatile
        var instance: IoDaemonService? = null
            private set

        fun start(context: Context) {
            val intent = Intent(context, IoDaemonService::class.java)
            context.startForegroundService(intent)
        }

        fun stop(context: Context) {
            val intent = Intent(context, IoDaemonService::class.java)
            context.stopService(intent)
        }
    }
}
