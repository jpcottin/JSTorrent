package com.jstorrent.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Extension
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.search.InstalledPluginRecord
import com.jstorrent.app.search.RecommendedSearchPlugin
import com.jstorrent.app.search.SearchPluginManifest
import com.jstorrent.app.ui.theme.JSTorrentTheme
import com.jstorrent.app.viewmodel.SearchPluginSettingsUiState
import com.jstorrent.app.viewmodel.SearchPluginSettingsViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchPluginSettingsScreen(
    viewModel: SearchPluginSettingsViewModel,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()
    SearchPluginSettingsContent(
        uiState = uiState,
        onNavigateBack = onNavigateBack,
        onSourceUrlChanged = viewModel::onSourceUrlChanged,
        onInstallFromUrl = viewModel::installFromUrl,
        onInstallRecommended = viewModel::installRecommendedPlugin,
        onSetPluginEnabled = viewModel::setPluginEnabled,
        onRemovePlugin = viewModel::removePlugin,
        modifier = modifier
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchPluginSettingsContent(
    uiState: SearchPluginSettingsUiState,
    onNavigateBack: () -> Unit,
    onSourceUrlChanged: (String) -> Unit,
    onInstallFromUrl: () -> Unit,
    onInstallRecommended: (RecommendedSearchPlugin) -> Unit,
    onSetPluginEnabled: (String, Boolean) -> Unit,
    onRemovePlugin: (String) -> Unit,
    modifier: Modifier = Modifier
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.search_plugins_title)) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.settings_back_button)
                        )
                    }
                },
                actions = {
                    if (uiState.isLoading) {
                        CircularProgressIndicator(
                            modifier = Modifier.padding(end = 16.dp),
                            strokeWidth = 2.dp
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
                SectionHeader(stringResource(R.string.search_plugins_recommended_section))
            }
            items(uiState.recommendedPlugins, key = { it.sourceUrl }) { plugin ->
                RecommendedPluginCard(
                    plugin = plugin,
                    isInstalled = uiState.installedPlugins.any { installed ->
                        installed.pluginId == plugin.manifest.id ||
                            installed.manifest.id == plugin.manifest.id ||
                            installed.sourceUrl == plugin.sourceUrl
                    },
                    onInstall = { onInstallRecommended(plugin) }
                )
            }

            item {
                SectionHeader(stringResource(R.string.search_plugins_installed_section))
            }
            if (uiState.installedPlugins.isEmpty()) {
                item {
                    Text(
                        text = stringResource(R.string.search_plugins_empty_installed),
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
            } else {
                items(uiState.installedPlugins, key = { it.pluginId }) { plugin ->
                    InstalledPluginCard(
                        plugin = plugin,
                        onSetPluginEnabled = onSetPluginEnabled,
                        onRemovePlugin = onRemovePlugin
                    )
                }
            }

            item {
                SectionHeader(stringResource(R.string.search_plugins_add_from_url_section))
            }
            item {
                AddFromUrlCard(
                    sourceUrl = uiState.sourceUrl,
                    isBusy = uiState.isLoading,
                    onSourceUrlChanged = onSourceUrlChanged,
                    onInstallFromUrl = onInstallFromUrl
                )
            }

            uiState.statusMessage?.let { message ->
                item {
                    StatusMessage(
                        message = message,
                        isError = false
                    )
                }
            }
            uiState.errorMessage?.let { message ->
                item {
                    StatusMessage(
                        message = message,
                        isError = true
                    )
                }
            }
        }
    }
}

@Composable
private fun RecommendedPluginCard(
    plugin: RecommendedSearchPlugin,
    isInstalled: Boolean,
    onInstall: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .padding(16.dp),
            horizontalArrangement = Arrangement.SpaceBetween,
            verticalAlignment = Alignment.CenterVertically
        ) {
            Column(
                modifier = Modifier.weight(1f)
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Icon(
                        imageVector = Icons.Default.Extension,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.primary
                    )
                    Text(
                        text = plugin.manifest.name,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(start = 12.dp)
                    )
                }
                plugin.manifest.description?.let { description ->
                    Text(
                        text = description,
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = 8.dp)
                    )
                }
            }
            Button(
                onClick = onInstall,
                enabled = !isInstalled
            ) {
                Text(
                    text = if (isInstalled) {
                        stringResource(R.string.search_plugins_installed_button)
                    } else {
                        stringResource(R.string.search_plugins_install_button)
                    }
                )
            }
        }
    }
}

