package com.jstorrent.app.companion

import com.jstorrent.app.service.IoDaemonService
import com.jstorrent.io.protocol.Protocol
import java.io.File
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import androidx.test.ext.junit.runners.AndroidJUnit4

@RunWith(AndroidJUnit4::class)
class DaemonContractHttpConformanceTest : CompanionTestBase() {
    private val json = Json { ignoreUnknownKeys = true }

    private lateinit var token: String
    private lateinit var testRootKey: String
    private lateinit var testDir: File

    @Before
    override fun setUp() {
        super.setUp()
        token = setupAuthToken()
        val root = addTestFileRoot(token, "daemon_conformance_${System.currentTimeMillis()}")
        testRootKey = root.first
        testDir = root.second
    }

    @After
    override fun tearDown() {
        testDir.deleteRecursively()
        super.tearDown()
    }

    private fun createClientHello(requestId: Int): ByteArray {
        return Protocol.createMessage(Protocol.OP_CLIENT_HELLO, requestId)
    }

    private fun createAuthFrame(requestId: Int, token: String, extensionId: String, installId: String): ByteArray {
        val payload = byteArrayOf(0) +
            token.toByteArray() + byteArrayOf(0) +
            extensionId.toByteArray() + byteArrayOf(0) +
            installId.toByteArray()
        return Protocol.createMessage(Protocol.OP_AUTH, requestId, payload)
    }

    private fun createControlJsonFrame(requestId: Int, opcode: Byte, body: String = "{}"): ByteArray {
        return Protocol.createMessage(opcode, requestId, body.toByteArray())
    }

    @Test
    fun conformance__health__ok_is_reported__impl__android() {
        val response = get("/health")
        assertEquals(200, response.code)
        assertEquals("ok", response.body?.string())
    }

    @Test
    fun conformance__status__capabilities_are_reported__impl__android() {
        val response = post("/status", """{"token":"$token"}""", extensionHeaders())
        assertEquals(200, response.code)

        val body = response.body?.string() ?: ""
        val payload = json.parseToJsonElement(body).jsonObject
        assertTrue(payload["port"]?.jsonPrimitive?.content?.toIntOrNull() ?: 0 > 0)
        assertTrue(payload["paired"]?.jsonPrimitive?.booleanOrNull ?: false)
        assertTrue(payload["tokenValid"]?.jsonPrimitive?.booleanOrNull ?: false)

        val capabilities = payload["capabilities"]?.jsonObject
        requireNotNull(capabilities)
        assertTrue(capabilities["status"]?.jsonPrimitive?.booleanOrNull ?: false)
        assertTrue(capabilities["fileOps"]?.jsonPrimitive?.booleanOrNull ?: false)
        assertTrue(capabilities["mediaBlocking206"]?.jsonPrimitive?.booleanOrNull ?: false)
        assertEquals(1, payload["protocolVersion"]?.jsonPrimitive?.content?.toIntOrNull())
        assertEquals(1, payload["behaviorVersion"]?.jsonPrimitive?.content?.toIntOrNull())
    }

    @Test
    fun conformance__status__contract_versions_are_reported__impl__android() {
        val response = post("/status", """{"token":"$token"}""", extensionHeaders())
        assertEquals(200, response.code)

        val body = response.body?.string() ?: ""
        val payload = json.parseToJsonElement(body).jsonObject
        assertEquals(1, payload["protocolVersion"]?.jsonPrimitive?.content?.toIntOrNull())
        assertEquals(1, payload["behaviorVersion"]?.jsonPrimitive?.content?.toIntOrNull())
    }

    @Test
    fun conformance__roots__list_is_reported__impl__android() {
        val response = get("/roots", extensionHeaders(token))

        assertEquals(200, response.code)
        val body = response.body?.string() ?: ""
        val payload = json.parseToJsonElement(body).jsonObject
        val roots = payload["roots"]?.jsonArray ?: error("Missing roots array")
        val rootKeys = roots.mapNotNull { it.jsonObject["key"]?.jsonPrimitive?.content }
        assertTrue(rootKeys.contains(testRootKey))
    }

