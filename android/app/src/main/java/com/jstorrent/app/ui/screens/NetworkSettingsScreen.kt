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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
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
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.viewmodel.SettingsViewModel

private data class EncryptionOption(val value: String, val labelResId: Int)

private val encryptionOptions = listOf(
    EncryptionOption("disabled", R.string.settings_network_encryption_disabled),
    EncryptionOption("allow", R.string.settings_network_encryption_allow),
    EncryptionOption("prefer", R.string.settings_network_encryption_prefer),
    EncryptionOption("required", R.string.settings_network_encryption_required)
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
                title = { Text(stringResource(R.string.settings_network_title)) },
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
                SectionHeader(title = stringResource(R.string.settings_network_connection_section))
            }

            item {
                NetworkSection(
                    wifiOnly = uiState.wifiOnlyEnabled,
                    vpnOnly = uiState.vpnOnlyEnabled,
                    encryptionPolicy = uiState.encryptionPolicy,
                    dhtEnabled = uiState.dhtEnabled,
                    pexEnabled = uiState.pexEnabled,
                    upnpEnabled = uiState.upnpEnabled,
                    upnpStatus = uiState.upnpStatus,
                    upnpExternalIP = uiState.upnpExternalIP,
                    upnpPort = uiState.upnpPort,
                    hasReceivedIncomingConnection = uiState.hasReceivedIncomingConnection,
                    proxyEnabled = uiState.proxyEnabled,
                    proxyHost = uiState.proxyHost,
                    proxyPort = uiState.proxyPort,
                    onWifiOnlyChange = { viewModel.setWifiOnly(it) },
                    onVpnOnlyChange = { viewModel.setVpnOnly(it) },
                    onEncryptionPolicyChange = { viewModel.setEncryptionPolicy(it) },
                    onDhtChange = { viewModel.setDhtEnabled(it) },
                    onPexChange = { viewModel.setPexEnabled(it) },
                    onUpnpChange = { viewModel.setUpnpEnabled(it) },
                    onDhtInfoClick = onDhtInfoClick,
                    onProxyClick = { viewModel.showProxyDialog() }
                )
            }
        }
    }

    // Proxy configuration dialog
    if (uiState.showProxyDialog) {
        ProxyConfigDialog(
            enabled = uiState.proxyEnabled,
            host = uiState.proxyHost ?: "",
            port = uiState.proxyPort,
            username = uiState.proxyUsername ?: "",
            password = uiState.proxyPassword ?: "",
            httpTrackers = uiState.proxyHttpTrackers,
            udpTrackers = uiState.proxyUdpTrackers,
            peerConnections = uiState.proxyPeerConnections,
            onDismiss = { viewModel.dismissProxyDialog() },
            onEnabledChange = { viewModel.setProxyEnabled(it) },
            onSave = { host, port, username, password, httpTrackers, udpTrackers, peerConnections ->
                viewModel.saveProxyConfig(host, port, username, password, httpTrackers, udpTrackers, peerConnections)
            }
        )
    }
}

