package com.jstorrent.app.ui.dialogs

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.window.DialogProperties
import com.jstorrent.app.R
import com.jstorrent.app.ui.theme.JSTorrentTheme

/**
 * Dialog explaining why notification permission is needed.
 * Shown once on first launch when permission is not granted.
 */
@Composable
fun NotificationPermissionDialog(
    onEnable: () -> Unit,
    onNotNow: () -> Unit,
    modifier: Modifier = Modifier
) {
    AlertDialog(
        onDismissRequest = { /* Require explicit button press */ },
        modifier = modifier,
        properties = DialogProperties(
            dismissOnBackPress = false,
            dismissOnClickOutside = false
        ),
        icon = {
            Icon(
                imageVector = Icons.Default.Notifications,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.primary
            )
        },
        title = { Text(stringResource(R.string.dialog_notification_permission_title)) },
        text = {
            Text(stringResource(R.string.dialog_notification_permission_message))
        },
        confirmButton = {
            Button(onClick = onEnable) {
                Text(stringResource(R.string.dialog_notification_permission_enable))
            }
        },
        dismissButton = {
            TextButton(onClick = onNotNow) {
                Text(stringResource(R.string.dialog_notification_permission_not_now))
            }
        }
    )
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun NotificationPermissionDialogPreview() {
    JSTorrentTheme {
        NotificationPermissionDialog(
            onEnable = {},
            onNotNow = {}
        )
    }
}
