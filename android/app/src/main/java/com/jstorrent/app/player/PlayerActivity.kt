package com.jstorrent.app.player

import android.app.PictureInPictureParams
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.os.Build
import android.os.Bundle
import android.util.Rational
import android.view.GestureDetector
import android.view.MotionEvent
import androidx.activity.ComponentActivity
import androidx.activity.compose.BackHandler
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.Fullscreen
import androidx.compose.material.icons.filled.FullscreenExit
import androidx.compose.material.icons.filled.PictureInPictureAlt
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
import androidx.compose.runtime.rememberUpdatedState
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
import androidx.media3.common.VideoSize
import androidx.media3.exoplayer.DefaultLoadControl
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.ProgressiveMediaSource
import androidx.media3.ui.PlayerView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.app.R
import com.jstorrent.app.ui.theme.JSTorrentTheme
import java.io.IOException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlin.math.abs

class PlayerActivity : ComponentActivity() {

    private val app: JSTorrentApplication
        get() = application as JSTorrentApplication

    private var screenState by mutableStateOf<PlayerScreenState>(PlayerScreenState.Preparing)
    private var player by mutableStateOf<ExoPlayer?>(null)
    private var bufferingMessage by mutableStateOf<String?>(null)
    private var playerErrorMessage by mutableStateOf<String?>(null)
    private var isFullscreen by mutableStateOf(false)
    private var isInPictureInPictureUiMode by mutableStateOf(false)
    private var playbackSessionRegistered = false

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

        override fun onVideoSizeChanged(videoSize: VideoSize) {
            updatePictureInPictureParams()
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val streamingRequest = PlayerActivityLauncher.fromIntent(intent)
        val localRequest = PlayerActivityLauncher.localFromIntent(intent)
        val launchSource = when {
            streamingRequest != null -> PlayerLaunchSource.Stream(streamingRequest)
            localRequest != null -> PlayerLaunchSource.Local(localRequest)
            else -> null
        }

        if (launchSource == null) {
            screenState = PlayerScreenState.Error(getString(R.string.player_invalid_request))
        } else {
            lifecycleScope.launch {
                prepareAndStartPlayback(launchSource)
            }
            if (launchSource is PlayerLaunchSource.Stream) {
                lifecycleScope.launch {
                    monitorPlaybackTorrent(launchSource.request.infoHash)
                }
            }
        }

        setContent {
            JSTorrentTheme {
                PlayerActivityScreen(
                    state = screenState,
                    player = player,
                    bufferingMessage = bufferingMessage,
                    playerErrorMessage = playerErrorMessage,
                    isFullscreen = isFullscreen,
                    isInPictureInPicture = isInPictureInPictureUiMode,
                    onSetFullscreen = ::setFullscreenMode,
                    onEnterPictureInPicture = ::enterPictureInPictureIfPossible,
                    onClose = ::closePlayer
                )
            }
        }
    }

    override fun onStart() {
        super.onStart()
        app.serviceLifecycleManager.onActivityStart()
        applySystemBarsVisibility()
        updatePictureInPictureParams()
    }

    override fun onStop() {
        super.onStop()
        app.serviceLifecycleManager.onActivityStop()
    }

    override fun onDestroy() {
        releasePlayer()
        setPlaybackSessionRegistered(false)
        setFullscreenMode(false)
        super.onDestroy()
    }