@Composable
private fun NetworkSection(
    wifiOnly: Boolean,
    vpnOnly: Boolean,
    encryptionPolicy: String,
    dhtEnabled: Boolean,
    pexEnabled: Boolean,
    upnpEnabled: Boolean,
    upnpStatus: String,
    upnpExternalIP: String?,
    upnpPort: Int,
    hasReceivedIncomingConnection: Boolean,
    proxyEnabled: Boolean,
    proxyHost: String?,
    proxyPort: Int,
    onWifiOnlyChange: (Boolean) -> Unit,
    onVpnOnlyChange: (Boolean) -> Unit,
    onEncryptionPolicyChange: (String) -> Unit,
    onDhtChange: (Boolean) -> Unit,
    onPexChange: (Boolean) -> Unit,
    onUpnpChange: (Boolean) -> Unit,
    onDhtInfoClick: () -> Unit,
    onProxyClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    Column(
        modifier = modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp)
    ) {
        // WiFi-only toggle
        SettingToggleRow(
            label = stringResource(R.string.settings_network_wifi_only_label),
            description = stringResource(R.string.settings_network_wifi_only_description),
            checked = wifiOnly,
            onCheckedChange = onWifiOnlyChange
        )

        Spacer(modifier = Modifier.height(8.dp))

        // VPN-only toggle
        SettingToggleRow(
            label = stringResource(R.string.settings_network_vpn_only_label),
            description = stringResource(R.string.settings_network_vpn_only_description),
            checked = vpnOnly,
            onCheckedChange = onVpnOnlyChange
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
            label = stringResource(R.string.settings_network_dht_label),
            description = stringResource(R.string.settings_network_dht_description),
            checked = dhtEnabled,
            onCheckedChange = onDhtChange
        )

        // DHT info link
        Text(
            text = stringResource(R.string.settings_network_view_dht_info),
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.primary,
            modifier = Modifier
                .clickable(onClick = onDhtInfoClick)
                .padding(start = 4.dp, top = 4.dp, bottom = 8.dp)
        )

        Spacer(modifier = Modifier.height(8.dp))

        // PEX toggle
        SettingToggleRow(
            label = stringResource(R.string.settings_network_pex_label),
            description = stringResource(R.string.settings_network_pex_description),
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

        Spacer(modifier = Modifier.height(8.dp))

        // SOCKS5 Proxy row
        ProxyRow(
            enabled = proxyEnabled,
            host = proxyHost,
            port = proxyPort,
            onClick = onProxyClick
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
    val discoveringText = stringResource(R.string.settings_network_upnp_discovering)
    val unavailableText = stringResource(R.string.settings_network_upnp_unavailable)
    val failedText = stringResource(R.string.settings_network_upnp_failed)
    val unknownText = stringResource(R.string.settings_network_upnp_unknown)
    val incomingVerifiedText = stringResource(R.string.settings_network_incoming_verified)
    val incomingNotVerifiedText = stringResource(R.string.settings_network_incoming_not_verified)

    // Determine status text and color
    val (statusText, statusColor) = when {
        !enabled -> "" to MaterialTheme.colorScheme.onSurfaceVariant
        status == "discovering" -> discoveringText to MaterialTheme.colorScheme.onSurfaceVariant
        status == "mapped" -> {
            val portStr = if (port > 0) ":$port" else ""
            val ipStr = externalIP ?: unknownText
            "$ipStr$portStr" to MaterialTheme.colorScheme.primary
        }
        status == "unavailable" -> unavailableText to MaterialTheme.colorScheme.onSurfaceVariant
        status == "failed" -> failedText to MaterialTheme.colorScheme.error
        else -> "" to MaterialTheme.colorScheme.onSurfaceVariant
    }

    // Incoming connection status (only show when enabled)
    val incomingStatusText = if (enabled && status == "mapped") {
        if (hasReceivedIncomingConnection) incomingVerifiedText else incomingNotVerifiedText
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
                text = stringResource(R.string.settings_network_upnp_label),
                style = MaterialTheme.typography.bodyLarge
            )
            Text(
                text = stringResource(R.string.settings_network_upnp_description),
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
            text = stringResource(R.string.settings_network_encryption_label),
            style = MaterialTheme.typography.bodyLarge
        )
        Box {
            OutlinedCard(
                modifier = Modifier.clickable { expanded = true }
            ) {
                Text(
                    text = stringResource(currentOption.labelResId),
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
                        text = { Text(stringResource(option.labelResId)) },
                        onClick = {
                            onPolicyChange(option.value)
                            expanded = false
                        },
                        trailingIcon = if (option.value == currentPolicy) {
                            { Icon(Icons.Default.Check, contentDescription = stringResource(R.string.selected)) }
                        } else null
                    )
                }
            }
        }
    }
}

@Composable
private fun ProxyRow(
    enabled: Boolean,
    host: String?,
    port: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier
) {
    val disabledText = stringResource(R.string.settings_network_proxy_disabled)
    val statusText = if (enabled && host != null) {
        "$host:$port"
    } else {
        disabledText
    }
    val statusColor = if (enabled && host != null) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(onClick = onClick)
            .padding(vertical = 8.dp),
        horizontalArrangement = Arrangement.SpaceBetween,
        verticalAlignment = Alignment.CenterVertically
    ) {
        Column(modifier = Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.settings_network_proxy_label),
                style = MaterialTheme.typography.bodyLarge
            )
            Text(
                text = stringResource(R.string.settings_network_proxy_description),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Text(
                text = statusText,
                style = MaterialTheme.typography.bodySmall,
                color = statusColor
            )
        }
    }
}

