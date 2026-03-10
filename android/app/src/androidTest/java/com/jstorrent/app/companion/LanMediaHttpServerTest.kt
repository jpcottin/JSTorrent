package com.jstorrent.app.companion

import android.content.Context
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jstorrent.companion.server.CompanionServerDeps
import com.jstorrent.companion.server.DownloadRoot
import com.jstorrent.companion.server.HttpStreamBackendKind
import com.jstorrent.companion.server.HttpStreamSessionRegistry
import com.jstorrent.companion.server.LocalAppTorrentHttpStreamBackend
import com.jstorrent.companion.server.KVStoreProvider
import com.jstorrent.companion.server.LanMediaHttpServer
import com.jstorrent.companion.server.RootStoreProvider
import com.jstorrent.companion.server.TokenStoreProvider
import com.jstorrent.companion.server.TorrentHttpStreamException
import com.jstorrent.companion.server.TorrentHttpStreamLifecycleEvent
import com.jstorrent.companion.server.TorrentHttpStreamSessionInfo
import com.jstorrent.companion.server.TorrentHttpStreamStatus
import com.jstorrent.io.file.FileManagerImpl
import java.io.IOException
import java.util.concurrent.CompletableFuture
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CopyOnWriteArraySet
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import okhttp3.Headers
import okhttp3.OkHttpClient
import okhttp3.Call
import okhttp3.Request
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.UUID

private data class HttpResponseData(
    val statusCode: Int,
    val headers: Headers,
    val body: ByteArray,
)

private data class ManagedHttpRequest(
    val call: Call,
    val response: CompletableFuture<HttpResponseData>,
)

private data class FakeTorrentFileKey(
    val torrentId: String,
    val fileIndex: Int,
)

private data class FakeActiveSession(
    val torrentId: String,
    val fileIndex: Int,
    val content: ByteArray,
)

