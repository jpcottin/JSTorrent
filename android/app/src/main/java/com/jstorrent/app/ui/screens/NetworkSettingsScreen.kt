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
import androidx.compose.material3.Switch
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

private data class EncryptionOption(val value: String, val label: String)

private val encryptionOptions = listOf(
    EncryptionOption("disabled", "Disabled"),
    EncryptionOption("allow", "Allow"),
    EncryptionOption("prefer", "Prefer"),
    EncryptionOption("required", "Required")
)

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun NetworkSettingsScreen(
    viewModel: SettingsViewModel,
    onNavigateBack: () -> Unit,
    onDhtInfoClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()

    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text("Network") },
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
                SectionHeader(title = "Connection")
            }

            item {
                NetworkSection(
                    wifiOnly = uiState.wifiOnlyEnabled,
                    encryptionPolicy = uiState.encryptionPolicy,
                    dhtEnabled = uiState.dhtEnabled,
                    pexEnabled = uiState.pexEnabled,
                    upnpEnabled = uiState.upnpEnabled,
                    upnpStatus = uiState.upnpStatus,
                    upnpExternalIP = uiState.upnpExternalIP,
                    upnpPort = uiState.upnpPort,
                    hasReceivedIncomingConnection = uiState.hasReceivedIncomingConnection,
                    onWifiOnlyChange = { viewModel.setWifiOnly(it) },
                    onEncryptionPolicyChange = { viewModel.setEncryptionPolicy(it) },
                    onDhtChange = { viewModel.setDhtEnabled(it) },
                    onPexChange = { viewModel.setPexEnabled(it) },
                    onUpnpChange = { viewModel.setUpnpEnabled(it) },
                    onDhtInfoClick = onDhtInfoClick
                )
            }
        }
    }
}

@Composable
private fun NetworkSection(
    wifiOnly: Boolean,
    encryptionPolicy: String,
    dhtEnabled: Boolean,
    pexEnabled: Boolean,
    upnpEnabled: Boolean,
    upnpStatus: String,
    upnpExternalIP: String?,
    upnpPort: Int,
    hasReceivedIncomingConnection: Boolean,
    onWifiOnlyChange: (Boolean) -> Unit,
    onEncryptionPolicyChange: (String) -> Unit,
    onDhtChange: (Boolean) -> Unit,
    onPexChange: (Boolean) -> Unit,
    onUpnpChange: (Boolean) -> Unit,
    onDhtInfoClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
    ) {
        // WiFi-only toggle
        SettingToggleRow(
            label = "WiFi-only",
            description = "Pause downloads on mobile data",
            checked = wifiOnly,
            onCheckedChange = onWifiOnlyChange
        )

        Spacer(modifier = Modifier.height(8.dp))

        // Protocol encryption dropdown
        EncryptionRow(
            currentPolicy = encryptionPolicy,
            onPolicyChange = onEncryptionPolicyChange
        )

        Spacer(modifier = Modifier.height(8.dp))

        // DHT toggle
        SettingToggleRow(
            label = "DHT",
            description = "Distributed Hash Table for finding peers",
            checked = dhtEnabled,
            onCheckedChange = onDhtChange
        )

        // DHT info link
        Text(
            text = "View DHT Info",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .clickable(onClick = onDhtInfoClick)
                .padding(start = 4.dp, top = 4.dp, bottom = 8.dp)
        )

        Spacer(modifier = Modifier.height(8.dp))

        // PEX toggle
        SettingToggleRow(
            label = "PEX (Peer Exchange)",
            description = "Share peer lists with other clients",
            checked = pexEnabled,
            onCheckedChange = onPexChange
        )

        Spacer(modifier = Modifier.height(8.dp))

        // UPnP toggle with status
        UpnpRow(
            enabled = upnpEnabled,
            status = upnpStatus,
            externalIP = upnpExternalIP,
            port = upnpPort,
            hasReceivedIncomingConnection = hasReceivedIncomingConnection,
            onEnabledChange = onUpnpChange
        )
    }
}

@Composable
private fun UpnpRow(
    enabled: Boolean,
    status: String,
    externalIP: String?,
    port: Int,
    hasReceivedIncomingConnection: Boolean,
    onEnabledChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier
) {
    // Determine status text and color
    val (statusText, statusColor) = when {
        !enabled -> "" to MaterialTheme.colorScheme.onSurfaceVariant
        status == "discovering" -> "Discovering..." to MaterialTheme.colorScheme.onSurfaceVariant
        status == "mapped" -> {
            val portStr = if (port > 0) ":$port" else ""
            val ipStr = externalIP ?: "Unknown"
            "$ipStr$portStr" to MaterialTheme.colorScheme.primary
        }
        status == "unavailable" -> "No UPnP gateway found" to MaterialTheme.colorScheme.onSurfaceVariant
        status == "failed" -> "Port mapping failed" to MaterialTheme.colorScheme.error
        else -> "" to MaterialTheme.colorScheme.onSurfaceVariant
    }

    // Incoming connection status (only show when enabled)
    val incomingStatusText = if (enabled && status == "mapped") {
        if (hasReceivedIncomingConnection) "Incoming: verified" else "Incoming: not yet verified"
    } else ""
    val incomingStatusColor = if (hasReceivedIncomingConnection) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable { onEnabledChange(!enabled) }
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = "UPnP Port Forwarding",
                style = MaterialTheme.typography.bodyLarge
            )
            Text(
                text = "Automatically configure router port forwarding",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            if (enabled && statusText.isNotEmpty()) {
                Text(
                    text = statusText,
                    style = MaterialTheme.typography.bodySmall,
                    color = statusColor
                )
            }
            if (incomingStatusText.isNotEmpty()) {
                Text(
                    text = incomingStatusText,
                    style = MaterialTheme.typography.bodySmall,
                    color = incomingStatusColor
                )
            }
        }
        Switch(
            checked = enabled,
            onCheckedChange = onEnabledChange
        )
    }
}

@Composable
private fun EncryptionRow(
    currentPolicy: String,
    onPolicyChange: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    var expanded by remember { mutableStateOf(false) }
    val currentOption = encryptionOptions.find { it.value == currentPolicy }
        ?: encryptionOptions[1] // Default to "allow"

    Row(
        modifier = modifier
            .fillMaxWidth()
            .padding(vertical = 4.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Text(
            text = "Protocol encryption",
            style = MaterialTheme.typography.bodyLarge
        )
        Box {
            OutlinedCard(
                modifier = Modifier.clickable { expanded = true }
            ) {
                Text(
                    text = currentOption.label,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                )
            }
            DropdownMenu(
                expanded = expanded,
                onDismissRequest = { expanded = false }
            ) {
                encryptionOptions.forEach { option ->
                    DropdownMenuItem(
                        text = { Text(option.label) },
                        onClick = {
                            onPolicyChange(option.value)
                            expanded = false
                        },
                        trailingIcon = if (option.value == currentPolicy) {
                            { Icon(Icons.Default.Check, contentDescription = "Selected") }
                        } else null
                    )
                }
            }
        }
    }
}
