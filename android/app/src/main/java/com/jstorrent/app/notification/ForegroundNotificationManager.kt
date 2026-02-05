package com.jstorrent.app.notification

import android.app.Notification
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import androidx.core.app.NotificationCompat
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.app.NativeStandaloneActivity
import com.jstorrent.app.R
import com.jstorrent.app.util.Formatters
import com.jstorrent.quickjs.model.TorrentSummary

/**
 * Manages the foreground service notification with dynamic content.
 *
 * Shows:
 * - Torrent counts (downloading, seeding)
 * - Aggregate speeds
 * - Action buttons (Pause All / Resume All, Quit)
 */
class ForegroundNotificationManager(private val context: Context) {

    companion object {
        const val NOTIFICATION_ID = 2
        private const val MAX_NAME_LENGTH = 40
    }

    /**
     * Computed notification state from torrent list.
     */
    data class NotificationState(
        val downloadingCount: Int,
        val seedingCount: Int,
        val downloadSpeed: Long,
        val uploadSpeed: Long,
        val hasActiveTorrents: Boolean,
        // For single-torrent display
        val singleTorrent: TorrentSummary? = null,
        // Network restriction status ("waiting_wifi", "waiting_vpn", or null)
        val restrictionStatus: String? = null
    )

    /**
     * Build notification from current torrent list.
     */
    fun buildNotification(torrents: List<TorrentSummary>): Notification {
        // Get restriction status from enforcer
        val app = context.applicationContext as? JSTorrentApplication
        val restrictionStatus = app?.networkRestrictionEnforcer?.getRestrictionStatus()

        val state = computeState(torrents, restrictionStatus)
        return createNotification(state)
    }

    /**
     * Update the notification with new torrent state.
     */
    fun updateNotification(torrents: List<TorrentSummary>) {
        val notification = buildNotification(torrents)
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(NOTIFICATION_ID, notification)
    }

    /**
     * Compute notification state from torrent list.
     */
    private fun computeState(torrents: List<TorrentSummary>, restrictionStatus: String? = null): NotificationState {
        var downloading = 0
        var seeding = 0
        var totalDown = 0L
        var totalUp = 0L
        var hasActive = false
        val activeTorrents = mutableListOf<TorrentSummary>()

        for (torrent in torrents) {
            // Check status - also consider progress and speeds for detection
            // (status string may not always match expected values)
            val isDownloading = torrent.status in listOf("downloading", "downloading_metadata", "checking", "queued") ||
                (torrent.progress < 1.0 && torrent.downloadSpeed > 0)
            val isSeeding = torrent.status == "seeding" ||
                (torrent.progress >= 1.0 && torrent.uploadSpeed > 0)
            val isStopped = torrent.status == "stopped"

            when {
                isDownloading && !isStopped -> {
                    downloading++
                    hasActive = true
                    activeTorrents.add(torrent)
                }
                isSeeding && !isStopped -> {
                    seeding++
                    hasActive = true
                    activeTorrents.add(torrent)
                }
            }
            totalDown += torrent.downloadSpeed
            totalUp += torrent.uploadSpeed
        }

        // If exactly one active torrent, store it for single-torrent display
        val singleTorrent = if (activeTorrents.size == 1) activeTorrents.first() else null

        return NotificationState(
            downloadingCount = downloading,
            seedingCount = seeding,
            downloadSpeed = totalDown,
            uploadSpeed = totalUp,
            hasActiveTorrents = hasActive,
            singleTorrent = singleTorrent,
            restrictionStatus = restrictionStatus
        )
    }