private class FakeLanMediaDeps(
    override val appContext: Context,
) : CompanionServerDeps {
    private val rootUri = Uri.parse("file://${appContext.cacheDir.absolutePath}")
    private val listeners = CopyOnWriteArraySet<(TorrentHttpStreamLifecycleEvent) -> Unit>()
    private val files = ConcurrentHashMap<FakeTorrentFileKey, ByteArray>()
    private val activeSessions = ConcurrentHashMap<String, FakeActiveSession>()
    private val failureByTorrentId = ConcurrentHashMap<String, TorrentHttpStreamStatus>()
    private val blockReadsGate = ConcurrentHashMap<String, CompletableDeferred<Unit>>()
    private val individuallyBlockedTorrents = ConcurrentHashMap.newKeySet<String>()
    private val sessionReadGates = ConcurrentHashMap<String, CompletableDeferred<Unit>>()

    val openCount = AtomicInteger(0)
    val readCount = AtomicInteger(0)
    val openedSessionIds = CopyOnWriteArrayList<String>()
    val closedSessionReasons = ConcurrentHashMap<String, String>()
    val readStarted = CountDownLatch(1)

    override val tokenStore: TokenStoreProvider = object : TokenStoreProvider {
        override val token: String? = null
        override val extensionId: String? = null
        override val installId: String? = null
        override val standaloneToken: String = "standalone"
        override fun hasToken(): Boolean = false
        override fun isPairedWith(extensionId: String, installId: String): Boolean = false
        override fun isTokenValid(token: String): Boolean = false
        override fun pair(token: String, installId: String, extensionId: String) = Unit
    }

    override val rootStore: RootStoreProvider = object : RootStoreProvider {
        override fun refreshAvailability(): List<DownloadRoot> = emptyList()
        override fun getRoot(key: String): DownloadRoot? = null
        override fun removeRoot(key: String): Boolean = false
        override fun resolveKey(key: String): Uri? = if (key == "root-a") rootUri else null
    }

    override val kvStore: KVStoreProvider = object : KVStoreProvider {
        override fun get(key: String): String? = null
        override fun getMulti(keys: List<String>): Map<String, String> = emptyMap()
        override fun set(key: String, value: String) = Unit
        override fun delete(key: String): Boolean = false
        override fun keys(prefix: String): List<String> = emptyList()
        override fun clear(prefix: String): Int = 0
    }

    override val versionName: String = "test"

    override fun openFolderPicker() = Unit

    override fun showPairingDialog(
        token: String,
        installId: String,
        extensionId: String,
        isReplace: Boolean
    ) = Unit

    override fun releaseSafPermission(uriString: String) = Unit

    override fun notifyConnectionEstablished() = Unit

    override fun openFile(rootKey: String, path: String): Pair<Boolean, String?> = true to null

    override fun openFolder(rootKey: String, path: String): Pair<Boolean, String?> = true to null

    fun registerTorrentFile(torrentId: String, fileIndex: Int, path: String, content: ByteArray) {
        files[FakeTorrentFileKey(torrentId, fileIndex)] = content
        val file = java.io.File(appContext.cacheDir, path)
        file.parentFile?.mkdirs()
        file.writeBytes(content)
    }

    fun failReadsForTorrent(torrentId: String, status: TorrentHttpStreamStatus) {
        failureByTorrentId[torrentId] = status
    }

    fun blockReadsForTorrent(torrentId: String): CompletableDeferred<Unit> {
        return CompletableDeferred<Unit>().also { gate ->
            blockReadsGate[torrentId] = gate
        }
    }

    fun blockReadsPerSessionForTorrent(torrentId: String) {
        individuallyBlockedTorrents += torrentId
    }

    fun unblockSessionRead(sessionId: String) {
        sessionReadGates[sessionId]?.complete(Unit)
    }

    fun emitLifecycle(event: TorrentHttpStreamLifecycleEvent) {
        listeners.forEach { it(event) }
    }

    override suspend fun openTorrentHttpStreamSession(
        sessionId: String,
        torrentId: String,
        fileIndex: Int
    ): TorrentHttpStreamSessionInfo {
        val key = FakeTorrentFileKey(torrentId, fileIndex)
        val content = files[key]
            ?: throw TorrentHttpStreamException(TorrentHttpStreamStatus.StreamSessionMismatch)
        openCount.incrementAndGet()
        openedSessionIds += sessionId
        if (individuallyBlockedTorrents.contains(torrentId)) {
            sessionReadGates[sessionId] = CompletableDeferred()
        }
        activeSessions[sessionId] = FakeActiveSession(
            torrentId = torrentId,
            fileIndex = fileIndex,
            content = content,
        )
        return TorrentHttpStreamSessionInfo(fileSize = content.size.toLong())
    }

    override suspend fun waitForTorrentHttpStreamRange(
        sessionId: String,
        offset: Long,
        length: Int
    ) {
        val session = activeSessions[sessionId]
            ?: throw TorrentHttpStreamException(TorrentHttpStreamStatus.StreamSessionNotFound)
        readCount.incrementAndGet()
        readStarted.countDown()

        sessionReadGates[sessionId]?.await()
        blockReadsGate[session.torrentId]?.await()

        val closeReason = closedSessionReasons[sessionId]
        if (closeReason == "client-aborted" || !activeSessions.containsKey(sessionId)) {
            throw IOException("Aborted")
        }

        failureByTorrentId[session.torrentId]?.let { status ->
            throw TorrentHttpStreamException(status)
        }
    }

    override fun closeTorrentHttpStreamSession(sessionId: String, reason: String) {
        closedSessionReasons[sessionId] = reason
        activeSessions.remove(sessionId)
        sessionReadGates.remove(sessionId)?.complete(Unit)
    }

    override fun subscribeTorrentHttpStreamLifecycle(
        listener: (TorrentHttpStreamLifecycleEvent) -> Unit
    ): AutoCloseable {
        listeners += listener
        return AutoCloseable {
            listeners -= listener
        }
    }
}

@RunWith(AndroidJUnit4::class)
class LanMediaHttpServerTest {
    private lateinit var context: Context
    private lateinit var deps: FakeLanMediaDeps
    private lateinit var registry: HttpStreamSessionRegistry
    private lateinit var server: LanMediaHttpServer
    private lateinit var httpClient: OkHttpClient