    override fun onUserLeaveHint() {
        super.onUserLeaveHint()
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
            enterPictureInPictureIfPossible()
        }
    }

    override fun onPictureInPictureModeChanged(
        isInPictureInPictureMode: Boolean,
        newConfig: Configuration
    ) {
        super.onPictureInPictureModeChanged(isInPictureInPictureMode, newConfig)
        isInPictureInPictureUiMode = isInPictureInPictureMode
        applySystemBarsVisibility()
    }

    private suspend fun prepareAndStartPlayback(source: PlayerLaunchSource) {
        screenState = PlayerScreenState.Preparing
        playerErrorMessage = null
        bufferingMessage = getString(R.string.player_loading_video)
        if (source is PlayerLaunchSource.Stream) {
            setPlaybackSessionRegistered(true)
        }

        try {
            val exoPlayer = when (source) {
                is PlayerLaunchSource.Stream -> {
                    withContext(Dispatchers.IO) {
                        app.ensureEngineStarted()
                        TorrentPlaybackCoordinator(app.engineServiceRepository)
                            .prepareForPlayback(
                                PlaybackPreparationInput(
                                    infoHash = source.request.infoHash,
                                    fileIndex = source.request.fileIndex,
                                    filePath = source.request.filePath,
                                    isFileSelected = source.request.isFileSelected,
                                    torrentUserState = source.request.torrentUserState,
                                    torrentStatus = source.request.torrentStatus
                                )
                            )
                    }

                    withContext(Dispatchers.Main.immediate) {
                        buildStreamingPlayer(source.request)
                    }
                }
                is PlayerLaunchSource.Local -> {
                    withContext(Dispatchers.Main.immediate) {
                        buildLocalPlayer(source.request)
                    }
                }
            }

            player = exoPlayer
            screenState = PlayerScreenState.Ready(
                fileName = when (source) {
                    is PlayerLaunchSource.Stream -> source.request.fileName
                    is PlayerLaunchSource.Local -> source.request.title
                }
            )
            updatePictureInPictureParams()
        } catch (t: Throwable) {
            releasePlayer()
            if (source is PlayerLaunchSource.Stream) {
                setPlaybackSessionRegistered(false)
            }
            screenState = PlayerScreenState.Error(t.message ?: getString(R.string.player_unknown_error))
        }
    }

    private fun buildStreamingPlayer(request: PlayerLaunchRequest): ExoPlayer {
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

    private fun buildLocalPlayer(request: LocalPlaybackRequest): ExoPlayer {
        releasePlayer()

        val mediaItemBuilder = MediaItem.Builder()
            .setMediaId(request.uri.toString())
            .setUri(request.uri)

        request.mimeType?.let(mediaItemBuilder::setMimeType)

        return ExoPlayer.Builder(this)
            .build()
            .also { exoPlayer ->
                exoPlayer.addListener(playerListener)
                exoPlayer.setMediaItem(mediaItemBuilder.build())
                exoPlayer.prepare()
                exoPlayer.playWhenReady = true
            }
    }

    private fun releasePlayer() {
        val hadPlayer = player != null
        player?.removeListener(playerListener)
        player?.release()
        player = null
        if (hadPlayer) {
            setPlaybackSessionRegistered(false)
        }
    }

    private fun closePlayer() {
        if (isTaskRoot) {
            startActivity(
                Intent(this, com.jstorrent.app.NativeStandaloneActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP or Intent.FLAG_ACTIVITY_SINGLE_TOP)
                }
            )
        }
        finish()
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
                setFullscreenMode(false)
                finish()
            }
        }
    }

    private fun setFullscreenMode(enabled: Boolean) {
        isFullscreen = enabled
        applySystemBarsVisibility()
    }

    private fun setPlaybackSessionRegistered(enabled: Boolean) {
        if (playbackSessionRegistered == enabled) return
        playbackSessionRegistered = enabled

        if (enabled) {
            app.serviceLifecycleManager.onPlaybackSessionStarted()
        } else {
            app.serviceLifecycleManager.onPlaybackSessionStopped()
        }
    }

    private fun applySystemBarsVisibility() {
        val controller = WindowCompat.getInsetsController(window, window.decorView)
        controller.systemBarsBehavior =
            WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE

        if (isFullscreen && !isInPictureInPictureUiMode) {
            controller.hide(WindowInsetsCompat.Type.systemBars())
        } else {
            controller.show(WindowInsetsCompat.Type.systemBars())
        }
    }

    private fun enterPictureInPictureIfPossible(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false
        if (isInPictureInPictureUiMode) return false
        if (screenState !is PlayerScreenState.Ready || player == null) return false
        if (isFinishing || isDestroyed) return false

        val params = buildPictureInPictureParams() ?: return false
        return enterPictureInPictureMode(params)
    }

    private fun updatePictureInPictureParams() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        buildPictureInPictureParams()?.let(::setPictureInPictureParams)
    }

    private fun buildPictureInPictureParams(): PictureInPictureParams? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return null

        val builder = PictureInPictureParams.Builder()
        val videoSize = player?.videoSize
        if (videoSize != null && videoSize.width > 0 && videoSize.height > 0) {
            builder.setAspectRatio(Rational(videoSize.width, videoSize.height))
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            val canAutoEnter = screenState is PlayerScreenState.Ready && player != null
            builder.setAutoEnterEnabled(canAutoEnter)
        }
        return builder.build()
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

