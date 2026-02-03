package com.jstorrent.app.ui.dialogs

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.jstorrent.app.R
import com.jstorrent.app.ui.theme.JSTorrentTheme

/**
 * Dialog prompting the user to leave a review.
 *
 * Shown after the user has completed enough downloads and used the app for
 * a sufficient period. Provides three options:
 * - Leave Review: Opens the In-App Review flow
 * - Later: Dismisses but may re-ask later
 * - Don't ask again: Permanently dismisses
 */
@Composable
fun ReviewPromptDialog(
    onLeaveReview: () -> Unit,
    onNotNow: () -> Unit,
    onNeverAskAgain: () -> Unit,
    modifier: Modifier = Modifier
) {
    AlertDialog(
        onDismissRequest = onNotNow,
        modifier = modifier,
        icon = {
            Text(
                text = "🎉",
                fontSize = 40.sp
            )
        },
        title = {
            Text(
                text = stringResource(R.string.dialog_review_title),
                textAlign = TextAlign.Center
            )
        },
        text = {
            Column(
                horizontalAlignment = Alignment.CenterHorizontally
            ) {
                Text(
                    text = stringResource(R.string.dialog_review_message),
                    textAlign = TextAlign.Center
                )
                Spacer(modifier = Modifier.height(16.dp))
                // "Don't ask again" as subtle link below the message
                Text(
                    text = stringResource(R.string.dialog_review_never),
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier
                        .clickable(onClick = onNeverAskAgain)
                        .padding(vertical = 4.dp)
                )
            }
        },
        confirmButton = {
            Button(onClick = onLeaveReview) {
                Text(stringResource(R.string.dialog_review_leave_review))
            }
        },
        dismissButton = {
            TextButton(onClick = onNotNow) {
                Text(stringResource(R.string.dialog_review_not_now))
            }
        }
    )
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun ReviewPromptDialogPreview() {
    JSTorrentTheme {
        ReviewPromptDialog(
            onLeaveReview = {},
            onNotNow = {},
            onNeverAskAgain = {}
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun ReviewPromptDialogDarkPreview() {
    JSTorrentTheme(darkTheme = true) {
        ReviewPromptDialog(
            onLeaveReview = {},
            onNotNow = {},
            onNeverAskAgain = {}
        )
    }
}
