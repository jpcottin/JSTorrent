package com.jstorrent.companion.server

interface TorrentHttpStreamBackend {
    suspend fun openStreamSession(
        stream: RegisteredHttpStream,
        sessionId: String
    ): TorrentHttpStreamSessionInfo

    suspend fun waitForStreamRange(
        stream: RegisteredHttpStream,
        sessionId: String,
        offset: Long,
        length: Int
    )

    fun closeStreamSession(
        stream: RegisteredHttpStream,
        sessionId: String,
        reason: String
    )

    fun subscribeLifecycle(
        listener: (TorrentHttpStreamLifecycleEvent) -> Unit
    ): AutoCloseable = AutoCloseable {}
}

enum class HttpStreamBackendKind {
    LocalApp,
    ExtensionControl,
}

class LocalAppTorrentHttpStreamBackend(
    private val deps: CompanionServerDeps,
) : TorrentHttpStreamBackend {
    override suspend fun openStreamSession(
        stream: RegisteredHttpStream,
        sessionId: String
    ): TorrentHttpStreamSessionInfo {
        return deps.openTorrentHttpStreamSession(sessionId, stream.torrentId, stream.fileIndex)
    }

    override suspend fun waitForStreamRange(
        stream: RegisteredHttpStream,
        sessionId: String,
        offset: Long,
        length: Int
    ) {
        deps.waitForTorrentHttpStreamRange(sessionId, offset, length)
    }

    override fun closeStreamSession(
        stream: RegisteredHttpStream,
        sessionId: String,
        reason: String
    ) {
        deps.closeTorrentHttpStreamSession(sessionId, reason)
    }

    override fun subscribeLifecycle(
        listener: (TorrentHttpStreamLifecycleEvent) -> Unit
    ): AutoCloseable {
        return deps.subscribeTorrentHttpStreamLifecycle(listener)
    }
}

class ExtensionControlTorrentHttpStreamBackend(
    private val lookupSession: (ownerId: String) -> ControlWebSocketHandler?,
) : TorrentHttpStreamBackend {
    override suspend fun openStreamSession(
        stream: RegisteredHttpStream,
        sessionId: String
    ): TorrentHttpStreamSessionInfo {
        val session = lookupSession(stream.ownerId)
            ?: throw TorrentHttpStreamException(TorrentHttpStreamStatus.StreamSessionNotFound)
        return session.openOwnedTorrentStreamSession(stream, sessionId)
    }

    override suspend fun waitForStreamRange(
        stream: RegisteredHttpStream,
        sessionId: String,
        offset: Long,
        length: Int
    ) {
        val session = lookupSession(stream.ownerId)
            ?: throw TorrentHttpStreamException(TorrentHttpStreamStatus.StreamSessionNotFound)
        session.waitForOwnedTorrentStreamRange(stream, sessionId, offset, length)
    }

    override fun closeStreamSession(
        stream: RegisteredHttpStream,
        sessionId: String,
        reason: String
    ) {
        lookupSession(stream.ownerId)?.closeOwnedTorrentStreamSession(sessionId, reason)
    }
}
