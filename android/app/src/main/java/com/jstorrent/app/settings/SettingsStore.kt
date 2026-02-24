package com.jstorrent.app.settings

import android.content.Context
import android.content.SharedPreferences
import androidx.core.content.edit

/**
 * Persists Android-only settings in SharedPreferences.
 *
 * These are settings specific to the Android standalone app that don't apply
 * to the extension (power management, network restrictions, etc.).
 *
 * Engine settings (speed limits, DHT, proxy, etc.) are stored in the SQLite
 * KV store alongside session data, so they can be shared with the extension.
 */
class SettingsStore(context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(
        PREFS_NAME,
        Context.MODE_PRIVATE
    )

    // =========================================================================
    // Network Restrictions (Android-only)
    // =========================================================================

    /**
     * Whether to only download on WiFi (pause on cellular).
     */
    var wifiOnlyEnabled: Boolean
        get() = prefs.getBoolean(KEY_WIFI_ONLY_ENABLED, false)
        set(value) = prefs.edit { putBoolean(KEY_WIFI_ONLY_ENABLED, value) }

    /**
     * Whether to only download when connected to a VPN.
     */
    var vpnOnlyEnabled: Boolean
        get() = prefs.getBoolean(KEY_VPN_ONLY_ENABLED, false)
        set(value) = prefs.edit { putBoolean(KEY_VPN_ONLY_ENABLED, value) }

    // =========================================================================
    // Power Management (Android-only)
    // =========================================================================

    /**
     * Whether to continue downloads in the background when the app is closed.
     * OFF by default - user must opt-in. Requires notification permission.
     */
    var backgroundDownloadsEnabled: Boolean
        get() = prefs.getBoolean(KEY_BACKGROUND_DOWNLOADS_ENABLED, false)
        set(value) = prefs.edit { putBoolean(KEY_BACKGROUND_DOWNLOADS_ENABLED, value) }

    /**
     * Whether to hold a CPU wake lock during downloads to prevent deep sleep.
     * OFF by default - increases battery usage but ensures downloads complete.
     */
    var cpuWakeLockEnabled: Boolean
        get() = prefs.getBoolean(KEY_CPU_WAKE_LOCK_ENABLED, false)
        set(value) = prefs.edit { putBoolean(KEY_CPU_WAKE_LOCK_ENABLED, value) }

    /**
     * Whether to automatically shutdown when battery drops below threshold.
     * OFF by default.
     */
    var shutdownOnLowBatteryEnabled: Boolean
        get() = prefs.getBoolean(KEY_SHUTDOWN_LOW_BATTERY_ENABLED, false)
        set(value) = prefs.edit { putBoolean(KEY_SHUTDOWN_LOW_BATTERY_ENABLED, value) }

    /**
     * Battery percentage threshold for shutdown (5-50%).
     * Default is 15%.
     */
    var shutdownOnLowBatteryThreshold: Int
        get() = prefs.getInt(KEY_SHUTDOWN_LOW_BATTERY_THRESHOLD, 15)
        set(value) = prefs.edit { putInt(KEY_SHUTDOWN_LOW_BATTERY_THRESHOLD, value.coerceIn(5, 50)) }

    // =========================================================================
    // Standalone Behavior (Android-only)
    // =========================================================================

    /**
     * Behavior when downloads complete: "stop_and_close" or "keep_seeding".
     */
    var whenDownloadsComplete: String
        get() = prefs.getString(KEY_WHEN_DOWNLOADS_COMPLETE, "stop_and_close") ?: "stop_and_close"
        set(value) = prefs.edit { putString(KEY_WHEN_DOWNLOADS_COMPLETE, value) }

    // =========================================================================
    // Language (Android-only)
    // =========================================================================

    /**
     * BCP 47 language tag for the app locale (e.g. "de", "zh-CN").
     * Empty string means use system default.
     */
    var appLocale: String
        get() = prefs.getString(KEY_APP_LOCALE, "") ?: ""
        set(value) = prefs.edit { putString(KEY_APP_LOCALE, value) }

    // =========================================================================
    // UI State (Android-only)
    // =========================================================================

    /**
     * Whether we've shown the notification permission prompt (first launch only).
     */
    var hasShownNotificationPrompt: Boolean
        get() = prefs.getBoolean(KEY_HAS_SHOWN_NOTIFICATION_PROMPT, false)
        set(value) = prefs.edit { putBoolean(KEY_HAS_SHOWN_NOTIFICATION_PROMPT, value) }

    /**
     * Reset all settings to defaults.
     * Preserves hasShownNotificationPrompt to avoid re-showing first-launch prompts.
     */
    fun resetToDefaults() {
        val preserveNotificationPrompt = hasShownNotificationPrompt
        val preserveLocale = appLocale
        prefs.edit { clear() }
        if (preserveNotificationPrompt) {
            hasShownNotificationPrompt = true
        }
        if (preserveLocale.isNotEmpty()) {
            appLocale = preserveLocale
        }
    }

    companion object {
        private const val PREFS_NAME = "jstorrent_settings"

        // Network restrictions
        private const val KEY_WIFI_ONLY_ENABLED = "wifi_only_enabled"
        private const val KEY_VPN_ONLY_ENABLED = "vpn_only_enabled"

        // Power management
        private const val KEY_BACKGROUND_DOWNLOADS_ENABLED = "background_downloads_enabled"
        private const val KEY_CPU_WAKE_LOCK_ENABLED = "cpu_wake_lock_enabled"
        private const val KEY_SHUTDOWN_LOW_BATTERY_ENABLED = "shutdown_low_battery_enabled"
        private const val KEY_SHUTDOWN_LOW_BATTERY_THRESHOLD = "shutdown_low_battery_threshold"

        // Standalone behavior
        private const val KEY_WHEN_DOWNLOADS_COMPLETE = "when_downloads_complete"

        // Language
        private const val KEY_APP_LOCALE = "app_locale"

        // UI state
        private const val KEY_HAS_SHOWN_NOTIFICATION_PROMPT = "has_shown_notification_prompt"
    }
}
