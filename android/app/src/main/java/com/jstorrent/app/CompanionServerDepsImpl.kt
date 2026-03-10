package com.jstorrent.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.core.app.NotificationCompat
import com.jstorrent.app.auth.TokenStore
import com.jstorrent.app.link.PendingLinkManager
import com.jstorrent.app.storage.RootStore
import com.jstorrent.companion.server.CompanionServerDeps
import com.jstorrent.companion.server.DownloadRoot
import com.jstorrent.companion.server.KVStoreProvider
import com.jstorrent.companion.server.RootStoreProvider
import com.jstorrent.companion.server.TorrentHttpStreamException
import com.jstorrent.companion.server.TorrentHttpStreamLifecycleEvent
import com.jstorrent.companion.server.TorrentHttpStreamSessionInfo
import com.jstorrent.companion.server.TorrentHttpStreamStatus
import com.jstorrent.companion.server.TokenStoreProvider
import com.jstorrent.app.util.FileOpener
import com.jstorrent.quickjs.model.TorrentSummary
import com.jstorrent.quickjs.storage.SqliteKVStore
import java.io.IOException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArraySet
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.launch

private const val TAG = "CompanionServerDepsImpl"

private data class ActiveTorrentHttpStreamSession(
    val sessionId: String,
    val torrentId: String,
)

/**
 * Implementation of CompanionServerDeps that bridges companion-server
 * to app-level components.
 */
