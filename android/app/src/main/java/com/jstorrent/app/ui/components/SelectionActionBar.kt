package com.jstorrent.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.BottomAppBar
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.res.stringResource
import com.jstorrent.app.R
import androidx.compose.ui.Modifier
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.jstorrent.app.ui.theme.JSTorrentTheme

/**
 * Bottom action bar shown during multi-select mode.
 * Provides bulk actions: Start All, Stop All, Delete All.
 */
@Composable
fun SelectionActionBar(
    selectedCount: Int,
    onStartAll: () -> Unit,
    onStopAll: () -> Unit,
    onDeleteAll: () -> Unit,
    onClearSelection: () -> Unit,
    modifier: Modifier = Modifier
) {
    BottomAppBar(
        modifier = modifier,
        containerColor = MaterialTheme.colorScheme.surfaceContainer
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            // Left side: Close button and count
            Row(
                verticalAlignment = Alignment.CenterVertically
            ) {
                IconButton(onClick = onClearSelection) {
                    Icon(
                        imageVector = Icons.Default.Close,
                        contentDescription = stringResource(R.string.component_selection_bar_clear_description)
                    )
                }
                Text(
                    text = stringResource(R.string.component_selection_bar_selected_count, selectedCount),
                    style = MaterialTheme.typography.titleMedium
                )
            }

            // Right side: Action buttons
            Row {
                IconButton(onClick = onStartAll) {
                    Icon(
                        imageVector = Icons.Default.PlayArrow,
                        contentDescription = stringResource(R.string.component_selection_bar_start_all_description)
                    )
                }
                IconButton(onClick = onStopAll) {
                    Icon(
                        imageVector = Icons.Default.Pause,
                        contentDescription = stringResource(R.string.component_selection_bar_stop_all_description)
                    )
                }
                IconButton(onClick = onDeleteAll) {
                    Icon(
                        imageVector = Icons.Default.Delete,
                        contentDescription = stringResource(R.string.component_selection_bar_delete_all_description),
                        tint = MaterialTheme.colorScheme.error
                    )
                }
            }
        }
    }
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun SelectionActionBarPreview() {
    JSTorrentTheme {
        SelectionActionBar(
            selectedCount = 3,
            onStartAll = {},
            onStopAll = {},
            onDeleteAll = {},
            onClearSelection = {}
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun SelectionActionBarSinglePreview() {
    JSTorrentTheme {
        SelectionActionBar(
            selectedCount = 1,
            onStartAll = {},
            onStopAll = {},
            onDeleteAll = {},
            onClearSelection = {}
        )
    }
}
