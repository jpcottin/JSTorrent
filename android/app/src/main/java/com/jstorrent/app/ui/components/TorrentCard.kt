package com.jstorrent.app.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.ui.theme.JSTorrentTheme
import com.jstorrent.app.util.Formatters
import com.jstorrent.quickjs.model.TorrentSummary

/**
 * Torrent card for the main list screen.
 * Displays torrent info with play/pause control, progress, and stats.
 * Supports multi-select mode with long-press.
 *
 * @param torrent The torrent summary data
 * @param onPause Callback when pause is requested
 * @param onResume Callback when resume is requested
 * @param onClick Callback when card is clicked (navigate to detail or toggle selection)
 * @param onLongClick Callback when card is long-pressed (enter selection mode)
 * @param isSelectionMode Whether multi-select mode is active
 * @param isSelected Whether this card is currently selected
 * @param isLive True when engine is running (live data), false when showing cached data.
 *               Currently unused but kept for potential future differentiation.
 * @param isPending True when action is pending (shows loading spinner on play/pause button).
 *                  Provides immediate feedback when user taps while engine is starting.
 * @param isPendingRemoval True when torrent is being removed (shows "Removing" status with faded appearance).
 * @param networkWaitingStatus The network waiting status to show when torrent is paused due to
 *                             WiFi-only or VPN-only mode. Null means not waiting for network.
 *                             Values: "waiting_wifi" or "waiting_vpn".
 * @param modifier Optional modifier
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun TorrentCard(
    torrent: TorrentSummary,
    onPause: () -> Unit,
    onResume: () -> Unit,
    onClick: () -> Unit = {},
    onLongClick: () -> Unit = {},
    isSelectionMode: Boolean = false,
    isSelected: Boolean = false,
    isLive: Boolean = true,
    isPending: Boolean = false,
    isPendingRemoval: Boolean = false,
    networkWaitingStatus: String? = null,
    modifier: Modifier = Modifier
) {
    val isPaused = torrent.status == "stopped"
    // Override status based on priority: removing > waiting_wifi/vpn > actual status
    val displayStatus = when {
        isPendingRemoval -> "removing"
        networkWaitingStatus != null && isPaused -> networkWaitingStatus
        else -> torrent.status
    }

    // Animate card background color for selection
    val cardBackgroundColor by animateColorAsState(
        targetValue = if (isSelected) {
            MaterialTheme.colorScheme.primaryContainer.copy(alpha = 0.3f)
        } else {
            MaterialTheme.colorScheme.surface
        },
        animationSpec = tween(durationMillis = 150),
        label = "cardBackground"
    )

    Card(
        modifier = modifier
            .fillMaxWidth()
            .alpha(if (isPendingRemoval) 0.5f else 1f)
            .combinedClickable(
                onClick = onClick,
                onLongClick = onLongClick
            ),
        colors = CardDefaults.cardColors(
            containerColor = cardBackgroundColor
        )
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(start = 0.dp, top = 12.dp, bottom = 12.dp, end = 12.dp),
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Selection checkbox OR Play/Pause button on left (animated swap)
            AnimatedContent(
                targetState = isSelectionMode,
                transitionSpec = {
                    (fadeIn(animationSpec = tween(150)) + scaleIn(initialScale = 0.8f))
                        .togetherWith(fadeOut(animationSpec = tween(150)) + scaleOut(targetScale = 0.8f))
                },
                label = "buttonCheckboxSwap"
            ) { selectionMode ->
                if (selectionMode) {
                    Checkbox(
                        checked = isSelected,
                        onCheckedChange = null, // Click handled by card
                        modifier = Modifier.size(44.dp)
                    )
                } else {
                    CompactPlayPauseButton(
                        isPaused = isPaused,
                        onToggle = if (isPaused) onResume else onPause,
                        isLoading = isPending
                    )
                }
            }

            Spacer(modifier = Modifier.width(12.dp))

            // Torrent info
            Column(modifier = Modifier.weight(1f)) {
                // Torrent name
                val unknownName = stringResource(R.string.component_torrent_card_unknown_name)
                Text(
                    text = torrent.name.ifEmpty { unknownName },
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis
                )

                Spacer(modifier = Modifier.height(4.dp))

                // Status line: "Downloading • 45%" or "Seeding • 100% (partial)" with ETA right-aligned
                // For error state: "Error • [error message]"
                // Stage 5: Show "—" for progress when hasMetadata=false (magnet without metadata yet)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.weight(1f, fill = false)
                    ) {
                        StatusBadge(status = displayStatus, checkingProgress = torrent.checkingProgress)
                        Text(
                            text = " • ",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        val errorMsg = torrent.errorMessage
                        if (displayStatus == "error" && errorMsg != null) {
                            // Show error message for error state
                            Text(
                                text = errorMsg,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.error,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        } else {
                            val partialSuffix = stringResource(R.string.component_torrent_card_partial_suffix)
                            Text(
                                text = if (!torrent.hasMetadata) {
                                    "—" // Unknown progress for magnets without metadata
                                } else {
                                    buildString {
                                        append(Formatters.formatPercent(torrent.progress))
                                        // Show "(partial)" when seeding with skipped files
                                        if (torrent.progress >= 0.999 && torrent.skippedFilesCount > 0) {
                                            append(" $partialSuffix")
                                        }
                                    }
                                },
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                    }
                    // ETA right-aligned (only show when downloading with speed > 0, not for error/removing state)
                    if (displayStatus != "error" && displayStatus != "removing") {
                        torrent.eta?.let { eta ->
                            if (eta > 0 && torrent.progress < 0.999) {
                                Text(
                                    text = stringResource(
                                        R.string.component_torrent_card_eta_prefix,
                                        Formatters.formatEta(eta)
                                    ),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant
                                )
                            }
                        }
                    }
                }

                Spacer(modifier = Modifier.height(4.dp))

                // Progress bar - Stage 5: Hide for magnets without metadata
                // Only show progress bar when we have metadata; otherwise show nothing
                // (status badge already shows "Getting metadata..." when applicable)
                if (torrent.hasMetadata) {
                    TorrentProgressBar(
                        progress = torrent.progress.toFloat()
                    )
                }

                Spacer(modifier = Modifier.height(4.dp))

                // Speed line - always show "0 B/s" when engine is off (cached speeds are 0)
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween
                ) {
                    SpeedIndicator(
                        bytesPerSecond = torrent.downloadSpeed,
                        direction = SpeedDirection.DOWN,
                        showZero = true
                    )
                    SpeedIndicator(
                        bytesPerSecond = torrent.uploadSpeed,
                        direction = SpeedDirection.UP,
                        showZero = true
                    )
                }
            }
        }
    }
}

/**
 * Simplified torrent card without play/pause button.
 * Used in contexts where controls are elsewhere.
 */