@Composable
private fun InstalledPluginCard(
    plugin: InstalledPluginRecord,
    onSetPluginEnabled: (String, Boolean) -> Unit,
    onRemovePlugin: (String) -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Text(
                text = plugin.manifest.name,
                style = MaterialTheme.typography.titleMedium
            )
            plugin.manifest.description?.let { description ->
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
            Text(
                text = plugin.manifest.hosts.joinToString(),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp)
            )
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = 12.dp),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalAlignment = Alignment.CenterVertically
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = stringResource(R.string.search_plugins_enabled_label),
                        style = MaterialTheme.typography.bodyLarge
                    )
                    Switch(
                        checked = plugin.enabled,
                        onCheckedChange = { enabled ->
                            onSetPluginEnabled(plugin.pluginId, enabled)
                        },
                        modifier = Modifier.padding(start = 12.dp)
                    )
                }
                TextButton(
                    onClick = { onRemovePlugin(plugin.pluginId) }
                ) {
                    Text(stringResource(R.string.search_plugins_remove_button))
                }
            }
        }
    }
}

@Composable
private fun AddFromUrlCard(
    sourceUrl: String,
    isBusy: Boolean,
    onSourceUrlChanged: (String) -> Unit,
    onInstallFromUrl: () -> Unit
) {
    Card(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            OutlinedTextField(
                value = sourceUrl,
                onValueChange = onSourceUrlChanged,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.search_plugins_add_from_url_label)) },
                placeholder = { Text("https://example.com/plugin.js") },
                singleLine = true
            )
            Button(
                onClick = onInstallFromUrl,
                enabled = !isBusy,
                modifier = Modifier.padding(top = 12.dp)
            ) {
                Text(stringResource(R.string.search_plugins_install_button))
            }
        }
    }
}

@Composable
private fun StatusMessage(
    message: String,
    isError: Boolean
) {
    Text(
        text = message,
        style = MaterialTheme.typography.bodyMedium,
        color = if (isError) {
            MaterialTheme.colorScheme.error
        } else {
            MaterialTheme.colorScheme.primary
        },
        modifier = Modifier.padding(horizontal = 16.dp, vertical = 12.dp)
    )
}

@Preview(showBackground = true)
@Composable
private fun SearchPluginSettingsScreenPreview() {
    JSTorrentTheme {
        SearchPluginSettingsContent(
            uiState = SearchPluginSettingsUiState(
                recommendedPlugins = listOf(
                    RecommendedSearchPlugin(
                        manifest = SearchPluginManifest(
                            id = "org.archive.search",
                            name = "Internet Archive",
                            description = "First-party provider for public-domain and openly licensed media.",
                            hosts = listOf("archive.org")
                        ),
                        sourceUrl = "https://example.com/archive.js"
                    )
                ),
                installedPlugins = listOf(
                    InstalledPluginRecord(
                        pluginId = "org.archive.search",
                        manifest = SearchPluginManifest(
                            id = "org.archive.search",
                            name = "Internet Archive",
                            description = "Public-domain media search.",
                            hosts = listOf("archive.org")
                        ),
                        sourceHash = "abc",
                        installedAt = 1L,
                        updatedAt = 1L,
                        enabled = true,
                        code = "code"
                    )
                ),
                sourceUrl = "https://example.com/plugin.js",
                statusMessage = "Plugin installed"
            ),
            onNavigateBack = {},
            onSourceUrlChanged = {},
            onInstallFromUrl = {},
            onInstallRecommended = {},
            onSetPluginEnabled = { _, _ -> },
            onRemovePlugin = {}
        )
    }
}
