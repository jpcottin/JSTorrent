package com.jstorrent.app.viewmodel

import android.Manifest
import android.content.Context
import android.os.Build
import androidx.core.content.ContextCompat
import androidx.core.content.PermissionChecker
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.app.service.ForegroundNotificationService
import com.jstorrent.app.settings.SettingsStore
import com.jstorrent.app.storage.DownloadRoot
import com.jstorrent.app.storage.RootStore
import com.jstorrent.quickjs.storage.AndroidConfigHub
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * UI state for the settings screen.
 */
/**
 * State for the remove folder confirmation dialog.
 */
data class RemoveFolderDialogState(
    val key: String,
    val displayName: String,
    val torrentCount: Int
)

data class SettingsUiState(
    // Storage
    val downloadRoots: List<DownloadRoot> = emptyList(),
    val defaultRootKey: String? = null,
    val removeFolderDialog: RemoveFolderDialogState? = null,
    // Reset/Clear dialogs
    val showResetSettingsConfirmation: Boolean = false,
    val showClearAllDataConfirmation: Boolean = false,
    // Bandwidth
    val downloadSpeedUnlimited: Boolean = true,
    val downloadSpeedLimit: Int = 1048576, // 1 MB/s
    val uploadSpeedUnlimited: Boolean = true,
    val uploadSpeedLimit: Int = 1048576, // 1 MB/s
    // Connection Limits
    val maxPeersPerTorrent: Int = 20,
    val maxGlobalPeers: Int = 200,
    val maxUploadSlots: Int = 4,
    val maxPipelineDepth: Int = AndroidConfigHub.DEFAULT_MAX_PIPELINE_DEPTH,
    // Queue Limits
    val activeDownloads: Int = AndroidConfigHub.DEFAULT_ACTIVE_DOWNLOADS,
    val activeSeeds: Int = AndroidConfigHub.DEFAULT_ACTIVE_SEEDS,
    // Behavior
    val whenDownloadsComplete: String = "stop_and_close",
    // Network
    val wifiOnlyEnabled: Boolean = false,
    val vpnOnlyEnabled: Boolean = false,
    val dhtEnabled: Boolean = true,
    val pexEnabled: Boolean = true,
    val upnpEnabled: Boolean = true,
    val upnpStatus: String = "disabled", // disabled, discovering, mapped, unavailable, failed
    val upnpExternalIP: String? = null,
    val upnpPort: Int = 0,
    val hasReceivedIncomingConnection: Boolean = false,
    val encryptionPolicy: String = "allow",
    // SOCKS5 Proxy
    val proxyEnabled: Boolean = false,
    val proxyHost: String? = null,
    val proxyPort: Int = 1080,
    val proxyUsername: String? = null,
    val proxyPassword: String? = null,
    val proxyHttpTrackers: Boolean = true,
    val proxyUdpTrackers: Boolean = true,
    val proxyPeerConnections: Boolean = true,
    val showProxyDialog: Boolean = false,
    // Power Management
    val backgroundDownloadsEnabled: Boolean = false,
    val cpuWakeLockEnabled: Boolean = false,
    val shutdownOnLowBatteryEnabled: Boolean = false,
    val shutdownOnLowBatteryThreshold: Int = 15,
    // Notifications
    val notificationPermissionGranted: Boolean = false,
    val canRequestNotificationPermission: Boolean = true,
    val showNotificationRequiredDialog: Boolean = false,
    val showKeepSeedingWarningDialog: Boolean = false
)

/**
 * ViewModel for the settings screen.
 * Manages storage roots and app settings.
 *
 * Settings are split between two stores:
 * - configHub (AndroidConfigHub): Engine settings shared with JS engine via SQLite
 *   Automatically handles persistence and JS engine notification
 * - settingsStore (SharedPreferences): Android-only settings
 */
