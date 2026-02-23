package com.jstorrent.app.ui.dialogs

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import com.jstorrent.app.R
import com.jstorrent.app.ui.theme.JSTorrentTheme

/**
 * Dialog shown when user tries to enable background downloads without notification permission.
 * Explains why permission is required and offers to open system settings.
 */
@Composable
fun NotificationRequiredDialog(
    onOpenSettings: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = modifier,
        icon = {
            Icon(
                imageVector = Icons.Default.Notifications,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
        },
        title = { Text(stringResource(R.string.dialog_notification_required_title)) },
        text = {
            Text(stringResource(R.string.dialog_notification_required_message))
        },
        confirmButton = {
            TextButton(onClick = onOpenSettings) {
                Text(stringResource(R.string.dialog_notification_required_open_settings))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.cancel))
            }
        }
    )
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun NotificationRequiredDialogPreview() {
    JSTorrentTheme {
        NotificationRequiredDialog(
            onOpenSettings = {},
            onDismiss = {}
        )
    }
}
