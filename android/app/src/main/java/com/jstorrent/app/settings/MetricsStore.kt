package com.jstorrent.app.settings

import android.content.Context
import android.content.SharedPreferences
import android.content.pm.PackageManager
import android.util.Log
import androidx.core.content.edit
import java.util.UUID

private const val TAG = "MetricsStore"

/**
 * Metrics tracking for JSTorrent Android.
 *
 * Tracks aggregate usage metrics for:
 * - Review prompt timing (show after sufficient engagement)
 * - Future analytics/feedback
 *
 * Uses the same key names as the Chrome extension for consistency.
 * Unlike the extension, we don't have chrome.storage.sync, so all metrics
 * are stored locally per-device.
 *
 * @see extension/src/lib/metrics.ts for the extension equivalent
 */
class MetricsStore(private val context: Context) {

    private val prefs: SharedPreferences = context.getSharedPreferences(
        PREFS_NAME,
        Context.MODE_PRIVATE
    )

    // =========================================================================
    // Platform Detection
    // =========================================================================

    /**
     * Detected platform: "android" or "chromeos" (for ARC).
     * Cached after first detection.
     */
    val platform: String by lazy {
        detectPlatform()
    }

    /**
     * Detect whether we're running on ChromeOS (ARC) or vanilla Android.
     */
    private fun detectPlatform(): String {
        return try {
            val pm = context.packageManager
            // ARC (Android Runtime for Chrome) exposes this feature
            if (pm.hasSystemFeature("org.chromium.arc") ||
                pm.hasSystemFeature("org.chromium.arc.device_management")) {
                "chromeos"
            } else {
                "android"
            }
        } catch (e: Exception) {
            Log.w(TAG, "Failed to detect platform, defaulting to android", e)
            "android"
        }
    }

    // =========================================================================
    // Install ID (matches extension's installId key)
    // =========================================================================

    /**
     * Unique installation ID for this device.
     * Generated once on first access, persisted forever.
     * Key matches extension: "installId"
     */
    val installId: String
        get() {
            val existing = prefs.getString(KEY_INSTALL_ID, null)
            if (existing != null) return existing

            val newId = UUID.randomUUID().toString()
            prefs.edit { putString(KEY_INSTALL_ID, newId) }
            Log.i(TAG, "Generated new installId: $newId")
            return newId
        }

    // =========================================================================
    // Install Timestamp (matches extension's metrics:installTimestamp key)
    // =========================================================================

    /**
     * Timestamp when the app was first installed/launched (epoch millis).
     * Set once on first access.
     * Key matches extension: "metrics:installTimestamp"
     */
    val installTimestamp: Long
        get() {
            val existing = prefs.getLong(KEY_INSTALL_TIMESTAMP, 0L)
            if (existing > 0L) return existing

            val now = System.currentTimeMillis()
            prefs.edit { putLong(KEY_INSTALL_TIMESTAMP, now) }
            Log.i(TAG, "Set installTimestamp: $now")
            return now
        }

    /**
     * Days since installation.
     */
    val daysInstalled: Int
        get() {
            val elapsed = System.currentTimeMillis() - installTimestamp
            return (elapsed / (1000 * 60 * 60 * 24)).toInt()
        }

    // =========================================================================
    // Aggregate Metrics (matches extension's metrics:aggregate structure)
    // =========================================================================

    /**
     * Total completed downloads across all sessions.
     */
    var completedDownloads: Int
        get() = prefs.getInt(KEY_COMPLETED_DOWNLOADS, 0)
        private set(value) = prefs.edit { putInt(KEY_COMPLETED_DOWNLOADS, value) }

    /**
     * Total torrents added across all sessions.
     */
    var torrentsAdded: Int
        get() = prefs.getInt(KEY_TORRENTS_ADDED, 0)
        private set(value) = prefs.edit { putInt(KEY_TORRENTS_ADDED, value) }

    /**
     * Total sessions started (app opens).
     */
    var sessionsStarted: Int
        get() = prefs.getInt(KEY_SESSIONS_STARTED, 0)
        private set(value) = prefs.edit { putInt(KEY_SESSIONS_STARTED, value) }

    // =========================================================================
    // Per-Platform Metrics (matches extension's byPlatform structure)
    // =========================================================================

    /**
     * Completed downloads on the current platform.
     */
    private var platformDownloads: Int
        get() = prefs.getInt(platformKey(SUFFIX_DOWNLOADS), 0)
        set(value) = prefs.edit { putInt(platformKey(SUFFIX_DOWNLOADS), value) }

    /**
     * Torrents added on the current platform.
     */
    private var platformAdded: Int
        get() = prefs.getInt(platformKey(SUFFIX_ADDED), 0)
        set(value) = prefs.edit { putInt(platformKey(SUFFIX_ADDED), value) }

    /**
     * Sessions started on the current platform.
     */
    private var platformSessions: Int
        get() = prefs.getInt(platformKey(SUFFIX_SESSIONS), 0)
        set(value) = prefs.edit { putInt(platformKey(SUFFIX_SESSIONS), value) }

    private fun platformKey(suffix: String): String = "byPlatform:$platform:$suffix"

    // =========================================================================
    // Increment Functions
    // =========================================================================

    /**
     * Increment completed downloads counter.
     * Call when a torrent finishes downloading.
     */
    fun incrementCompletedDownloads() {
        completedDownloads++
        platformDownloads++
        Log.i(TAG, "Download completed, total: $completedDownloads (platform $platform: $platformDownloads)")
    }

    /**
     * Increment torrents added counter.
     * Call when a new torrent is added (magnet link or .torrent file).
     */
    fun incrementTorrentsAdded() {
        torrentsAdded++
        platformAdded++
        Log.i(TAG, "Torrent added, total: $torrentsAdded (platform $platform: $platformAdded)")
    }

