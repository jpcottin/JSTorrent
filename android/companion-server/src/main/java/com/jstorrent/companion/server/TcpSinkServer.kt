package com.jstorrent.companion.server

import android.util.Log
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

private const val TAG = "TcpSinkServer"

/**
 * Raw TCP sink for measuring pure network throughput without protocol overhead.
 *
 * Accepts connections, reads all data as fast as possible, discards it.
 * Logs throughput stats every second and on connection close.
 *
 * Usage from Chrome:
 * ```javascript
 * const socket = new TCPSocket('100.115.92.2', 7802);  // Not available in browsers!
 * ```
 *
 * Since browsers can't do raw TCP, test from:
 * - chromeroot: `dd if=/dev/zero bs=1M count=100 | nc 100.115.92.2 7802`
 * - Or use a WebSocket-to-TCP proxy in the extension
 */
class TcpSinkServer(private val port: Int = 7802) {

    private var serverSocket: ServerSocket? = null
    private val running = AtomicBoolean(false)
    private val executor = Executors.newCachedThreadPool()

    val boundPort: Int get() = serverSocket?.localPort ?: 0
    val isRunning: Boolean get() = running.get()

    fun start() {
        if (running.get()) {
            Log.w(TAG, "Already running on port $boundPort")
            return
        }

        serverSocket = ServerSocket(port)
        running.set(true)
        Log.i(TAG, "TCP sink server started on port ${serverSocket?.localPort}")

        executor.submit {
            acceptLoop()
        }
    }

    fun stop() {
        running.set(false)
        serverSocket?.close()
        serverSocket = null
        executor.shutdownNow()
        Log.i(TAG, "TCP sink server stopped")
    }

    private fun acceptLoop() {
        while (running.get()) {
            try {
                val socket = serverSocket?.accept() ?: break
                Log.i(TAG, "Connection from ${socket.remoteSocketAddress}")
                executor.submit { handleConnection(socket) }
            } catch (e: Exception) {
                if (running.get()) {
                    Log.e(TAG, "Accept error: ${e.message}")
                }
            }
        }
    }

    private fun handleConnection(socket: Socket) {
        val startTime = System.currentTimeMillis()
        var totalBytes = 0L
        var lastLogTime = startTime
        var lastLogBytes = 0L

        try {
            socket.tcpNoDelay = true
            val buffer = ByteArray(256 * 1024) // 256KB read buffer
            val input = socket.getInputStream()

            while (true) {
                val read = input.read(buffer)
                if (read == -1) break

                totalBytes += read

                // Log every second
                val now = System.currentTimeMillis()
                if (now - lastLogTime >= 1000) {
                    val intervalBytes = totalBytes - lastLogBytes
                    val intervalSec = (now - lastLogTime) / 1000.0
                    val mbps = intervalBytes / intervalSec / (1024 * 1024)
                    Log.i(TAG, "TCP sink: ${"%.1f".format(mbps)} MB/s (${totalBytes / (1024*1024)} MB total)")
                    lastLogTime = now
                    lastLogBytes = totalBytes
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "Connection error: ${e.message}")
        } finally {
            val elapsed = System.currentTimeMillis() - startTime
            val mbps = if (elapsed > 0) totalBytes / (elapsed / 1000.0) / (1024 * 1024) else 0.0
            Log.i(TAG, "TCP sink closed: ${totalBytes / (1024*1024)} MB in ${elapsed}ms = ${"%.1f".format(mbps)} MB/s")
            socket.close()
        }
    }
}
