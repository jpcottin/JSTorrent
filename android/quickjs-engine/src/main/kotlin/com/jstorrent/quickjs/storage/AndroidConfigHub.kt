package com.jstorrent.quickjs.storage

import android.util.Log
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.asSharedFlow
import org.json.JSONArray

private const val TAG = "AndroidConfigHub"
private const val CONFIG_PREFIX = "config:"

/**
 * Configuration change event emitted when any setting changes.
 */
data class ConfigChangeEvent(
    val key: String,
    val value: Any?,
    val oldValue: Any?
)

/**
 * Android ConfigHub - unified configuration management for Kotlin and JS engine.
 *
 * This class mirrors the TypeScript BaseConfigHub pattern:
 * - Single point for reading/writing config values
 * - Automatic persistence to SQLite
 * - Automatic notification to JS engine (when connected)
 * - Kotlin Flow-based subscriptions for UI updates
 *
 * Usage:
 * ```kotlin
 * val configHub = AndroidConfigHub(store) { engineController?.configBridge }
 *
 * // Setting a value handles persistence + JS notification automatically
 * configHub.downloadSpeedLimit = 1048576
 *
 * // Or use the generic setter
 * configHub.set("downloadSpeedLimit", 1048576)
 *
 * // Subscribe to changes for UI updates
 * scope.launch {
 *     configHub.changes.collect { event ->
 *         updateUi(event.key, event.value)
 *     }
 * }
 * ```
 */
