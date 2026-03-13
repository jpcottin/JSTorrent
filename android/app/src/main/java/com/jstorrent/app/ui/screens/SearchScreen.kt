package com.jstorrent.app.ui.screens

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.search.RecommendedSearchPlugin
import com.jstorrent.app.search.SearchDisplayResult
import com.jstorrent.app.search.SearchPluginManifest
import com.jstorrent.app.search.SearchRunSummary
import com.jstorrent.app.ui.theme.JSTorrentTheme
import com.jstorrent.app.viewmodel.SearchUiState
import com.jstorrent.app.viewmodel.SearchViewModel

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreen(
    viewModel: SearchViewModel,
    onNavigateBack: () -> Unit,
    onManageSearchPlugins: () -> Unit,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()
    SearchScreenContent(
        uiState = uiState,
        onNavigateBack = onNavigateBack,
        onManageSearchPlugins = onManageSearchPlugins,
        onQueryChanged = viewModel::onQueryChanged,
        onCategoryChanged = viewModel::onCategoryChanged,
        onSearch = viewModel::search,
        onInstallRecommended = viewModel::installRecommendedPlugin,
        onAddResult = viewModel::addResult,
        modifier = modifier
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SearchScreenContent(
    uiState: SearchUiState,
    onNavigateBack: () -> Unit,
    onManageSearchPlugins: () -> Unit,
    onQueryChanged: (String) -> Unit,
    onCategoryChanged: (String?) -> Unit,
    onSearch: () -> Unit,
    onInstallRecommended: (RecommendedSearchPlugin) -> Unit,
    onAddResult: (SearchDisplayResult) -> Unit,
    modifier: Modifier = Modifier
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.search_title)) },
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
                SearchFormCard(
                    uiState = uiState,
                    onQueryChanged = onQueryChanged,
                    onCategoryChanged = onCategoryChanged,
                    onSearch = onSearch
                )
            }

            if (uiState.enabledPlugins.isEmpty()) {
                item {
                    EmptyPluginsCard(
                        recommendedPlugin = uiState.recommendedPlugins.firstOrNull(),
                        onInstallRecommended = onInstallRecommended,
                        onManageSearchPlugins = onManageSearchPlugins
                    )
                }
            } else if (uiState.results.isEmpty() && uiState.searchedOnce && !uiState.isSearching) {
                item {
                    Text(
                        text = stringResource(R.string.search_no_results),
                        style = MaterialTheme.typography.bodyLarge,
                        modifier = Modifier.padding(16.dp)
                    )
                }
            }

            if (uiState.isSearching) {
                item {
                    Box(
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(24.dp),
                        contentAlignment = Alignment.Center
                    ) {
                        CircularProgressIndicator()
                    }
                }
            }

            if (uiState.results.isNotEmpty()) {
                item {
                    Text(
                        text = stringResource(R.string.search_results_title),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
                items(uiState.results, key = { it.stableId }) { result ->
                    SearchResultCard(
                        result = result,
                        isAdding = result.stableId in uiState.addingResultIds,
                        onAddResult = { onAddResult(result) }
                    )
                }
            }

            if (uiState.runSummaries.isNotEmpty()) {
                item {
                    Text(
                        text = stringResource(R.string.search_sources_title),
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp)
                    )
                }
                items(uiState.runSummaries, key = { it.pluginId }) { summary ->
                    SearchRunSummaryCard(summary = summary)
                }
            }

            uiState.statusMessage?.let { message ->
                item {
                    StatusMessage(message = message, isError = false)
                }
            }
            uiState.errorMessage?.let { message ->
                item {
                    StatusMessage(message = message, isError = true)
                }
            }
        }
    }
}

@Composable
private fun SearchRunSummaryCard(
    summary: SearchRunSummary
) {
    OutlinedCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 6.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Text(
                text = summary.pluginName,
                style = MaterialTheme.typography.titleSmall
            )
            Text(
                text = if (summary.ok) {
                    stringResource(
                        R.string.search_source_success,
                        summary.resultCount,
                        summary.durationMs
                    )
                } else {
                    summary.errorMessage ?: stringResource(R.string.search_source_failed)
                },
                style = MaterialTheme.typography.bodySmall,
                color = if (summary.ok) {
                    MaterialTheme.colorScheme.onSurfaceVariant
                } else {
                    MaterialTheme.colorScheme.error
                },
                modifier = Modifier.padding(top = 4.dp)
            )
        }
    }
}