class SettingsViewModel(
    private val app: JSTorrentApplication,
    private val rootStore: RootStore,
    private val settingsStore: SettingsStore,
    private val configHub: AndroidConfigHub,
    initialNotificationPermissionGranted: Boolean
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        SettingsUiState(notificationPermissionGranted = initialNotificationPermissionGranted)
    )
    val uiState: StateFlow<SettingsUiState> = _uiState.asStateFlow()

    init {
        refreshAllSettings()
    }

    /**
     * Refresh all settings from stores.
     */
    fun refreshAllSettings() {
        val roots = rootStore.refreshAvailability()

        // Check notification permission at init time to avoid UI flicker
        val notificationGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                app,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PermissionChecker.PERMISSION_GRANTED
        } else {
            true
        }

        _uiState.value = _uiState.value.copy(
            downloadRoots = roots,
            // Engine settings (from AndroidConfigHub / SQLite KV)
            defaultRootKey = configHub.defaultRootKey,
            downloadSpeedUnlimited = configHub.downloadSpeedUnlimited,
            downloadSpeedLimit = configHub.downloadSpeedLimit,
            uploadSpeedUnlimited = configHub.uploadSpeedUnlimited,
            uploadSpeedLimit = configHub.uploadSpeedLimit,
            maxPeersPerTorrent = configHub.maxPeersPerTorrent,
            maxGlobalPeers = configHub.maxGlobalPeers,
            maxUploadSlots = configHub.maxUploadSlots,
            maxPipelineDepth = configHub.maxPipelineDepth,
            activeDownloads = configHub.activeDownloads,
            activeSeeds = configHub.activeSeeds,
            dhtEnabled = configHub.dhtEnabled,
            pexEnabled = configHub.pexEnabled,
            upnpEnabled = configHub.upnpEnabled,
            encryptionPolicy = configHub.encryptionPolicy,
            proxyEnabled = configHub.proxyEnabled,
            proxyHost = configHub.proxyHost,
            proxyPort = configHub.proxyPort,
            proxyUsername = configHub.proxyUsername,
            proxyPassword = configHub.proxyPassword,
            proxyHttpTrackers = configHub.proxyHttpTrackers,
            proxyUdpTrackers = configHub.proxyUdpTrackers,
            proxyPeerConnections = configHub.proxyPeerConnections,
            // Android-only settings (from SharedPreferences)
            whenDownloadsComplete = settingsStore.whenDownloadsComplete,
            wifiOnlyEnabled = settingsStore.wifiOnlyEnabled,
            vpnOnlyEnabled = settingsStore.vpnOnlyEnabled,
            backgroundDownloadsEnabled = settingsStore.backgroundDownloadsEnabled,
            cpuWakeLockEnabled = settingsStore.cpuWakeLockEnabled,
            shutdownOnLowBatteryEnabled = settingsStore.shutdownOnLowBatteryEnabled,
            shutdownOnLowBatteryThreshold = settingsStore.shutdownOnLowBatteryThreshold,
            notificationPermissionGranted = notificationGranted
        )
        // Also refresh UPnP status from engine
        refreshUpnpStatus()
    }

    /**
     * Refresh UPnP status from engine.
     */
    fun refreshUpnpStatus() {
        val upnpInfo = app.engineController?.getUpnpStatus()
        if (upnpInfo != null) {
            _uiState.value = _uiState.value.copy(
                upnpStatus = upnpInfo.status,
                upnpExternalIP = upnpInfo.externalIP,
                upnpPort = upnpInfo.port,
                hasReceivedIncomingConnection = upnpInfo.hasReceivedIncomingConnection
            )
        }
    }

    /**
     * Refresh the list of download roots from storage.
     */
    fun refreshRoots() {
        val roots = rootStore.refreshAvailability()
        _uiState.value = _uiState.value.copy(
            downloadRoots = roots,
            defaultRootKey = configHub.defaultRootKey
        )
    }

    // =========================================================================
    // Storage Settings
    // =========================================================================

    /**
     * Set the default download folder.
     */
    fun setDefaultRoot(key: String) {
        configHub.defaultRootKey = key
        _uiState.value = _uiState.value.copy(defaultRootKey = key)
    }

    /**
     * Remove a download root by key.
     */
    fun removeRoot(key: String) {
        // If removing the default, clear the default
        if (configHub.defaultRootKey == key) {
            val remainingRoots = rootStore.listRoots().filter { it.key != key }
            configHub.defaultRootKey = remainingRoots.firstOrNull()?.key
        }
        rootStore.removeRoot(key)
        refreshRoots()
    }

    // =========================================================================
    // Reset Settings (keeps torrents and folders)
    // =========================================================================

    /**
     * Show the reset settings confirmation dialog.
     */
    fun showResetSettingsConfirmation() {
        _uiState.value = _uiState.value.copy(showResetSettingsConfirmation = true)
    }

    /**
     * Dismiss the reset settings confirmation dialog.
     */
    fun dismissResetSettingsConfirmation() {
        _uiState.value = _uiState.value.copy(showResetSettingsConfirmation = false)
    }

    /**
     * Reset all settings to defaults.
     * Keeps torrents, download folders, and metrics.
     */
    fun resetSettings() {
        // Reset engine settings (bandwidth, connections, protocol, proxy)
        configHub.resetToDefaults()

        // Reset Android-only settings (network restrictions, power management, behavior)
        settingsStore.resetToDefaults()

        // Refresh UI state from stores (now showing defaults)
        refreshAllSettings()

        dismissResetSettingsConfirmation()
    }

    // =========================================================================
    // Clear All Data (full wipe)
    // =========================================================================

    /**
     * Show the clear all data confirmation dialog.
     */
    fun showClearAllDataConfirmation() {
        _uiState.value = _uiState.value.copy(showClearAllDataConfirmation = true)
    }

    /**
     * Dismiss the clear all data confirmation dialog.
     */
    fun dismissClearAllDataConfirmation() {
        _uiState.value = _uiState.value.copy(showClearAllDataConfirmation = false)
    }

    /**
     * Clear all app data (full wipe like reinstall).
     * Removes all torrents, settings, and download folders.
     * Preserves installId and metrics for analytics continuity.
     *
     * @param deleteFiles If true, also delete downloaded files from disk
     */
    fun clearAllData(deleteFiles: Boolean) {
        // 1. Remove all torrents from engine (optionally deleting files)
        val engineState = app.engineController?.state?.value
        val torrents = engineState?.torrents ?: emptyList()
        for (torrent in torrents) {
            app.engineController?.removeTorrent(torrent.infoHash, deleteFiles)
        }

        // 2. Reset all settings to defaults
        configHub.resetToDefaults()
        settingsStore.resetToDefaults()

        // 3. Clear all download folders
        val roots = rootStore.listRoots()
        for (root in roots) {
            rootStore.removeRoot(root.key)
        }

        // 4. Refresh UI state
        refreshAllSettings()

        dismissClearAllDataConfirmation()
    }

    // =========================================================================
    // Bandwidth Settings
    // =========================================================================

    /**
     * Set download speed unlimited flag.
     * AndroidConfigHub handles persistence and JS engine notification.
     */
    fun setDownloadSpeedUnlimited(unlimited: Boolean) {
        configHub.downloadSpeedUnlimited = unlimited
        _uiState.value = _uiState.value.copy(downloadSpeedUnlimited = unlimited)
    }

    /**
     * Set download speed limit value.
     * AndroidConfigHub handles persistence and JS engine notification.
     */
    fun setDownloadSpeedLimit(bytesPerSec: Int) {
        configHub.downloadSpeedLimit = bytesPerSec
        _uiState.value = _uiState.value.copy(downloadSpeedLimit = bytesPerSec)
    }

    /**
     * Set upload speed unlimited flag.
     * AndroidConfigHub handles persistence and JS engine notification.
     */
    fun setUploadSpeedUnlimited(unlimited: Boolean) {
        configHub.uploadSpeedUnlimited = unlimited
        _uiState.value = _uiState.value.copy(uploadSpeedUnlimited = unlimited)
    }

    /**
     * Set upload speed limit value.
     * AndroidConfigHub handles persistence and JS engine notification.
     */
    fun setUploadSpeedLimit(bytesPerSec: Int) {
        configHub.uploadSpeedLimit = bytesPerSec
        _uiState.value = _uiState.value.copy(uploadSpeedLimit = bytesPerSec)
    }

    // =========================================================================
    // Connection Limit Settings
    // =========================================================================

    /**
     * Set maximum peers per torrent.
     */
    fun setMaxPeersPerTorrent(max: Int) {
        configHub.maxPeersPerTorrent = max
        _uiState.value = _uiState.value.copy(maxPeersPerTorrent = max)
    }

    /**
     * Set maximum global peers across all torrents.
     */
    fun setMaxGlobalPeers(max: Int) {
        configHub.maxGlobalPeers = max
        _uiState.value = _uiState.value.copy(maxGlobalPeers = max)
    }

    /**
     * Set maximum upload slots.
     */
    fun setMaxUploadSlots(max: Int) {
        configHub.maxUploadSlots = max
        _uiState.value = _uiState.value.copy(maxUploadSlots = max)
    }

    /**
     * Set maximum pipeline depth.
     */
    fun setMaxPipelineDepth(depth: Int) {
        configHub.maxPipelineDepth = depth
        _uiState.value = _uiState.value.copy(maxPipelineDepth = depth)
    }

    // =========================================================================
    // Queue Settings
    // =========================================================================

    /**
     * Set maximum active downloads.
     */
    fun setActiveDownloads(max: Int) {
        configHub.activeDownloads = max
        _uiState.value = _uiState.value.copy(activeDownloads = max)
    }

    /**
     * Set maximum active seeds.
     */
    fun setActiveSeeds(max: Int) {
        configHub.activeSeeds = max
        _uiState.value = _uiState.value.copy(activeSeeds = max)
    }

    // =========================================================================
    // Behavior Settings
    // =========================================================================

    /**
     * Request to enable keep seeding mode. Shows warning dialog first.
     */
    fun requestEnableKeepSeeding() {
        _uiState.value = _uiState.value.copy(showKeepSeedingWarningDialog = true)
    }

    /**
     * Dismiss the keep seeding warning dialog.
     */
    fun dismissKeepSeedingWarningDialog() {
        _uiState.value = _uiState.value.copy(showKeepSeedingWarningDialog = false)
    }

    /**
     * Confirm enabling keep seeding mode after user acknowledges the warning.
     */
    fun confirmKeepSeeding() {
        settingsStore.whenDownloadsComplete = "keep_seeding"
        _uiState.value = _uiState.value.copy(
            whenDownloadsComplete = "keep_seeding",
            showKeepSeedingWarningDialog = false
        )
    }

    /**
     * Set behavior when downloads complete.
     */
    fun setWhenDownloadsComplete(mode: String) {
        settingsStore.whenDownloadsComplete = mode
        _uiState.value = _uiState.value.copy(whenDownloadsComplete = mode)
    }

    // =========================================================================
    // Network Settings
    // =========================================================================

    /**
     * Set WiFi-only mode.
     * Persists the setting and notifies both Application (for UI) and enforcer (for engine).
     */
    fun setWifiOnly(enabled: Boolean) {
        settingsStore.wifiOnlyEnabled = enabled
        // Update Application's restrictionStatus StateFlow (for UI display)
        app.onNetworkRestrictionSettingChanged()
        // Notify enforcer to suspend/resume engine if running
        app.networkRestrictionEnforcer?.onWifiOnlySettingChanged(enabled)
        _uiState.value = _uiState.value.copy(wifiOnlyEnabled = enabled)
    }

    /**
     * Set VPN-only mode.
     * Persists the setting and notifies both Application (for UI) and enforcer (for engine).
     */
    fun setVpnOnly(enabled: Boolean) {
        settingsStore.vpnOnlyEnabled = enabled
        // Update Application's restrictionStatus StateFlow (for UI display)
        app.onNetworkRestrictionSettingChanged()
        // Notify enforcer to suspend/resume engine if running
        app.networkRestrictionEnforcer?.onVpnOnlySettingChanged(enabled)
        _uiState.value = _uiState.value.copy(vpnOnlyEnabled = enabled)
    }

    /**
     * Set DHT enabled state.
     */
    fun setDhtEnabled(enabled: Boolean) {
        configHub.dhtEnabled = enabled
        _uiState.value = _uiState.value.copy(dhtEnabled = enabled)
    }

    /**
     * Set PEX enabled state.
     */
    fun setPexEnabled(enabled: Boolean) {
        configHub.pexEnabled = enabled
        _uiState.value = _uiState.value.copy(pexEnabled = enabled)
    }

    /**
     * Set UPnP enabled state.
     */
    fun setUpnpEnabled(enabled: Boolean) {
        configHub.upnpEnabled = enabled
        _uiState.value = _uiState.value.copy(upnpEnabled = enabled)
        // Status will be updated via refreshUpnpStatus when status changes
    }

    /**
     * Set encryption policy.
     */
    fun setEncryptionPolicy(policy: String) {
        configHub.encryptionPolicy = policy
        _uiState.value = _uiState.value.copy(encryptionPolicy = policy)
    }

    // =========================================================================
    // SOCKS5 Proxy Settings
    // =========================================================================

    /**
     * Show the proxy configuration dialog.
     */
    fun showProxyDialog() {
        _uiState.value = _uiState.value.copy(showProxyDialog = true)
    }

    /**
     * Dismiss the proxy configuration dialog.
     */
    fun dismissProxyDialog() {
        _uiState.value = _uiState.value.copy(showProxyDialog = false)
    }

    /**
     * Set proxy enabled state.
     */
    fun setProxyEnabled(enabled: Boolean) {
        configHub.proxyEnabled = enabled
        _uiState.value = _uiState.value.copy(proxyEnabled = enabled)
    }

    /**
     * Save proxy configuration.
     * Uses batch update for efficiency - single JS notification for all changes.
     * @param host Proxy host
     * @param port Proxy port
     * @param username Optional username
     * @param password Optional password
     * @param httpTrackers Route HTTP trackers through proxy
     * @param udpTrackers Route UDP trackers through proxy
     * @param peerConnections Route peer connections through proxy
     */
    fun saveProxyConfig(
        host: String,
        port: Int,
        username: String?,
        password: String?,
        httpTrackers: Boolean,
        udpTrackers: Boolean,
        peerConnections: Boolean
    ) {
        val hostValue = host.ifBlank { null }
        val usernameValue = username?.ifBlank { null }
        val passwordValue = password?.ifBlank { null }

        // Use batch update for efficiency
        configHub.batch(mapOf(
            "proxyHost" to hostValue,
            "proxyPort" to port,
            "proxyUsername" to usernameValue,
            "proxyPassword" to passwordValue,
            "proxyHttpTrackers" to httpTrackers,
            "proxyUdpTrackers" to udpTrackers,
            "proxyPeerConnections" to peerConnections
        ))

        _uiState.value = _uiState.value.copy(
            proxyHost = hostValue,
            proxyPort = port,
            proxyUsername = usernameValue,
            proxyPassword = passwordValue,
            proxyHttpTrackers = httpTrackers,
            proxyUdpTrackers = udpTrackers,
            proxyPeerConnections = peerConnections,
            showProxyDialog = false
        )
    }

    // =========================================================================
    // Power Management Settings
    // =========================================================================

    /**
     * Set background downloads enabled.
     * Requires notification permission - if not granted, shows the permission required dialog.
     */
    fun setBackgroundDownloadsEnabled(enabled: Boolean) {
        if (enabled && !_uiState.value.notificationPermissionGranted) {
            // Can't enable without notification permission - show dialog
            _uiState.value = _uiState.value.copy(showNotificationRequiredDialog = true)
            return
        }

        settingsStore.backgroundDownloadsEnabled = enabled
        _uiState.value = _uiState.value.copy(backgroundDownloadsEnabled = enabled)
    }

    /**
     * Set CPU wake lock enabled.
     * Notifies running service to acquire/release wake lock.
     */
    fun setCpuWakeLockEnabled(enabled: Boolean) {
        settingsStore.cpuWakeLockEnabled = enabled
        ForegroundNotificationService.instance?.setCpuWakeLockEnabled(enabled)
        _uiState.value = _uiState.value.copy(cpuWakeLockEnabled = enabled)
    }

    /**
     * Set shutdown on low battery enabled.
     * Notifies running service to start/stop battery monitoring.
     */
    fun setShutdownOnLowBatteryEnabled(enabled: Boolean) {
        settingsStore.shutdownOnLowBatteryEnabled = enabled
        ForegroundNotificationService.instance?.setShutdownOnLowBatteryEnabled(enabled)
        _uiState.value = _uiState.value.copy(shutdownOnLowBatteryEnabled = enabled)
    }

    /**
     * Set shutdown on low battery threshold (5-50%).
     */
    fun setShutdownOnLowBatteryThreshold(threshold: Int) {
        val clampedThreshold = threshold.coerceIn(5, 50)
        settingsStore.shutdownOnLowBatteryThreshold = clampedThreshold
        ForegroundNotificationService.instance?.setShutdownOnLowBatteryThreshold(clampedThreshold)
        _uiState.value = _uiState.value.copy(shutdownOnLowBatteryThreshold = clampedThreshold)
    }

    /**
     * Dismiss the notification required dialog.
     */
    fun dismissNotificationRequiredDialog() {
        _uiState.value = _uiState.value.copy(showNotificationRequiredDialog = false)
    }

    // =========================================================================
    // Notification Settings
    // =========================================================================

    /**
     * Update notification permission state.
     * Also disables background downloads if permission is revoked.
     */
    fun updateNotificationPermissionState(granted: Boolean, canRequest: Boolean) {
        // If permission was revoked and background downloads was enabled, disable it
        val backgroundEnabled = if (!granted && settingsStore.backgroundDownloadsEnabled) {
            settingsStore.backgroundDownloadsEnabled = false
            false
        } else {
            settingsStore.backgroundDownloadsEnabled
        }

        _uiState.value = _uiState.value.copy(
            notificationPermissionGranted = granted,
            canRequestNotificationPermission = canRequest,
            backgroundDownloadsEnabled = backgroundEnabled
        )
    }

    /**
     * Factory for creating SettingsViewModel with dependencies.
     */
    class Factory(
        private val context: Context
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            if (modelClass.isAssignableFrom(SettingsViewModel::class.java)) {
                val app = context.applicationContext as JSTorrentApplication

                // Check notification permission upfront to avoid UI flicker
                val notificationGranted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    ContextCompat.checkSelfPermission(
                        context,
                        Manifest.permission.POST_NOTIFICATIONS
                    ) == PermissionChecker.PERMISSION_GRANTED
                } else {
                    true
                }

                // Get or create the shared AndroidConfigHub
                val configHub = app.getConfigHub()

                return SettingsViewModel(
                    app,
                    RootStore(context),
                    app.settingsStore,  // Use shared instance from Application
                    configHub,
                    notificationGranted
                ) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
    }
}
