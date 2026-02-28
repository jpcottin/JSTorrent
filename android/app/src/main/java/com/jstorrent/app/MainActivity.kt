package com.jstorrent.app

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.util.Log
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.Launch
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.PowerSettingsNew
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.lifecycleScope
import com.jstorrent.app.auth.TokenStore
import com.jstorrent.app.mode.ModeDetector
import com.jstorrent.app.service.IoDaemonService
import com.jstorrent.app.ui.screens.SectionHeader
import com.jstorrent.app.ui.screens.SettingToggleRow
import com.jstorrent.app.ui.theme.JSTorrentTheme
import kotlinx.coroutines.launch

private const val TAG = "MainActivity"
private const val FALLBACK_URL = "https://new.jstorrent.com/launch"
private const val CHROME_WEB_STORE_URL = "https://chrome.google.com/webstore/detail/jstorrent/anhdpjpojoipgpmfanmedjghaligalgb"

class MainActivity : AppCompatActivity() {

    private lateinit var tokenStore: TokenStore
    private var isPaired = mutableStateOf(false)
    private var backgroundModeEnabled = mutableStateOf(false)
    private var hasNotificationPermission = mutableStateOf(false)
    private var preferStandaloneOnChromebook = mutableStateOf(false)

    private val notificationPermissionLauncher = registerForActivityResult(
        ActivityResultContracts.RequestPermission()
    ) { isGranted ->
        Log.i(TAG, "Notification permission granted: $isGranted")
        hasNotificationPermission.value = isGranted
        if (isGranted) {
            // Permission granted - enable background mode
            tokenStore.backgroundModeEnabled = true
            backgroundModeEnabled.value = true
            IoDaemonService.instance?.setForegroundMode(true)
        } else {
            // Permission denied - ensure background mode stays disabled
            tokenStore.backgroundModeEnabled = false
            backgroundModeEnabled.value = false
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        tokenStore = TokenStore(this)
        isPaired.value = tokenStore.hasToken()
        backgroundModeEnabled.value = tokenStore.backgroundModeEnabled
        hasNotificationPermission.value = checkNotificationPermission()
        preferStandaloneOnChromebook.value = tokenStore.preferStandaloneOnChromebook

        // Check if running on Chromebook
        val isChromebook = ModeDetector.isChromebook(this)
        Log.i(TAG, "Running on Chromebook: $isChromebook")

        // Check if launched from extension with force_companion flag
        val forceCompanion = intent?.getStringExtra("force_companion") == "true"
        if (forceCompanion) {
            Log.i(TAG, "Launched from extension with force_companion flag")
        }

        // Non-Chromebook OR user prefers standalone: launch standalone mode
        // Note: Magnet/torrent links go through LinkHandlerActivity, not here
        // Exception: if launched from extension (force_companion=true), always use companion mode
        val preferStandalone = isChromebook && tokenStore.preferStandaloneOnChromebook && !forceCompanion
        if (!isChromebook || preferStandalone) {
            Log.i(TAG, "${if (preferStandalone) "Chromebook prefers standalone" else "Not a Chromebook"} - launching native standalone mode")
            startActivity(Intent(this, NativeStandaloneActivity::class.java).apply {
                addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
            })
            finish()
            return
        }

        // Chromebook companion mode: handle pairing intent and start service
        handleIntent()
        IoDaemonService.start(this)

        // Mutual exclusion: Shutdown standalone engine when entering companion mode
        // This prevents confusion from having two separate torrent lists (extension vs standalone)
        (application as JSTorrentApplication).shutdownEngine()

        setContent {
            JSTorrentTheme {
                MainScreen(
                    isPaired = isPaired.value,
                    backgroundModeEnabled = backgroundModeEnabled.value,
                    hasNotificationPermission = hasNotificationPermission.value,
                    preferStandaloneOnChromebook = preferStandaloneOnChromebook.value,
                    onBackgroundModeToggle = { enabled ->
                        if (enabled) {
                            // Request permission when enabling
                            requestNotificationPermission()
                        } else {
                            // Disable background mode
                            tokenStore.backgroundModeEnabled = false
                            backgroundModeEnabled.value = false
                            IoDaemonService.instance?.setForegroundMode(false)
                        }
                    },
                    onPreferStandaloneChange = { prefer ->
                        tokenStore.preferStandaloneOnChromebook = prefer
                        preferStandaloneOnChromebook.value = prefer
                    },
                    onLaunchStandalone = {
                        // Always use native standalone on Chromebook
                        startActivity(Intent(this@MainActivity, NativeStandaloneActivity::class.java))
                    },
                    onBackToJSTorrent = {
                        // Check actual current state before deciding to close
                        val bgEnabled = tokenStore.backgroundModeEnabled
                        val hasPermission = checkNotificationPermission()
                        Log.i(TAG, "Back to JSTorrent: bgEnabled=$bgEnabled, hasPermission=$hasPermission")
                        launchBrowserFallback()
                        // Only close this window if background mode is fully enabled
                        if (bgEnabled && hasPermission) {
                            Log.i(TAG, "Closing window - background mode active")
                            finish()
                        } else {
                            Log.i(TAG, "Keeping window open - background mode not active")
                        }
                    },
                    onUnpair = {
                        // Close all WebSocket connections before clearing token
                        // This ensures the extension sees the disconnect
                        lifecycleScope.launch {
                            IoDaemonService.instance?.closeAllSessions()
                        }
                        tokenStore.clear()
                        isPaired.value = false
                        backgroundModeEnabled.value = false
                    },
                    onOpenExtensionPage = {
                        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(CHROME_WEB_STORE_URL))
                        startActivity(intent)
                    },
                    onQuit = {
                        quit()
                    }
                )
            }
        }
    }