@Composable
private fun ProxyConfigDialog(
    enabled: Boolean,
    host: String,
    port: Int,
    username: String,
    password: String,
    httpTrackers: Boolean,
    udpTrackers: Boolean,
    peerConnections: Boolean,
    onDismiss: () -> Unit,
    onEnabledChange: (Boolean) -> Unit,
    onSave: (host: String, port: Int, username: String?, password: String?, httpTrackers: Boolean, udpTrackers: Boolean, peerConnections: Boolean) -> Unit
) {
    var editHost by remember { mutableStateOf(host) }
    var editPort by remember { mutableStateOf(port.toString()) }
    var editUsername by remember { mutableStateOf(username) }
    var editPassword by remember { mutableStateOf(password) }
    var editHttpTrackers by remember { mutableStateOf(httpTrackers) }
    var editUdpTrackers by remember { mutableStateOf(udpTrackers) }
    var editPeerConnections by remember { mutableStateOf(peerConnections) }

    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.settings_network_proxy_label)) },
        text = {
            Column(
                modifier = Modifier.fillMaxWidth(),
                verticalArrangement = Arrangement.spacedBy(12.dp)
            ) {
                // Enable/disable toggle
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = stringResource(R.string.settings_network_proxy_enable_label),
                        style = MaterialTheme.typography.bodyLarge
                    )
                    Switch(
                        checked = enabled,
                        onCheckedChange = onEnabledChange
                    )
                }

                // Host input
                OutlinedTextField(
                    value = editHost,
                    onValueChange = { editHost = it },
                    label = { Text(stringResource(R.string.settings_network_proxy_host_label)) },
                    placeholder = { Text(stringResource(R.string.settings_network_proxy_host_placeholder)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                // Port input
                OutlinedTextField(
                    value = editPort,
                    onValueChange = { editPort = it.filter { c -> c.isDigit() } },
                    label = { Text(stringResource(R.string.settings_network_proxy_port_label)) },
                    placeholder = { Text(stringResource(R.string.settings_network_proxy_port_placeholder)) },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                    modifier = Modifier.fillMaxWidth()
                )

                // Username input (optional)
                OutlinedTextField(
                    value = editUsername,
                    onValueChange = { editUsername = it },
                    label = { Text(stringResource(R.string.settings_network_proxy_username_label)) },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth()
                )

                // Password input (optional)
                OutlinedTextField(
                    value = editPassword,
                    onValueChange = { editPassword = it },
                    label = { Text(stringResource(R.string.settings_network_proxy_password_label)) },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password),
                    modifier = Modifier.fillMaxWidth()
                )

                // Route through proxy section
                Text(
                    text = stringResource(R.string.settings_network_proxy_route_section),
                    style = MaterialTheme.typography.titleSmall,
                    modifier = Modifier.padding(top = 8.dp)
                )

                // HTTP trackers toggle
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = stringResource(R.string.settings_network_proxy_http_trackers),
                        style = MaterialTheme.typography.bodyMedium
                    )
                    Switch(
                        checked = editHttpTrackers,
                        onCheckedChange = { editHttpTrackers = it }
                    )
                }

                // UDP trackers toggle
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(modifier = Modifier.weight(1f)) {
                        Text(
                            text = stringResource(R.string.settings_network_proxy_udp_trackers),
                            style = MaterialTheme.typography.bodyMedium
                        )
                        Text(
                            text = stringResource(R.string.settings_network_proxy_udp_note),
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    Spacer(modifier = Modifier.width(8.dp))
                    Switch(
                        checked = editUdpTrackers,
                        onCheckedChange = { editUdpTrackers = it }
                    )
                }

                // Peer connections toggle
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Text(
                        text = stringResource(R.string.settings_network_proxy_peer_connections),
                        style = MaterialTheme.typography.bodyMedium
                    )
                    Switch(
                        checked = editPeerConnections,
                        onCheckedChange = { editPeerConnections = it }
                    )
                }
            }
        },
        confirmButton = {
            TextButton(
                onClick = {
                    val portNum = editPort.toIntOrNull() ?: 1080
                    onSave(
                        editHost,
                        portNum,
                        editUsername.ifBlank { null },
                        editPassword.ifBlank { null },
                        editHttpTrackers,
                        editUdpTrackers,
                        editPeerConnections
                    )
                }
            ) {
                Text(stringResource(R.string.save))
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text(stringResource(R.string.cancel))
            }
        }
    )
}
