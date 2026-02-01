package com.jstorrent.app.ui.dialogs

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Checkbox
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.ui.theme.JSTorrentTheme

/**
 * Dialog for confirming bulk torrent removal.
 * Shows count and provides option to delete files.
 */
@Composable
fun BulkRemoveTorrentDialog(
    count: Int,
    onDismiss: () -> Unit,
    onConfirm: (deleteFiles: Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
    var deleteFiles by remember { mutableStateOf(false) }

    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = modifier,
        title = {
            Text(pluralStringResource(R.plurals.dialog_bulk_remove_title, count, count))
        },
        text = {
            Column {
                Text(
                    text = if (count == 1) {
                        stringResource(R.string.dialog_bulk_remove_message_one)
                    } else {
                        stringResource(R.string.dialog_bulk_remove_message_other)
                    },
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(modifier = Modifier.height(16.dp))
                Row(
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { deleteFiles = !deleteFiles },
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Checkbox(
                        checked = deleteFiles,
                        onCheckedChange = { deleteFiles = it }
                    )
                    Text(
                        text = stringResource(R.string.dialog_bulk_remove_delete_files_label),
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(start = 8.dp)
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(deleteFiles) }
            ) {
                Text(
                    text = stringResource(R.string.dialog_bulk_remove_confirm_button),
                    color = MaterialTheme.colorScheme.error
                )
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.dialog_bulk_remove_cancel_button))
            }
        }
    )
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun BulkRemoveTorrentDialogSinglePreview() {
    JSTorrentTheme {
        BulkRemoveTorrentDialog(
            count = 1,
            onDismiss = {},
            onConfirm = {}
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun BulkRemoveTorrentDialogMultiplePreview() {
    JSTorrentTheme {
        BulkRemoveTorrentDialog(
            count = 5,
            onDismiss = {},
            onConfirm = {}
        )
    }
}
