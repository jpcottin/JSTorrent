package com.jstorrent.app.ui.components

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.jstorrent.app.ui.theme.JSTorrentTheme
import java.util.BitSet
import kotlin.math.ceil
import kotlin.math.min

/**
 * Visual piece map showing download progress as a grid.
 * Dynamically adjusts grid size based on piece count:
 * - Small (< 100): Large squares, one row if possible
 * - Medium (100-1000): Medium squares, multiple rows
 * - Large (> 1000): Small squares, many rows
 *
 * Uses BitSet for accurate piece-by-piece visualization.
 *
 * Color coding (priority order):
 * - Completed (verified): primary color (blue)
 * - Responded (all blocks received, awaiting verification): green
 * - Requested (all blocks requested, waiting for data): cyan/light blue
 * - Partial (has unrequested blocks): orange
 * - Missing: surfaceVariant (gray)
 */
@Composable
fun PieceMap(
    piecesTotal: Int,
    bitfield: BitSet?,
    modifier: Modifier = Modifier,
    piecesCompleted: Int = bitfield?.cardinality() ?: 0,
    activePiecesPartial: Set<Int>? = null,
    activePiecesRequested: Set<Int>? = null,
    activePiecesResponded: Set<Int>? = null
) {
    val primaryColor = MaterialTheme.colorScheme.primary
    val emptyColor = MaterialTheme.colorScheme.surfaceVariant
    // Active piece state colors
    val partialColor = Color(0xFFFF9800)   // Orange - has unrequested blocks
    val requestedColor = Color(0xFF00BCD4) // Cyan - all blocks requested
    val respondedColor = Color(0xFF4CAF50) // Green - all blocks received

    // Dynamic grid sizing based on piece count
    val (columns, cellSizeDp) = remember(piecesTotal) {
        when {
            piecesTotal <= 10 -> piecesTotal to 24.dp
            piecesTotal <= 50 -> min(piecesTotal, 25) to 16.dp
            piecesTotal <= 200 -> min(piecesTotal, 40) to 10.dp
            piecesTotal <= 1000 -> 50 to 6.dp
            piecesTotal <= 5000 -> 80 to 4.dp
            else -> 100 to 3.dp
        }
    }
    val rows = if (columns > 0) ceil(piecesTotal.toDouble() / columns).toInt() else 0
    val density = LocalDensity.current
    val cellSizePx = with(density) { cellSizeDp.toPx() }
    val gap = 1f
    val totalHeight = (rows * cellSizePx / density.density + 8).dp

    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(totalHeight)
            .padding(4.dp)
    ) {
        if (piecesTotal == 0 || columns == 0) return@Canvas

        // Use actual cell size based on available width
        val actualCellWidth = size.width / columns
        val actualCellHeight = actualCellWidth

        for (i in 0 until piecesTotal) {
            val col = i % columns
            val row = i / columns

            // Determine piece color based on state (priority: completed > responded > requested > partial > missing)
            val color = when {
                bitfield?.get(i) == true -> primaryColor  // Verified complete
                activePiecesResponded?.contains(i) == true -> respondedColor  // All blocks received
                activePiecesRequested?.contains(i) == true -> requestedColor  // All blocks requested
                activePiecesPartial?.contains(i) == true -> partialColor      // Has unrequested blocks
                bitfield == null && i < piecesCompleted -> primaryColor       // Fallback mode
                else -> emptyColor  // Missing
            }

            val x = col * actualCellWidth + gap
            val y = row * actualCellHeight + gap

            drawRect(
                color = color,
                topLeft = Offset(x, y),
                size = Size(actualCellWidth - gap * 2, actualCellHeight - gap * 2)
            )
        }
    }
}

/**
 * Segment state for PieceBar - tracks what fraction of pieces in each state.
 */
private data class SegmentState(
    val completed: Float,   // Fraction of verified pieces
    val responded: Float,   // Fraction in responded state
    val requested: Float,   // Fraction in requested state
    val partial: Float      // Fraction in partial state
)

/**
 * Single-line piece bar showing download progress.
 * Aggregates pieces into segments for large torrents.
 * Uses BitSet for accurate piece-by-piece visualization.
 *
 * Shows active piece states with colored overlays:
 * - Completed (verified): primary color
 * - Responded (awaiting verification): green
 * - Requested (awaiting data): cyan
 * - Partial (has unrequested blocks): orange
 */
