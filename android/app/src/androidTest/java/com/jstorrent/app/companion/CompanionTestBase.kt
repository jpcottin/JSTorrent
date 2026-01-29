package com.jstorrent.app.companion

import android.content.Context
import androidx.test.platform.app.InstrumentationRegistry
import com.jstorrent.app.auth.TokenStore
import com.jstorrent.app.service.IoDaemonService
import com.jstorrent.app.storage.RootStore
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.junit.After
import org.junit.Before
import java.util.concurrent.TimeUnit

/**
 * Base class for companion mode tests.
 * Provides common setup/teardown and HTTP client utilities.
 */
abstract class CompanionTestBase {

    protected val context: Context = InstrumentationRegistry.getInstrumentation().targetContext
    protected lateinit var tokenStore: TokenStore
    protected lateinit var rootStore: RootStore

    protected val httpClient = OkHttpClient.Builder()
        .connectTimeout(5, TimeUnit.SECONDS)
        .readTimeout(5, TimeUnit.SECONDS)
        .writeTimeout(5, TimeUnit.SECONDS)
        .build()

    protected val baseUrl: String
        get() = "http://127.0.0.1:${IoDaemonService.instance?.port ?: 7800}"

    @Before
    open fun setUp() {
        tokenStore = TokenStore(context)
        rootStore = RootStore(context)

        // Clear any existing state
        tokenStore.clear()

        // Start service
        IoDaemonService.start(context)

        // Wait for server to be ready (both Ktor and java-websocket)
        // java-websocket may need extra time if ports are in use (fallback logic)
        runBlocking {
            repeat(100) {  // Up to 10 seconds
                val service = IoDaemonService.instance
                if (service?.isServerRunning == true && service.ioPort > 0) {
                    return@runBlocking
                }
                delay(100)
            }
            // Log warning if ioPort still not ready
            val service = IoDaemonService.instance
            if (service?.ioPort == 0) {
                android.util.Log.w("CompanionTestBase", "ioPort not available after 10s, port=${service?.port}")
            }
        }
    }

    @After
    open fun tearDown() {
        IoDaemonService.stop(context)
        // Wait longer for sockets to fully release before next test
        runBlocking { delay(2000) }
    }

    // =========================================================================
    // HTTP Helpers
    // =========================================================================

    protected fun get(path: String, headers: Map<String, String> = emptyMap()): okhttp3.Response {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .apply { headers.forEach { (k, v) -> addHeader(k, v) } }
            .get()
            .build()
        return httpClient.newCall(request).execute()
    }

    protected fun post(
        path: String,
        body: String = "",
        headers: Map<String, String> = emptyMap()
    ): okhttp3.Response {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .apply { headers.forEach { (k, v) -> addHeader(k, v) } }
            .post(body.toRequestBody("application/json".toMediaType()))
            .build()
        return httpClient.newCall(request).execute()
    }

    protected fun postBytes(
        path: String,
        body: ByteArray,
        headers: Map<String, String> = emptyMap()
    ): okhttp3.Response {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .apply { headers.forEach { (k, v) -> addHeader(k, v) } }
            .post(body.toRequestBody("application/octet-stream".toMediaType()))
            .build()
        return httpClient.newCall(request).execute()
    }

    protected fun delete(path: String, headers: Map<String, String> = emptyMap()): okhttp3.Response {
        val request = Request.Builder()
            .url("$baseUrl$path")
            .apply { headers.forEach { (k, v) -> addHeader(k, v) } }
            .delete()
            .build()
        return httpClient.newCall(request).execute()
    }

    // =========================================================================
    // Auth Helpers
    // =========================================================================

    protected fun extensionHeaders(token: String? = null): Map<String, String> {
        val headers = mutableMapOf(
            "Origin" to "chrome-extension://testextensionid",
            "X-JST-ExtensionId" to "testextensionid",
            "X-JST-InstallId" to "test-install-id-12345"
        )
        if (token != null) {
            headers["X-JST-Auth"] = token
        }
        return headers
    }

    /**
     * Set up a valid token for authenticated requests.
     */
    protected fun setupAuthToken(): String {
        val token = "test-token-${System.currentTimeMillis()}"
        // API: pair(token, installId, extensionId)
        tokenStore.pair(token, "test-install-id-12345", "testextensionid")
        return token
    }
}
