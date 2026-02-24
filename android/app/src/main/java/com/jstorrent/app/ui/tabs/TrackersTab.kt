package com.jstorrent.app.ui.tabs

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Sync
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.model.TrackerStatus
import com.jstorrent.app.model.TrackerUi
import com.jstorrent.app.ui.theme.JSTorrentTheme

/**
 * Trackers tab showing DHT/LSD/PeX status and tracker list.
 */
@Composable
fun TrackersTab(
    trackers: List<TrackerUi>,
    dhtEnabled: Boolean,
    pexEnabled: Boolean,
    modifier: Modifier = Modifier,
    onAddTracker: (() -> Unit)? = null
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        floatingActionButton = {
            if (onAddTracker != null) {
                FloatingActionButton(
                    onClick = onAddTracker,
                    containerColor = MaterialTheme.colorScheme.primary
                ) {
                    Icon(Icons.Default.Add, contentDescription = stringResource(R.string.tab_trackers_add_button))
                }
            }
        }
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentPadding = PaddingValues(16.dp),
            verticalArrangement = Arrangement.spacedBy(8.dp)
        ) {
            // DHT/PeX status section
            item {
                DhtPexSection(
                    dhtEnabled = dhtEnabled,
                    pexEnabled = pexEnabled
                )
            }

            item {
                Spacer(modifier = Modifier.height(8.dp))
                HorizontalDivider()
                Spacer(modifier = Modifier.height(8.dp))
            }

            // Trackers section header
            item {
                Text(
                    text = stringResource(R.string.tab_trackers_section_title),
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(8.dp))
            }

            if (trackers.isEmpty()) {
                item {
                    Text(
                        text = stringResource(R.string.tab_trackers_empty),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            } else {
                items(trackers, key = { it.url }) { tracker ->
                    TrackerItem(tracker = tracker)
                }
            }
        }
    }
}

/**
 * DHT/PeX status indicators.
 * Note: LSD (Local Service Discovery) is not yet implemented.
 */
@Composable
private fun DhtPexSection(
    dhtEnabled: Boolean,
    pexEnabled: Boolean,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Text(
            text = stringResource(R.string.tab_trackers_peer_discovery_title),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.height(8.dp))
        Row(
            modifier = Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            StatusChip(
                label = stringResource(R.string.tab_trackers_dht),
                isEnabled = dhtEnabled,
                modifier = Modifier.weight(1f)
            )
            StatusChip(
                label = stringResource(R.string.tab_trackers_pex),
                isEnabled = pexEnabled,
                modifier = Modifier.weight(1f)
            )
        }
    }
}

/**
 * Status chip showing enabled/disabled state.
 */
@Composable
private fun StatusChip(
    label: String,
    isEnabled: Boolean,
    modifier: Modifier = Modifier
) {
    Surface(
        modifier = modifier,
        shape = RoundedCornerShape(8.dp),
        color = if (isEnabled) {
            MaterialTheme.colorScheme.primaryContainer
        } else {
            MaterialTheme.colorScheme.surfaceVariant
        }
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 12.dp, vertical = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.Center
        ) {
            Icon(
                imageVector = if (isEnabled) Icons.Default.Check else Icons.Default.Close,
                contentDescription = null,
                modifier = Modifier.size(16.dp),
                tint = if (isEnabled) {
                    MaterialTheme.colorScheme.primary
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                }
            )
            Spacer(modifier = Modifier.width(4.dp))
            Text(
                text = label,
                style = MaterialTheme.typography.labelMedium,
                color = if (isEnabled) {
                    MaterialTheme.colorScheme.onPrimaryContainer
                } else {
                    MaterialTheme.colorScheme.onSurfaceVariant
                }
            )
        }
    }
}

/**
 * Individual tracker item.
 */
