package com.jstorrent.app.player

import android.graphics.Color
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.app.R
import com.jstorrent.app.ui.theme.JSTorrentTheme
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class PlayerActivity : ComponentActivity() {

    private val app: JSTorrentApplication
        get() = application as JSTorrentApplication

    private var screenState by mutableStateOf<PlayerScreenState>(PlayerScreenState.Preparing)
    private var player by mutableStateOf<ExoPlayer?>(null)
    private var bufferingMessage by mutableStateOf<String?>(null)
    private var playerErrorMessage by mutableStateOf<String?>(null)

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            bufferingMessage = when (playbackState) {
                Player.STATE_IDLE -> getString(R.string.player_loading_video)
                Player.STATE_BUFFERING -> getString(R.string.player_buffering)
                Player.STATE_READY, Player.STATE_ENDED -> null
                else -> null
            }
        }

        override fun onPlayerError(error: androidx.media3.common.PlaybackException) {
            playerErrorMessage = buildPlayerErrorMessage(error)
            bufferingMessage = null
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val request = PlayerActivityLauncher.fromIntent(intent)
        if (request == null) {
            screenState = PlayerScreenState.Error(getString(R.string.player_invalid_request))
        } else {
            lifecycleScope.launch {
                prepareAndStartPlayback(request)
            }
            lifecycleScope.launch {
                monitorPlaybackTorrent(request.infoHash)
            }
        }

        setContent {
            JSTorrentTheme {
                PlayerActivityScreen(
                    state = screenState,
                    player = player,
                    bufferingMessage = bufferingMessage,
                    playerErrorMessage = playerErrorMessage,
                    onClose = { finish() }
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        app.serviceLifecycleManager.onActivityStart()
    }

    override fun onStop() {
        super.onStop()
        app.serviceLifecycleManager.onActivityStop()
    }

    override fun onDestroy() {
        releasePlayer()
        super.onDestroy()
    }

    private suspend fun prepareAndStartPlayback(request: PlayerLaunchRequest) {
        screenState = PlayerScreenState.Preparing
        playerErrorMessage = null
        bufferingMessage = getString(R.string.player_loading_video)

        try {
            withContext(Dispatchers.IO) {
                app.ensureEngineStarted()
                TorrentPlaybackCoordinator(app.engineServiceRepository)
                    .prepareForPlayback(
                        PlaybackPreparationInput(
                            infoHash = request.infoHash,
                            fileIndex = request.fileIndex,
                            filePath = request.filePath,
                            isFileSelected = request.isFileSelected,
                            torrentUserState = request.torrentUserState,
                            torrentStatus = request.torrentStatus
                        )
                    )
            }

            val exoPlayer = withContext(Dispatchers.Main.immediate) {
                buildPlayer(request)
            }

            player = exoPlayer
            screenState = PlayerScreenState.Ready(
                fileName = request.fileName
            )
        } catch (t: Throwable) {
            releasePlayer()
            screenState = PlayerScreenState.Error(t.message ?: getString(R.string.player_unknown_error))
        }
    }

    private fun buildPlayer(request: PlayerLaunchRequest): ExoPlayer {
        releasePlayer()

        val dataSourceFactory = TorrentPlaybackDataSourceFactory(app, request)
        val mediaItem = MediaItem.Builder()
            .setMediaId("${request.infoHash}:${request.fileIndex}")
            .setUri(PlayerActivityLauncher.buildPlaybackUri(request))
            .build()
        val mediaSource = ProgressiveMediaSource.Factory(dataSourceFactory).createMediaSource(mediaItem)
        val loadControl = DefaultLoadControl.Builder()
            .setBufferDurationsMs(
                5_000,
                20_000,
                1_500,
                3_000
            )
            .build()

        return ExoPlayer.Builder(this)
            .setLoadControl(loadControl)
            .build()
            .also { exoPlayer ->
            exoPlayer.addListener(playerListener)
            exoPlayer.setMediaSource(mediaSource)
            exoPlayer.prepare()
            exoPlayer.playWhenReady = true
        }
    }

    private fun releasePlayer() {
        player?.removeListener(playerListener)
        player?.release()
        player = null
    }

    private suspend fun monitorPlaybackTorrent(infoHash: String) {
        var hasSeenPlaybackTorrent = false

        app.engineServiceRepository.state.collectLatest { state ->
            if (screenState !is PlayerScreenState.Ready || isFinishing || isDestroyed) {
                return@collectLatest
            }

            val torrents = state?.torrents ?: return@collectLatest
            val torrent = torrents.firstOrNull { it.infoHash == infoHash }
            if (torrent != null) {
                hasSeenPlaybackTorrent = true
            }

            val playbackUnavailable = (hasSeenPlaybackTorrent && torrent == null) ||
                torrent?.userState == "stopped" ||
                torrent?.status == "stopped"

            if (playbackUnavailable) {
                releasePlayer()
                finish()
            }
        }
    }

    private fun buildPlayerErrorMessage(error: androidx.media3.common.PlaybackException): String {
        val rootCause = generateSequence(error.cause) { it.cause }.lastOrNull()
        val usefulCause = generateSequence(error.cause) { it.cause }
            .firstOrNull { it.message?.isNotBlank() == true }
            ?: rootCause

        val message = usefulCause?.message?.takeIf { it.isNotBlank() }
            ?: error.localizedMessage
            ?: getString(R.string.player_unknown_error)

        return if (usefulCause is IOException) {
            message
        } else {
            message
        }
    }
}

private sealed interface PlayerScreenState {
    data object Preparing : PlayerScreenState
    data class Ready(val fileName: String) : PlayerScreenState
    data class Error(val message: String) : PlayerScreenState
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlayerActivityScreen(
    state: PlayerScreenState,
    player: ExoPlayer?,
    bufferingMessage: String?,
    playerErrorMessage: String?,
    onClose: () -> Unit
) {
    val title = when (state) {
        PlayerScreenState.Preparing -> stringResource(R.string.player_title)
        is PlayerScreenState.Ready -> state.fileName
        is PlayerScreenState.Error -> stringResource(R.string.player_error_title)
    }

    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onClose) {
                        Icon(
                            imageVector = Icons.AutoMirrored.Filled.ArrowBack,
                            contentDescription = stringResource(R.string.player_close)
                        )
                    }
                }
            )
        }
    ) { innerPadding ->
        when (state) {
            PlayerScreenState.Preparing -> {
                LoadingState(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(innerPadding),
                    title = stringResource(R.string.player_preparing_title),
                    message = stringResource(R.string.player_preparing_message)
                )
            }

            is PlayerScreenState.Ready -> {
                Box(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(innerPadding)
                        .background(MaterialTheme.colorScheme.surface)
                ) {
                    player?.let { exoPlayer ->
                        AndroidView(
                            modifier = Modifier.fillMaxSize(),
                            factory = { context ->
                                PlayerView(context).apply {
                                    this.player = exoPlayer
                                    useController = true
                                    setShutterBackgroundColor(Color.BLACK)
                                    keepScreenOn = true
                                }
                            },
                            update = { view ->
                                view.player = exoPlayer
                            }
                        )
                    }

                    if (bufferingMessage != null) {
                        LoadingState(
                            modifier = Modifier
                                .align(Alignment.Center)
                                .padding(24.dp),
                            title = stringResource(R.string.player_loading_video),
                            message = bufferingMessage
                        )
                    }

                    if (playerErrorMessage != null) {
                        Surface(
                            modifier = Modifier
                                .align(Alignment.TopCenter)
                                .padding(16.dp),
                            color = MaterialTheme.colorScheme.errorContainer,
                            tonalElevation = 4.dp
                        ) {
                            Column(
                                modifier = Modifier.padding(16.dp),
                                verticalArrangement = Arrangement.spacedBy(6.dp)
                            ) {
                                Text(
                                    text = stringResource(R.string.player_playback_failed),
                                    style = MaterialTheme.typography.titleMedium,
                                    color = MaterialTheme.colorScheme.onErrorContainer,
                                    fontWeight = FontWeight.SemiBold
                                )
                                Text(
                                    text = playerErrorMessage,
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.onErrorContainer
                                )
                            }
                        }
                    }
                }
            }

            is PlayerScreenState.Error -> {
                LoadingState(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(innerPadding),
                    title = stringResource(R.string.player_error_title),
                    message = state.message,
                    showSpinner = false
                )
            }
        }
    }
}

@Composable
private fun LoadingState(
    modifier: Modifier = Modifier,
    title: String,
    message: String,
    showSpinner: Boolean = true
) {
    Box(
        modifier = modifier,
        contentAlignment = Alignment.Center
    ) {
        Column(
            modifier = Modifier.padding(24.dp),
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            if (showSpinner) {
                CircularProgressIndicator()
            }
            Text(
                text = title,
                style = MaterialTheme.typography.headlineSmall,
                fontWeight = FontWeight.SemiBold
            )
            Text(
                text = message,
                style = MaterialTheme.typography.bodyLarge
            )
        }
    }
}
