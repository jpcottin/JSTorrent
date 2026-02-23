package com.jstorrent.app.ui.screens

import android.widget.Toast
import com.jstorrent.app.BuildConfig
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.FastForward
import androidx.compose.material.icons.filled.KeyboardDoubleArrowDown
import androidx.compose.material.icons.filled.KeyboardDoubleArrowUp
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Pause
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Tab
import androidx.compose.material3.ScrollableTabRow
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
import androidx.compose.ui.platform.LocalContext
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleEventEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.tooling.preview.Preview
import androidx.compose.ui.unit.DpOffset
import androidx.compose.ui.unit.dp
import com.jstorrent.app.R
import com.jstorrent.app.model.DetailTab
import com.jstorrent.app.model.FilePriority
import com.jstorrent.app.model.TorrentDetailUi
import com.jstorrent.app.model.TorrentDetailUiState
import com.jstorrent.app.model.TorrentFileUi
import com.jstorrent.app.ui.dialogs.RemoveTorrentDialog
import com.jstorrent.app.ui.tabs.DetailsTab
import com.jstorrent.app.ui.tabs.FilesTab
import com.jstorrent.app.ui.tabs.PeersTab
import com.jstorrent.app.ui.tabs.PiecesTab
import com.jstorrent.app.ui.tabs.StatusTab
import com.jstorrent.app.ui.tabs.TrackersTab
import com.jstorrent.app.ui.theme.JSTorrentTheme
import com.jstorrent.app.util.FileOpener
import com.jstorrent.app.ui.components.CompactPlayPauseButton
import com.jstorrent.app.ui.components.SharedMenuItems
import com.jstorrent.app.viewmodel.TorrentDetailViewModel

/**
 * Torrent detail screen.
 * Shows detailed information about a torrent with tabs for different aspects.
 */