class CompanionServerDepsImpl(
    override val appContext: Context,
    private val tokenStoreImpl: TokenStore,
    private val rootStoreImpl: RootStore,
    private val sqliteKVStore: SqliteKVStore
) : CompanionServerDeps {
    private val app: JSTorrentApplication
        get() = appContext.applicationContext as JSTorrentApplication

    private val streamScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val activeHttpStreamSessions = ConcurrentHashMap<String, ActiveTorrentHttpStreamSession>()
    private val closedHttpStreamReasons = ConcurrentHashMap<String, String>()
    private val streamLifecycleListeners =
        CopyOnWriteArraySet<(TorrentHttpStreamLifecycleEvent) -> Unit>()

    override val versionName: String = BuildConfig.VERSION_NAME

    init {
        observeTorrentHttpStreamLifecycle()
    }

    override val tokenStore: TokenStoreProvider = object : TokenStoreProvider {
        override val token: String? get() = tokenStoreImpl.token
        override val extensionId: String? get() = tokenStoreImpl.extensionId
        override val installId: String? get() = tokenStoreImpl.installId
        override val standaloneToken: String get() = tokenStoreImpl.standaloneToken

        override fun hasToken(): Boolean = tokenStoreImpl.hasToken()
        override fun isPairedWith(extensionId: String, installId: String): Boolean =
            tokenStoreImpl.isPairedWith(extensionId, installId)
        override fun isTokenValid(token: String): Boolean = tokenStoreImpl.isTokenValid(token)
        override fun pair(token: String, installId: String, extensionId: String) {
            tokenStoreImpl.pair(token, installId, extensionId)
        }
    }

    override val rootStore: RootStoreProvider = object : RootStoreProvider {
        override fun refreshAvailability(): List<DownloadRoot> {
            return rootStoreImpl.refreshAvailability().map { root ->
                DownloadRoot(
                    key = root.key,
                    uri = root.uri,
                    displayName = root.displayName,
                    removable = root.removable,
                    lastStatOk = root.lastStatOk,
                    lastChecked = root.lastChecked
                )
            }
        }

        override fun getRoot(key: String): DownloadRoot? {
            return rootStoreImpl.getRoot(key)?.let { root ->
                DownloadRoot(
                    key = root.key,
                    uri = root.uri,
                    displayName = root.displayName,
                    removable = root.removable,
                    lastStatOk = root.lastStatOk,
                    lastChecked = root.lastChecked
                )
            }
        }

        override fun removeRoot(key: String): Boolean = rootStoreImpl.removeRoot(key)

        override fun resolveKey(key: String): Uri? = rootStoreImpl.resolveKey(key)
    }

    override val kvStore: KVStoreProvider = object : KVStoreProvider {
        override fun get(key: String): String? = sqliteKVStore.get(key)
        override fun getMulti(keys: List<String>): Map<String, String> = sqliteKVStore.getMulti(keys)
        override fun set(key: String, value: String) = sqliteKVStore.set(key, value)
        override fun delete(key: String): Boolean = sqliteKVStore.delete(key)
        override fun keys(prefix: String): List<String> = sqliteKVStore.keys(prefix)
        override fun clear(prefix: String): Int = sqliteKVStore.clear(prefix)
    }

    /**
     * Open the SAF folder picker activity.
     * Uses notification with full-screen intent as fallback for background restrictions.
     */
    override fun openFolderPicker() {
        val intent = Intent(appContext, AddRootActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_NEW_DOCUMENT
        }

        // Post notification first (as safety net) - activity will cancel it when it starts
        val channelId = "jstorrent_folder_picker"
        val notificationId = AddRootActivity.FOLDER_PICKER_NOTIFICATION_ID

        val channel = NotificationChannel(
            channelId,
            "Folder Picker",
            NotificationManager.IMPORTANCE_HIGH
        ).apply {
            description = "Shows folder picker when requested by extension"
        }
        val notificationManager = appContext.getSystemService(NotificationManager::class.java)
        notificationManager.createNotificationChannel(channel)

        // Cancel any existing notification first - forces fresh heads-up
        notificationManager.cancel(notificationId)

        val pendingIntent = PendingIntent.getActivity(
            appContext,
            0,
            intent,
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )

        val notification = NotificationCompat.Builder(appContext, channelId)
            .setContentTitle("Add Download Folder")
            .setContentText("Tap to select a download folder")
            .setSmallIcon(R.drawable.ic_launcher_foreground)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setFullScreenIntent(pendingIntent, true)
            .setAutoCancel(true)
            .build()

        notificationManager.notify(notificationId, notification)
        Log.i(TAG, "Folder picker notification posted")

        // Also try direct activity start
        try {
            appContext.startActivity(intent)
            Log.i(TAG, "Folder picker activity start attempted")
        } catch (e: Exception) {
            Log.w(TAG, "Direct activity start failed: ${e.message}")
        }
    }

    /**
     * Show pairing approval dialog.
     */
    override fun showPairingDialog(
        token: String,
        installId: String,
        extensionId: String,
        isReplace: Boolean
    ) {
        PairingApprovalActivity.pendingCallback = { approved, approvedToken, approvedInstallId, approvedExtensionId ->
            if (approved && approvedToken != null && approvedInstallId != null && approvedExtensionId != null) {
                tokenStoreImpl.pair(approvedToken, approvedInstallId, approvedExtensionId)
                Log.i(TAG, "Pairing approved and stored")
            } else {
                Log.i(TAG, "Pairing denied or dismissed")
            }
        }

        val intent = Intent(appContext, PairingApprovalActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_NEW_TASK
            putExtra(PairingApprovalActivity.EXTRA_TOKEN, token)
            putExtra(PairingApprovalActivity.EXTRA_INSTALL_ID, installId)
            putExtra(PairingApprovalActivity.EXTRA_EXTENSION_ID, extensionId)
            putExtra(PairingApprovalActivity.EXTRA_IS_REPLACE, isReplace)
        }
        appContext.startActivity(intent)
    }

    /**
     * Release SAF permission for a URI.
     */
    override fun releaseSafPermission(uriString: String) {
        try {
            val uri = Uri.parse(uriString)
            appContext.contentResolver.releasePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                        Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
            Log.i(TAG, "Released SAF permission for $uriString")
        } catch (e: Exception) {
            Log.w(TAG, "Failed to release SAF permission: ${e.message}")
        }
    }

    /**
     * Notify that a new control connection has been established.
     */
    override fun notifyConnectionEstablished() {
        PendingLinkManager.notifyConnectionEstablished()
    }

    /**
     * Open a file with the system's default application.
     */
    override fun openFile(rootKey: String, path: String): Pair<Boolean, String?> {
        val result = FileOpener.openFile(appContext, rootKey, path)
        return Pair(result.ok, result.error)
    }

    /**
     * Open/reveal a folder in the system file manager.
     */
    override fun openFolder(rootKey: String, path: String): Pair<Boolean, String?> {
        val result = if (path.isEmpty()) {
            FileOpener.openFolder(appContext, rootKey)
        } else {
            FileOpener.revealInFolder(appContext, rootKey, path)
        }
        return Pair(result.ok, result.error)
    }

    override suspend fun openTorrentHttpStreamSession(
        sessionId: String,
        torrentId: String,
        fileIndex: Int
    ): TorrentHttpStreamSessionInfo {
        closedHttpStreamReasons.remove(sessionId)
        val controller = app.ensureEngineStarted()
        val info = controller.openPlaybackSessionAsync(sessionId, torrentId, fileIndex)
        val fileSize = info.fileSize
        if (!info.ok || fileSize == null || fileSize < 0) {
            throw TorrentHttpStreamException(
                status = TorrentHttpStreamStatus.StreamSessionMismatch,
                message = info.error ?: "Failed to open torrent HTTP stream session",
            )
        }

        activeHttpStreamSessions[sessionId] = ActiveTorrentHttpStreamSession(
            sessionId = sessionId,
            torrentId = torrentId,
        )
        return TorrentHttpStreamSessionInfo(fileSize = fileSize)
    }

    override suspend fun readTorrentHttpStreamBytes(
        sessionId: String,
        offset: Long,
        length: Int
    ): ByteArray {
        val controller = app.ensureEngineStarted()
        return try {
            controller.readPlaybackBytesAsync(sessionId, offset, length)
        } catch (e: Exception) {
            val directStatus = mapTorrentHttpStreamStatus(e.message)
            if (directStatus != null) {
                throw TorrentHttpStreamException(directStatus, e.message ?: directStatus.name, e)
            }

            val closeReason = closedHttpStreamReasons.remove(sessionId)
            if (e.message == "Aborted" && closeReason != null) {
                throw TorrentHttpStreamException(
                    mapCloseReasonToStatus(closeReason),
                    closeReason,
                    e,
                )
            }

            if (e.message == "Playback session not found") {
                throw TorrentHttpStreamException(
                    TorrentHttpStreamStatus.StreamSessionNotFound,
                    e.message ?: TorrentHttpStreamStatus.StreamSessionNotFound.name,
                    e,
                )
            }

            throw IOException(e.message ?: "Torrent HTTP stream read failed", e)
        } finally {
            if (!activeHttpStreamSessions.containsKey(sessionId)) {
                closedHttpStreamReasons.remove(sessionId)
            }
        }
    }

    override fun closeTorrentHttpStreamSession(sessionId: String, reason: String) {
        closedHttpStreamReasons[sessionId] = reason
        activeHttpStreamSessions.remove(sessionId)
        app.engineController?.closePlaybackSession(sessionId)
    }

    override fun subscribeTorrentHttpStreamLifecycle(
        listener: (TorrentHttpStreamLifecycleEvent) -> Unit
    ): AutoCloseable {
        streamLifecycleListeners += listener
        return AutoCloseable {
            streamLifecycleListeners -= listener
        }
    }

    private fun observeTorrentHttpStreamLifecycle() {
        streamScope.launch {
            var previousTorrents = emptyMap<String, TorrentSummary>()
            app.engineServiceRepository.state.collectLatest { state ->
                val currentTorrents = state?.torrents?.associateBy { it.infoHash } ?: emptyMap()

                for (removedTorrentId in previousTorrents.keys - currentTorrents.keys) {
                    closeHttpStreamSessionsForTorrent(removedTorrentId, "torrent-removed")
                    notifyTorrentHttpStreamLifecycle(
                        TorrentHttpStreamLifecycleEvent(
                            torrentId = removedTorrentId,
                            reason = "torrent-removed",
                        )
                    )
                }

                for ((torrentId, torrent) in currentTorrents) {
                    val previous = previousTorrents[torrentId]
                    val currentReason = getTorrentSessionCloseReason(torrent)
                    val previousReason = previous?.let(::getTorrentSessionCloseReason)
                    if (currentReason != null && currentReason != previousReason) {
                        closeHttpStreamSessionsForTorrent(torrentId, currentReason)
                    }
                }

                previousTorrents = currentTorrents
            }
        }
    }

    private fun closeHttpStreamSessionsForTorrent(torrentId: String, reason: String) {
        val sessionIds = activeHttpStreamSessions.values
            .filter { it.torrentId == torrentId }
            .map { it.sessionId }
        for (sessionId in sessionIds) {
            closeTorrentHttpStreamSession(sessionId, reason)
        }
    }

    private fun notifyTorrentHttpStreamLifecycle(event: TorrentHttpStreamLifecycleEvent) {
        for (listener in streamLifecycleListeners) {
            listener(event)
        }
    }

    private fun getTorrentSessionCloseReason(torrent: TorrentSummary): String? {
        if (torrent.errorMessage != null || torrent.status == "error") {
            return "torrent-errored"
        }
        if (torrent.userState == "stopped" || torrent.status == "stopped") {
            return "torrent-stopped"
        }
        if (torrent.userState != "active" || torrent.status == "queued") {
            return "torrent-inactive"
        }
        return null
    }

    private fun mapCloseReasonToStatus(reason: String): TorrentHttpStreamStatus {
        return when (reason) {
            "torrent-removed" -> TorrentHttpStreamStatus.TorrentRemoved
            "torrent-stopped" -> TorrentHttpStreamStatus.TorrentStopped
            "torrent-errored" -> TorrentHttpStreamStatus.TorrentErrored
            else -> TorrentHttpStreamStatus.TorrentInactive
        }
    }

    private fun mapTorrentHttpStreamStatus(message: String?): TorrentHttpStreamStatus? {
        return when (message) {
            TorrentHttpStreamStatus.FileSkipped.name -> TorrentHttpStreamStatus.FileSkipped
            TorrentHttpStreamStatus.StreamSessionMismatch.name -> TorrentHttpStreamStatus.StreamSessionMismatch
            TorrentHttpStreamStatus.StreamSessionNotFound.name -> TorrentHttpStreamStatus.StreamSessionNotFound
            TorrentHttpStreamStatus.TorrentErrored.name -> TorrentHttpStreamStatus.TorrentErrored
            TorrentHttpStreamStatus.TorrentInactive.name -> TorrentHttpStreamStatus.TorrentInactive
            TorrentHttpStreamStatus.TorrentRemoved.name -> TorrentHttpStreamStatus.TorrentRemoved
            TorrentHttpStreamStatus.TorrentStopped.name -> TorrentHttpStreamStatus.TorrentStopped
            else -> null
        }
    }
}