@Composable
fun PieceBar(
    piecesTotal: Int,
    bitfield: BitSet?,
    modifier: Modifier = Modifier,
    piecesCompleted: Int = bitfield?.cardinality() ?: 0,
    height: Dp = 12.dp,
    maxSegments: Int = 100,
    activePiecesPartial: Set<Int>? = null,
    activePiecesRequested: Set<Int>? = null,
    activePiecesResponded: Set<Int>? = null
) {
    val primaryColor = MaterialTheme.colorScheme.primary
    val emptyColor = MaterialTheme.colorScheme.surfaceVariant
    // Active piece state colors (must match PieceMap)
    val partialColor = Color(0xFFFF9800)   // Orange
    val requestedColor = Color(0xFF00BCD4) // Cyan
    val respondedColor = Color(0xFF4CAF50) // Green

    // Pre-compute segment states
    val displaySegments = min(piecesTotal, maxSegments)
    val segmentStates = remember(
        bitfield,
        piecesTotal,
        piecesCompleted,
        activePiecesPartial,
        activePiecesRequested,
        activePiecesResponded
    ) {
        if (displaySegments == 0) return@remember emptyList()

        val piecesPerSegment = piecesTotal.toFloat() / displaySegments
        List(displaySegments) { segmentIndex ->
            val startPiece = (segmentIndex * piecesPerSegment).toInt()
            val endPiece = min(((segmentIndex + 1) * piecesPerSegment).toInt(), piecesTotal)
            val segmentSize = endPiece - startPiece
            if (segmentSize == 0) return@List SegmentState(0f, 0f, 0f, 0f)

            var completed = 0
            var responded = 0
            var requested = 0
            var partial = 0

            for (i in startPiece until endPiece) {
                when {
                    bitfield?.get(i) == true -> completed++
                    activePiecesResponded?.contains(i) == true -> responded++
                    activePiecesRequested?.contains(i) == true -> requested++
                    activePiecesPartial?.contains(i) == true -> partial++
                    bitfield == null && i < piecesCompleted -> completed++
                }
            }

            SegmentState(
                completed = completed.toFloat() / segmentSize,
                responded = responded.toFloat() / segmentSize,
                requested = requested.toFloat() / segmentSize,
                partial = partial.toFloat() / segmentSize
            )
        }
    }

    Canvas(
        modifier = modifier
            .fillMaxWidth()
            .height(height)
    ) {
        if (piecesTotal == 0 || displaySegments == 0) return@Canvas

        val segmentWidth = size.width / displaySegments
        val gap = if (displaySegments <= 50) 1f else 0.5f

        for (i in 0 until displaySegments) {
            val state = segmentStates[i]
            val x = i * segmentWidth

            // Draw background (empty)
            drawRect(
                color = emptyColor,
                topLeft = Offset(x + gap, 0f),
                size = Size(segmentWidth - gap * 2, size.height)
            )

            // Draw state overlays from bottom to top (most complete first)
            // Each layer's alpha reflects the fraction in that state
            if (state.completed > 0f) {
                drawRect(
                    color = primaryColor.copy(alpha = 0.3f + state.completed * 0.7f),
                    topLeft = Offset(x + gap, 0f),
                    size = Size(segmentWidth - gap * 2, size.height)
                )
            }
            if (state.responded > 0f) {
                drawRect(
                    color = respondedColor.copy(alpha = 0.3f + state.responded * 0.7f),
                    topLeft = Offset(x + gap, 0f),
                    size = Size(segmentWidth - gap * 2, size.height)
                )
            }
            if (state.requested > 0f) {
                drawRect(
                    color = requestedColor.copy(alpha = 0.3f + state.requested * 0.7f),
                    topLeft = Offset(x + gap, 0f),
                    size = Size(segmentWidth - gap * 2, size.height)
                )
            }
            if (state.partial > 0f) {
                drawRect(
                    color = partialColor.copy(alpha = 0.3f + state.partial * 0.7f),
                    topLeft = Offset(x + gap, 0f),
                    size = Size(segmentWidth - gap * 2, size.height)
                )
            }
        }
    }
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun PieceMapSmallPreview() {
    JSTorrentTheme {
        Box(modifier = Modifier.padding(16.dp)) {
            // 10 pieces, 5 complete (scattered)
            val bitfield = BitSet(10).apply {
                set(0); set(2); set(4); set(7); set(9)
            }
            PieceMap(
                piecesTotal = 10,
                bitfield = bitfield
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun PieceMapMediumPreview() {
    JSTorrentTheme {
        Box(modifier = Modifier.padding(16.dp)) {
            // 100 pieces, 50% complete (scattered)
            val bitfield = BitSet(100).apply {
                for (i in 0 until 100 step 2) set(i)
            }
            PieceMap(
                piecesTotal = 100,
                bitfield = bitfield
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun PieceMapLargePreview() {
    JSTorrentTheme {
        Box(modifier = Modifier.padding(16.dp)) {
            // 1000 pieces, 50% complete
            val bitfield = BitSet(1000).apply {
                for (i in 0 until 500) set(i)
            }
            PieceMap(
                piecesTotal = 1000,
                bitfield = bitfield
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun PieceMapVeryLargePreview() {
    JSTorrentTheme {
        Box(modifier = Modifier.padding(16.dp)) {
            // 10000 pieces, scattered completion
            val bitfield = BitSet(10000).apply {
                for (i in 0 until 10000 step 3) set(i)
            }
            PieceMap(
                piecesTotal = 10000,
                bitfield = bitfield
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun PieceBarPreview() {
    JSTorrentTheme {
        Box(modifier = Modifier.padding(16.dp)) {
            // 1000 pieces, scattered completion
            val bitfield = BitSet(1000).apply {
                for (i in 0 until 1000 step 2) set(i)
            }
            PieceBar(
                piecesTotal = 1000,
                bitfield = bitfield
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun PieceBarSmallPreview() {
    JSTorrentTheme {
        Box(modifier = Modifier.padding(16.dp)) {
            val bitfield = BitSet(20).apply {
                set(0); set(5); set(10); set(15); set(19)
            }
            PieceBar(
                piecesTotal = 20,
                bitfield = bitfield
            )
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun PieceMapNoBitfieldPreview() {
    JSTorrentTheme {
        Box(modifier = Modifier.padding(16.dp)) {
            // Fallback mode: no bitfield, use count
            PieceMap(
                piecesTotal = 100,
                bitfield = null,
                piecesCompleted = 50
            )
        }
    }
}
