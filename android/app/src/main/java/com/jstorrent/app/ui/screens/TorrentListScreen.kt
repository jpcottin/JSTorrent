package com.jstorrent.app.ui.screens

import android.content.Intent
import android.net.Uri
import android.provider.Settings
import android.util.Base64
import android.util.Log
import android.widget.Toast
import androidx.activity.compose.BackHandler
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.CreateNewFolder
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Sort
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FloatingActionButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Tab
import androidx.compose.material3.TabRow
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.sp
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.dp
import com.jstorrent.app.BuildConfig
import com.jstorrent.app.R
import com.jstorrent.app.debug.TestTorrentHelper
import com.jstorrent.app.model.TorrentFilter
import com.jstorrent.app.model.TorrentListUiState
import com.jstorrent.app.model.TorrentSortOrder
import com.jstorrent.app.ui.components.CombinedSpeedIndicator
import com.jstorrent.app.ui.components.EngineStatusIndicator
import com.jstorrent.app.ui.components.SelectionActionBar
import com.jstorrent.app.ui.components.SharedMenuItems
import com.jstorrent.app.ui.components.TorrentCard
import com.jstorrent.app.ui.dialogs.AddTorrentDialog
import com.jstorrent.app.ui.dialogs.BulkRemoveTorrentDialog
import com.jstorrent.app.ui.theme.JSTorrentTheme
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.app.viewmodel.TorrentListViewModel
import com.jstorrent.quickjs.model.TorrentSummary

