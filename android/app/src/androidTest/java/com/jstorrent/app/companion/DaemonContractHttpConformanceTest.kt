package com.jstorrent.app.companion

import java.io.File
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
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