    /**
     * Increment sessions started counter.
     * Call when the app is opened (Activity onCreate).
     */
    fun incrementSessionsStarted() {
        sessionsStarted++
        platformSessions++
        Log.i(TAG, "Session started, total: $sessionsStarted (platform $platform: $platformSessions)")
    }

    // =========================================================================
    // Review Prompt Timing
    // =========================================================================

    /**
     * Timestamp when we last showed the review prompt (epoch millis).
     * 0 if never shown.
     */
    var lastReviewPromptShown: Long
        get() = prefs.getLong(KEY_LAST_REVIEW_PROMPT, 0L)
        set(value) = prefs.edit { putLong(KEY_LAST_REVIEW_PROMPT, value) }

    /**
     * Whether the user has explicitly declined to leave a review.
     * If true, we won't show the prompt again.
     */
    var reviewDeclined: Boolean
        get() = prefs.getBoolean(KEY_REVIEW_DECLINED, false)
        set(value) = prefs.edit { putBoolean(KEY_REVIEW_DECLINED, value) }

    /**
     * Whether the user has completed the review flow (opened Play Store).
     * If true, we won't show the prompt again.
     */
    var reviewCompleted: Boolean
        get() = prefs.getBoolean(KEY_REVIEW_COMPLETED, false)
        set(value) = prefs.edit { putBoolean(KEY_REVIEW_COMPLETED, value) }

    /**
     * Check if we should show the review prompt.
     * Delegates to pure function for testability.
     */
    fun shouldShowReviewPrompt(): Boolean {
        val daysSinceLastPrompt = if (lastReviewPromptShown > 0) {
            ((System.currentTimeMillis() - lastReviewPromptShown) / MS_PER_DAY).toInt()
        } else {
            Int.MAX_VALUE // Never shown
        }

        return shouldShowReviewPrompt(
            completedDownloads = completedDownloads,
            daysInstalled = daysInstalled,
            daysSinceLastPrompt = daysSinceLastPrompt,
            reviewDeclined = reviewDeclined,
            reviewCompleted = reviewCompleted
        )
    }

    /**
     * Record that we showed the review prompt.
     */
    fun recordReviewPromptShown() {
        lastReviewPromptShown = System.currentTimeMillis()
        Log.i(TAG, "Review prompt shown")
    }

    // =========================================================================
    // Debug/Logging
    // =========================================================================

    /**
     * Log current metrics state for debugging.
     */
    fun logMetrics() {
        Log.i(TAG, """
            Metrics Summary:
            - Platform: $platform
            - Install ID: $installId
            - Days installed: $daysInstalled
            - Completed downloads: $completedDownloads (platform: $platformDownloads)
            - Torrents added: $torrentsAdded (platform: $platformAdded)
            - Sessions started: $sessionsStarted (platform: $platformSessions)
            - Should show review: ${shouldShowReviewPrompt()}
        """.trimIndent())
    }

    companion object {
        private const val PREFS_NAME = "jstorrent_metrics"

        // Keys matching extension's storage keys
        private const val KEY_INSTALL_ID = "installId"
        private const val KEY_INSTALL_TIMESTAMP = "metrics:installTimestamp"

        // Aggregate metrics (extension stores these in metrics:aggregate object)
        private const val KEY_COMPLETED_DOWNLOADS = "completedDownloads"
        private const val KEY_TORRENTS_ADDED = "torrentsAdded"
        private const val KEY_SESSIONS_STARTED = "sessionsStarted"

        // Per-platform suffixes (extension uses byPlatform object)
        private const val SUFFIX_DOWNLOADS = "downloads"
        private const val SUFFIX_ADDED = "added"
        private const val SUFFIX_SESSIONS = "sessions"

        // Review prompt state
        private const val KEY_LAST_REVIEW_PROMPT = "lastReviewPromptShown"
        private const val KEY_REVIEW_DECLINED = "reviewDeclined"
        private const val KEY_REVIEW_COMPLETED = "reviewCompleted"

        // Time constants
        private const val MS_PER_DAY = 1000L * 60 * 60 * 24

        // Review prompt thresholds (internal for testing)
        internal const val MIN_DOWNLOADS_FOR_REVIEW = 3
        internal const val MIN_DAYS_FOR_REVIEW = 7
        internal const val DAYS_BETWEEN_PROMPTS = 30

        /**
         * Pure function to determine if review prompt should be shown.
         * Extracted for unit testing without Android dependencies.
         *
         * Criteria:
         * - At least [MIN_DOWNLOADS_FOR_REVIEW] completed downloads (engagement threshold)
         * - At least [MIN_DAYS_FOR_REVIEW] days since install (not a drive-by user)
         * - Haven't shown prompt in the last [DAYS_BETWEEN_PROMPTS] days
         * - User hasn't declined or completed review
         */
        internal fun shouldShowReviewPrompt(
            completedDownloads: Int,
            daysInstalled: Int,
            daysSinceLastPrompt: Int,
            reviewDeclined: Boolean,
            reviewCompleted: Boolean
        ): Boolean {
            // Already declined or completed - never show again
            if (reviewDeclined || reviewCompleted) return false

            // Engagement thresholds
            if (completedDownloads < MIN_DOWNLOADS_FOR_REVIEW) return false
            if (daysInstalled < MIN_DAYS_FOR_REVIEW) return false

            // Don't nag - wait at least DAYS_BETWEEN_PROMPTS between prompts
            if (daysSinceLastPrompt < DAYS_BETWEEN_PROMPTS) return false

            return true
        }
    }
}