/**
 * Main torrent list screen.
 * Displays a list of torrents with filter tabs and add FAB.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TorrentListScreen(
    viewModel: TorrentListViewModel,
    onTorrentClick: (String) -> Unit = {},
    onAddRootClick: () -> Unit = {},
    onSettingsClick: () -> Unit = {},
    onShutdownClick: () -> Unit = {},
    onSpeedClick: () -> Unit = {},
    onDhtInfoClick: () -> Unit = {},
    onLogsClick: () -> Unit = {},
    onDebugShowReviewDialog: (() -> Unit)? = null,
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()
    val currentFilter by viewModel.filter.collectAsState()
    val currentSortOrder by viewModel.sortOrder.collectAsState()
    val aggregateDownloadSpeed by viewModel.aggregateDownloadSpeed.collectAsState()
    val aggregateUploadSpeed by viewModel.aggregateUploadSpeed.collectAsState()
    val selectedTorrents by viewModel.selectedTorrents.collectAsState()
    val isSelectionMode by viewModel.isSelectionMode.collectAsState()
    val filterCounts by viewModel.filterCounts.collectAsState()
    val engineError by viewModel.engineError.collectAsState()
    val pendingTorrents by viewModel.pendingTorrents.collectAsState()
    val pendingRemovalTorrents by viewModel.pendingRemovalTorrents.collectAsState()
    val highlightedTorrent by viewModel.highlightedTorrent.collectAsState()

    // Get network restriction status to show "Waiting for WiFi/VPN" status
    // The Application exposes this StateFlow directly, so it's always available
    // (even before the engine starts)
    val context = LocalContext.current
    val app = context.applicationContext as? JSTorrentApplication
    val networkWaitingStatus by (app?.restrictionStatus
        ?: kotlinx.coroutines.flow.MutableStateFlow<String?>(null)).collectAsState()
    val isDataSaverRestricted by (app?.isDataSaverRestricted
        ?: kotlinx.coroutines.flow.MutableStateFlow(false)).collectAsState()

    // Lifecycle-aware subscriptions: pause when screen is not visible (e.g., navigated
    // to detail view or app backgrounded), resume when screen becomes visible again.
    LifecycleEventEffect(Lifecycle.Event.ON_PAUSE) {
        viewModel.onScreenPaused()
    }

    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        viewModel.onScreenResumed()
        // Also refresh cache to pick up any changes that occurred while
        // the screen was off (e.g., background downloads completing)
        viewModel.refreshCache()
    }

    // Show toast when engine reports an error (e.g., JS initialization failure)
    LaunchedEffect(engineError) {
        engineError?.let { error ->
            Toast.makeText(
                context,
                context.getString(R.string.torrent_list_engine_error),
                Toast.LENGTH_LONG
            ).show()
            Log.e("TorrentListScreen", "Engine error: $error")
        }
    }

    val snackbarHostState = remember { SnackbarHostState() }
    val lazyListState = rememberLazyListState()
    val duplicateMessage = stringResource(R.string.torrent_already_in_list)

    // Handle duplicate torrent: show snackbar + scroll to highlighted item
    LaunchedEffect(highlightedTorrent) {
        val infoHash = highlightedTorrent ?: return@LaunchedEffect
        snackbarHostState.showSnackbar(duplicateMessage)
        // Scroll to the torrent in the current filtered list
        val state = uiState
        if (state is TorrentListUiState.Loaded) {
            val index = state.torrents.indexOfFirst { it.infoHash == infoHash }
            if (index >= 0) {
                lazyListState.animateScrollToItem(index)
            }
        }
    }

    var showAddDialog by remember { mutableStateOf(false) }
    var showMenu by remember { mutableStateOf(false) }
    var showSortMenu by remember { mutableStateOf(false) }
    var showBulkDeleteDialog by remember { mutableStateOf(false) }

    // File picker for .torrent files
    val torrentFilePicker = rememberLauncherForActivityResult(
        contract = ActivityResultContracts.OpenDocument()
    ) { uri ->
        if (uri != null) {
            try {
                val bytes = context.contentResolver.openInputStream(uri)?.use { it.readBytes() }
                if (bytes != null) {
                    val base64 = Base64.encodeToString(bytes, Base64.NO_WRAP)
                    Log.i("TorrentListScreen", "Read torrent file: ${bytes.size} bytes")
                    viewModel.addTorrent(base64)
                } else {
                    Log.e("TorrentListScreen", "Failed to read torrent file: empty content")
                }
            } catch (e: Exception) {
                Log.e("TorrentListScreen", "Failed to read torrent file", e)
            }
        }
    }

    // Handle back press in selection mode
    BackHandler(enabled = isSelectionMode) {
        viewModel.clearSelection()
    }

    Scaffold(
        modifier = modifier.fillMaxSize(),
        snackbarHost = { SnackbarHost(snackbarHostState) },
        topBar = {
            TopAppBar(
                title = {
                    val isLive = (uiState as? TorrentListUiState.Loaded)?.isLive ?: false
                    Box {
                        // Logo, title, and engine status indicator
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Image(
                                painter = painterResource(id = R.drawable.ic_launcher_foreground),
                                contentDescription = null,
                                modifier = Modifier.size(48.dp)
                            )
                            Text(stringResource(R.string.app_name))
                            Spacer(modifier = Modifier.width(8.dp))
                            // Engine status indicator: green dot = live, hollow = cached
                            if (uiState is TorrentListUiState.Loaded) {
                                EngineStatusIndicator(isLive = isLive)
                            }
                        }

                        // Global speed indicators positioned below the title (offset doesn't affect layout)
                        if (uiState is TorrentListUiState.Loaded &&
                            (aggregateDownloadSpeed > 0 || aggregateUploadSpeed > 0)) {
                            CombinedSpeedIndicator(
                                downloadSpeed = aggregateDownloadSpeed,
                                uploadSpeed = aggregateUploadSpeed,
                                style = MaterialTheme.typography.labelSmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                modifier = Modifier.offset(x = 36.dp, y = 36.dp)
                            )
                        }
                    }
                },
                actions = {
                    // Sort button with dropdown
                    Box {
                        IconButton(onClick = { showSortMenu = true }) {
                            Icon(
                                imageVector = Icons.Default.Sort,
                                contentDescription = stringResource(R.string.torrent_list_sort)
                            )
                        }
                        DropdownMenu(
                            expanded = showSortMenu,
                            onDismissRequest = { showSortMenu = false }
                        ) {
                            TorrentSortOrder.entries.forEach { sortOrder ->
                                DropdownMenuItem(
                                    text = {
                                        Text(
                                            text = getSortOrderDisplayName(sortOrder),
                                            color = if (sortOrder == currentSortOrder) {
                                                MaterialTheme.colorScheme.primary
                                            } else {
                                                MaterialTheme.colorScheme.onSurface
                                            }
                                        )
                                    },
                                    onClick = {
                                        showSortMenu = false
                                        viewModel.setSortOrder(sortOrder)
                                    }
                                )
                            }
                        }
                    }
                    IconButton(onClick = { showMenu = true }) {
                        Icon(
                            imageVector = Icons.Default.MoreVert,
                            contentDescription = stringResource(R.string.torrent_list_menu)
                        )
                    }
                    DropdownMenu(
                        expanded = showMenu,
                        onDismissRequest = { showMenu = false }
                    ) {
                        // Screen-specific items at top
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.torrent_list_pause_all)) },
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Default.Pause,
                                    contentDescription = null
                                )
                            },
                            onClick = {
                                showMenu = false
                                viewModel.pauseAll()
                            }
                        )
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.torrent_list_resume_all)) },
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Default.PlayArrow,
                                    contentDescription = null
                                )
                            },
                            onClick = {
                                showMenu = false
                                viewModel.resumeAll()
                            }
                        )
                        if (isSelectionMode) {
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.torrent_list_delete_all)) },
                                leadingIcon = {
                                    Icon(
                                        imageVector = Icons.Default.Delete,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.error
                                    )
                                },
                                onClick = {
                                    showMenu = false
                                    showBulkDeleteDialog = true
                                }
                            )
                        }
                        DropdownMenuItem(
                            text = { Text(stringResource(R.string.torrent_list_add_download_folder)) },
                            leadingIcon = {
                                Icon(
                                    imageVector = Icons.Default.CreateNewFolder,
                                    contentDescription = null
                                )
                            },
                            onClick = {
                                showMenu = false
                                onAddRootClick()
                            }
                        )
                        // Debug-only: Add test torrents with kitchen sink peer hints
                        if (BuildConfig.DEBUG) {
                            HorizontalDivider()
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.debug_add_test_100mb)) },
                                onClick = {
                                    showMenu = false
                                    viewModel.addTorrent(TestTorrentHelper.buildKitchenSinkMagnet100MB())
                                }
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.debug_add_test_1gb)) },
                                onClick = {
                                    showMenu = false
                                    viewModel.addTorrent(TestTorrentHelper.buildKitchenSinkMagnet1GB())
                                }
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.debug_add_ubuntu)) },
                                onClick = {
                                    showMenu = false
                                    viewModel.addTorrent(TestTorrentHelper.buildUbuntuServerMagnet())
                                }
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.debug_add_bunny)) },
                                onClick = {
                                    showMenu = false
                                    viewModel.addTorrent(TestTorrentHelper.buildBigBuckBunnyMagnet())
                                }
                            )
                            DropdownMenuItem(
                                text = { Text(stringResource(R.string.debug_add_webtorrent)) },
                                onClick = {
                                    showMenu = false
                                    TestTorrentHelper.WEBTORRENT_MAGNETS.forEach { magnet ->
                                        viewModel.addTorrent(magnet)
                                    }
                                }
                            )
                            if (onDebugShowReviewDialog != null) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.debug_show_review_dialog)) },
                                    onClick = {
                                        showMenu = false
                                        onDebugShowReviewDialog()
                                    }
                                )
                            }
                        }
                        // Shared menu items at bottom (Speed, DHT Info, Settings, Shutdown)
                        HorizontalDivider()
                        SharedMenuItems.SpeedMenuItem(
                            onClick = onSpeedClick,
                            onDismiss = { showMenu = false }
                        )
                        SharedMenuItems.DhtInfoMenuItem(
                            onClick = onDhtInfoClick,
                            onDismiss = { showMenu = false }
                        )
                        SharedMenuItems.LogsMenuItem(
                            onClick = onLogsClick,
                            onDismiss = { showMenu = false }
                        )
                        SharedMenuItems.SettingsMenuItem(
                            onClick = onSettingsClick,
                            onDismiss = { showMenu = false }
                        )
                        SharedMenuItems.ShutdownMenuItem(
                            onClick = onShutdownClick,
                            onDismiss = { showMenu = false }
                        )
                    }
                }
            )
        },
        floatingActionButton = {
            if (uiState is TorrentListUiState.Loaded && !isSelectionMode) {
                FloatingActionButton(
                    onClick = { showAddDialog = true }
                ) {
                    Icon(
                        imageVector = Icons.Default.Add,
                        contentDescription = stringResource(R.string.torrent_list_add_torrent)
                    )
                }
            }
        }
    ) { innerPadding ->
        when (val state = uiState) {
            is TorrentListUiState.Loading -> {
                LoadingContent(modifier = Modifier.padding(innerPadding))
            }
            is TorrentListUiState.Error -> {
                ErrorContent(
                    message = state.message,
                    modifier = Modifier.padding(innerPadding)
                )
            }
            is TorrentListUiState.Loaded -> {
                Box(modifier = Modifier.padding(innerPadding)) {
                    TorrentListContent(
                        torrents = state.torrents,
                        currentFilter = currentFilter,
                        onFilterChange = { viewModel.setFilter(it) },
                        filterCounts = filterCounts,
                        onTorrentClick = { infoHash ->
                            if (isSelectionMode) {
                                viewModel.toggleSelection(infoHash)
                            } else {
                                onTorrentClick(infoHash)
                            }
                        },
                        onTorrentLongClick = { infoHash ->
                            viewModel.selectTorrent(infoHash)
                        },
                        onPauseTorrent = { viewModel.pauseTorrent(it) },
                        onResumeTorrent = { viewModel.resumeTorrent(it) },
                        isPaused = { viewModel.isPaused(it) },
                        isSelectionMode = isSelectionMode,
                        selectedTorrents = selectedTorrents,
                        pendingTorrents = pendingTorrents,
                        pendingRemovalTorrents = pendingRemovalTorrents,
                        isLive = state.isLive,
                        networkWaitingStatus = networkWaitingStatus,
                        isDataSaverRestricted = isDataSaverRestricted,
                        highlightedTorrent = highlightedTorrent,
                        onHighlightShown = { viewModel.clearHighlight() },
                        lazyListState = lazyListState,
                        modifier = Modifier.fillMaxSize()
                    )

                    // Selection action bar at bottom
                    if (isSelectionMode) {
                        SelectionActionBar(
                            selectedCount = selectedTorrents.size,
                            onStartAll = { viewModel.resumeSelected() },
                            onStopAll = { viewModel.pauseSelected() },
                            onDeleteAll = { showBulkDeleteDialog = true },
                            onClearSelection = { viewModel.clearSelection() },
                            modifier = Modifier.align(Alignment.BottomCenter)
                        )
                    }
                }
            }
        }
    }

    // Add torrent dialog
    if (showAddDialog) {
        AddTorrentDialog(
            onDismiss = { showAddDialog = false },
            onAddTorrent = { magnetLink ->
                viewModel.addTorrent(magnetLink)
                showAddDialog = false
            },
            onBrowseForFile = {
                torrentFilePicker.launch(arrayOf("application/x-bittorrent"))
            }
        )
    }

    // Bulk delete dialog
    if (showBulkDeleteDialog) {
        BulkRemoveTorrentDialog(
            count = selectedTorrents.size,
            onDismiss = { showBulkDeleteDialog = false },
            onConfirm = { deleteFiles ->
                viewModel.removeSelected(deleteFiles)
                showBulkDeleteDialog = false
            }
        )
    }
}

/**
 * Content shown while loading.
 */
