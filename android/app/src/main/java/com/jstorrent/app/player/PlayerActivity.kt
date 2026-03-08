package com.jstorrent.app.player

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.lifecycle.lifecycleScope
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.app.R
import com.jstorrent.app.ui.theme.JSTorrentTheme
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/**
 * Phase 0/1 player entry scaffold.
 *
 * This activity currently prepares the torrent/file state for playback but does
 * not yet attach Media3. It exists so the launch contract and playback
 * preparation logic can be built and tested without regressing the current UI.
 */
class PlayerActivity : ComponentActivity() {

    private val app: JSTorrentApplication
        get() = application as JSTorrentApplication

    private var screenState by mutableStateOf<PlayerScreenState>(PlayerScreenState.Preparing)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        val request = PlayerActivityLauncher.fromIntent(intent)
        if (request == null) {
            screenState = PlayerScreenState.Error(getString(R.string.player_invalid_request))
        } else {
            lifecycleScope.launch {
                screenState = try {
                    withContext(Dispatchers.IO) {
                        app.ensureEngineStarted()
                        val result = TorrentPlaybackCoordinator(app.engineServiceRepository)
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
                        PlayerScreenState.Prepared(
                            fileName = request.fileName,
                            filePath = request.filePath,
                            result = result
                        )
                    }
                } catch (t: Throwable) {
                    PlayerScreenState.Error(t.message ?: getString(R.string.player_unknown_error))
                }
            }
        }

        setContent {
            JSTorrentTheme {
                PlayerActivityScreen(
                    state = screenState,
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
}

@Immutable
private sealed interface PlayerScreenState {
    data object Preparing : PlayerScreenState
    data class Prepared(
        val fileName: String,
        val filePath: String,
        val result: PlaybackPreparationResult
    ) : PlayerScreenState
    data class Error(val message: String) : PlayerScreenState
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PlayerActivityScreen(
    state: PlayerScreenState,
    onClose: () -> Unit
) {
    Scaffold(
        topBar = {
            TopAppBar(
                title = { Text(stringResource(R.string.player_title)) }
            )
        }
    ) { innerPadding ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(innerPadding)
                .padding(24.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp)
        ) {
            when (state) {
                PlayerScreenState.Preparing -> {
                    Text(
                        text = stringResource(R.string.player_preparing_title),
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = stringResource(R.string.player_preparing_message),
                        style = MaterialTheme.typography.bodyLarge
                    )
                }

                is PlayerScreenState.Prepared -> {
                    Text(
                        text = state.fileName,
                        style = MaterialTheme.typography.headlineSmall,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = stringResource(R.string.player_prepare_complete),
                        style = MaterialTheme.typography.bodyLarge
                    )
                    Text(
                        text = state.filePath,
                        style = MaterialTheme.typography.bodyMedium
                    )
                    Text(
                        text = if (state.result.fileUnskipped) {
                            stringResource(R.string.player_file_unskipped)
                        } else {
                            stringResource(R.string.player_file_already_selected)
                        },
                        style = MaterialTheme.typography.bodyMedium
                    )
                    Text(
                        text = if (state.result.torrentStarted) {
                            stringResource(R.string.player_torrent_resumed)
                        } else {
                            stringResource(R.string.player_torrent_already_active)
                        },
                        style = MaterialTheme.typography.bodyMedium
                    )
                    Text(
                        text = stringResource(R.string.player_placeholder_message),
                        style = MaterialTheme.typography.bodyLarge
                    )
                }

                is PlayerScreenState.Error -> {
                    Text(
                        text = stringResource(R.string.player_error_title),
                        style = MaterialTheme.typography.headlineSmall,
                        color = MaterialTheme.colorScheme.error,
                        fontWeight = FontWeight.SemiBold
                    )
                    Text(
                        text = state.message,
                        style = MaterialTheme.typography.bodyLarge
                    )
                }
            }

            Button(onClick = onClose) {
                Text(stringResource(R.string.player_close))
            }
        }
    }
}
