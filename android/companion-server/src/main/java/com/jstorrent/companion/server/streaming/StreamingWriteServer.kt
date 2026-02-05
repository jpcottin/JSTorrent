package com.jstorrent.companion.server.streaming

import android.net.Uri
import android.util.Log
import com.jstorrent.io.file.FileManager
import java.net.ServerSocket
import java.net.Socket
import java.net.SocketException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Minimal streaming HTTP server for high-throughput batch writes.
 *
 * Architecture:
 * - Single-threaded accept loop
 * - Thread-per-connection for request handling
 * - Streaming binary parser (no body aggregation)
 * - Bounded queue + worker pool for hash verification + disk writes
 * - Backpressure: queue full → socket read blocks → HTTP client slows down
 *
 * Memory bound = queueCapacity × avgPieceSize (not total batch size)
 *
 * @param port Port to listen on
 * @param fileManager For disk writes
 * @param rootResolver Resolves rootKey → SAF Uri
 * @param tokenValidator Validates auth token
 * @param workerCount Number of hash+write worker threads
 * @param queueCapacity Max pieces queued for processing
 */
class StreamingWriteServer(
    private val port: Int,
    private val fileManager: FileManager,
    private val rootResolver: (String) -> Uri?,
    private val tokenValidator: (String) -> Boolean,
    workerCount: Int = 6,
    queueCapacity: Int = 64,
) {
    companion object {
        private const val TAG = "StreamingWriteServer"
        const val DEFAULT_PORT = 8899
    }

    private val running = AtomicBoolean(false)
    private var serverSocket: ServerSocket? = null
    private var acceptThread: Thread? = null
    private val connectionExecutor: ExecutorService = Executors.newCachedThreadPool { r ->
        Thread(r, "StreamingWrite-Conn").also { it.isDaemon = true }
    }
    private val workerPool = WriteWorkerPool(fileManager, workerCount, queueCapacity)

    /**
     * Start the server.
     */
    fun start() {
        if (!running.compareAndSet(false, true)) {
            Log.w(TAG, "Server already running")
            return
        }

        try {
            serverSocket = ServerSocket().also {
                it.reuseAddress = true
                it.bind(java.net.InetSocketAddress(port))
            }
            Log.i(TAG, "Listening on port $port")

            workerPool.start()

            acceptThread = Thread({
                acceptLoop()
            }, "StreamingWrite-Accept")
            acceptThread?.start()

        } catch (e: Exception) {
            Log.e(TAG, "Failed to start server on port $port", e)
            running.set(false)
            throw e
        }
    }

    /**
     * Stop the server.
     */
    fun stop() {
        if (!running.compareAndSet(true, false)) {
            return
        }

        Log.i(TAG, "Stopping server...")

        // Close server socket (interrupts accept)
        try {
            serverSocket?.close()
        } catch (e: Exception) {
            // Ignore
        }
        serverSocket = null

        // Wait for accept thread
        try {
            acceptThread?.join(2000)
        } catch (e: InterruptedException) {
            // Ignore
        }
        acceptThread = null

        // Shutdown connection executor
        connectionExecutor.shutdownNow()

        // Stop worker pool
        workerPool.stop()

        Log.i(TAG, "Server stopped")
    }

    /**
     * Check if server is running.
     */
    fun isRunning(): Boolean = running.get()

    private fun acceptLoop() {
        Log.d(TAG, "Accept loop started")

        while (running.get()) {
            try {
                val socket = serverSocket?.accept() ?: break
                connectionExecutor.submit { handleConnection(socket) }
            } catch (e: SocketException) {
                if (running.get()) {
                    Log.e(TAG, "Accept error", e)
                }
                // Otherwise, server is stopping
            } catch (e: Exception) {
                if (running.get()) {
                    Log.e(TAG, "Accept error", e)
                }
            }
        }

        Log.d(TAG, "Accept loop stopped")
    }

    private fun handleConnection(socket: Socket) {
        val clientAddr = socket.remoteSocketAddress
        Log.d(TAG, "Connection from $clientAddr")

        try {
            socket.soTimeout = 30000  // 30s read timeout
            socket.tcpNoDelay = true

            val input = socket.getInputStream()
            val output = socket.getOutputStream()

            // Parse HTTP headers
            val headers = HttpHeaderParser.parse(input)
            if (headers == null) {
                Log.w(TAG, "Failed to parse HTTP headers from $clientAddr")
                HttpHeaderParser.sendResponse(output, 400, "Bad Request", "Invalid HTTP request")
                return
            }

            // Validate method
            if (headers.method != "POST") {
                HttpHeaderParser.sendResponse(output, 405, "Method Not Allowed", "Only POST allowed")
                return
            }

            // Validate path: /write-batch/{rootKey} or just /write-batch
            if (!headers.path.startsWith("/write-batch")) {
                HttpHeaderParser.sendResponse(output, 404, "Not Found", "Unknown endpoint")
                return
            }

            // Validate Content-Length
            if (headers.contentLength <= 0) {
                HttpHeaderParser.sendResponse(output, 400, "Bad Request", "Content-Length required")
                return
            }

            // Validate auth
            val token = headers.authToken
            if (token == null || !tokenValidator(token)) {
                HttpHeaderParser.sendResponse(output, 401, "Unauthorized", "Invalid token")
                return
            }

            // Optional: extract rootKey from URL for validation
            // val urlRootKey = headers.path.removePrefix("/write-batch/").takeIf { it.isNotBlank() }

            Log.d(TAG, "Processing batch: ${headers.contentLength} bytes from $clientAddr")

            // Stream-parse the body
            val parser = StreamingBatchParser(
                input = input,
                contentLength = headers.contentLength,
                rootResolver = rootResolver,
                onWrite = { job -> workerPool.submit(job) }
            )

            val emitted = parser.parse()

            if (emitted < 0) {
                Log.w(TAG, "Failed to parse batch from $clientAddr")
                HttpHeaderParser.sendResponse(output, 400, "Bad Request", "Invalid batch format")
                return
            }

            Log.d(TAG, "Batch complete: $emitted writes queued from $clientAddr")

            // Return 202 Accepted (results come via WebSocket)
            HttpHeaderParser.sendResponse(
                output, 202, "Accepted",
                """{"queued":$emitted}""",
                "application/json"
            )

        } catch (e: Exception) {
            Log.e(TAG, "Error handling connection from $clientAddr", e)
            try {
                HttpHeaderParser.sendResponse(
                    socket.getOutputStream(),
                    500, "Internal Server Error",
                    "Server error"
                )
            } catch (e2: Exception) {
                // Ignore
            }
        } finally {
            try {
                socket.close()
            } catch (e: Exception) {
                // Ignore
            }
        }
    }
}