@Composable
private fun LoadingContent(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator()
            Spacer(modifier = Modifier.height(16.dp))
            Text(
                text = stringResource(R.string.torrent_list_loading),
                style = MaterialTheme.typography.bodyLarge
            )
        }
    }
}

/**
 * Content shown on error.
 */
@Composable
private fun ErrorContent(
    message: String,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp)
        ) {
            Text(
                text = stringResource(R.string.torrent_list_error),
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.error
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = message,
                style = MaterialTheme.typography.bodyMedium,
                textAlign = TextAlign.Center
            )
        }
    }
}

/**
 * Main content with filter tabs and torrent list.
 */
@Composable
private fun TorrentListContent(
    torrents: List<TorrentSummary>,
    currentFilter: TorrentFilter,
    onFilterChange: (TorrentFilter) -> Unit,
    filterCounts: Map<TorrentFilter, Int>,
    onTorrentClick: (String) -> Unit,
    onTorrentLongClick: (String) -> Unit,
    onPauseTorrent: (String) -> Unit,
    onResumeTorrent: (String) -> Unit,
    isPaused: (TorrentSummary) -> Boolean,
    isSelectionMode: Boolean,
    selectedTorrents: Set<String>,
    pendingTorrents: Set<String>,
    pendingRemovalTorrents: Set<String>,
    isLive: Boolean,
    networkWaitingStatus: String? = null,
    isDataSaverRestricted: Boolean = false,
    highlightedTorrent: String? = null,
    onHighlightShown: () -> Unit = {},
    lazyListState: LazyListState = rememberLazyListState(),
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current

    Column(modifier = modifier.fillMaxSize()) {
        // Data Saver warning banner
        if (isDataSaverRestricted) {
            Text(
                text = stringResource(R.string.data_saver_warning),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(MaterialTheme.colorScheme.errorContainer)
                    .clickable {
                        try {
                            context.startActivity(
                                Intent(
                                    Settings.ACTION_IGNORE_BACKGROUND_DATA_RESTRICTIONS_SETTINGS,
                                    Uri.parse("package:${context.packageName}")
                                )
                            )
                        } catch (e: Exception) {
                            // Fallback to general data usage settings
                            context.startActivity(Intent(Settings.ACTION_DATA_USAGE_SETTINGS))
                        }
                    }
                    .padding(horizontal = 16.dp, vertical = 10.dp)
            )
        }

        // Filter tabs
        FilterTabRow(
            currentFilter = currentFilter,
            onFilterChange = onFilterChange,
            filterCounts = filterCounts
        )

        // Torrent list or empty state
        if (torrents.isEmpty()) {
            EmptyState(currentFilter = currentFilter)
        } else {
            LazyColumn(
                state = lazyListState,
                modifier = Modifier.fillMaxSize(),
                contentPadding = PaddingValues(
                    start = 12.dp,
                    end = 16.dp,
                    top = 8.dp,
                    // Extra padding at bottom when selection bar is visible
                    bottom = if (isSelectionMode) 80.dp else 8.dp
                ),
                verticalArrangement = Arrangement.spacedBy(8.dp)
            ) {
                items(torrents, key = { it.infoHash }) { torrent ->
                    TorrentCard(
                        torrent = torrent,
                        onPause = { onPauseTorrent(torrent.infoHash) },
                        onResume = { onResumeTorrent(torrent.infoHash) },
                        onClick = { onTorrentClick(torrent.infoHash) },
                        onLongClick = { onTorrentLongClick(torrent.infoHash) },
                        isSelectionMode = isSelectionMode,
                        isSelected = torrent.infoHash in selectedTorrents,
                        isLive = isLive,
                        isPending = torrent.infoHash in pendingTorrents,
                        isPendingRemoval = torrent.infoHash in pendingRemovalTorrents,
                        isHighlighted = torrent.infoHash == highlightedTorrent,
                        onHighlightShown = onHighlightShown,
                        networkWaitingStatus = networkWaitingStatus
                    )
                }
            }
        }
    }
}