    @Before
    fun setUp() {
        context = InstrumentationRegistry.getInstrumentation().targetContext
        deps = FakeLanMediaDeps(context)
        registry = HttpStreamSessionRegistry()
        server = LanMediaHttpServer(
            deps = deps,
            fileManager = FileManagerImpl(context),
            httpStreams = registry,
            localAppBackend = LocalAppTorrentHttpStreamBackend(deps),
            extensionControlBackend = LocalAppTorrentHttpStreamBackend(deps),
        )
        server.startIfNeeded(0)
        httpClient = OkHttpClient.Builder()
            .connectTimeout(5, TimeUnit.SECONDS)
            .readTimeout(5, TimeUnit.SECONDS)
            .writeTimeout(5, TimeUnit.SECONDS)
            .build()
    }

    @After
    fun tearDown() {
        server.stop()
        registry.clear()
        httpClient.dispatcher.executorService.shutdownNow()
        httpClient.connectionPool.evictAll()
    }

    @Test
    fun conformance__stream__blocks_until_ready__impl__android() {
        val torrentId = "torrent-a"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(64) { it.toByte() }
        deps.registerTorrentFile(torrentId, 0, "fixture.bin", content)
        val gate = deps.blockReadsForTorrent(torrentId)
        registry.register(
            ownerId = "owner-a",
            backendKind = HttpStreamBackendKind.LocalApp,
            token = token,
            torrentId = torrentId,
            fileIndex = 0,
            rootKey = "root-a",
            path = "fixture.bin",
            fileSize = content.size.toLong(),
            mimeType = "application/octet-stream",
        )

        val future = startRequest(
            Request.Builder()
                .url(streamUrl(token))
                .header("Range", "bytes=8-23")
                .build()
        )

        assertTrue("read should start", deps.readStarted.await(5, TimeUnit.SECONDS))
        Thread.sleep(200)
        assertFalse("request should still be blocked", future.isDone)

        gate.complete(Unit)
        val response = future.get(5, TimeUnit.SECONDS)

        assertEquals(206, response.statusCode)
        assertEquals("bytes 8-23/${content.size}", response.headers["Content-Range"])
        assertArrayEquals(content.copyOfRange(8, 24), response.body)
        assertEquals(1, deps.openCount.get())
        assertEquals(1, deps.readCount.get())
        waitForCondition { deps.closedSessionReasons.size == 1 }
        assertEquals("request-complete", deps.closedSessionReasons.values.single())
    }

    @Test
    fun conformance__stream__concurrent_readers_are_isolated__impl__android() {
        val torrentId = "torrent-concurrent"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(128) { (it * 3).toByte() }
        deps.registerTorrentFile(torrentId, 0, "concurrent.bin", content)
        val gate = deps.blockReadsForTorrent(torrentId)
        registry.register(
            ownerId = "owner-concurrent",
            backendKind = HttpStreamBackendKind.LocalApp,
            token = token,
            torrentId = torrentId,
            fileIndex = 0,
            rootKey = "root-a",
            path = "concurrent.bin",
            fileSize = content.size.toLong(),
            mimeType = "application/octet-stream",
        )

        val first = startRequest(
            Request.Builder()
                .url(streamUrl(token))
                .header("Range", "bytes=0-15")
                .build()
        )
        val second = startRequest(
            Request.Builder()
                .url(streamUrl(token))
                .header("Range", "bytes=32-47")
                .build()
        )

        waitForCondition { deps.openCount.get() == 2 && deps.readCount.get() == 2 }
        assertFalse(first.isDone)
        assertFalse(second.isDone)

        gate.complete(Unit)

        val firstResponse = first.get(5, TimeUnit.SECONDS)
        val secondResponse = second.get(5, TimeUnit.SECONDS)

        assertEquals(206, firstResponse.statusCode)
        assertEquals(206, secondResponse.statusCode)
        assertEquals("bytes 0-15/${content.size}", firstResponse.headers["Content-Range"])
        assertEquals("bytes 32-47/${content.size}", secondResponse.headers["Content-Range"])
        assertArrayEquals(content.copyOfRange(0, 16), firstResponse.body)
        assertArrayEquals(content.copyOfRange(32, 48), secondResponse.body)
        assertEquals(2, deps.openCount.get())
        assertEquals(2, deps.readCount.get())
        assertEquals(2, deps.openedSessionIds.distinct().size)
        waitForCondition { deps.closedSessionReasons.size == 2 }
        assertEquals(2, deps.closedSessionReasons.size)
        assertTrue(deps.closedSessionReasons.values.all { it == "request-complete" })
    }

