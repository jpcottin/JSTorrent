package com.jstorrent.app.companion

import android.content.Context
import android.net.Uri
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jstorrent.companion.server.CompanionServerDeps
import com.jstorrent.companion.server.DownloadRoot
import com.jstorrent.companion.server.HttpStreamSessionRegistry
import com.jstorrent.companion.server.KVStoreProvider
import com.jstorrent.companion.server.LanMediaHttpServer
import com.jstorrent.companion.server.RootStoreProvider
import com.jstorrent.companion.server.TokenStoreProvider
import com.jstorrent.companion.server.TorrentHttpStreamException
import com.jstorrent.companion.server.TorrentHttpStreamLifecycleEvent
import com.jstorrent.companion.server.TorrentHttpStreamSessionInfo
import com.jstorrent.companion.server.TorrentHttpStreamStatus
import com.jstorrent.io.file.FileManagerImpl
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

    fun registerTorrentFile(torrentId: String, fileIndex: Int, content: ByteArray) {
        files[FakeTorrentFileKey(torrentId, fileIndex)] = content
    }

    fun failReadsForTorrent(torrentId: String, status: TorrentHttpStreamStatus) {
        failureByTorrentId[torrentId] = status
    }

    fun blockReadsForTorrent(torrentId: String): CompletableDeferred<Unit> {
        return CompletableDeferred<Unit>().also { gate ->
            blockReadsGate[torrentId] = gate
        }
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
        activeSessions[sessionId] = FakeActiveSession(
            torrentId = torrentId,
            fileIndex = fileIndex,
            content = content,
        )
        return TorrentHttpStreamSessionInfo(fileSize = content.size.toLong())
    }

    override suspend fun readTorrentHttpStreamBytes(
        sessionId: String,
        offset: Long,
        length: Int
    ): ByteArray {
        val session = activeSessions[sessionId]
            ?: throw TorrentHttpStreamException(TorrentHttpStreamStatus.StreamSessionNotFound)
        readCount.incrementAndGet()
        readStarted.countDown()

        blockReadsGate[session.torrentId]?.await()

        failureByTorrentId[session.torrentId]?.let { status ->
            throw TorrentHttpStreamException(status)
        }

        val start = offset.toInt()
        val endExclusive = minOf(session.content.size, start + length)
        return session.content.copyOfRange(start, endExclusive)
    }

    override fun closeTorrentHttpStreamSession(sessionId: String, reason: String) {
        closedSessionReasons[sessionId] = reason
        activeSessions.remove(sessionId)
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
    fun rangeRequestBlocksThenReturnsPartialContent() {
        val torrentId = "torrent-a"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(64) { it.toByte() }
        deps.registerTorrentFile(torrentId, 0, content)
        val gate = deps.blockReadsForTorrent(torrentId)
        registry.register(
            ownerId = "owner-a",
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
        assertEquals("request-complete", deps.closedSessionReasons.values.single())
    }

    @Test
    fun headRequestDoesNotOpenTorrentStreamSession() {
        val torrentId = "torrent-head"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(32) { (it + 10).toByte() }
        deps.registerTorrentFile(torrentId, 0, content)
        registry.register(
            ownerId = "owner-head",
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
    fun torrentStoppedReturnsConflict() {
        val torrentId = "torrent-stopped"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(48) { (it * 2).toByte() }
        deps.registerTorrentFile(torrentId, 0, content)
        deps.failReadsForTorrent(torrentId, TorrentHttpStreamStatus.TorrentStopped)
        registry.register(
            ownerId = "owner-stop",
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
        assertEquals("request-complete", deps.closedSessionReasons.values.single())
    }

    @Test
    fun torrentRemovedLifecycleRevokesToken() {
        val torrentId = "torrent-removed"
        val token = "stream-${UUID.randomUUID()}"
        val content = ByteArray(24) { (it + 1).toByte() }
        deps.registerTorrentFile(torrentId, 0, content)
        registry.register(
            ownerId = "owner-remove",
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
