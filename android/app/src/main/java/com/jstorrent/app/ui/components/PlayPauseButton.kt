package com.jstorrent.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.scale
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import com.jstorrent.app.R
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.jstorrent.app.ui.theme.JSTorrentTheme

/**
 * Circular play/pause button for torrent control.
 * Matches Flud's design with teal background and white icon.
 *
 * @param isPaused Whether the torrent is currently paused
 * @param onToggle Callback when button is clicked
 * @param modifier Optional modifier
 * @param size Button size (default 40.dp)
 * @param backgroundColor Background color (defaults to primary/teal)
 * @param iconColor Icon color (defaults to onPrimary/white)
 * @param enabled Whether the button is enabled
 * @param isLoading Show loading spinner instead of play/pause icon (for pending actions)
 */
@Composable
fun PlayPauseButton(
    isPaused: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    size: Dp = 40.dp,
    backgroundColor: Color = MaterialTheme.colorScheme.primary,
    iconColor: Color = MaterialTheme.colorScheme.onPrimary,
    enabled: Boolean = true,
    isLoading: Boolean = false
) {
    val icon = if (isPaused) Icons.Default.PlayArrow else Icons.Default.Pause
    val description = when {
        isLoading -> stringResource(R.string.component_play_pause_loading_description)
        isPaused -> stringResource(R.string.component_play_pause_resume_description)
        else -> stringResource(R.string.component_play_pause_pause_description)
    }

    // Track press state for scale animation
    var isPressed by remember { mutableStateOf(false) }

    // Keep callback up-to-date across recompositions (fixes stale closure in pointerInput)
    val currentOnToggle by rememberUpdatedState(onToggle)

    // Smooth scale animation: pressed = 0.85, released = 1.0
    val scale by animateFloatAsState(
        targetValue = if (isPressed) 0.85f else 1f,
        animationSpec = spring(
            dampingRatio = 0.6f,
            stiffness = 400f
        ),
        label = "buttonScale"
    )

    // Effective enabled state - disabled when loading
    val effectiveEnabled = enabled && !isLoading

    // Smooth background color transition
    val animatedBackgroundColor by animateColorAsState(
        targetValue = if (effectiveEnabled) backgroundColor else backgroundColor.copy(alpha = 0.5f),
        animationSpec = tween(durationMillis = 200),
        label = "backgroundColor"
    )

    // Smooth icon color transition
    val animatedIconColor by animateColorAsState(
        targetValue = if (effectiveEnabled) iconColor else iconColor.copy(alpha = 0.5f),
        animationSpec = tween(durationMillis = 200),
        label = "iconColor"
    )

    Box(
        modifier = modifier
            .size(size)
            .scale(scale)
            .clip(CircleShape)
            .background(animatedBackgroundColor)
            .pointerInput(effectiveEnabled) {
                if (effectiveEnabled) {
                    detectTapGestures(
                        onPress = {
                            isPressed = true
                            try {
                                awaitRelease()
                            } finally {
                                isPressed = false
                            }
                        },
                        onTap = { currentOnToggle() }
                    )
                }
            }
            .semantics {
                role = Role.Button
                contentDescription = description
            },
        contentAlignment = Alignment.Center
    ) {
        if (isLoading) {
            CircularProgressIndicator(
                modifier = Modifier.size(size * 0.5f),
                color = animatedIconColor,
                strokeWidth = 2.dp
            )
        } else {
            Icon(
                imageVector = icon,
                contentDescription = null, // Handled by parent semantics
                tint = animatedIconColor,
                modifier = Modifier.size(size * 0.6f)
            )
        }
    }
}

/**
 * Larger play/pause button for prominent placement.
 * Used in torrent detail screen app bar.
 */
@Composable
fun LargePlayPauseButton(
    isPaused: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true
) {
    PlayPauseButton(
        isPaused = isPaused,
        onToggle = onToggle,
        modifier = modifier,
        size = 48.dp,
        enabled = enabled
    )
}

/**
 * Compact play/pause button for torrent list cards.
 * Play button uses primary color for emphasis, pause uses muted secondary color.
 *
 * @param isPaused Whether the torrent is currently paused
 * @param onToggle Callback when button is clicked
 * @param modifier Optional modifier
 * @param enabled Whether the button is enabled
 * @param isLoading Show loading spinner (for pending actions while engine starts)
 */
@Composable
fun CompactPlayPauseButton(
    isPaused: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    isLoading: Boolean = false
) {
    // Play button (start) should be more prominent than pause
    // When loading, use primary color to match the "starting" action
    val backgroundColor = if (isLoading || isPaused) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.surfaceVariant
    }
    val iconColor = if (isLoading || isPaused) {
        MaterialTheme.colorScheme.onPrimary
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    PlayPauseButton(
        isPaused = isPaused,
        onToggle = onToggle,
        modifier = modifier,
        size = 44.dp,
        backgroundColor = backgroundColor,
        iconColor = iconColor,
        enabled = enabled,
        isLoading = isLoading
    )
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun PlayPauseButtonPausedPreview() {
    JSTorrentTheme {
        PlayPauseButton(
            isPaused = true,
            onToggle = {}
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun PlayPauseButtonPlayingPreview() {
    JSTorrentTheme {
        PlayPauseButton(
            isPaused = false,
            onToggle = {}
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun PlayPauseButtonDisabledPreview() {
    JSTorrentTheme {
        PlayPauseButton(
            isPaused = true,
            onToggle = {},
            enabled = false
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun LargePlayPauseButtonPreview() {
    JSTorrentTheme {
        LargePlayPauseButton(
            isPaused = true,
            onToggle = {}
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun CompactPlayPauseButtonPreview() {
    JSTorrentTheme {
        CompactPlayPauseButton(
            isPaused = false,
            onToggle = {}
        )
    }
}