    @Test
    fun conformance__stream__cancel_isolation__impl__android() {
        val torrentId = "torrent-cancel-isolated"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(128) { (it * 5).toByte() }
        deps.registerTorrentFile(torrentId, 0, "cancel.bin", content)
        deps.blockReadsPerSessionForTorrent(torrentId)
        registry.register(
            ownerId = "owner-cancel",
            backendKind = HttpStreamBackendKind.LocalApp,
            token = token,
            torrentId = torrentId,
            fileIndex = 0,
            rootKey = "root-a",
            path = "cancel.bin",
            fileSize = content.size.toLong(),
            mimeType = "application/octet-stream",
        )

        val first = startManagedRequest(
            Request.Builder()
                .url(streamUrl(token))
                .header("Range", "bytes=0-15")
                .build()
        )
        val second = startManagedRequest(
            Request.Builder()
                .url(streamUrl(token))
                .header("Range", "bytes=32-47")
                .build()
        )

        waitForCondition { deps.openedSessionIds.size == 2 && deps.readCount.get() == 2 }
        assertFalse(first.response.isDone)
        assertFalse(second.response.isDone)

        first.call.cancel()
        waitForCondition { deps.closedSessionReasons.values.any { it == "client-aborted" } }
        val abortedSessionId = deps.closedSessionReasons.entries
            .first { it.value == "client-aborted" }
            .key

        deps.openedSessionIds
            .filterNot { it == abortedSessionId }
            .forEach { deps.unblockSessionRead(it) }

        val secondResponse = second.response.get(5, TimeUnit.SECONDS)
        assertEquals(206, secondResponse.statusCode)
        assertEquals("bytes 32-47/${content.size}", secondResponse.headers["Content-Range"])
        assertArrayEquals(content.copyOfRange(32, 48), secondResponse.body)

        val firstFailure = runCatching { first.response.get(5, TimeUnit.SECONDS) }
        assertTrue(firstFailure.isFailure)
        waitForCondition { deps.closedSessionReasons.size == 2 }
        assertEquals(1, deps.closedSessionReasons.values.count { it == "client-aborted" })
        assertEquals(1, deps.closedSessionReasons.values.count { it == "request-complete" })
    }

    @Test
    fun headRequestDoesNotOpenTorrentStreamSession() {
        val torrentId = "torrent-head"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(32) { (it + 10).toByte() }
        deps.registerTorrentFile(torrentId, 0, "head.bin", content)
        registry.register(
            ownerId = "owner-head",
            backendKind = HttpStreamBackendKind.LocalApp,
            token = token,
            torrentId = torrentId,
            fileIndex = 0,
            rootKey = "root-a",
            path = "head.bin",
            fileSize = content.size.toLong(),
            mimeType = "video/mp4",
        )

        val response = execute(
            Request.Builder()
                .url(streamUrl(token))
                .header("Range", "bytes=0-15")
                .head()
                .build()
        )

        assertEquals(206, response.statusCode)
        assertEquals("bytes 0-15/${content.size}", response.headers["Content-Range"])
        assertEquals("16", response.headers["Content-Length"])
        assertTrue(response.body.isEmpty())
        assertEquals(0, deps.openCount.get())
        assertEquals(0, deps.readCount.get())
        assertTrue(deps.closedSessionReasons.isEmpty())
    }

    @Test
    fun conformance__stream__stopped_incomplete_returns_409__impl__android() {
        val torrentId = "torrent-stopped"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(48) { (it * 2).toByte() }
        deps.registerTorrentFile(torrentId, 0, "stopped.bin", content)
        deps.failReadsForTorrent(torrentId, TorrentHttpStreamStatus.TorrentStopped)
        registry.register(
            ownerId = "owner-stop",
            backendKind = HttpStreamBackendKind.LocalApp,
            token = token,
            torrentId = torrentId,
            fileIndex = 0,
            rootKey = "root-a",
            path = "stopped.bin",
            fileSize = content.size.toLong(),
            mimeType = "application/octet-stream",
        )

        val response = execute(
            Request.Builder()
                .url(streamUrl(token))
                .header("Range", "bytes=0-15")
                .build()
        )

        assertEquals(409, response.statusCode)
        assertEquals("Torrent is stopped", response.body.decodeToString())
        assertEquals(1, deps.openCount.get())
        assertEquals(1, deps.readCount.get())
        waitForCondition { deps.closedSessionReasons.size == 1 }
        assertEquals("request-complete", deps.closedSessionReasons.values.single())
    }

