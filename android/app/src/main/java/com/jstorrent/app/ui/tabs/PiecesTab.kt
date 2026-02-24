package com.jstorrent.app.ui.tabs

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.ui.components.PieceBar
import com.jstorrent.app.ui.components.PieceMap
import com.jstorrent.app.ui.components.StatRowPair
import com.jstorrent.app.ui.theme.JSTorrentTheme
import com.jstorrent.app.util.Formatters
import java.util.BitSet

// Piece state colors (must match PieceMap.kt)
private val PartialColor = Color(0xFFFF9800)   // Orange
private val RequestedColor = Color(0xFF00BCD4) // Cyan
private val RespondedColor = Color(0xFF4CAF50) // Green
private val MissingColor = Color(0xFF3A3A3C)   // Dark gray

/**
 * Pieces tab showing piece completion status and visual map.
 *
 * Active piece states show download progress:
 * - Partial (orange): has unrequested blocks
 * - Requested (cyan): all blocks requested, awaiting data
 * - Responded (green): all blocks received, awaiting verification
 */
@Composable
fun PiecesTab(
    piecesCompleted: Int?,
    piecesTotal: Int?,
    pieceSize: Long?,
    bitfield: BitSet?,
    modifier: Modifier = Modifier,
    activePiecesPartial: Set<Int>? = null,
    activePiecesRequested: Set<Int>? = null,
    activePiecesResponded: Set<Int>? = null
) {
    if (piecesTotal == null || piecesTotal == 0) {
        NoPiecesState(modifier = modifier)
    } else {
        Column(
            modifier = modifier
                .fillMaxSize()
                .verticalScroll(rememberScrollState())
                .padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(16.dp)
        ) {
            // Statistics
            StatRowPair(
                leftLabel = stringResource(R.string.tab_pieces_count_label),
                leftValue = "${Formatters.formatNumber(piecesCompleted ?: 0)} / ${Formatters.formatNumber(piecesTotal)}",
                rightLabel = stringResource(R.string.tab_pieces_piece_size),
                rightValue = pieceSize?.let { Formatters.formatBytes(it) } ?: stringResource(R.string.tab_pieces_unknown)
            )

            // Progress bar (single line, aggregated view)
            Text(
                text = stringResource(R.string.tab_pieces_progress).uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            PieceBar(
                piecesTotal = piecesTotal,
                bitfield = bitfield,
                piecesCompleted = piecesCompleted ?: 0,
                activePiecesPartial = activePiecesPartial,
                activePiecesRequested = activePiecesRequested,
                activePiecesResponded = activePiecesResponded,
                modifier = Modifier.padding(top = 4.dp)
            )

            Spacer(modifier = Modifier.height(8.dp))

            // Piece map (grid view)
            Text(
                text = stringResource(R.string.tab_pieces_piece_map).uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )

            PieceMap(
                piecesTotal = piecesTotal,
                bitfield = bitfield,
                piecesCompleted = piecesCompleted ?: 0,
                activePiecesPartial = activePiecesPartial,
                activePiecesRequested = activePiecesRequested,
                activePiecesResponded = activePiecesResponded,
                modifier = Modifier.padding(top = 4.dp)
            )

            // Legend
            Spacer(modifier = Modifier.height(8.dp))
            PieceLegend()
        }
    }
}

/**
 * Legend showing piece state colors.
 * Uses FlowRow to wrap items to next line when space is constrained.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun PieceLegend() {
    val completedColor = MaterialTheme.colorScheme.primary

    FlowRow(
        horizontalArrangement = Arrangement.spacedBy(16.dp),
        verticalArrangement = Arrangement.spacedBy(8.dp)
    ) {
        LegendItem(color = completedColor, label = stringResource(R.string.tab_pieces_legend_complete))
        LegendItem(color = RespondedColor, label = stringResource(R.string.tab_pieces_legend_verifying))
        LegendItem(color = RequestedColor, label = stringResource(R.string.tab_pieces_legend_receiving))
        LegendItem(color = PartialColor, label = stringResource(R.string.tab_pieces_legend_requesting))
        LegendItem(color = MissingColor, label = stringResource(R.string.tab_pieces_legend_missing))
    }
}

@Composable
private fun LegendItem(color: Color, label: String) {
    Row(
        verticalAlignment = Alignment.CenterVertically
    ) {
        Box(
            modifier = Modifier
                .size(12.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(color)
        )
        Spacer(modifier = Modifier.width(4.dp))
        Text(
            text = label,
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

/**
 * State shown when no piece info available.
 */
@Composable
private fun NoPiecesState(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp)
        ) {
            Text(
                text = stringResource(R.string.tab_pieces_no_info_title),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Text(
                text = stringResource(R.string.tab_pieces_no_info_description),
                style = MaterialTheme.typography.bodyMedium,
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
private fun PiecesTabPreview() {
    // Create a scattered bitfield for preview
    val bitfield = BitSet(8152).apply {
        for (i in 0 until 500) set(i * 16)
    }
    JSTorrentTheme {
        PiecesTab(
            piecesCompleted = 500,
            piecesTotal = 8152,
            pieceSize = 262144,
            bitfield = bitfield
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun PiecesTabCompletePreview() {
    val bitfield = BitSet(8152).apply {
        set(0, 8152)
    }
    JSTorrentTheme {
        PiecesTab(
            piecesCompleted = 8152,
            piecesTotal = 8152,
            pieceSize = 262144,
            bitfield = bitfield
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun PiecesTabNoDataPreview() {
    JSTorrentTheme {
        PiecesTab(
            piecesCompleted = null,
            piecesTotal = null,
            pieceSize = null,
            bitfield = null
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun PiecesTabSmallTorrentPreview() {
    // Small torrent with 10 pieces
    val bitfield = BitSet(10).apply {
        set(0); set(2); set(5); set(7)
    }
    JSTorrentTheme {
        PiecesTab(
            piecesCompleted = 4,
            piecesTotal = 10,
            pieceSize = 16384,
            bitfield = bitfield
        )
    }
}
