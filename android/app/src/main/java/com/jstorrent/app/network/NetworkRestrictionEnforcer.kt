package com.jstorrent.app.network

import android.util.Log
import com.jstorrent.app.settings.SettingsStore
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.launch

private const val TAG = "NetworkRestrictionEnforcer"

/**
 * Enforces network restriction policies (WiFi-only, VPN-only) on the engine.
 *
 * This class is responsible for:
 * - Monitoring network state changes via NetworkStateProvider
 * - Reading policy settings from SettingsStore
 * - Calling suspend/resume on the engine when network conditions change
 *
 * Lifecycle: Created when engine starts, destroyed when engine stops.
 * Lives in JSTorrentApplication, not in ForegroundNotificationService.
 *
 * This ensures network restrictions work regardless of whether the foreground
 * service is running (foreground service only runs when app is backgrounded).
 */
class NetworkRestrictionEnforcer(
    private val settingsStore: SettingsStore,
    private val networkStateProvider: NetworkStateProvider,
    private val scope: CoroutineScope,
    private val onSuspend: suspend () -> Unit,
    private val onResume: suspend () -> Unit
) {
    /**
     * Current restriction status.
     * - "waiting_wifi": WiFi-only enabled but not on WiFi
     * - "waiting_vpn": VPN-only enabled but not on VPN
     * - null: No restrictions active, downloads allowed
     */
    private val _restrictionStatus = MutableStateFlow<String?>(null)
    val restrictionStatus: StateFlow<String?> = _restrictionStatus.asStateFlow()

    private var monitorJob: Job? = null

    // Track whether we suspended the engine, to avoid resuming if we didn't suspend
    private var didSuspend = false

    /**
     * Start monitoring network state and enforcing restrictions.
     * Call this when the engine starts.
     */
    fun start() {
        if (monitorJob != null) {
            Log.w(TAG, "Already started")
            return
        }

        Log.i(TAG, "Starting network restriction enforcement")

        // Check initial state immediately
        updateRestrictionState(
            isWifi = networkStateProvider.isWifiConnected.value,
            isVpn = networkStateProvider.isVpnConnected.value
        )

        // Monitor ongoing changes
        monitorJob = scope.launch {
            combine(
                networkStateProvider.isWifiConnected,
                networkStateProvider.isVpnConnected
            ) { isWifi, isVpn ->
                Pair(isWifi, isVpn)
            }.collect { (isWifi, isVpn) ->
                updateRestrictionState(isWifi, isVpn)
            }
        }
    }

    /**
     * Stop monitoring. Call this when the engine stops.
     */
    fun stop() {
        monitorJob?.cancel()
        monitorJob = null
        _restrictionStatus.value = null
        didSuspend = false
        Log.i(TAG, "Stopped network restriction enforcement")
    }

    /**
     * Called when WiFi-only setting changes.
     * Re-evaluates current state with new setting.
     */
    fun onWifiOnlySettingChanged(enabled: Boolean) {
        Log.i(TAG, "WiFi-only setting changed: $enabled")
        updateRestrictionState(
            isWifi = networkStateProvider.isWifiConnected.value,
            isVpn = networkStateProvider.isVpnConnected.value
        )
    }

    /**
     * Called when VPN-only setting changes.
     * Re-evaluates current state with new setting.
     */
    fun onVpnOnlySettingChanged(enabled: Boolean) {
        Log.i(TAG, "VPN-only setting changed: $enabled")
        updateRestrictionState(
            isWifi = networkStateProvider.isWifiConnected.value,
            isVpn = networkStateProvider.isVpnConnected.value
        )
    }

    /**
     * Compute what restriction should be active and apply it.
     */
    private fun updateRestrictionState(isWifi: Boolean, isVpn: Boolean) {
        val newStatus = computeRestrictionStatus(isWifi, isVpn)
        val oldStatus = _restrictionStatus.value

        if (newStatus == oldStatus) return

        Log.i(TAG, "Restriction status changing: $oldStatus -> $newStatus (wifi=$isWifi, vpn=$isVpn)")
        _restrictionStatus.value = newStatus

        // Apply the restriction
        scope.launch {
            if (newStatus != null && oldStatus == null) {
                // Transitioning to restricted state - suspend engine
                Log.i(TAG, "Suspending engine due to: $newStatus")
                didSuspend = true
                onSuspend()
            } else if (newStatus == null && oldStatus != null) {
                // Transitioning to unrestricted state - resume engine (only if we suspended it)
                if (didSuspend) {
                    Log.i(TAG, "Resuming engine - network conditions met")
                    onResume()
                    didSuspend = false
                }
            }
            // If transitioning between restriction types (wifi -> vpn), engine stays suspended
        }
    }

    /**
     * Compute the restriction status based on current network state and settings.
     *
     * Priority: WiFi check first, then VPN check.
     * If both are enabled and neither condition is met, WiFi status is returned.
     */
    private fun computeRestrictionStatus(isWifi: Boolean, isVpn: Boolean): String? {
        if (settingsStore.wifiOnlyEnabled && !isWifi) {
            return "waiting_wifi"
        }
        if (settingsStore.vpnOnlyEnabled && !isVpn) {
            return "waiting_vpn"
        }
        return null
    }

    /**
     * Check if downloads should currently be blocked.
     * Used for initial engine startup decision.
     */
    fun shouldBlockDownloads(): Boolean {
        return computeRestrictionStatus(
            isWifi = networkStateProvider.isWifiConnected.value,
            isVpn = networkStateProvider.isVpnConnected.value
        ) != null
    }

    /**
     * Get the current restriction status for display purposes.
     * Returns "waiting_wifi", "waiting_vpn", or null.
     */
    fun getRestrictionStatus(): String? = _restrictionStatus.value
}
