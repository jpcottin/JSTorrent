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
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.NotificationsOff
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.viewmodel.SettingsViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NotificationsSettingsScreen(
    viewModel: SettingsViewModel,
    onNavigateBack: () -> Unit,
    onRequestNotificationPermission: () -> Unit,
    onOpenNotificationSettings: () -> Unit,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.settings_notifications_title)) },
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
                SectionHeader(title = stringResource(R.string.settings_notifications_permission_section))
            }

            item {
                NotificationsSection(
                    permissionGranted = uiState.notificationPermissionGranted,
                    canRequestInline = uiState.canRequestNotificationPermission,
                    onRequestPermission = onRequestNotificationPermission,
                    onOpenSettings = onOpenNotificationSettings
                )
            }
        }
    }
}

@Composable
private fun NotificationsSection(
    permissionGranted: Boolean,
    canRequestInline: Boolean,
    onRequestPermission: () -> Unit,
    onOpenSettings: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(modifier = modifier.fillMaxWidth()) {
        Card(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = 16.dp),
            colors = CardDefaults.cardColors(
                containerColor = if (permissionGranted) {
                    MaterialTheme.colorScheme.surface
                } else {
                    MaterialTheme.colorScheme.errorContainer.copy(alpha = 0.3f)
                }
            )
        ) {
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    imageVector = if (permissionGranted) {
                        Icons.Default.Notifications
                    } else {
                        Icons.Default.NotificationsOff
                    },
                    contentDescription = null,
                    modifier = Modifier.size(24.dp),
                    tint = if (permissionGranted) {
                        MaterialTheme.colorScheme.primary
                    } else {
                        MaterialTheme.colorScheme.error
                    }
                )
                Spacer(modifier = Modifier.width(12.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = stringResource(if (permissionGranted) R.string.settings_notifications_enabled else R.string.settings_notifications_disabled),
                        style = MaterialTheme.typography.bodyLarge
                    )
                    if (!permissionGranted) {
                        Text(
                            text = stringResource(R.string.settings_notifications_required_for_background),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                if (!permissionGranted) {
                    Button(
                        onClick = if (canRequestInline) onRequestPermission else onOpenSettings
                    ) {
                        Text(stringResource(if (canRequestInline) R.string.settings_notifications_enable_button else R.string.settings_notifications_settings_button))
                    }
                }
            }
        }

        // Always show link to system notification settings
        Text(
            text = stringResource(R.string.settings_notifications_manage_preferences),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .clickable(onClick = onOpenSettings)
                .padding(horizontal = 20.dp, vertical = 12.dp)
        )
    }
}
