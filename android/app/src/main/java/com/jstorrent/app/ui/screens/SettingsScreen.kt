package com.jstorrent.app.ui.screens

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.filled.BatteryChargingFull
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.People
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material.icons.filled.Speed
import androidx.compose.material.icons.filled.Wifi
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.ui.theme.JSTorrentTheme

/**
 * Settings hub screen - shows navigation links to settings sub-pages.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SettingsScreen(
    onNavigateBack: () -> Unit,
    onNavigateToSearchPlugins: () -> Unit,
    onNavigateToStorage: () -> Unit,
    onNavigateToSpeedConnectionLimits: () -> Unit,
    onNavigateToNotifications: () -> Unit,
    onNavigateToNetwork: () -> Unit,
    onNavigateToPower: () -> Unit,
    onNavigateToAdvanced: () -> Unit,
    modifier: Modifier = Modifier
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_title)) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.settings_back_button)
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
                SettingsNavItem(
                    icon = Icons.Default.Extension,
                    title = stringResource(R.string.search_plugins_title),
                    subtitle = stringResource(R.string.search_plugins_settings_description),
                    onClick = onNavigateToSearchPlugins
                )
            }
            item {
                SettingsNavItem(
                    icon = Icons.Default.Folder,
                    title = stringResource(R.string.settings_storage_title),
                    subtitle = stringResource(R.string.settings_storage_description),
                    onClick = onNavigateToStorage
                )
            }
            item {
                SettingsNavItem(
                    icon = Icons.Default.Speed,
                    title = stringResource(R.string.settings_speed_limits_title),
                    subtitle = stringResource(R.string.settings_speed_limits_description),
                    onClick = onNavigateToSpeedConnectionLimits
                )
            }
            item {
                SettingsNavItem(
                    icon = Icons.Default.Notifications,
                    title = stringResource(R.string.settings_notifications_title),
                    subtitle = stringResource(R.string.settings_notifications_description),
                    onClick = onNavigateToNotifications
                )
            }
            item {
                SettingsNavItem(
                    icon = Icons.Default.Wifi,
                    title = stringResource(R.string.settings_network_title),
                    subtitle = stringResource(R.string.settings_network_description),
                    onClick = onNavigateToNetwork
                )
            }
            item {
                SettingsNavItem(
                    icon = Icons.Default.BatteryChargingFull,
                    title = stringResource(R.string.settings_power_title),
                    subtitle = stringResource(R.string.settings_power_description),
                    onClick = onNavigateToPower
                )
            }
            item {
                SettingsNavItem(
                    icon = Icons.Default.Settings,
                    title = stringResource(R.string.settings_advanced_title),
                    subtitle = stringResource(R.string.settings_advanced_description),
                    onClick = onNavigateToAdvanced
                )
            }
        }
    }
}

@Composable
private fun SettingsNavItem(
    icon: ImageVector,
    title: String,
    subtitle: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(horizontal = 16.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            modifier = Modifier.size(24.dp),
            tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
        Spacer(modifier = Modifier.width(16.dp))
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = title,
                style = MaterialTheme.typography.bodyLarge
            )
            Text(
                text = subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
        Icon(
            imageVector = Icons.AutoMirrored.Filled.KeyboardArrowRight,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant
        )
    }
}

@Preview(showBackground = true)
@Composable
private fun SettingsHubPreview() {
    JSTorrentTheme {
        SettingsScreen(
            onNavigateBack = {},
            onNavigateToSearchPlugins = {},
            onNavigateToStorage = {},
            onNavigateToSpeedConnectionLimits = {},
            onNavigateToNotifications = {},
            onNavigateToNetwork = {},
            onNavigateToPower = {},
            onNavigateToAdvanced = {}
        )
    }
}