    @Test
    fun conformance__roots__delete_existing_root_succeeds__impl__android() {
        val deleteResponse = delete("/roots/$testRootKey", extensionHeaders(token))
        assertEquals(200, deleteResponse.code)

        val rootsResponse = get("/roots", extensionHeaders(token))
        assertEquals(200, rootsResponse.code)
        val body = rootsResponse.body?.string() ?: ""
        val payload = json.parseToJsonElement(body).jsonObject
        val roots = payload["roots"]?.jsonArray ?: error("Missing roots array")
        val rootKeys = roots.mapNotNull { it.jsonObject["key"]?.jsonPrimitive?.content }
        assertFalse(rootKeys.contains(testRootKey))
    }

    @Test
    fun conformance__control__capabilities_are_reported__impl__android() {
        val ioPort = IoDaemonService.instance?.ioPort?.takeIf { it > 0 }
            ?: throw AssertionError("ioPort not available (WebSocket server failed to start)")
        val request = Request.Builder()
            .url("ws://127.0.0.1:$ioPort/control")
            .build()
        val latch = CountDownLatch(1)
        val error = AtomicReference<Throwable>()
        val payloadRef = AtomicReference<String?>()

        val listener = object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                webSocket.send(createClientHello(1).toByteString())
            }

            override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                val data = bytes.toByteArray()
                val opcode = data.getOrNull(1)?.toInt()?.and(0xFF) ?: -1

                when (opcode) {
                    Protocol.OP_SERVER_HELLO.toInt() and 0xFF -> {
                        webSocket.send(
                            createAuthFrame(2, token, "testextensionid", "test-install-id-12345").toByteString()
                        )
                    }
                    Protocol.OP_AUTH_RESULT.toInt() and 0xFF -> {
                        val status = data.getOrNull(8)?.toInt()?.and(0xFF) ?: -1
                        if (status != 0) {
                            error.set(AssertionError("Control auth failed with status=$status"))
                            latch.countDown()
                            webSocket.close(1000, "Auth failed")
                            return
                        }
                        webSocket.send(createControlJsonFrame(9, Protocol.OP_CTRL_GET_CAPABILITIES).toByteString())
                    }
                    Protocol.OP_CTRL_GET_CAPABILITIES.toInt() and 0xFF -> {
                        payloadRef.set(String(data.copyOfRange(8, data.size)))
                        latch.countDown()
                        webSocket.close(1000, "Done")
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                error.set(t)
                latch.countDown()
            }
        }

        httpClient.newWebSocket(request, listener)

        assertTrue("Should complete control capabilities request", latch.await(10, TimeUnit.SECONDS))
        assertNull("Should have no websocket error", error.get())

        val payloadText = payloadRef.get()
        assertNotNull("Should have capability payload", payloadText)
        val payload = json.parseToJsonElement(payloadText!!).jsonObject
        assertTrue(payload["ok"]?.jsonPrimitive?.booleanOrNull ?: false)
        assertEquals(1, payload["protocolVersion"]?.jsonPrimitive?.content?.toIntOrNull())
        assertEquals(1, payload["behaviorVersion"]?.jsonPrimitive?.content?.toIntOrNull())
        val capabilities = payload["capabilities"]?.jsonObject ?: error("Missing capabilities object")
        assertTrue(capabilities["roots_manageable"]?.jsonPrimitive?.booleanOrNull ?: false)
        assertTrue(capabilities["lan_share_urls"]?.jsonPrimitive?.booleanOrNull ?: false)
    }

    @Test
    fun conformance__ops__delete__missing_returns_404__impl__android() {
        val response = post(
            "/ops/delete",
            """{"root_key":"$testRootKey","path":"missing-file.bin"}""",
            extensionHeaders(token)
        )

        assertEquals(404, response.code)
    }

    @Test
    fun conformance__ops__batch_delete__ignores_missing_entries__impl__android() {
        val nestedDir = File(testDir, "nested")
        nestedDir.mkdirs()
        File(nestedDir, "present.txt").writeText("hello")

        val response = post(
            "/ops/batch_delete",
            """{"root_key":"$testRootKey","directory":"nested","entries":["present.txt","missing.txt","../escape.txt"]}""",
            extensionHeaders(token)
        )

        assertEquals(200, response.code)
        val body = response.body?.string() ?: ""
        val failedEntries = json.parseToJsonElement(body).jsonArray.map { it.jsonPrimitive.content }
        assertEquals(listOf("../escape.txt"), failedEntries)
        assertFalse(File(nestedDir, "present.txt").exists())
    }
}