    private fun quit() {
        Log.i(TAG, "Quitting companion app")
        // Close all WebSocket connections
        lifecycleScope.launch {
            IoDaemonService.instance?.closeAllSessions()
        }
        // Stop the service
        IoDaemonService.stop(this)
        // Close the activity and remove from recents
        finishAndRemoveTask()
    }

    override fun onResume() {
        super.onResume()
        // Refresh all state when returning to activity
        isPaired.value = tokenStore.hasToken()
        backgroundModeEnabled.value = tokenStore.backgroundModeEnabled

        // Check if permission was revoked in system settings
        val permissionGranted = checkNotificationPermission()
        hasNotificationPermission.value = permissionGranted

        // If permission was revoked but background mode is enabled, disable it
        if (backgroundModeEnabled.value && !permissionGranted && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            tokenStore.backgroundModeEnabled = false
            backgroundModeEnabled.value = false
            IoDaemonService.instance?.setForegroundMode(false)
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent()
    }

    private fun handleIntent() {
        val uri = intent?.data ?: return
        Log.d(TAG, "Received intent: $uri")

        // Only handle jstorrent:// scheme intents here
        // Magnet/torrent links are handled by LinkHandlerActivity
        when {
            uri.scheme == "jstorrent" && uri.host == "launch" -> {
                Log.i(TAG, "Launch intent - app started")
            }
            uri.scheme == "jstorrent" && uri.host == "pair" -> {
                // Pairing happens via HTTP POST /pair, not via intent
                Log.i(TAG, "Pair intent - ignored, use POST /pair")
            }
        }
    }

    private fun launchBrowserFallback() {
        // Target Chrome explicitly - on ChromeOS this opens in the real Chrome browser
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(FALLBACK_URL)).apply {
            setPackage("com.android.chrome")
        }
        try {
            startActivity(intent)
            Log.i(TAG, "Launched browser fallback: $FALLBACK_URL")
        } catch (e: Exception) {
            Log.e(TAG, "Failed to launch Chrome, trying default browser", e)
            // Fallback to default browser if Chrome not available
            val fallbackIntent = Intent(Intent.ACTION_VIEW, Uri.parse(FALLBACK_URL))
            startActivity(fallbackIntent)
        }
    }