    private fun createNotification(state: NotificationState): Notification {
        // Content intent - open app
        val contentIntent = PendingIntent.getActivity(
            context,
            0,
            Intent(context, NativeStandaloneActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE
        )

        val builder = NotificationCompat.Builder(context, JSTorrentApplication.NotificationChannels.SERVICE)
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .setSilent(true)

        // Single torrent: show name and details
        // Multiple torrents: show summary counts
        val singleTorrent = state.singleTorrent
        if (singleTorrent != null) {
            val title = truncateName(singleTorrent.name)
            // Show restriction status instead of speeds when network is restricted
            val contentText = state.restrictionStatus?.let { status ->
                when (status) {
                    "waiting_wifi" -> "Paused \u2013 waiting for WiFi"
                    "waiting_vpn" -> "Paused \u2013 waiting for VPN"
                    else -> "Paused \u2013 network restricted"
                }
            } ?: buildSingleTorrentLine(singleTorrent)
            builder.setContentTitle(title)
            builder.setContentText(contentText)
        } else {
            // Multiple torrents or no active torrents
            val title = buildStatusLine(state)
            // Don't show speeds when network is restricted (they're stale)
            val speedLine = if (state.restrictionStatus != null) "" else buildSpeedLine(state)
            builder.setContentTitle(title)
            if (speedLine.isNotEmpty()) {
                builder.setContentText(speedLine)
            }
        }

        // Add action buttons
        addActionButtons(builder, state)

        return builder.build()
    }

    /**
     * Truncate torrent name to fit in notification.
     */
    private fun truncateName(name: String): String {
        return if (name.length > MAX_NAME_LENGTH) {
            name.take(MAX_NAME_LENGTH - 1) + "…"
        } else {
            name
        }
    }

    /**
     * Build content line for single torrent display.
     * Downloading: "45% · 3m left · 16 MB/s ↓"
     * Seeding: "Seeding · 1.2 MB/s ↑"
     */
    private fun buildSingleTorrentLine(torrent: TorrentSummary): String {
        val parts = mutableListOf<String>()
        val isComplete = torrent.progress >= 1.0

        if (isComplete) {
            // Seeding
            parts.add("Seeding")
            if (torrent.uploadSpeed > 0) {
                parts.add("${Formatters.formatSpeed(torrent.uploadSpeed)} \u2191")
            }
        } else {
            // Downloading
            parts.add(Formatters.formatPercent(torrent.progress))

            // ETA if available
            torrent.eta?.let { eta ->
                if (eta > 0 && eta < Long.MAX_VALUE) {
                    parts.add(formatCompactEta(eta))
                }
            }

            // Download speed
            if (torrent.downloadSpeed > 0) {
                parts.add("${Formatters.formatSpeed(torrent.downloadSpeed)} \u2193")
            }
        }

        return parts.joinToString(" \u00B7 ")
    }

    /**
     * Format ETA in compact form for notifications.
     * "< 1m", "3m", "2h 15m", "1d 5h"
     */
    private fun formatCompactEta(seconds: Long): String {
        if (seconds < 60) return "< 1m"

        val days = seconds / 86400
        val hours = (seconds % 86400) / 3600
        val minutes = (seconds % 3600) / 60

        return when {
            days > 0 -> "${days}d ${hours}h"
            hours > 0 -> "${hours}h ${minutes}m"
            else -> "${minutes}m"
        }
    }

    /**
     * Build status line like "2 downloading · 1 seeding" or "No active torrents"
     * Shows restriction status when network conditions block downloads.
     */
    private fun buildStatusLine(state: NotificationState): String {
        // Show restriction status if active
        state.restrictionStatus?.let { status ->
            return when (status) {
                "waiting_wifi" -> "Paused \u2013 waiting for WiFi"
                "waiting_vpn" -> "Paused \u2013 waiting for VPN"
                else -> "Paused \u2013 network restricted"
            }
        }

        val parts = mutableListOf<String>()

        if (state.downloadingCount > 0) {
            parts.add("${state.downloadingCount} downloading")
        }
        if (state.seedingCount > 0) {
            parts.add("${state.seedingCount} seeding")
        }

        return if (parts.isEmpty()) {
            "No active torrents"
        } else {
            parts.joinToString(" \u00B7 ")
        }
    }

    /**
     * Build speed line like "16 MB/s ↓ · 1.2 MB/s ↑"
     */
    private fun buildSpeedLine(state: NotificationState): String {
        val parts = mutableListOf<String>()

        if (state.downloadSpeed > 0) {
            parts.add("${Formatters.formatSpeed(state.downloadSpeed)} \u2193")
        }
        if (state.uploadSpeed > 0) {
            parts.add("${Formatters.formatSpeed(state.uploadSpeed)} \u2191")
        }

        return parts.joinToString(" \u00B7 ")
    }

    private fun addActionButtons(builder: NotificationCompat.Builder, state: NotificationState) {
        // Pause All / Resume All (mutually exclusive based on state)
        if (state.hasActiveTorrents) {
            val pauseIntent = PendingIntent.getBroadcast(
                context,
                0,
                Intent(NotificationActionReceiver.ACTION_PAUSE_ALL).setPackage(context.packageName),
                PendingIntent.FLAG_IMMUTABLE
            )
            builder.addAction(0, "Pause All", pauseIntent)
        } else {
            val resumeIntent = PendingIntent.getBroadcast(
                context,
                1,
                Intent(NotificationActionReceiver.ACTION_RESUME_ALL).setPackage(context.packageName),
                PendingIntent.FLAG_IMMUTABLE
            )
            builder.addAction(0, "Resume All", resumeIntent)
        }

        // Quit action (always shown)
        val quitIntent = PendingIntent.getBroadcast(
            context,
            2,
            Intent(NotificationActionReceiver.ACTION_QUIT).setPackage(context.packageName),
            PendingIntent.FLAG_IMMUTABLE
        )
        builder.addAction(0, "Quit", quitIntent)
    }
}