private sealed interface PlayerLaunchSource {
    data class Stream(val request: PlayerLaunchRequest) : PlayerLaunchSource
    data class Local(val request: LocalPlaybackRequest) : PlayerLaunchSource
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
    isFullscreen: Boolean,
    isInPictureInPicture: Boolean,
    onSetFullscreen: (Boolean) -> Unit,
    onEnterPictureInPicture: () -> Unit,
    onClose: () -> Unit
) {
    val title = when (state) {
        PlayerScreenState.Preparing -> stringResource(R.string.player_title)
        is PlayerScreenState.Ready -> state.fileName
        is PlayerScreenState.Error -> stringResource(R.string.player_error_title)
    }

    if ((isFullscreen || isInPictureInPicture) && state is PlayerScreenState.Ready) {
        PlayerReadyContent(
            modifier = Modifier.fillMaxSize(),
            player = player,
            bufferingMessage = bufferingMessage,
            playerErrorMessage = playerErrorMessage,
            isFullscreen = true,
            isInPictureInPicture = isInPictureInPicture,
            onSetFullscreen = onSetFullscreen,
            onEnterPictureInPicture = onEnterPictureInPicture,
            onClose = onClose
        )
        return
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
                },
                actions = {
                    if (state is PlayerScreenState.Ready) {
                        IconButton(onClick = onEnterPictureInPicture) {
                            Icon(
                                imageVector = Icons.Filled.PictureInPictureAlt,
                                contentDescription = stringResource(R.string.player_enter_picture_in_picture)
                            )
                        }
                        IconButton(onClick = { onSetFullscreen(true) }) {
                            Icon(
                                imageVector = Icons.Filled.Fullscreen,
                                contentDescription = stringResource(R.string.player_enter_fullscreen)
                            )
                        }
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
                PlayerReadyContent(
                    modifier = Modifier
                        .fillMaxSize()
                        .padding(innerPadding),
                    player = player,
                    bufferingMessage = bufferingMessage,
                    playerErrorMessage = playerErrorMessage,
                    isFullscreen = false,
                    isInPictureInPicture = false,
                    onSetFullscreen = onSetFullscreen,
                    onEnterPictureInPicture = onEnterPictureInPicture,
                    onClose = onClose
                )
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
private fun PlayerReadyContent(
    modifier: Modifier = Modifier,
    player: ExoPlayer?,
    bufferingMessage: String?,
    playerErrorMessage: String?,
    isFullscreen: Boolean,
    isInPictureInPicture: Boolean,
    onSetFullscreen: (Boolean) -> Unit,
    onEnterPictureInPicture: () -> Unit,
    onClose: () -> Unit
) {
    val currentOnSetFullscreen = rememberUpdatedState(onSetFullscreen)

    BackHandler(enabled = isFullscreen && !isInPictureInPicture) {
        currentOnSetFullscreen.value(false)
    }

    Box(
        modifier = modifier.background(MaterialTheme.colorScheme.surface)
    ) {
        player?.let { exoPlayer ->
            AndroidView(
                modifier = Modifier.fillMaxSize(),
                factory = { context ->
                    val density = context.resources.displayMetrics.density
                    val swipeDistanceThreshold = 72f * density
                    val swipeVelocityThreshold = 240f * density
                    val gestureDetector = GestureDetector(
                        context,
                        object : GestureDetector.SimpleOnGestureListener() {
                            override fun onDown(e: MotionEvent): Boolean = true

                            override fun onFling(
                                e1: MotionEvent?,
                                e2: MotionEvent,
                                velocityX: Float,
                                velocityY: Float
                            ): Boolean {
                                val start = e1 ?: return false
                                val deltaX = e2.x - start.x
                                val deltaY = e2.y - start.y
                                if (abs(deltaY) <= abs(deltaX)) return false
                                if (abs(deltaY) < swipeDistanceThreshold) return false
                                if (abs(velocityY) < swipeVelocityThreshold) return false

                                if (deltaY < 0f) {
                                    currentOnSetFullscreen.value(true)
                                    return true
                                }

                                currentOnSetFullscreen.value(false)
                                return true
                            }
                        }
                    )

                    PlayerView(context).apply {
                        this.player = exoPlayer
                        useController = !isInPictureInPicture
                        setShutterBackgroundColor(Color.BLACK)
                        keepScreenOn = true
                        setOnTouchListener { _, event ->
                            gestureDetector.onTouchEvent(event)
                            false
                        }
                    }
                },
                update = { view ->
                    view.player = exoPlayer
                    view.useController = !isInPictureInPicture
                }
            )
        }

        if (isFullscreen && !isInPictureInPicture) {
            Row(
                modifier = Modifier
                    .align(Alignment.TopCenter)
                    .fillMaxWidth()
                    .statusBarsPadding()
                    .padding(horizontal = 12.dp, vertical = 8.dp),
                horizontalArrangement = Arrangement.SpaceBetween
            ) {
                Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                    PlayerOverlayButton(
                        icon = Icons.AutoMirrored.Filled.ArrowBack,
                        contentDescription = stringResource(R.string.player_close),
                        onClick = onClose
                    )
                    PlayerOverlayButton(
                        icon = Icons.Filled.PictureInPictureAlt,
                        contentDescription = stringResource(R.string.player_enter_picture_in_picture),
                        onClick = onEnterPictureInPicture
                    )
                }
                PlayerOverlayButton(
                    icon = Icons.Filled.FullscreenExit,
                    contentDescription = stringResource(R.string.player_exit_fullscreen),
                    onClick = { onSetFullscreen(false) }
                )
            }
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
                    .align(if (isFullscreen) Alignment.TopStart else Alignment.TopCenter)
                    .statusBarsPadding()
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

@Composable
private fun PlayerOverlayButton(
    modifier: Modifier = Modifier,
    icon: androidx.compose.ui.graphics.vector.ImageVector,
    contentDescription: String,
    onClick: () -> Unit
) {
    Surface(
        modifier = modifier,
        shape = CircleShape,
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.88f),
        tonalElevation = 4.dp
    ) {
        IconButton(onClick = onClick) {
            Icon(
                imageVector = icon,
                contentDescription = contentDescription
            )
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
