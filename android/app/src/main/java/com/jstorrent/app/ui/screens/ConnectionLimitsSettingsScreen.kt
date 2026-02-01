package com.jstorrent.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.jstorrent.app.viewmodel.SettingsViewModel

private data class ConnectionLimitPreset(val value: Int, val label: String)

private val maxPeersPerTorrentPresets = listOf(
    ConnectionLimitPreset(5, "5"),
    ConnectionLimitPreset(10, "10"),
    ConnectionLimitPreset(20, "20"),
    ConnectionLimitPreset(50, "50"),
    ConnectionLimitPreset(100, "100")
)

private val maxGlobalPeersPresets = listOf(
    ConnectionLimitPreset(50, "50"),
    ConnectionLimitPreset(100, "100"),
    ConnectionLimitPreset(200, "200"),
    ConnectionLimitPreset(500, "500"),
    ConnectionLimitPreset(1000, "1000")
)

private val maxUploadSlotsPresets = listOf(
    ConnectionLimitPreset(0, "0 (disabled)"),
    ConnectionLimitPreset(2, "2"),
    ConnectionLimitPreset(4, "4"),
    ConnectionLimitPreset(8, "8"),
    ConnectionLimitPreset(16, "16")
)

private val maxPipelineDepthPresets = listOf(
    ConnectionLimitPreset(10, "10 (conservative)"),
    ConnectionLimitPreset(25, "25"),
    ConnectionLimitPreset(50, "50 (default)"),
    ConnectionLimitPreset(100, "100"),
    ConnectionLimitPreset(250, "250"),
    ConnectionLimitPreset(500, "500 (aggressive)")
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ConnectionLimitsSettingsScreen(
    viewModel: SettingsViewModel,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text("Connection Limits") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = "Back"
                        )
                    }
                }
            )
        }
    ) { innerPadding ->
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            item {
                SectionHeader(title = "Peer Limits")
            }

            item {
                ConnectionLimitsSection(
                    maxPeersPerTorrent = uiState.maxPeersPerTorrent,
                    maxGlobalPeers = uiState.maxGlobalPeers,
                    maxUploadSlots = uiState.maxUploadSlots,
                    maxPipelineDepth = uiState.maxPipelineDepth,
                    onMaxPeersPerTorrentChange = { viewModel.setMaxPeersPerTorrent(it) },
                    onMaxGlobalPeersChange = { viewModel.setMaxGlobalPeers(it) },
                    onMaxUploadSlotsChange = { viewModel.setMaxUploadSlots(it) },
                    onMaxPipelineDepthChange = { viewModel.setMaxPipelineDepth(it) }
                )
            }
        }
    }
}

@Composable
private fun ConnectionLimitsSection(
    maxPeersPerTorrent: Int,
    maxGlobalPeers: Int,
    maxUploadSlots: Int,
    maxPipelineDepth: Int,
    onMaxPeersPerTorrentChange: (Int) -> Unit,
    onMaxGlobalPeersChange: (Int) -> Unit,
    onMaxUploadSlotsChange: (Int) -> Unit,
    onMaxPipelineDepthChange: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
    ) {
        ConnectionLimitRow(
            label = "Max peers per torrent",
            description = "Maximum connections per torrent",
            currentValue = maxPeersPerTorrent,
            presets = maxPeersPerTorrentPresets,
            onValueChange = onMaxPeersPerTorrentChange
        )
        Spacer(modifier = Modifier.height(8.dp))
        ConnectionLimitRow(
            label = "Max global peers",
            description = "Maximum total connections",
            currentValue = maxGlobalPeers,
            presets = maxGlobalPeersPresets,
            onValueChange = onMaxGlobalPeersChange
        )
        Spacer(modifier = Modifier.height(8.dp))
        ConnectionLimitRow(
            label = "Max upload slots",
            description = "Simultaneous upload connections",
            currentValue = maxUploadSlots,
            presets = maxUploadSlotsPresets,
            onValueChange = onMaxUploadSlotsChange
        )
        Spacer(modifier = Modifier.height(16.dp))
        HorizontalDivider()
        Spacer(modifier = Modifier.height(16.dp))
        Text(
            text = "Advanced",
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary
        )
        Spacer(modifier = Modifier.height(8.dp))
        ConnectionLimitRow(
            label = "Pipeline depth",
            description = "Outstanding block requests per peer. Higher values improve speed on high-latency connections but use more memory.",
            currentValue = maxPipelineDepth,
            presets = maxPipelineDepthPresets,
            onValueChange = onMaxPipelineDepthChange
        )
    }
}

@Composable
private fun ConnectionLimitRow(
    label: String,
    description: String,
    currentValue: Int,
    presets: List<ConnectionLimitPreset>,
    onValueChange: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    var expanded by remember { mutableStateOf(false) }
    val currentPreset = presets.find { it.value == currentValue }
        ?: ConnectionLimitPreset(currentValue, currentValue.toString())

    Column(modifier = modifier.fillMaxWidth()) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(vertical = 4.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(modifier = Modifier.weight(1f)) {
                Text(
                    text = label,
                    style = MaterialTheme.typography.bodyLarge
                )
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Spacer(modifier = Modifier.width(8.dp))
            Box {
                OutlinedCard(
                    modifier = Modifier.clickable { expanded = true }
                ) {
                    Text(
                        text = currentPreset.label,
                        style = MaterialTheme.typography.bodyMedium,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
                DropdownMenu(
                    expanded = expanded,
                    onDismissRequest = { expanded = false }
                ) {
                    presets.forEach { preset ->
                        DropdownMenuItem(
                            text = { Text(preset.label) },
                            onClick = {
                                onValueChange(preset.value)
                                expanded = false
                            },
                            trailingIcon = if (preset.value == currentValue) {
                                { Icon(Icons.Default.Check, contentDescription = "Selected") }
                            } else null
                        )
                    }
                }
            }
        }
    }
}