    @Test
    fun conformance__stream__removed_token_returns_404__impl__android() {
        val torrentId = "torrent-removed"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(24) { (it + 1).toByte() }
        deps.registerTorrentFile(torrentId, 0, "removed.bin", content)
        registry.register(
            ownerId = "owner-remove",
            backendKind = HttpStreamBackendKind.LocalApp,
            token = token,
            torrentId = torrentId,
            fileIndex = 0,
            rootKey = "root-a",
            path = "removed.bin",
            fileSize = content.size.toLong(),
            mimeType = "application/octet-stream",
        )

        deps.emitLifecycle(
            TorrentHttpStreamLifecycleEvent(
                torrentId = torrentId,
                reason = "torrent-removed",
            )
        )

        waitForCondition { registry.getAndTouch(token) == null }

        val response = execute(
            Request.Builder()
                .url(streamUrl(token))
                .build()
        )

        assertEquals(404, response.statusCode)
        assertEquals(0, deps.openCount.get())
        assertEquals(0, deps.readCount.get())
    }

    @Test
    fun conformance__stream__multi_chunk_waits__impl__android() {
        val torrentId = "torrent-multi-chunk"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(2 * 256 * 1024 + 8192) { (it % 251).toByte() }
        deps.registerTorrentFile(torrentId, 0, "multi-chunk.bin", content)
        val gate = deps.blockReadsForTorrent(torrentId)
        registry.register(
            ownerId = "owner-multi",
            backendKind = HttpStreamBackendKind.LocalApp,
            token = token,
            torrentId = torrentId,
            fileIndex = 0,
            rootKey = "root-a",
            path = "multi-chunk.bin",
            fileSize = content.size.toLong(),
            mimeType = "application/octet-stream",
        )

        val future = startRequest(
            Request.Builder()
                .url(streamUrl(token))
                .header("Range", "bytes=0-${content.size - 1}")
                .build()
        )

        assertTrue("first read should start", deps.readStarted.await(5, TimeUnit.SECONDS))
        Thread.sleep(200)
        assertFalse("request should still be blocked", future.isDone)

        gate.complete(Unit)
        val response = future.get(5, TimeUnit.SECONDS)

        assertEquals(206, response.statusCode)
        assertEquals("bytes 0-${content.size - 1}/${content.size}", response.headers["Content-Range"])
        assertArrayEquals(content, response.body)
        assertEquals(1, deps.openCount.get())
        assertEquals(3, deps.readCount.get())
        waitForCondition { deps.closedSessionReasons.size == 1 }
        assertEquals("request-complete", deps.closedSessionReasons.values.single())
    }

    private fun streamUrl(token: String): String = "http://127.0.0.1:${server.boundPort}/stream/$token"

    private fun execute(request: Request): HttpResponseData {
        httpClient.newCall(request).execute().use { response ->
            return HttpResponseData(
                statusCode = response.code,
                headers = response.headers,
                body = response.body?.bytes() ?: ByteArray(0),
            )
        }
    }

    private fun startRequest(request: Request): CompletableFuture<HttpResponseData> {
        return CompletableFuture.supplyAsync {
            execute(request)
        }
    }

    private fun startManagedRequest(request: Request): ManagedHttpRequest {
        val call = httpClient.newCall(request)
        return ManagedHttpRequest(
            call = call,
            response = CompletableFuture.supplyAsync {
                call.execute().use { response ->
                    HttpResponseData(
                        statusCode = response.code,
                        headers = response.headers,
                        body = response.body?.bytes() ?: ByteArray(0),
                    )
                }
            },
        )
    }

    private fun waitForCondition(
        timeoutMs: Long = 5_000,
        stepMs: Long = 10,
        condition: () -> Boolean,
    ) {
        val startedAt = System.currentTimeMillis()
        while (!condition()) {
            if (System.currentTimeMillis() - startedAt > timeoutMs) {
                throw AssertionError("Timed out waiting for condition")
            }
            Thread.sleep(stepMs)
        }
    }
}
