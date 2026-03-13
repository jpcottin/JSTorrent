package com.jstorrent.app.search

import android.annotation.SuppressLint
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancelChildren
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.json.JSONObject
import java.io.ByteArrayInputStream

private const val TAG = "SearchPluginSandbox"

class AndroidSearchPluginSandboxHost(
    context: Context,
    private val fetcher: SearchPluginFetcher = SearchPluginFetchMediator(),
    private val mainDispatcher: CoroutineDispatcher = Dispatchers.Main.immediate
) : SearchPluginExecutionRuntime {

    @Serializable
    private data class RunDraftMessage(
        val __jstSearchPluginSandbox: Boolean = true,
        val type: String = "run-draft",
        val requestId: Int,
        val source: String,
        val input: SearchPluginSearchInput
    )

    @Serializable
    private data class InspectSourceMessage(
        val __jstSearchPluginSandbox: Boolean = true,
        val type: String = "inspect-source",
        val requestId: Int,
        val source: String
    )

    @Serializable
    private data class FetchResponseMessage(
        val __jstSearchPluginSandbox: Boolean = true,
        val type: String = "fetch-response",
        val requestId: Int,
        val fetchRequestId: Int,
        val response: SearchPluginFetchResponse? = null,
        val error: SandboxMessageError? = null
    )

    @Serializable
    private data class SandboxMessageError(
        val name: String = "Error",
        val message: String,
        val stack: String? = null
    )

    @Serializable
    private data class FetchRequestMessage(
        val requestId: Int,
        val fetchRequestId: Int,
        val input: SearchPluginFetchInput
    )

    private val appContext = context.applicationContext
    private val scope = CoroutineScope(SupervisorJob() + mainDispatcher)
    private val mainHandler = Handler(Looper.getMainLooper())

    private var webView: WebView? = null
    private var readyDeferred = CompletableDeferred<Unit>()
    private var nextRequestId = 1
    private val pendingRuns = mutableMapOf<Int, CompletableDeferred<SearchPluginDraftRunResult>>()
    private val pendingInspections = mutableMapOf<Int, CompletableDeferred<SearchPluginSourceInspection>>()
    private val requestPolicies = mutableMapOf<Int, SearchPluginFetchPolicy>()
    private var disposed = false

    override suspend fun fetchSource(url: String): String {
        val response = fetcher.fetch(
            input = SearchPluginFetchInput(url = url, method = "GET")
        )
        if (response.statusCode >= 400) {
            throw IllegalStateException("Failed to fetch plugin source: HTTP ${response.statusCode}")
        }
        return response.bodyText
    }

    override suspend fun inspectSource(source: String): SearchPluginSourceInspection {
        ensureReady()
        val deferred = withContext(mainDispatcher) {
            check(!disposed) { "Sandbox host is disposed" }
            val requestId = nextRequestId++
            CompletableDeferred<SearchPluginSourceInspection>().also { pending ->
                pendingInspections[requestId] = pending
                dispatchToSandbox(
                    SearchPluginJson.encodeToString(
                        InspectSourceMessage(
                            requestId = requestId,
                            source = source
                        )
                    )
                )
            }
        }
        return deferred.await()
    }

    override suspend fun runDraft(
        source: String,
        input: SearchPluginSearchInput
    ): SearchPluginDraftRunResult {
        val inspection = inspectSource(source)
        ensureReady()
        val deferred = withContext(mainDispatcher) {
            check(!disposed) { "Sandbox host is disposed" }
            val requestId = nextRequestId++
            CompletableDeferred<SearchPluginDraftRunResult>().also { pending ->
                pendingRuns[requestId] = pending
                requestPolicies[requestId] = SearchPluginFetchPolicy(
                    allowedHosts = inspection.manifest.hosts
                )
                dispatchToSandbox(
                    SearchPluginJson.encodeToString(
                        RunDraftMessage(
                            requestId = requestId,
                            source = source,
                            input = input
                        )
                    )
                )
            }
        }
        return deferred.await()
    }

    fun dispose() {
        mainHandler.post {
            if (disposed) {
                return@post
            }
            disposed = true
            val error = IllegalStateException("Sandbox host disposed")
            if (!readyDeferred.isCompleted) {
                readyDeferred.completeExceptionally(error)
            }
            pendingRuns.values.forEach { it.completeExceptionally(error) }
            pendingInspections.values.forEach { it.completeExceptionally(error) }
            pendingRuns.clear()
            pendingInspections.clear()
            requestPolicies.clear()
            webView?.removeJavascriptInterface(BRIDGE_NAME)
            webView?.destroy()
            webView = null
            scope.coroutineContext.cancelChildren()
        }
    }

    private suspend fun ensureReady() {
        val ready = withContext(mainDispatcher) {
            check(!disposed) { "Sandbox host is disposed" }
            if (webView == null) {
                readyDeferred = CompletableDeferred()
                webView = createWebView()
                webView?.loadUrl(SANDBOX_ASSET_URL)
            }
            readyDeferred
        }
        ready.await()
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun createWebView(): WebView {
        return WebView(appContext).apply {
            settings.apply {
                javaScriptEnabled = true
                domStorageEnabled = false
                allowFileAccess = false
                allowContentAccess = false
                javaScriptCanOpenWindowsAutomatically = false
                mediaPlaybackRequiresUserGesture = true
                cacheMode = WebSettings.LOAD_NO_CACHE
                setSupportMultipleWindows(false)
            }

            addJavascriptInterface(
                SearchPluginJavascriptBridge { payload ->
                    scope.launch {
                        handleBridgeMessage(payload)
                    }
                },
                BRIDGE_NAME
            )

            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(
                    view: WebView?,
                    request: WebResourceRequest?
                ): Boolean {
                    val url = request?.url?.toString().orEmpty()
                    return !url.startsWith(SANDBOX_ASSET_PREFIX)
                }

                override fun shouldInterceptRequest(
                    view: WebView?,
                    request: WebResourceRequest?
                ): WebResourceResponse? {
                    val url = request?.url?.toString().orEmpty()
                    if (url.startsWith(SANDBOX_ASSET_PREFIX)) {
                        return null
                    }
                    return blockedResponse()
                }

                override fun onPageFinished(view: WebView, url: String?) {
                    if (url == SANDBOX_ASSET_URL) {
                        injectBridgeShim(view)
                    }
                }

                override fun onReceivedError(
                    view: WebView?,
                    request: WebResourceRequest?,
                    error: WebResourceError?
                ) {
                    if (request?.isForMainFrame == true) {
                        failSandbox(
                            IllegalStateException(
                                "Failed to load search plugin sandbox: ${error?.description ?: "unknown"}"
                            )
                        )
                    }
                }
            }
        }
    }

    private fun injectBridgeShim(view: WebView) {
        view.evaluateJavascript(BRIDGE_SHIM_SCRIPT) { result ->
            if (disposed) {
                return@evaluateJavascript
            }
            if (result == "\"ok\"") {
                if (!readyDeferred.isCompleted) {
                    readyDeferred.complete(Unit)
                }
            } else {
                failSandbox(
                    IllegalStateException("Failed to initialize search plugin bridge: $result")
                )
            }
        }
    }

    private suspend fun handleBridgeMessage(payload: String) {
        withContext(mainDispatcher) {
            if (disposed) {
                return@withContext
            }
            val root = SearchPluginJson.parseToJsonElement(payload).jsonObject
            val isChannelMessage = root["__jstSearchPluginSandbox"]?.jsonPrimitive?.booleanOrNull == true
            if (!isChannelMessage) {
                return@withContext
            }

            when (root["type"]?.jsonPrimitive?.contentOrNull) {
                "inspect-result" -> handleInspectResult(root)
                "run-result" -> handleRunResult(root)
                "fetch-request" -> handleFetchRequest(root)
                "ready" -> if (!readyDeferred.isCompleted) readyDeferred.complete(Unit)
            }
        }
    }

    private fun handleInspectResult(root: JsonObject) {
        val requestId = root["requestId"]?.jsonPrimitive?.intOrNull ?: return
        val pending = pendingInspections.remove(requestId) ?: return
        val error = root["error"]
        if (error != null) {
            val parsedError = SearchPluginJson.decodeFromJsonElement<SandboxMessageError>(error)
            pending.completeExceptionally(IllegalStateException(parsedError.message))
            return
        }

        val inspectionElement = root["inspection"]
        if (inspectionElement == null) {
            pending.completeExceptionally(IllegalStateException("Sandbox inspection returned no manifest"))
            return
        }

        val inspection = SearchPluginJson.decodeFromJsonElement<SearchPluginSourceInspection>(inspectionElement)
        pending.complete(
            SearchPluginSourceInspection(
                manifest = normalizeSearchPluginManifest(inspection.manifest)
            )
        )
    }

    private fun handleRunResult(root: JsonObject) {
        val requestId = root["requestId"]?.jsonPrimitive?.intOrNull ?: return
        val pending = pendingRuns.remove(requestId) ?: return
        requestPolicies.remove(requestId)

        val resultElement = root["result"]
        if (resultElement == null) {
            pending.completeExceptionally(IllegalStateException("Sandbox run returned no result"))
            return
        }

        val result = SearchPluginJson.decodeFromJsonElement<SearchPluginDraftRunResult>(resultElement)
        pending.complete(
            result.copy(
                manifest = result.manifest?.let { normalizeSearchPluginManifest(it) }
            )
        )
    }

    private fun handleFetchRequest(root: JsonObject) {
        val message = SearchPluginJson.decodeFromJsonElement<FetchRequestMessage>(root)
        scope.launch {
            postFetchResponse(message)
        }
    }

    private suspend fun postFetchResponse(message: FetchRequestMessage) {
        val policy = withContext(mainDispatcher) {
            requestPolicies[message.requestId]
        }

        val responseMessage = try {
            val response = fetcher.fetch(message.input, policy)
            FetchResponseMessage(
                requestId = message.requestId,
                fetchRequestId = message.fetchRequestId,
                response = response
            )
        } catch (error: Exception) {
            FetchResponseMessage(
                requestId = message.requestId,
                fetchRequestId = message.fetchRequestId,
                error = SandboxMessageError(
                    message = error.message ?: error.javaClass.simpleName,
                    stack = error.stackTraceToString()
                )
            )
        }

        withContext(mainDispatcher) {
            if (!disposed && requestPolicies.containsKey(message.requestId)) {
                dispatchToSandbox(SearchPluginJson.encodeToString(responseMessage))
            }
        }
    }

    private fun dispatchToSandbox(payloadJson: String) {
        val target = webView ?: throw IllegalStateException("Sandbox WebView is not ready")
        val quotedPayload = JSONObject.quote(payloadJson)
        target.evaluateJavascript(
            "window.__dispatchAndroidSearchPluginMessage($quotedPayload);",
            null
        )
    }

    private fun failSandbox(error: Throwable) {
        Log.e(TAG, "Search plugin sandbox failed", error)
        if (!readyDeferred.isCompleted) {
            readyDeferred.completeExceptionally(error)
        }
        pendingRuns.values.forEach { it.completeExceptionally(error) }
        pendingInspections.values.forEach { it.completeExceptionally(error) }
        pendingRuns.clear()
        pendingInspections.clear()
        requestPolicies.clear()
        webView?.destroy()
        webView = null
    }

    private fun blockedResponse(): WebResourceResponse {
        return WebResourceResponse(
            "text/plain",
            "utf-8",
            403,
            "Blocked",
            emptyMap(),
            ByteArrayInputStream(ByteArray(0))
        )
    }

    private class SearchPluginJavascriptBridge(
        private val onMessage: (String) -> Unit
    ) {
        @JavascriptInterface
        fun postMessage(payload: String?) {
            if (!payload.isNullOrBlank()) {
                onMessage(payload)
            }
        }
    }

    companion object {
        private const val BRIDGE_NAME = "AndroidSearchPluginBridge"
        private const val SANDBOX_ASSET_URL =
            "file:///android_asset/search-plugin-sandbox/search-plugin-sandbox.html"
        private const val SANDBOX_ASSET_PREFIX =
            "file:///android_asset/search-plugin-sandbox/"
        private val BRIDGE_SHIM_SCRIPT = """
            (function() {
              if (window.__dispatchAndroidSearchPluginMessage) {
                return 'ok';
              }
              var bridge = window.$BRIDGE_NAME;
              if (!bridge || typeof bridge.postMessage !== 'function') {
                return 'missing_bridge';
              }
              var dispatchEventFn = window.dispatchEvent.bind(window);
              window.postMessage = function(message) {
                bridge.postMessage(JSON.stringify(message));
              };
              window.__dispatchAndroidSearchPluginMessage = function(messageJson) {
                var payload = JSON.parse(messageJson);
                dispatchEventFn(new MessageEvent('message', { data: payload }));
              };
              return 'ok';
            })();
        """.trimIndent()
    }
}