@Composable
fun SimpleTorrentCard(
    torrent: TorrentSummary,
    onClick: () -> Unit = {},
    modifier: Modifier = Modifier
) {
    Card(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick),
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.surface
        )
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(12.dp)
        ) {
            // Torrent name
            val unknownName = stringResource(R.string.component_torrent_card_unknown_name)
            Text(
                text = torrent.name.ifEmpty { unknownName },
                style = MaterialTheme.typography.titleSmall,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis
            )

            Spacer(modifier = Modifier.height(4.dp))

            // Status and progress
            Row(
                modifier = Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                StatusBadge(status = torrent.status, checkingProgress = torrent.checkingProgress)
                Text(
                    text = Formatters.formatPercent(torrent.progress),
                    style = MaterialTheme.typography.bodySmall
                )
            }

            Spacer(modifier = Modifier.height(4.dp))

            // Progress bar
            TorrentProgressBar(progress = torrent.progress.toFloat())
        }
    }
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun TorrentCardDownloadingPreview() {
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "abc123",
                name = "Ubuntu 22.04 Desktop AMD64 ISO",
                progress = 0.45,
                downloadSpeed = 2_500_000,
                uploadSpeed = 150_000,
                status = "downloading"
            ),
            onPause = {},
            onResume = {},
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TorrentCardPausedPreview() {
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "def456",
                name = "Big Buck Bunny 1080p",
                progress = 0.75,
                downloadSpeed = 0,
                uploadSpeed = 0,
                status = "stopped"
            ),
            onPause = {},
            onResume = {},
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TorrentCardSeedingPreview() {
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "ghi789",
                name = "Sintel 4K",
                progress = 1.0,
                downloadSpeed = 0,
                uploadSpeed = 500_000,
                status = "seeding"
            ),
            onPause = {},
            onResume = {},
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TorrentCardMetadataPreview() {
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "jkl012",
                name = "",
                progress = 0.0,
                downloadSpeed = 0,
                uploadSpeed = 0,
                status = "downloading_metadata"
            ),
            onPause = {},
            onResume = {},
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TorrentCardErrorPreview() {
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "err123",
                name = "Failed Download",
                progress = 0.05,
                downloadSpeed = 0,
                uploadSpeed = 0,
                status = "error",
                errorMessage = "Download location unavailable. Storage root not found."
            ),
            onPause = {},
            onResume = {},
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TorrentCardNoMetadataPreview() {
    // Stage 5: Preview for magnet without metadata yet
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "mag012",
                name = "Ubuntu 22.04 via Magnet",
                progress = 0.0,
                downloadSpeed = 0,
                uploadSpeed = 0,
                status = "stopped",
                hasMetadata = false
            ),
            onPause = {},
            onResume = {},
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TorrentCardLongNamePreview() {
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "mno345",
                name = "This is a very long torrent name that should be truncated with ellipsis because it exceeds the available space in the card layout",
                progress = 0.25,
                downloadSpeed = 1_000_000,
                uploadSpeed = 50_000,
                status = "downloading"
            ),
            onPause = {},
            onResume = {},
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun SimpleTorrentCardPreview() {
    JSTorrentTheme {
        SimpleTorrentCard(
            torrent = TorrentSummary(
                infoHash = "pqr678",
                name = "Sample Torrent",
                progress = 0.6,
                downloadSpeed = 0,
                uploadSpeed = 0,
                status = "stopped"
            ),
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TorrentCardSelectedPreview() {
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "sel123",
                name = "Selected Torrent",
                progress = 0.5,
                downloadSpeed = 1_500_000,
                uploadSpeed = 100_000,
                status = "downloading"
            ),
            onPause = {},
            onResume = {},
            isSelectionMode = true,
            isSelected = true,
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TorrentCardUnselectedPreview() {
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "unsel456",
                name = "Unselected Torrent",
                progress = 0.75,
                downloadSpeed = 500_000,
                uploadSpeed = 50_000,
                status = "downloading"
            ),
            onPause = {},
            onResume = {},
            isSelectionMode = true,
            isSelected = false,
            modifier = Modifier.padding(8.dp)
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TorrentCardRemovingPreview() {
    JSTorrentTheme {
        TorrentCard(
            torrent = TorrentSummary(
                infoHash = "rem789",
                name = "Torrent Being Removed",
                progress = 0.65,
                downloadSpeed = 0,
                uploadSpeed = 0,
                status = "downloading"
            ),
            onPause = {},
            onResume = {},
            isPendingRemoval = true,
            modifier = Modifier.padding(8.dp)
        )
    }
}
