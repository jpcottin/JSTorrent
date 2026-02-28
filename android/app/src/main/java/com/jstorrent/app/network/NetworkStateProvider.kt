package com.jstorrent.app.network

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.StateFlow

private const val TAG = "NetworkStateProvider"

/**
 * Provides low-level network state monitoring via StateFlows.
 *
 * This is a singleton that exposes reactive network state (WiFi, VPN, connectivity).
 * It does NOT contain business logic for network restrictions (WiFi-only, VPN-only) -
 * that logic lives in NetworkRestrictionEnforcer.
 *
 * Used by:
 * - NetworkRestrictionEnforcer: For monitoring and enforcing network restrictions
 */
class NetworkStateProvider(context: Context) {

    private val networkMonitor = NetworkMonitor(context)

    /**
     * Whether the current network is unmetered (WiFi, Ethernet, etc.).
     * Used by the "WiFi only" setting to block downloads on metered connections.
     */
    val isUnmetered: StateFlow<Boolean> = networkMonitor.isUnmetered

    /**
     * Whether VPN is currently connected.
     */
    val isVpnConnected: StateFlow<Boolean> = networkMonitor.isVpnConnected

    /**
     * Whether the device has any internet connection.
     */
    val isConnected: StateFlow<Boolean> = networkMonitor.isConnected

    /**
     * Whether Data Saver is enabled and the app is NOT whitelisted.
     * When true, Android restricts background data which can stall torrent downloads.
     */
    val isDataSaverRestricted: StateFlow<Boolean> = networkMonitor.isDataSaverRestricted

    init {
        // Start monitoring immediately
        networkMonitor.start()
        Log.i(TAG, "NetworkStateProvider initialized, unmetered=${isUnmetered.value}, VPN=${isVpnConnected.value}")
    }

    companion object {
        @Volatile
        private var instance: NetworkStateProvider? = null

        /**
         * Initialize the singleton instance.
         * Should be called from Application.onCreate().
         */
        fun initialize(context: Context) {
            if (instance == null) {
                synchronized(this) {
                    if (instance == null) {
                        instance = NetworkStateProvider(context.applicationContext)
                    }
                }
            }
        }

        /**
         * Get the singleton instance.
         * Throws if not initialized.
         */
        fun getInstance(): NetworkStateProvider {
            return instance ?: throw IllegalStateException(
                "NetworkStateProvider not initialized. Call initialize() first."
            )
        }

        /**
         * Get the singleton instance, or null if not initialized.
         */
        fun getInstanceOrNull(): NetworkStateProvider? = instance
    }
}
