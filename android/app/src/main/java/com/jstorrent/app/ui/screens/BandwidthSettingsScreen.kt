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
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
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

private data class SpeedPreset(val bytesPerSec: Int, val label: String)

private val speedPresets = listOf(
    SpeedPreset(0, "Unlimited"),
    SpeedPreset(102400, "100 KB/s"),
    SpeedPreset(512000, "500 KB/s"),
    SpeedPreset(1048576, "1 MB/s"),
    SpeedPreset(5242880, "5 MB/s"),
    SpeedPreset(10485760, "10 MB/s")
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun BandwidthSettingsScreen(
    viewModel: SettingsViewModel,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text("Bandwidth") },
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
                SectionHeader(title = "Speed Limits")
            }

            item {
                BandwidthSection(
                    downloadUnlimited = uiState.downloadSpeedUnlimited,
                    downloadLimit = uiState.downloadSpeedLimit,
                    uploadUnlimited = uiState.uploadSpeedUnlimited,
                    uploadLimit = uiState.uploadSpeedLimit,
                    onDownloadUnlimitedChange = { viewModel.setDownloadSpeedUnlimited(it) },
                    onDownloadLimitChange = { viewModel.setDownloadSpeedLimit(it) },
                    onUploadUnlimitedChange = { viewModel.setUploadSpeedUnlimited(it) },
                    onUploadLimitChange = { viewModel.setUploadSpeedLimit(it) }
                )
            }
        }
    }
}

@Composable
private fun BandwidthSection(
    downloadUnlimited: Boolean,
    downloadLimit: Int,
    uploadUnlimited: Boolean,
    uploadLimit: Int,
    onDownloadUnlimitedChange: (Boolean) -> Unit,
    onDownloadLimitChange: (Int) -> Unit,
    onUploadUnlimitedChange: (Boolean) -> Unit,
    onUploadLimitChange: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
    ) {
        SpeedLimitRow(
            label = "Download",
            currentValue = if (downloadUnlimited) 0 else downloadLimit,
            onValueChange = { value ->
                if (value == 0) {
                    onDownloadUnlimitedChange(true)
                } else {
                    onDownloadUnlimitedChange(false)
                    onDownloadLimitChange(value)
                }
            }
        )
        Spacer(modifier = Modifier.height(8.dp))
        SpeedLimitRow(
            label = "Upload",
            currentValue = if (uploadUnlimited) 0 else uploadLimit,
            onValueChange = { value ->
                if (value == 0) {
                    onUploadUnlimitedChange(true)
                } else {
                    onUploadUnlimitedChange(false)
                    onUploadLimitChange(value)
                }
            }
        )
    }
}

@Composable
private fun SpeedLimitRow(
    label: String,
    currentValue: Int,
    onValueChange: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    var expanded by remember { mutableStateOf(false) }
    val currentPreset = speedPresets.find { it.bytesPerSec == currentValue }
        ?: SpeedPreset(currentValue, formatSpeed(currentValue))

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge
        )
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
                speedPresets.forEach { preset ->
                    DropdownMenuItem(
                        text = { Text(preset.label) },
                        onClick = {
                            onValueChange(preset.bytesPerSec)
                            expanded = false
                        },
                        trailingIcon = if (preset.bytesPerSec == currentValue) {
                            { Icon(Icons.Default.Check, contentDescription = "Selected") }
                        } else null
                    )
                }
            }
        }
    }
}