@Composable
private fun TrackerItem(
    tracker: TrackerUi,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        // Status icon
        Box(
            modifier = Modifier.size(24.dp),
            contentAlignment = Alignment.Center
        ) {
            when (tracker.status) {
                TrackerStatus.OK -> Icon(
                    imageVector = Icons.Default.Check,
                    contentDescription = stringResource(R.string.tab_trackers_status_ok),
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(16.dp)
                )
                TrackerStatus.UPDATING -> Icon(
                    imageVector = Icons.Default.Sync,
                    contentDescription = stringResource(R.string.tab_trackers_status_updating),
                    tint = MaterialTheme.colorScheme.tertiary,
                    modifier = Modifier.size(16.dp)
                )
                TrackerStatus.ERROR -> Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = stringResource(R.string.tab_trackers_status_error),
                    tint = MaterialTheme.colorScheme.error,
                    modifier = Modifier.size(16.dp)
                )
                TrackerStatus.DISABLED -> Icon(
                    imageVector = Icons.Default.Close,
                    contentDescription = stringResource(R.string.tab_trackers_status_disabled),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp)
                )
            }
        }

        Spacer(modifier = Modifier.width(12.dp))

        // Tracker info
        Column(modifier = Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = tracker.url,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f, fill = false)
                )
                // Show connection family badge if available
                tracker.connectionFamily?.let { family ->
                    Spacer(modifier = Modifier.width(6.dp))
                    Text(
                        text = family.uppercase(),
                        style = MaterialTheme.typography.labelSmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }
            // Show message or status-based subtext
            val announcingText = stringResource(R.string.tab_trackers_announcing)
            val subtext = tracker.message
                ?: if (tracker.status == TrackerStatus.UPDATING) announcingText else null
            if (subtext != null) {
                Spacer(modifier = Modifier.height(2.dp))
                Text(
                    text = subtext,
                    style = MaterialTheme.typography.bodySmall,
                    color = if (tracker.status == TrackerStatus.ERROR) {
                        MaterialTheme.colorScheme.error
                    } else {
                        MaterialTheme.colorScheme.onSurfaceVariant
                    },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis
                )
            }
        }

        // Peer count: show "received / total" if we have received count
        when {
            tracker.peersReceived != null && tracker.peers != null && tracker.peers > 0 ->
                Text(
                    text = stringResource(R.string.tab_trackers_peers_received_of_total, tracker.peersReceived, tracker.peers),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            tracker.peersReceived != null && tracker.peersReceived > 0 ->
                Text(
                    text = stringResource(R.string.tab_trackers_peers_received, tracker.peersReceived),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            tracker.peers != null && tracker.peers > 0 ->
                Text(
                    text = stringResource(R.string.tab_trackers_peers_count, tracker.peers),
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
        }
    }
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun TrackersTabPreview() {
    JSTorrentTheme {
        TrackersTab(
            trackers = listOf(
                TrackerUi(
                    url = "udp://tracker.opentrackr.org:1337/announce",
                    status = TrackerStatus.OK,
                    message = null,
                    peers = 1500,
                    peersReceived = 50,
                    connectionFamily = "ipv4"
                ),
                TrackerUi(
                    url = "udp://tracker.openbittorrent.com:6969/announce",
                    status = TrackerStatus.OK,
                    message = null,
                    peers = 890,
                    peersReceived = 1,  // Shows the issue: tracker says 890 but only gave 1
                    connectionFamily = "ipv6"
                ),
                TrackerUi(
                    url = "http://tracker.example.com/announce",
                    status = TrackerStatus.ERROR,
                    message = "Connection refused",
                    peers = null,
                    peersReceived = null,
                    connectionFamily = null
                ),
                TrackerUi(
                    url = "udp://tracker.updating.org:1337/announce",
                    status = TrackerStatus.UPDATING,
                    message = null,
                    peers = null,
                    peersReceived = null,
                    connectionFamily = null
                )
            ),
            dhtEnabled = true,
            pexEnabled = false
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun TrackersTabEmptyPreview() {
    JSTorrentTheme {
        TrackersTab(
            trackers = emptyList(),
            dhtEnabled = true,
            pexEnabled = true
        )
    }
}