/**
 * Filter tab row: ALL | ACTIVE | QUEUED | FINISHED
 */
@Composable
private fun FilterTabRow(
    currentFilter: TorrentFilter,
    onFilterChange: (TorrentFilter) -> Unit,
    filterCounts: Map<TorrentFilter, Int>,
    modifier: Modifier = Modifier
) {
    val tabs = listOf(TorrentFilter.ALL, TorrentFilter.ACTIVE, TorrentFilter.QUEUED, TorrentFilter.FINISHED)
    val selectedIndex = tabs.indexOf(currentFilter)

    TabRow(
        selectedTabIndex = selectedIndex,
        modifier = modifier.fillMaxWidth()
    ) {
        tabs.forEach { filter ->
            val count = filterCounts[filter] ?: 0
            val displayName = getFilterDisplayName(filter)
            Tab(
                selected = filter == currentFilter,
                onClick = { onFilterChange(filter) },
                modifier = Modifier.padding(horizontal = 2.dp),
                text = {
                    Text(
                        text = if (count > 0) {
                            "$displayName ($count)"
                        } else {
                            displayName
                        },
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        fontSize = 13.sp
                    )
                }
            )
        }
    }
}

/**
 * Empty state when no torrents match the filter.
 */
@Composable
private fun EmptyState(
    currentFilter: TorrentFilter,
    modifier: Modifier = Modifier
) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            modifier = Modifier.padding(32.dp)
        ) {
            Text(
                text = stringResource(when (currentFilter) {
                    TorrentFilter.ALL -> R.string.torrent_list_empty_all
                    TorrentFilter.ACTIVE -> R.string.torrent_list_empty_active
                    TorrentFilter.QUEUED -> R.string.torrent_list_empty_queued
                    TorrentFilter.FINISHED -> R.string.torrent_list_empty_finished
                }),
                style = MaterialTheme.typography.titleMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(modifier = Modifier.height(8.dp))
            Text(
                text = stringResource(when (currentFilter) {
                    TorrentFilter.ALL -> R.string.torrent_list_hint_all
                    TorrentFilter.ACTIVE -> R.string.torrent_list_hint_active
                    TorrentFilter.QUEUED -> R.string.torrent_list_hint_queued
                    TorrentFilter.FINISHED -> R.string.torrent_list_hint_finished
                }),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center
            )
        }
    }
}