class AndroidConfigHub(
    private val store: SqliteKVStore,
    private val configBridgeProvider: () -> ConfigBridgeInterface?
) {
    /**
     * Flow of config change events for UI subscriptions.
     */
    private val _changes = MutableSharedFlow<ConfigChangeEvent>(extraBufferCapacity = 16)
    val changes: SharedFlow<ConfigChangeEvent> = _changes.asSharedFlow()

    // =========================================================================
    // Rate Limiting
    // =========================================================================

    var downloadSpeedUnlimited: Boolean
        get() = getBoolean("downloadSpeedUnlimited", true)
        set(value) = set("downloadSpeedUnlimited", value)

    var downloadSpeedLimit: Int
        get() = getInt("downloadSpeedLimit", 1048576)
        set(value) = set("downloadSpeedLimit", value)

    var uploadSpeedUnlimited: Boolean
        get() = getBoolean("uploadSpeedUnlimited", true)
        set(value) = set("uploadSpeedUnlimited", value)

    var uploadSpeedLimit: Int
        get() = getInt("uploadSpeedLimit", 1048576)
        set(value) = set("uploadSpeedLimit", value)

    // =========================================================================
    // Connection Limits
    // =========================================================================

    var maxPeersPerTorrent: Int
        get() = getInt("maxPeersPerTorrent", 20)
        set(value) = set("maxPeersPerTorrent", value)

    var maxGlobalPeers: Int
        get() = getInt("maxGlobalPeers", 200)
        set(value) = set("maxGlobalPeers", value)

    var maxUploadSlots: Int
        get() = getInt("maxUploadSlots", 4)
        set(value) = set("maxUploadSlots", value)

    var maxPipelineDepth: Int
        get() = getInt("maxPipelineDepth", DEFAULT_MAX_PIPELINE_DEPTH)
        set(value) = set("maxPipelineDepth", value)

    // =========================================================================
    // Protocol
    // =========================================================================

    var encryptionPolicy: String
        get() = getString("encryptionPolicy", "allow") ?: "allow"
        set(value) = set("encryptionPolicy", value)

    var dhtEnabled: Boolean
        get() = getBoolean("dhtEnabled", true)
        set(value) = set("dhtEnabled", value)

    var pexEnabled: Boolean
        get() = getBoolean("pexEnabled", true)
        set(value) = set("pexEnabled", value)

    var upnpEnabled: Boolean
        get() = getBoolean("upnpEnabled", true)
        set(value) = set("upnpEnabled", value)

    // =========================================================================
    // Proxy
    // =========================================================================

    var proxyEnabled: Boolean
        get() = getBoolean("proxyEnabled", false)
        set(value) = set("proxyEnabled", value)

    var proxyHost: String?
        get() = getString("proxyHost", null)
        set(value) = set("proxyHost", value)

    var proxyPort: Int
        get() = getInt("proxyPort", 1080)
        set(value) = set("proxyPort", value)

    var proxyUsername: String?
        get() = getString("proxyUsername", null)
        set(value) = set("proxyUsername", value)

    var proxyPassword: String?
        get() = getString("proxyPassword", null)
        set(value) = set("proxyPassword", value)

    var proxyHttpTrackers: Boolean
        get() = getBoolean("proxyHttpTrackers", true)
        set(value) = set("proxyHttpTrackers", value)

    var proxyUdpTrackers: Boolean
        get() = getBoolean("proxyUdpTrackers", true)
        set(value) = set("proxyUdpTrackers", value)

    var proxyPeerConnections: Boolean
        get() = getBoolean("proxyPeerConnections", true)
        set(value) = set("proxyPeerConnections", value)

    // =========================================================================
    // Storage
    // =========================================================================

    var defaultRootKey: String?
        get() = getString("defaultRootKey", null)
        set(value) = set("defaultRootKey", value)

    // =========================================================================
    // Generic Accessors
    // =========================================================================

    /**
     * Set a config value by key.
     * Handles: persistence to SQLite, notification to JS engine, emission to Kotlin subscribers.
     */
    fun set(key: String, value: Any?) {
        val oldValue = getRaw(key)

        // 1. Persist to SQLite
        persistValue(key, value)

        // 2. Notify JS engine (if running)
        notifyJsEngine(key, value)

        // 3. Emit change event for Kotlin subscribers
        _changes.tryEmit(ConfigChangeEvent(key, value, oldValue))

        Log.d(TAG, "Set $key = $value (was: $oldValue)")
    }

    /**
     * Set multiple config values at once.
     * More efficient than individual sets when updating related values.
     */
    fun batch(updates: Map<String, Any?>) {
        val events = mutableListOf<ConfigChangeEvent>()

        for ((key, value) in updates) {
            val oldValue = getRaw(key)
            persistValue(key, value)
            events.add(ConfigChangeEvent(key, value, oldValue))
        }

        // Batch notify JS engine
        val jsUpdates = updates.filterValues { it != null }
        if (jsUpdates.isNotEmpty()) {
            configBridgeProvider()?.batchUpdate(jsUpdates.mapValues { it.value!! })
        }

        // Emit all change events
        for (event in events) {
            _changes.tryEmit(event)
        }

        Log.d(TAG, "Batch set ${updates.keys.joinToString()}")
    }

    // =========================================================================
    // Private Helpers - Persistence
    // =========================================================================

    private fun persistValue(key: String, value: Any?) {
        val storageKey = CONFIG_PREFIX + key
        when (value) {
            null -> store.set(storageKey, "null")
            is Boolean -> store.set(storageKey, value.toString())
            is Int -> store.set(storageKey, value.toString())
            is Long -> store.set(storageKey, value.toString())
            is Double -> store.set(storageKey, value.toString())
            is String -> {
                // Properly JSON encode the string (handles quotes, backslashes, etc.)
                val encoded = JSONArray().put(value).toString().let {
                    it.substring(1, it.length - 1) // Strip the [] wrapper
                }
                store.set(storageKey, encoded)
            }
            else -> {
                Log.w(TAG, "Unknown value type for $key: ${value::class.java}")
                store.set(storageKey, value.toString())
            }
        }
    }

    private fun getRaw(key: String): Any? {
        val json = store.get(CONFIG_PREFIX + key) ?: return null
        return try {
            when {
                json == "null" -> null
                json == "true" -> true
                json == "false" -> false
                json.toIntOrNull() != null -> json.toInt()
                json.toLongOrNull() != null -> json.toLong()
                json.toDoubleOrNull() != null -> json.toDouble()
                json.startsWith("\"") -> JSONArray("[$json]").getString(0)
                else -> json
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to parse $key: $json", e)
            null
        }
    }

    private fun getBoolean(key: String, default: Boolean): Boolean {
        val json = store.get(CONFIG_PREFIX + key) ?: return default
        return try {
            json == "true"
        } catch (e: Exception) {
            default
        }
    }

    private fun getInt(key: String, default: Int): Int {
        val json = store.get(CONFIG_PREFIX + key) ?: return default
        return try {
            json.toInt()
        } catch (e: Exception) {
            default
        }
    }

    private fun getString(key: String, default: String?): String? {
        val json = store.get(CONFIG_PREFIX + key) ?: return default
        return try {
            when {
                json == "null" -> null
                json.startsWith("\"") -> JSONArray("[$json]").getString(0)
                else -> json // Legacy unquoted value
            }
        } catch (e: Exception) {
            default
        }
    }

    // =========================================================================
    // Private Helpers - JS Engine Notification
    // =========================================================================

    private fun notifyJsEngine(key: String, value: Any?) {
        val bridge = configBridgeProvider() ?: return

        // Handle special cases where ConfigBridge has custom logic
        when (key) {
            "downloadSpeedUnlimited", "downloadSpeedLimit" -> {
                // ConfigBridge.setDownloadSpeedLimit expects combined logic
                val unlimited = if (key == "downloadSpeedUnlimited") value as Boolean else downloadSpeedUnlimited
                val limit = if (key == "downloadSpeedLimit") value as Int else downloadSpeedLimit
                val effectiveLimit = if (unlimited) 0 else limit
                bridge.setDownloadSpeedLimit(effectiveLimit)
            }
            "uploadSpeedUnlimited", "uploadSpeedLimit" -> {
                val unlimited = if (key == "uploadSpeedUnlimited") value as Boolean else uploadSpeedUnlimited
                val limit = if (key == "uploadSpeedLimit") value as Int else uploadSpeedLimit
                val effectiveLimit = if (unlimited) 0 else limit
                bridge.setUploadSpeedLimit(effectiveLimit)
            }
            "maxPeersPerTorrent" -> bridge.setMaxPeersPerTorrent(value as Int)
            "maxGlobalPeers" -> bridge.setMaxGlobalPeers(value as Int)
            "maxUploadSlots" -> bridge.setMaxUploadSlots(value as Int)
            "maxPipelineDepth" -> bridge.setMaxPipelineDepth(value as Int)
            "encryptionPolicy" -> bridge.setEncryptionPolicy(value as String)
            "dhtEnabled" -> bridge.setDhtEnabled(value as Boolean)
            "pexEnabled" -> bridge.setPexEnabled(value as Boolean)
            "upnpEnabled" -> bridge.setUpnpEnabled(value as Boolean)
            "proxyEnabled" -> bridge.setProxyEnabled(value as Boolean)
            "proxyHost" -> if (value != null) bridge.setProxyHost(value as String)
            "proxyPort" -> bridge.setProxyPort(value as Int)
            "proxyUsername" -> if (value != null) bridge.setProxyUsername(value as String)
            "proxyPassword" -> if (value != null) bridge.setProxyPassword(value as String)
            "proxyHttpTrackers" -> bridge.setProxyHttpTrackers(value as Boolean)
            "proxyUdpTrackers" -> bridge.setProxyUdpTrackers(value as Boolean)
            "proxyPeerConnections" -> bridge.setProxyPeerConnections(value as Boolean)
            // defaultRootKey is handled separately via syncRoots
            "defaultRootKey" -> { /* No-op, handled by RootStore */ }
            else -> Log.w(TAG, "No JS notification handler for key: $key")
        }
    }

    companion object {
        /** Default max pipeline depth - must match DEFAULT_MAX_PIPELINE_DEPTH in config-schema.ts */
        const val DEFAULT_MAX_PIPELINE_DEPTH = 500
    }
}

/**
 * Interface for ConfigBridge to avoid circular dependency.
 * ConfigBridge implements this interface.
 */
interface ConfigBridgeInterface {
    fun setDownloadSpeedLimit(bytesPerSec: Int)
    fun setUploadSpeedLimit(bytesPerSec: Int)
    fun setMaxPeersPerTorrent(max: Int)
    fun setMaxGlobalPeers(max: Int)
    fun setMaxUploadSlots(max: Int)
    fun setMaxPipelineDepth(depth: Int)
    fun setEncryptionPolicy(policy: String)
    fun setDhtEnabled(enabled: Boolean)
    fun setPexEnabled(enabled: Boolean)
    fun setUpnpEnabled(enabled: Boolean)
    fun setProxyEnabled(enabled: Boolean)
    fun setProxyHost(host: String?)
    fun setProxyPort(port: Int)
    fun setProxyUsername(username: String?)
    fun setProxyPassword(password: String?)
    fun setProxyHttpTrackers(enabled: Boolean)
    fun setProxyUdpTrackers(enabled: Boolean)
    fun setProxyPeerConnections(enabled: Boolean)
    fun batchUpdate(updates: Map<String, Any>)
}