    private fun checkNotificationPermission(): Boolean {
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(
                this,
                Manifest.permission.POST_NOTIFICATIONS
            ) == PackageManager.PERMISSION_GRANTED
        } else {
            // Before Android 13, no permission needed for notifications
            true
        }
    }

    private fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (!checkNotificationPermission()) {
                notificationPermissionLauncher.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                // Already have permission - enable background mode directly
                tokenStore.backgroundModeEnabled = true
                backgroundModeEnabled.value = true
                IoDaemonService.instance?.setForegroundMode(true)
            }
        } else {
            // Before Android 13, no permission needed - enable directly
            tokenStore.backgroundModeEnabled = true
            backgroundModeEnabled.value = true
            IoDaemonService.instance?.setForegroundMode(true)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun MainScreen(
    isPaired: Boolean,
    backgroundModeEnabled: Boolean,
    hasNotificationPermission: Boolean,
    preferStandaloneOnChromebook: Boolean,
    onBackgroundModeToggle: (Boolean) -> Unit,
    onPreferStandaloneChange: (Boolean) -> Unit,
    onLaunchStandalone: () -> Unit,
    onBackToJSTorrent: () -> Unit,
    onUnpair: () -> Unit,
    onOpenExtensionPage: () -> Unit,
    onQuit: () -> Unit
) {
    var showSettings by rememberSaveable { mutableStateOf(false) }
    var showQuitDialog by rememberSaveable { mutableStateOf(false) }

    // Show settings screen or main screen
    if (showSettings) {
        CompanionSettingsScreen(
            onNavigateBack = { showSettings = false },
            backgroundModeEnabled = backgroundModeEnabled,
            hasNotificationPermission = hasNotificationPermission,
            preferStandaloneOnChromebook = preferStandaloneOnChromebook,
            onBackgroundModeToggle = onBackgroundModeToggle,
            onPreferStandaloneChange = onPreferStandaloneChange,
            onLaunchStandalone = {
                showSettings = false
                onLaunchStandalone()
            },
            onOpenExtensionPage = onOpenExtensionPage,
            onQuit = { showQuitDialog = true }
        )
    } else {
        CompanionMainScreen(
            isPaired = isPaired,
            backgroundModeEnabled = backgroundModeEnabled,
            hasNotificationPermission = hasNotificationPermission,
            onSettingsClick = { showSettings = true },
            onBackToJSTorrent = onBackToJSTorrent,
            onUnpair = onUnpair,
            onQuit = { showQuitDialog = true }
        )
    }

    // Quit confirmation dialog
    if (showQuitDialog) {
        QuitConfirmationDialog(
            onConfirm = {
                showQuitDialog = false
                onQuit()
            },
            onDismiss = { showQuitDialog = false }
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CompanionMainScreen(
    isPaired: Boolean,
    backgroundModeEnabled: Boolean,
    hasNotificationPermission: Boolean,
    onSettingsClick: () -> Unit,
    onBackToJSTorrent: () -> Unit,
    onUnpair: () -> Unit,
    onQuit: () -> Unit
) {
    var showOverflowMenu by remember { mutableStateOf(false) }

    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Image(
                            painter = painterResource(id = R.drawable.ic_launcher_foreground),
                            contentDescription = null,
                            modifier = Modifier.size(48.dp)
                        )
                        Text("JSTorrent Companion")
                    }
                },
                actions = {
                    IconButton(onClick = onSettingsClick) {
                        Icon(Icons.Default.Settings, contentDescription = "Settings")
                    }
                    Box {
                        IconButton(onClick = { showOverflowMenu = true }) {
                            Icon(Icons.Default.MoreVert, contentDescription = "More options")
                        }
                        DropdownMenu(
                            expanded = showOverflowMenu,
                            onDismissRequest = { showOverflowMenu = false }
                        ) {
                            DropdownMenuItem(
                                text = { Text("Quit") },
                                leadingIcon = {
                                    Icon(
                                        Icons.Default.PowerSettingsNew,
                                        contentDescription = null,
                                        tint = MaterialTheme.colorScheme.error
                                    )
                                },
                                onClick = {
                                    showOverflowMenu = false
                                    onQuit()
                                }
                            )
                        }
                    }
                }
            )
        }
    ) { innerPadding ->
        val context = LocalContext.current
        val app = context.applicationContext as? JSTorrentApplication
        val isDataSaverRestricted by (app?.isDataSaverRestricted
            ?: kotlinx.coroutines.flow.MutableStateFlow(false)).collectAsState()

        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
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
                                context.startActivity(Intent(Settings.ACTION_DATA_USAGE_SETTINGS))
                            }
                        }
                        .padding(horizontal = 16.dp, vertical = 10.dp)
                )
            }

            Column(
                modifier = Modifier
                    .fillMaxSize()
                    .padding(24.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
                verticalArrangement = Arrangement.Center
            ) {
            if (isPaired) {
                // Paired state header
                Text(
                    text = "Paired",
                    style = MaterialTheme.typography.headlineMedium,
                    color = MaterialTheme.colorScheme.primary
                )

                Spacer(modifier = Modifier.height(8.dp))

                Text(
                    text = "Connected to JSTorrent",
                    style = MaterialTheme.typography.bodyLarge
                )

                Spacer(modifier = Modifier.height(24.dp))

                // Status message based on background mode
                if (backgroundModeEnabled && hasNotificationPermission) {
                    Text(
                        text = "Running in background",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.primary
                    )
                    Spacer(modifier = Modifier.height(4.dp))
                    Text(
                        text = "You can safely close this window.",
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                } else {
                    Text(
                        text = "Keep this window open while",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.error
                    )
                    Text(
                        text = "downloading torrents.",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.error
                    )
                }

                Spacer(modifier = Modifier.height(32.dp))

                // Buttons
                Button(onClick = onBackToJSTorrent) {
                    Text("Back to JSTorrent")
                }

                Spacer(modifier = Modifier.height(8.dp))

                OutlinedButton(onClick = onUnpair) {
                    Text("Unpair")
                }
            } else {
                // Unpaired state
                Text(
                    text = "JSTorrent Companion",
                    style = MaterialTheme.typography.headlineMedium
                )

                Spacer(modifier = Modifier.height(24.dp))

                Text(
                    text = "Not paired",
                    style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.outline
                )

                Spacer(modifier = Modifier.height(8.dp))

                Text(
                    text = "Open JSTorrent in Chrome to pair.",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )

                Spacer(modifier = Modifier.height(24.dp))

                Button(onClick = onBackToJSTorrent) {
                    Text("Open JSTorrent")
                }
            }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun CompanionSettingsScreen(
    onNavigateBack: () -> Unit,
    backgroundModeEnabled: Boolean,
    hasNotificationPermission: Boolean,
    preferStandaloneOnChromebook: Boolean,
    onBackgroundModeToggle: (Boolean) -> Unit,
    onPreferStandaloneChange: (Boolean) -> Unit,
    onLaunchStandalone: () -> Unit,
    onOpenExtensionPage: () -> Unit,
    onQuit: () -> Unit
) {
    Scaffold(
        modifier = Modifier.fillMaxSize(),
        topBar = {
            TopAppBar(
                title = { Text("Settings") },
                navigationIcon = {
                    IconButton(onClick = onNavigateBack) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                }
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
        ) {
            // Background section
            SectionHeader("Background")
            SettingToggleRow(
                label = "Run in background",
                description = "Shows persistent notification, keeps running when window is closed",
                checked = backgroundModeEnabled && hasNotificationPermission,
                onCheckedChange = onBackgroundModeToggle,
                modifier = Modifier.padding(horizontal = 16.dp)
            )

            Spacer(modifier = Modifier.height(16.dp))

            // Standalone section
            SectionHeader("Standalone Mode")
            SettingToggleRow(
                label = "Prefer standalone",
                description = "Launch standalone mode by default instead of companion mode",
                checked = preferStandaloneOnChromebook,
                onCheckedChange = onPreferStandaloneChange,
                modifier = Modifier.padding(horizontal = 16.dp)
            )

            Spacer(modifier = Modifier.height(8.dp))

            // Launch Standalone option
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onLaunchStandalone() }
                    .padding(horizontal = 16.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.Launch,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary
                )
                Spacer(modifier = Modifier.width(16.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Launch Standalone Now",
                        style = MaterialTheme.typography.bodyLarge
                    )
                    Text(
                        text = "Open standalone mode without changing default",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            HorizontalDivider()

            // Chrome extension link
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onOpenExtensionPage() }
                    .padding(horizontal = 16.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    Icons.AutoMirrored.Filled.OpenInNew,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary
                )
                Spacer(modifier = Modifier.width(16.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Chrome Extension",
                        style = MaterialTheme.typography.bodyLarge
                    )
                    Text(
                        text = "Open in Chrome Web Store",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            HorizontalDivider()

            // Quit option
            Row(
                modifier = Modifier
                    .fillMaxWidth()
                    .clickable { onQuit() }
                    .padding(horizontal = 16.dp, vertical = 16.dp),
                verticalAlignment = Alignment.CenterVertically
            ) {
                Icon(
                    Icons.Default.PowerSettingsNew,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.error
                )
                Spacer(modifier = Modifier.width(16.dp))
                Column(modifier = Modifier.weight(1f)) {
                    Text(
                        text = "Quit",
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.error
                    )
                    Text(
                        text = "Stop service and close app",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            }

            HorizontalDivider()

            Spacer(modifier = Modifier.weight(1f))

            // Version info at bottom
            Text(
                text = "Version ${BuildConfig.VERSION_NAME}",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(16.dp)
            )
        }
    }
}

@Composable
private fun QuitConfirmationDialog(
    onConfirm: () -> Unit,
    onDismiss: () -> Unit
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        icon = {
            Icon(
                Icons.Default.PowerSettingsNew,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error
            )
        },
        title = { Text("Quit JSTorrent?") },
        text = {
            Text("This will stop the background service. The Chrome extension will disconnect.")
        },
        confirmButton = {
            TextButton(onClick = onConfirm) {
                Text("Quit", color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) {
                Text("Cancel")
            }
        }
    )
}