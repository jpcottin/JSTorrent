@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.jstorrent.companion.server

import android.util.Log
import com.jstorrent.companion.server.websocket.WebSocketSession
import com.jstorrent.io.protocol.Protocol
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import kotlinx.serialization.json.*
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicInteger

private const val TAG = "ControlWebSocketHandler"

/**
 * WebSocket handler for control plane operations.
 *
 * This handler manages:
 * - Authentication handshake
 * - Control plane broadcasts (ROOTS_CHANGED, EVENT)
 * - Folder picker requests (OP_CTRL_OPEN_FOLDER_PICKER)
 *
 * Unlike IoWebSocketHandler, this doesn't manage sockets - it's for
 * out-of-band communication between extension and daemon.
 */
class ControlWebSocketHandler(
    private val session: WebSocketSession,
    private val deps: CompanionServerDeps,
    private val onSessionRegistered: (ControlWebSocketHandler) -> Unit,
    private val onSessionUnregistered: (ControlWebSocketHandler) -> Unit
) {
    private var authenticated = false
    private var isExtensionAuth = false
    private val scope = CoroutineScope(Dispatchers.IO + SupervisorJob())

    // Outgoing message queue
    private val outgoing = Channel<ByteArray>(100)

    // Session statistics
    private val dropCount = AtomicLong(0)
    private val queueDepth = AtomicInteger(0)
    private val bytesReceived = AtomicLong(0)
    private val bytesSent = AtomicLong(0)
    private val framesReceived = AtomicLong(0)
    private val framesSent = AtomicLong(0)
    private val connectTime = System.currentTimeMillis()

    // ==========================================================================
    // Main run loop
    // ==========================================================================

    suspend fun run() {
        // Start sender coroutine
        val senderJob = scope.launch {
            try {
                for (data in outgoing) {
                    queueDepth.decrementAndGet()
                    session.send(data)
                }
            } catch (e: Exception) {
                Log.w(TAG, "WebSocket sender failed: ${e.message}")
                try {
                    session.close(1001, "Sender failed")
                } catch (_: Exception) {}
            }
        }

        try {
            while (true) {
                val data = session.receive() ?: break
                handleMessage(data)
            }
            Log.d(TAG, "WebSocket closed normally")
        } catch (e: Exception) {
            Log.e(TAG, "WebSocket error: ${e.message}")
        } finally {
            cleanup()
            senderJob.cancel()
        }
    }

    // ==========================================================================
    // Message handling
    // ==========================================================================

    private suspend fun handleMessage(data: ByteArray) {
        framesReceived.incrementAndGet()
        bytesReceived.addAndGet(data.size.toLong())

        if (data.size < 8) {
            Log.w(TAG, "Message too short: ${data.size} bytes")
            return
        }

        val envelope = Protocol.Envelope.fromBytes(data) ?: run {
            Log.e(TAG, "Failed to parse envelope from ${data.size} bytes")
            return
        }

        Log.d(TAG, "RECV: opcode=0x${envelope.opcode.toString(16)}, reqId=${envelope.requestId}, " +
            "payloadSize=${data.size - 8}, authenticated=$authenticated")

        if (envelope.version != Protocol.VERSION) {
            Log.e(TAG, "Invalid version: ${envelope.version} (expected ${Protocol.VERSION})")
            sendError(envelope.requestId, "Invalid protocol version")
            return
        }

        // Validate opcode is allowed for CONTROL endpoint
        if (envelope.opcode !in Protocol.CONTROL_OPCODES) {
            Log.w(TAG, "Opcode 0x${envelope.opcode.toString(16)} not allowed on CONTROL endpoint")
            sendError(envelope.requestId, "Opcode not allowed on this endpoint")
            return
        }

        val payload = data.copyOfRange(8, data.size)

        if (!authenticated) {
            handlePreAuth(envelope, payload)
        } else {
            handlePostAuth(envelope, payload)
        }
    }

    private suspend fun handlePreAuth(envelope: Protocol.Envelope, payload: ByteArray) {
        when (envelope.opcode) {
            Protocol.OP_CLIENT_HELLO -> {
                send(Protocol.createMessage(Protocol.OP_SERVER_HELLO, envelope.requestId))
            }
            Protocol.OP_AUTH -> {
                if (payload.isEmpty()) {
                    sendError(envelope.requestId, "Invalid auth payload")
                    return
                }

                // Parse AUTH payload: authType(1) + token + \0 + extensionId + \0 + installId
                val authType = payload[0]
                val payloadStr = String(payload, 1, payload.size - 1)
                val parts = payloadStr.split('\u0000')

                if (parts.size < 3) {
                    sendError(envelope.requestId, "Invalid auth payload format")
                    return
                }

                val token = parts[0]
                val extensionId = parts[1]
                val installId = parts[2]

                // For extension auth, also verify pairing
                isExtensionAuth = deps.tokenStore.token != null &&
                    token == deps.tokenStore.token &&
                    deps.tokenStore.isPairedWith(extensionId, installId)
                // For standalone mode, just the standalone token is enough
                val isStandaloneAuth = token == deps.tokenStore.standaloneToken

                if (isExtensionAuth || isStandaloneAuth) {
                    authenticated = true
                    send(Protocol.createMessage(Protocol.OP_AUTH_RESULT, envelope.requestId, byteArrayOf(0)))
                    val authTypeStr = if (isStandaloneAuth) "standalone" else "extension"
                    Log.i(TAG, "WebSocket authenticated ($authTypeStr, CONTROL)")

                    // Register for broadcasts
                    onSessionRegistered(this)

                    // Extension-only: notify for intent handling (pending magnet links)
                    if (isExtensionAuth) {
                        deps.notifyConnectionEstablished()
                    }
                } else {
                    val errorMsg = "Invalid credentials".toByteArray()
                    send(Protocol.createMessage(Protocol.OP_AUTH_RESULT, envelope.requestId, byteArrayOf(1) + errorMsg))
                    Log.w(TAG, "WebSocket auth failed: extensionAuth=$isExtensionAuth, standaloneAuth=$isStandaloneAuth")
                }
            }
            else -> {
                sendError(envelope.requestId, "Not authenticated")
            }
        }
    }

    private fun handlePostAuth(envelope: Protocol.Envelope, payload: ByteArray) {
        when (envelope.opcode) {
            Protocol.OP_CTRL_OPEN_FOLDER_PICKER -> {
                deps.openFolderPicker()
            }
            Protocol.OP_KV_GET -> handleKvGet(envelope, payload)
            Protocol.OP_KV_GET_MULTI -> handleKvGetMulti(envelope, payload)
            Protocol.OP_KV_SET -> handleKvSet(envelope, payload)
            Protocol.OP_KV_DELETE -> handleKvDelete(envelope, payload)
            Protocol.OP_KV_KEYS -> handleKvKeys(envelope, payload)
            Protocol.OP_KV_CLEAR -> handleKvClear(envelope, payload)
            else -> {
                sendError(envelope.requestId, "Unknown opcode: ${envelope.opcode}")
            }
        }
    }

    // ==========================================================================
    // KV Storage handlers
    // ==========================================================================

    private val json = Json { ignoreUnknownKeys = true }

    /**
     * All values are stored as JSON in SQLite.
     * - Strings: "hello" (JSON string with quotes)
     * - Objects: {"key":"value"}
     * - Arrays: [1,2,3]
     * - Numbers: 42
     * - Booleans: true/false
     *
     * When reading, we JSON-parse the stored value to get back the typed JsonElement.
     */

    private fun handleKvGet(envelope: Protocol.Envelope, payload: ByteArray) {
        val opcode = Protocol.OP_KV_GET
        try {
            val request = json.parseToJsonElement(String(payload)).jsonObject
            val key = request["key"]?.jsonPrimitive?.content
                ?: return sendKvError(envelope.requestId, opcode, "Missing key")

            val value = deps.kvStore.get(key)
            val response = buildJsonObject {
                put("ok", true)
                if (value != null) {
                    put("value", json.parseToJsonElement(value))
                } else {
                    put("value", JsonNull)
                }
            }
            sendKvResponse(envelope.requestId, opcode, response)
        } catch (e: Exception) {
            Log.e(TAG, "KV_GET error: ${e.message}")
            sendKvError(envelope.requestId, opcode, e.message ?: "Unknown error")
        }
    }

    private fun handleKvGetMulti(envelope: Protocol.Envelope, payload: ByteArray) {
        val opcode = Protocol.OP_KV_GET_MULTI
        try {
            val request = json.parseToJsonElement(String(payload)).jsonObject
            val keys = request["keys"]?.jsonArray?.map { it.jsonPrimitive.content }
                ?: return sendKvError(envelope.requestId, opcode, "Missing keys")

            val values = deps.kvStore.getMulti(keys)
            val response = buildJsonObject {
                put("ok", true)
                put("values", buildJsonObject {
                    for (key in keys) {
                        val value = values[key]
                        if (value != null) {
                            put(key, json.parseToJsonElement(value))
                        } else {
                            put(key, JsonNull)
                        }
                    }
                })
            }
            sendKvResponse(envelope.requestId, opcode, response)
        } catch (e: Exception) {
            Log.e(TAG, "KV_GET_MULTI error: ${e.message}")
            sendKvError(envelope.requestId, opcode, e.message ?: "Unknown error")
        }
    }

    private fun handleKvSet(envelope: Protocol.Envelope, payload: ByteArray) {
        val opcode = Protocol.OP_KV_SET
        try {
            val request = json.parseToJsonElement(String(payload)).jsonObject
            val key = request["key"]?.jsonPrimitive?.content
                ?: return sendKvError(envelope.requestId, opcode, "Missing key")
            val value = request["value"]
                ?: return sendKvError(envelope.requestId, opcode, "Missing value")

            // Store as JSON - value.toString() gives the JSON representation
            deps.kvStore.set(key, value.toString())

            val response = buildJsonObject { put("ok", true) }
            sendKvResponse(envelope.requestId, opcode, response)
        } catch (e: Exception) {
            Log.e(TAG, "KV_SET error: ${e.message}")
            sendKvError(envelope.requestId, opcode, e.message ?: "Unknown error")
        }
    }

    private fun handleKvDelete(envelope: Protocol.Envelope, payload: ByteArray) {
        val opcode = Protocol.OP_KV_DELETE
        try {
            val request = json.parseToJsonElement(String(payload)).jsonObject
            val key = request["key"]?.jsonPrimitive?.content
                ?: return sendKvError(envelope.requestId, opcode, "Missing key")

            deps.kvStore.delete(key)

            val response = buildJsonObject { put("ok", true) }
            sendKvResponse(envelope.requestId, opcode, response)
        } catch (e: Exception) {
            Log.e(TAG, "KV_DELETE error: ${e.message}")
            sendKvError(envelope.requestId, opcode, e.message ?: "Unknown error")
        }
    }

    private fun handleKvKeys(envelope: Protocol.Envelope, payload: ByteArray) {
        val opcode = Protocol.OP_KV_KEYS
        try {
            val request = json.parseToJsonElement(String(payload)).jsonObject
            val prefix = request["prefix"]?.jsonPrimitive?.content ?: ""

            val keys = deps.kvStore.keys(prefix)

            val response = buildJsonObject {
                put("ok", true)
                put("keys", JsonArray(keys.map { JsonPrimitive(it) }))
            }
            sendKvResponse(envelope.requestId, opcode, response)
        } catch (e: Exception) {
            Log.e(TAG, "KV_KEYS error: ${e.message}")
            sendKvError(envelope.requestId, opcode, e.message ?: "Unknown error")
        }
    }

    private fun handleKvClear(envelope: Protocol.Envelope, payload: ByteArray) {
        val opcode = Protocol.OP_KV_CLEAR
        try {
            val request = json.parseToJsonElement(String(payload)).jsonObject
            val prefix = request["prefix"]?.jsonPrimitive?.content ?: ""

            val count = deps.kvStore.clear(prefix)

            val response = buildJsonObject {
                put("ok", true)
                put("count", count)
            }
            sendKvResponse(envelope.requestId, opcode, response)
        } catch (e: Exception) {
            Log.e(TAG, "KV_CLEAR error: ${e.message}")
            sendKvError(envelope.requestId, opcode, e.message ?: "Unknown error")
        }
    }

    private fun sendKvResponse(requestId: Int, opcode: Byte, response: JsonObject) {
        val payload = response.toString().toByteArray()
        send(Protocol.createMessage(opcode, requestId, payload))
    }

    private fun sendKvError(requestId: Int, opcode: Byte, message: String) {
        val response = buildJsonObject {
            put("ok", false)
            put("error", message)
        }
        sendKvResponse(requestId, opcode, response)
    }

    // ==========================================================================
    // Send helpers
    // ==========================================================================

    internal fun send(data: ByteArray) {
        framesSent.incrementAndGet()
        bytesSent.addAndGet(data.size.toLong())

        val result = outgoing.trySend(data)
        if (result.isSuccess) {
            queueDepth.incrementAndGet()
        } else {
            if (dropCount.incrementAndGet() % 100 == 1L) {
                Log.w(TAG, "Outgoing buffer full, dropped ${dropCount.get()} messages total")
            }
        }
    }

    /**
     * Send a control frame. Only works if authenticated.
     */
    fun sendControl(frame: ByteArray) {
        if (authenticated) {
            send(frame)
        }
    }

    private fun sendError(requestId: Int, message: String) {
        send(Protocol.createError(requestId, message))
    }

    /**
     * Close the WebSocket session with a close code and reason.
     * Used for external close (e.g., unpair).
     */
    suspend fun closeSession(code: Int = 1001, reason: String = "Closed") {
        session.close(code, reason)
    }

    // ==========================================================================
    // Cleanup
    // ==========================================================================

    private fun cleanup() {
        val duration = (System.currentTimeMillis() - connectTime) / 1000.0
        Log.i(TAG, "Session closed after ${String.format("%.1f", duration)}s: " +
            "recv=${framesReceived.get()} frames, sent=${framesSent.get()} frames")

        onSessionUnregistered(this)
        scope.cancel()
        outgoing.close()
    }
}
