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
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
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
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.ui.dialogs.NotificationRequiredDialog
import com.jstorrent.app.viewmodel.SettingsViewModel

private data class BatteryThresholdPreset(val value: Int, val label: String)

private val batteryThresholdPresets = listOf(
    BatteryThresholdPreset(5, "5%"),
    BatteryThresholdPreset(10, "10%"),
    BatteryThresholdPreset(15, "15%"),
    BatteryThresholdPreset(20, "20%"),
    BatteryThresholdPreset(25, "25%"),
    BatteryThresholdPreset(30, "30%")
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun PowerManagementSettingsScreen(
    viewModel: SettingsViewModel,
    onNavigateBack: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_power_title)) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.back)
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
                SectionHeader(title = stringResource(R.string.settings_power_background_section))
            }

            item {
                PowerManagementSection(
                    backgroundDownloadsEnabled = uiState.backgroundDownloadsEnabled,
                    notificationPermissionGranted = uiState.notificationPermissionGranted,
                    onBackgroundDownloadsChange = { viewModel.setBackgroundDownloadsEnabled(it) },
                    cpuWakeLockEnabled = uiState.cpuWakeLockEnabled,
                    onCpuWakeLockChange = { viewModel.setCpuWakeLockEnabled(it) },
                    whenDownloadsComplete = uiState.whenDownloadsComplete,
                    onWhenDownloadsCompleteChange = { viewModel.setWhenDownloadsComplete(it) },
                    onKeepSeedingRequested = { viewModel.requestEnableKeepSeeding() },
                    shutdownOnLowBatteryEnabled = uiState.shutdownOnLowBatteryEnabled,
                    onShutdownOnLowBatteryChange = { viewModel.setShutdownOnLowBatteryEnabled(it) },
                    shutdownOnLowBatteryThreshold = uiState.shutdownOnLowBatteryThreshold,
                    onShutdownOnLowBatteryThresholdChange = { viewModel.setShutdownOnLowBatteryThreshold(it) }
                )
            }
        }
    }

    // Notification required dialog
    if (uiState.showNotificationRequiredDialog) {
        NotificationRequiredDialog(
            onOpenSettings = {
                viewModel.dismissNotificationRequiredDialog()
                onOpenNotificationSettings()
            },
            onDismiss = { viewModel.dismissNotificationRequiredDialog() }
        )
    }

    // Keep seeding battery warning dialog
    if (uiState.showKeepSeedingWarningDialog) {
        KeepSeedingWarningDialog(
            onConfirm = { viewModel.confirmKeepSeeding() },
            onDismiss = { viewModel.dismissKeepSeedingWarningDialog() }
        )
    }
}

@Composable
private fun PowerManagementSection(
    backgroundDownloadsEnabled: Boolean,
    notificationPermissionGranted: Boolean,
    onBackgroundDownloadsChange: (Boolean) -> Unit,
    cpuWakeLockEnabled: Boolean,
    onCpuWakeLockChange: (Boolean) -> Unit,
    whenDownloadsComplete: String,
    onWhenDownloadsCompleteChange: (String) -> Unit,
    onKeepSeedingRequested: () -> Unit,
    shutdownOnLowBatteryEnabled: Boolean,
    onShutdownOnLowBatteryChange: (Boolean) -> Unit,
    shutdownOnLowBatteryThreshold: Int,
    onShutdownOnLowBatteryThresholdChange: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    val backgroundDescriptionEnabled = stringResource(R.string.settings_power_background_downloads_description)
    val backgroundDescriptionDisabled = stringResource(R.string.settings_power_background_downloads_requires_permission)
    val preventSleepDescriptionEnabled = stringResource(R.string.settings_power_prevent_sleep_description)
    val preventSleepDescriptionDisabled = stringResource(R.string.settings_power_prevent_sleep_requires_background)

    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
    ) {
        SettingToggleRow(
            label = stringResource(R.string.settings_power_background_downloads_label),
            description = if (notificationPermissionGranted) {
                backgroundDescriptionEnabled
            } else {
                backgroundDescriptionDisabled
            },
            checked = backgroundDownloadsEnabled,
            onCheckedChange = onBackgroundDownloadsChange
        )

        Spacer(modifier = Modifier.height(8.dp))

        SettingToggleRow(
            label = stringResource(R.string.settings_power_prevent_sleep_label),
            description = if (backgroundDownloadsEnabled) {
                preventSleepDescriptionEnabled
            } else {
                preventSleepDescriptionDisabled
            },
            checked = cpuWakeLockEnabled,
            onCheckedChange = onCpuWakeLockChange,
            enabled = backgroundDownloadsEnabled
        )

        Spacer(modifier = Modifier.height(16.dp))
        HorizontalDivider()
        Spacer(modifier = Modifier.height(16.dp))

        Text(
            text = stringResource(R.string.settings_power_battery_section),
            style = MaterialTheme.typography.titleSmall,
            color = MaterialTheme.colorScheme.primary
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Shutdown on low battery toggle
        SettingToggleRow(
            label = stringResource(R.string.settings_power_shutdown_low_battery_label),
            description = stringResource(R.string.settings_power_shutdown_low_battery_description),
            checked = shutdownOnLowBatteryEnabled,
            onCheckedChange = onShutdownOnLowBatteryChange
        )

        // Threshold selector (only shown when enabled)
        if (shutdownOnLowBatteryEnabled) {
            BatteryThresholdRow(
                currentThreshold = shutdownOnLowBatteryThreshold,
                onThresholdChange = onShutdownOnLowBatteryThresholdChange
            )
        }

        Spacer(modifier = Modifier.height(16.dp))
        HorizontalDivider()
        Spacer(modifier = Modifier.height(16.dp))

        SettingToggleRow(
            label = stringResource(R.string.settings_power_keep_seeding_label),
            description = stringResource(R.string.settings_power_keep_seeding_description),
            checked = whenDownloadsComplete == "keep_seeding",
            onCheckedChange = { enabled ->
                if (enabled) {
                    onKeepSeedingRequested()
                } else {
                    onWhenDownloadsCompleteChange("stop_and_close")
                }
            }
        )
    }
}

@Composable
private fun BatteryThresholdRow(
    currentThreshold: Int,
    onThresholdChange: (Int) -> Unit,
    modifier: Modifier = Modifier
) {
    var expanded by remember { mutableStateOf(false) }
    val currentPreset = batteryThresholdPresets.find { it.value == currentThreshold }
        ?: BatteryThresholdPreset(currentThreshold, "$currentThreshold%")

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp, horizontal = 16.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = stringResource(R.string.settings_power_shutdown_threshold_label),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant
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
                batteryThresholdPresets.forEach { preset ->
                    DropdownMenuItem(
                        text = { Text(preset.label) },
                        onClick = {
                            onThresholdChange(preset.value)
                            expanded = false
                        },
                        trailingIcon = if (preset.value == currentThreshold) {
                            { Icon(Icons.Default.Check, contentDescription = stringResource(R.string.selected)) }
                        } else null
                    )
                }
            }
        }
    }
}

@Composable
private fun KeepSeedingWarningDialog(
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                imageVector = Icons.Default.BatteryChargingFull,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error
            )
        },
        title = { Text(stringResource(R.string.settings_power_battery_warning_title)) },
        text = {
            Text(stringResource(R.string.settings_power_battery_warning_message))
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text(stringResource(R.string.settings_power_enable_anyway))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.cancel))
            }
        }
    )
}
