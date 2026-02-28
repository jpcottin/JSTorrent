package com.jstorrent.app.network

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Monitors network connectivity and type changes.
 * Exposes unmetered connectivity state as a StateFlow for WiFi-only mode.
 */
class NetworkMonitor(private val context: Context) {

    companion object {
        private const val TAG = "NetworkMonitor"
    }

    private val connectivityManager = context.getSystemService(Context.CONNECTIVITY_SERVICE)
        as ConnectivityManager

    private val _isUnmetered = MutableStateFlow(checkCurrentUnmeteredState())
    val isUnmetered: StateFlow<Boolean> = _isUnmetered.asStateFlow()

    private val _isVpnConnected = MutableStateFlow(checkCurrentVpnState())
    val isVpnConnected: StateFlow<Boolean> = _isVpnConnected.asStateFlow()

    private val _isConnected = MutableStateFlow(checkCurrentConnectionState())
    val isConnected: StateFlow<Boolean> = _isConnected.asStateFlow()

    /**
     * Whether Data Saver is enabled AND the app is NOT whitelisted.
     * When true, Android may restrict background data usage which can stall downloads.
     */
    private val _isDataSaverRestricted = MutableStateFlow(checkDataSaverState())
    val isDataSaverRestricted: StateFlow<Boolean> = _isDataSaverRestricted.asStateFlow()

    private var networkCallback: ConnectivityManager.NetworkCallback? = null
    private var dataSaverReceiver: BroadcastReceiver? = null

    /**
     * Start monitoring network changes.
     */
    fun start() {
        if (networkCallback != null) {
            Log.w(TAG, "NetworkMonitor already started")
            return
        }

        val callback = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                Log.d(TAG, "Network available: $network")
                updateNetworkState()
            }

            override fun onLost(network: Network) {
                Log.d(TAG, "Network lost: $network")
                updateNetworkState()
            }

            override fun onCapabilitiesChanged(
                network: Network,
                networkCapabilities: NetworkCapabilities
            ) {
                Log.d(TAG, "Network capabilities changed")
                updateNetworkState()
            }
        }

        val request = NetworkRequest.Builder()
            .addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
            .build()

        connectivityManager.registerNetworkCallback(request, callback)
        networkCallback = callback

        // Register for Data Saver changes
        val receiver = object : BroadcastReceiver() {
            override fun onReceive(context: Context, intent: Intent) {
                Log.d(TAG, "Data Saver state changed")
                _isDataSaverRestricted.value = checkDataSaverState()
            }
        }
        context.registerReceiver(
            receiver,
            IntentFilter(ConnectivityManager.ACTION_RESTRICT_BACKGROUND_CHANGED)
        )
        dataSaverReceiver = receiver

        // Update initial state
        updateNetworkState()
        Log.i(TAG, "NetworkMonitor started, unmetered=${_isUnmetered.value}, dataSaverRestricted=${_isDataSaverRestricted.value}")
    }

    /**
     * Stop monitoring network changes.
     */
    fun stop() {
        networkCallback?.let { callback ->
            try {
                connectivityManager.unregisterNetworkCallback(callback)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to unregister network callback", e)
            }
            networkCallback = null
        }
        dataSaverReceiver?.let { receiver ->
            try {
                context.unregisterReceiver(receiver)
            } catch (e: Exception) {
                Log.w(TAG, "Failed to unregister data saver receiver", e)
            }
            dataSaverReceiver = null
        }
        Log.i(TAG, "NetworkMonitor stopped")
    }

    private fun updateNetworkState() {
        _isUnmetered.value = checkCurrentUnmeteredState()
        _isVpnConnected.value = checkCurrentVpnState()
        _isConnected.value = checkCurrentConnectionState()
        Log.d(TAG, "Network state updated: unmetered=${_isUnmetered.value}, vpn=${_isVpnConnected.value}, connected=${_isConnected.value}")
    }

    private fun checkCurrentUnmeteredState(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_METERED)
    }

    private fun checkCurrentVpnState(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasTransport(NetworkCapabilities.TRANSPORT_VPN)
    }

    private fun checkCurrentConnectionState(): Boolean {
        val network = connectivityManager.activeNetwork ?: return false
        val capabilities = connectivityManager.getNetworkCapabilities(network) ?: return false
        return capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }

    /**
     * Check if Data Saver is enabled and the app is NOT whitelisted.
     * Returns true when the app's background data is restricted.
     */
    private fun checkDataSaverState(): Boolean {
        return connectivityManager.restrictBackgroundStatus ==
            ConnectivityManager.RESTRICT_BACKGROUND_STATUS_ENABLED
    }
}