@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun TorrentDetailScreen(
    viewModel: TorrentDetailViewModel,
    onNavigateBack: () -> Unit,
    onSettingsClick: () -> Unit,
    onSpeedClick: () -> Unit,
    onDhtInfoClick: () -> Unit,
    onLogsClick: () -> Unit = {},
    onShutdownClick: () -> Unit,
    onRemoveInitiated: (String) -> Unit = {},
    modifier: Modifier = Modifier
) {
    val uiState by viewModel.uiState.collectAsState()
    val selectedTab by viewModel.selectedTab.collectAsState()
    val isPendingAction by viewModel.isPendingAction.collectAsState()

    // Lifecycle-aware polling: pause when screen is not visible (e.g., navigated
    // to DHT view or app backgrounded), resume when screen becomes visible again.
    LifecycleEventEffect(Lifecycle.Event.ON_PAUSE) {
        viewModel.onScreenPaused()
    }

    // Re-sync pieces when app resumes from background to catch any updates
    // that were missed while the app was suspended.
    // Also ensure engine is started - it may have been shut down for battery
    // saving while the screen was off.
    LifecycleEventEffect(Lifecycle.Event.ON_RESUME) {
        viewModel.onScreenResumed()
        viewModel.ensureEngineStarted()
        viewModel.resyncPieces()
    }

    var showMenu by remember { mutableStateOf(false) }
    var showRemoveDialog by remember { mutableStateOf(false) }

    when (val state = uiState) {
        is TorrentDetailUiState.Loading -> {
            LoadingContent(modifier = modifier)
        }
        is TorrentDetailUiState.Error -> {
            ErrorContent(
                message = state.message,
                onNavigateBack = onNavigateBack,
                modifier = modifier
            )
        }
        is TorrentDetailUiState.Loaded -> {
            val torrent = state.torrent
            val isPaused = torrent.status == "stopped"

            Scaffold(
                modifier = modifier.fillMaxSize(),
                topBar = {
                    TopAppBar(
                        title = {
                            Text(
                                text = torrent.name,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis
                            )
                        },
                        navigationIcon = {
                            IconButton(onClick = onNavigateBack) {
                                Icon(
                                    imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                                    contentDescription = stringResource(R.string.torrent_detail_back_button)
                                )
                            }
                        },
                        actions = {
                            // Play/Pause button with processing indicator
                            CompactPlayPauseButton(
                                isPaused = isPaused,
                                onToggle = {
                                    if (isPaused) viewModel.resume() else viewModel.pause()
                                },
                                isLoading = isPendingAction
                            )

                            // Overflow menu
                            IconButton(onClick = { showMenu = true }) {
                                Icon(
                                    imageVector = Icons.Default.MoreVert,
                                    contentDescription = stringResource(R.string.torrent_detail_menu_button)
                                )
                            }
                            DropdownMenu(
                                expanded = showMenu,
                                onDismissRequest = { showMenu = false },
                                offset = DpOffset(8.dp, 0.dp)
                            ) {
                                // Screen-specific items at top
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.torrent_detail_recheck_button)) },
                                    onClick = {
                                        showMenu = false
                                        viewModel.recheck()
                                    },
                                    leadingIcon = {
                                        Icon(Icons.Default.Refresh, contentDescription = null)
                                    },
                                    enabled = torrent.status != "checking"
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.torrent_detail_remove_button)) },
                                    onClick = {
                                        showMenu = false
                                        showRemoveDialog = true
                                    },
                                    leadingIcon = {
                                        Icon(Icons.Default.Delete, contentDescription = null)
                                    }
                                )
                                HorizontalDivider()
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.torrent_detail_force_start)) },
                                    onClick = {
                                        showMenu = false
                                        viewModel.forceStart()
                                    },
                                    leadingIcon = {
                                        Icon(Icons.Default.FastForward, contentDescription = null)
                                    }
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.torrent_detail_move_to_top)) },
                                    onClick = {
                                        showMenu = false
                                        viewModel.queueMoveToTop()
                                    },
                                    leadingIcon = {
                                        Icon(Icons.Default.KeyboardDoubleArrowUp, contentDescription = null)
                                    }
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.torrent_detail_move_to_bottom)) },
                                    onClick = {
                                        showMenu = false
                                        viewModel.queueMoveToBottom()
                                    },
                                    leadingIcon = {
                                        Icon(Icons.Default.KeyboardDoubleArrowDown, contentDescription = null)
                                    }
                                )
                                if (BuildConfig.DEBUG) {
                                    HorizontalDivider()
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.debug_reset_state)) },
                                        onClick = {
                                            showMenu = false
                                            viewModel.resetState()
                                        },
                                        leadingIcon = {
                                            Icon(Icons.Default.Refresh, contentDescription = null)
                                        }
                                    )
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
                }
            ) { innerPadding ->
                val context = LocalContext.current
                DetailContent(
                    torrent = torrent,
                    selectedTab = selectedTab,
                    hasPendingFileChanges = state.hasPendingFileChanges,
                    onTabSelected = { viewModel.setSelectedTab(it) },
                    onToggleFileSelection = { viewModel.toggleFileSelection(it) },
                    onSetFilePriority = { index, priority -> viewModel.setFilePriority(index, priority) },
                    onSelectAllFiles = { viewModel.selectAllFiles() },
                    onSelectNoFiles = { viewModel.deselectAllFiles() },
                    onApplyFileChanges = { viewModel.applyFileChanges() },
                    onCancelFileChanges = { viewModel.cancelFileChanges() },
                    onOpenSaveLocation = { openFolder(context, torrent.rootKey) },
                    modifier = Modifier.padding(innerPadding)
                )
            }

            // Remove torrent dialog
            if (showRemoveDialog) {
                RemoveTorrentDialog(
                    torrentName = torrent.name,
                    onDismiss = { showRemoveDialog = false },
                    onConfirm = { deleteFiles ->
                        // Notify list view to show "Removing" treatment before navigating
                        onRemoveInitiated(torrent.infoHash)
                        viewModel.remove(deleteFiles)
                        showRemoveDialog = false
                        onNavigateBack()
                    }
                )
            }
        }
    }
}

/**
 * Content showing loading state.
 */
@Composable
private fun LoadingContent(modifier: Modifier = Modifier) {
    Box(
        modifier = modifier.fillMaxSize(),
        contentAlignment = Alignment.Center
    ) {
        CircularProgressIndicator()
    }
}