@Composable
private fun SearchFormCard(
    uiState: SearchUiState,
    onQueryChanged: (String) -> Unit,
    onCategoryChanged: (String?) -> Unit,
    onSearch: () -> Unit
) {
    val searchButtonContentDescription = stringResource(R.string.search_action_button)
    OutlinedCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            OutlinedTextField(
                value = uiState.query,
                onValueChange = onQueryChanged,
                modifier = Modifier.fillMaxWidth(),
                label = { Text(stringResource(R.string.search_query_label)) },
                singleLine = true
            )
            if (uiState.categoryOptions.isNotEmpty()) {
                SettingDropdownRow(
                    label = stringResource(R.string.search_category_label),
                    currentValue = uiState.category ?: uiState.categoryOptions.first(),
                    options = uiState.categoryOptions,
                    labelFor = { value -> value.replaceFirstChar { it.uppercase() } },
                    onValueChange = { onCategoryChanged(it) },
                    modifier = Modifier.padding(top = 12.dp)
                )
            }
            Button(
                onClick = onSearch,
                enabled = !uiState.isSearching,
                modifier = Modifier
                    .padding(top = 12.dp)
                    .semantics {
                        contentDescription = searchButtonContentDescription
                    }
            ) {
                Icon(
                    imageVector = Icons.Default.Search,
                    contentDescription = null
                )
                Text(
                    text = stringResource(R.string.search_action),
                    modifier = Modifier.padding(start = 8.dp)
                )
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

@Composable
private fun EmptyPluginsCard(
    recommendedPlugin: RecommendedSearchPlugin?,
    onInstallRecommended: (RecommendedSearchPlugin) -> Unit,
    onManageSearchPlugins: () -> Unit
) {
    OutlinedCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(16.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Text(
                text = stringResource(R.string.search_no_plugins_enabled),
                style = MaterialTheme.typography.titleMedium
            )
            Text(
                text = stringResource(R.string.search_no_plugins_enabled_description),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 8.dp)
            )
            Row(
                modifier = Modifier.padding(top = 12.dp),
                horizontalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                if (recommendedPlugin != null) {
                    Button(onClick = { onInstallRecommended(recommendedPlugin) }) {
                        Text(stringResource(R.string.search_install_internet_archive))
                    }
                }
                TextButton(onClick = onManageSearchPlugins) {
                    Text(stringResource(R.string.search_manage_plugins))
                }
            }
        }
    }
}

@Composable
private fun SearchResultCard(
    result: SearchDisplayResult,
    isAdding: Boolean,
    onAddResult: () -> Unit
) {
    OutlinedCard(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = 16.dp, vertical = 8.dp)
    ) {
        Column(
            modifier = Modifier.padding(16.dp)
        ) {
            Text(
                text = result.result.name,
                style = MaterialTheme.typography.titleMedium
            )
            Text(
                text = SearchViewModel.formatResultMeta(result),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = 4.dp)
            )
            result.result.detailsUrl?.let { url ->
                Text(
                    text = url,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.padding(top = 4.dp)
                )
            }
            Button(
                onClick = onAddResult,
                enabled = !isAdding,
                modifier = Modifier.padding(top = 12.dp)
            ) {
                if (isAdding) {
                    CircularProgressIndicator(
                        strokeWidth = 2.dp,
                        modifier = Modifier.padding(end = 8.dp)
                    )
                }
                Text(stringResource(R.string.search_add_result))
            }
        }
    }
}

@Preview(showBackground = true)
@Composable
private fun SearchScreenPreview() {
    JSTorrentTheme {
        SearchScreenContent(
            uiState = SearchUiState(
                enabledPlugins = emptyList(),
                recommendedPlugins = listOf(
                    RecommendedSearchPlugin(
                        manifest = SearchPluginManifest(
                            id = "org.archive.search",
                            name = "Internet Archive",
                            hosts = listOf("archive.org")
                        ),
                        sourceUrl = "https://example.com/archive.js"
                    )
                )
            ),
            onNavigateBack = {},
            onManageSearchPlugins = {},
            onQueryChanged = {},
            onCategoryChanged = {},
            onSearch = {},
            onInstallRecommended = {},
            onAddResult = {}
        )
    }
}