// =============================================================================
// Previews
// =============================================================================

@Preview(showBackground = true)
@Composable
private fun EmptyStatePreview() {
    JSTorrentTheme {
        EmptyState(currentFilter = TorrentFilter.ALL)
    }
}

@Preview(showBackground = true)
@Composable
private fun LoadingContentPreview() {
    JSTorrentTheme {
        LoadingContent()
    }
}

@Preview(showBackground = true)
@Composable
private fun ErrorContentPreview() {
    JSTorrentTheme {
        ErrorContent(message = "Failed to initialize engine")
    }
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get display name for sort order.
 */
@Composable
private fun getSortOrderDisplayName(sortOrder: TorrentSortOrder): String {
    return stringResource(when (sortOrder) {
        TorrentSortOrder.NAME -> R.string.sort_name
        TorrentSortOrder.DATE_ADDED -> R.string.sort_date_added
        TorrentSortOrder.DOWNLOAD_SPEED -> R.string.sort_download_speed
    })
}

/**
 * Get localized display name for filter.
 */
@Composable
private fun getFilterDisplayName(filter: TorrentFilter): String {
    return stringResource(when (filter) {
        TorrentFilter.ALL -> R.string.filter_all
        TorrentFilter.ACTIVE -> R.string.filter_active
        TorrentFilter.QUEUED -> R.string.filter_queued
        TorrentFilter.FINISHED -> R.string.filter_finished
    })
}