/**
 * Content showing error state with back navigation.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun ErrorContent(
    message: String,
    onNavigateBack: () -> Unit,
    modifier: Modifier = Modifier
) {
    Scaffold(
        modifier = modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.torrent_detail_error_title)) },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.torrent_detail_back_button)
                        )
                    }
                }
            )
        }
    ) { innerPadding ->
        Box(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding),
            contentAlignment = Alignment.Center
        ) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Text(
                    text = message,
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.error
                )
            }
        }
    }
}

/**
 * Main detail content with tab bar and pager.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun DetailContent(
    torrent: TorrentDetailUi,
    selectedTab: DetailTab,
    hasPendingFileChanges: Boolean,
    onTabSelected: (DetailTab) -> Unit,
    onToggleFileSelection: (Int) -> Unit,
    onSetFilePriority: (Int, FilePriority) -> Unit,
    onSelectAllFiles: () -> Unit,
    onSelectNoFiles: () -> Unit,
    onApplyFileChanges: () -> Unit,
    onCancelFileChanges: () -> Unit,
    onOpenSaveLocation: () -> Unit,
    modifier: Modifier = Modifier
) {
    val context = LocalContext.current
    val tabs = DetailTab.entries
    val pagerState = rememberPagerState(
        initialPage = tabs.indexOf(selectedTab),
        pageCount = { tabs.size }
    )

    // Sync pager with tab selection
    LaunchedEffect(selectedTab) {
        val targetPage = tabs.indexOf(selectedTab)
        if (pagerState.currentPage != targetPage) {
            // If animation is in progress (rapid taps), snap immediately to avoid conflicts
            if (pagerState.isScrollInProgress) {
                pagerState.scrollToPage(targetPage)
            } else {
                pagerState.animateScrollToPage(targetPage)
            }
        }
    }

    // Sync tab selection with pager (use settledPage to avoid mid-animation triggers)
    LaunchedEffect(pagerState.settledPage) {
        val currentTab = tabs[pagerState.settledPage]
        if (currentTab != selectedTab) {
            onTabSelected(currentTab)
        }
    }

    Column(modifier = modifier.fillMaxSize()) {
        // Tab bar - use ScrollableTabRow to prevent text wrapping on narrow screens
        ScrollableTabRow(
            selectedTabIndex = tabs.indexOf(selectedTab),
            modifier = Modifier.fillMaxWidth(),
            edgePadding = 0.dp
        ) {
            tabs.forEach { tab ->
                Tab(
                    selected = tab == selectedTab,
                    onClick = { onTabSelected(tab) },
                    text = {
                        Text(
                            text = tab.name,
                            style = MaterialTheme.typography.labelMedium
                        )
                    }
                )
            }
        }

        // Tab content
        HorizontalPager(
            state = pagerState,
            modifier = Modifier.fillMaxSize()
        ) { page ->
            when (tabs[page]) {
                DetailTab.DETAILS -> DetailsTab(
                    torrent = torrent,
                    onOpenSaveLocation = onOpenSaveLocation
                )
                DetailTab.STATUS -> StatusTab(torrent = torrent)
                DetailTab.FILES -> FilesTab(
                    files = torrent.files,
                    hasPendingChanges = hasPendingFileChanges,
                    onToggleFileSelection = onToggleFileSelection,
                    onOpenFile = { fileIndex ->
                        openFile(context, torrent.files, fileIndex, torrent.rootKey)
                    },
                    onSetFilePriority = onSetFilePriority,
                    onSelectAll = onSelectAllFiles,
                    onSelectNone = onSelectNoFiles,
                    onApplyChanges = onApplyFileChanges,
                    onCancelChanges = onCancelFileChanges,
                    rootDisplayName = torrent.rootDisplayName,
                    onOpenSaveLocation = onOpenSaveLocation
                )
                DetailTab.TRACKERS -> TrackersTab(
                    trackers = torrent.trackers,
                    dhtEnabled = torrent.dhtEnabled,
                    pexEnabled = torrent.pexEnabled
                )
                DetailTab.PEERS -> PeersTab(peers = torrent.peers)
                DetailTab.PIECES -> PiecesTab(
                    piecesCompleted = torrent.piecesCompleted,
                    piecesTotal = torrent.piecesTotal,
                    pieceSize = torrent.pieceSize,
                    bitfield = torrent.pieceBitfield,
                    activePiecesPartial = torrent.activePiecesPartial,
                    activePiecesRequested = torrent.activePiecesRequested,
                    activePiecesResponded = torrent.activePiecesResponded
                )
            }
        }
    }
}

// =============================================================================
// Helper Functions
// =============================================================================

private fun openFile(
    context: android.content.Context,
    files: List<TorrentFileUi>,
    fileIndex: Int,
    rootKey: String?
) {
    val file = files.find { it.index == fileIndex } ?: return

    if (file.progress < 1.0) {
        Toast.makeText(
            context,
            context.getString(R.string.torrent_detail_file_not_downloaded),
            Toast.LENGTH_SHORT
        ).show()
        return
    }

    if (rootKey == null) {
        Toast.makeText(
            context,
            context.getString(R.string.torrent_detail_storage_unknown),
            Toast.LENGTH_SHORT
        ).show()
        return
    }

    val result = FileOpener.openFile(context, rootKey, file.path)
    if (!result.ok) {
        Toast.makeText(
            context,
            context.getString(R.string.torrent_detail_open_file_error, result.error),
            Toast.LENGTH_SHORT
        ).show()
    }
}

private fun openFolder(
    context: android.content.Context,
    rootKey: String?
) {
    if (rootKey == null) {
        Toast.makeText(
            context,
            context.getString(R.string.torrent_detail_storage_unknown),
            Toast.LENGTH_SHORT
        ).show()
        return
    }

    val result = FileOpener.openFolder(context, rootKey)
    if (!result.ok) {
        Toast.makeText(
            context,
            context.getString(R.string.torrent_detail_open_folder_error, result.error),
            Toast.LENGTH_SHORT
        ).show()
    }
}

// =============================================================================
// Previews
// =============================================================================

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
        ErrorContent(
            message = "Torrent not found",
            onNavigateBack = {}
        )
    }
}
