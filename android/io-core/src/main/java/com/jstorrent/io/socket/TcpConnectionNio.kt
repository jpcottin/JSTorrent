@file:OptIn(kotlinx.coroutines.ExperimentalCoroutinesApi::class)

package com.jstorrent.io.socket

import android.util.Log
import kotlinx.coroutines.*
import kotlinx.coroutines.channels.Channel
import java.io.IOException
import java.net.Socket
import java.nio.ByteBuffer
import java.nio.channels.SocketChannel

/**
 * NIO-based TCP connection handler using SocketChannel and direct ByteBuffers.
 *
 * Benefits over InputStream-based TcpConnection:
 * - No 128KB read size cap (InputStream limitation)
 * - Direct ByteBuffer reduces GC pressure (off-heap allocation)
 * - Larger reads per syscall = fewer context switches
 * - Zero-copy framing: allocates with header space for WS protocol
 *
 * Threading model: Same as TcpConnection - blocking reads on coroutine dispatcher.
 *
 * @param socketId Unique identifier for this socket
 * @param channel The underlying connected SocketChannel (blocking mode)
 * @param scope CoroutineScope for I/O operations
 * @param onDataFramed Callback with pre-framed buffer (frame, dataOffset, dataLen)
 * @param onClose Callback when socket closes (hadError, errorCode)
 */
internal class TcpConnectionNio(
    override val socketId: Int,
    private var channel: SocketChannel,
    private val scope: CoroutineScope,
    private val onDataFramed: (ByteArray, Int, Int) -> Unit,
    private val onClose: (Boolean, Int) -> Unit
) : TcpConnectionBase {
    private val sendQueue = Channel<ByteArray>(100)
    private var senderJob: Job? = null
    private var readerJob: Job? = null
    private var isActive = false

    @Volatile
    private var readsPaused = false

    companion object {
        private const val TAG = "TcpConnectionNio"

        // NIO can read larger chunks than InputStream (no 128KB cap)
        private const val READ_BUFFER_SIZE = 1024 * 1024  // 1MB direct buffer

        private const val WRITE_BUFFER_SIZE = 64 * 1024
        private const val FLUSH_THRESHOLD = 32 * 1024
        private const val SMALL_MESSAGE_SIZE = 1024

        // Frame header size for zero-copy WS forwarding
        // 8 bytes protocol envelope + 4 bytes socketId = 12 bytes
        const val FRAME_HEADER_SIZE = 12
    }

    /**
     * Activate the connection to start I/O loops.
     */
    override fun activate() {
        if (isActive) return
        isActive = true
        startReading()
        startSending()
    }

    /**
     * Replace the underlying channel.
     * Used for TLS upgrade - must be called before [activate].
     */
    fun replaceChannel(newChannel: SocketChannel) {
        require(!isActive) { "Cannot replace channel on active connection" }
        channel = newChannel
    }

    /**
     * Queue data for transmission.
     */
    override fun send(data: ByteArray) {
        val result = sendQueue.trySend(data)
        if (result.isFailure) {
            // Queue full - connection overwhelmed
        }
    }

    /**
     * Close the connection.
     */
    override fun close() {
        isActive = false
        sendQueue.close()
        senderJob?.cancel()
        readerJob?.cancel()
        try {
            channel.close()
        } catch (_: Exception) {}
    }

    override fun pauseReads() {
        readsPaused = true
    }

    override fun resumeReads() {
        readsPaused = false
    }

    private fun startReading() {
        readerJob = scope.launch {
            // Allocate direct buffer once - off-heap, no GC pressure
            val directBuffer = ByteBuffer.allocateDirect(READ_BUFFER_SIZE)
            var totalBytesRead = 0L

            // Stats tracking
            var statsReadCount = 0L
            var statsBytes = 0L
            var statsMinRead = Int.MAX_VALUE
            var statsMaxRead = 0
            var statsCopyTimeNs = 0L
            var statsLastLogTime = System.currentTimeMillis()

            try {
                // Log buffer info once at start
                val socket = channel.socket()
                val actualRcvBuf = socket.receiveBufferSize
                Log.i(TAG, "Socket $socketId: SO_RCVBUF=$actualRcvBuf (${actualRcvBuf/1024}KB), " +
                        "READ_BUFFER=$READ_BUFFER_SIZE (direct), NIO zero-copy mode")

                while (isActive) {
                    // Backpressure: wait while reads are paused
                    while (readsPaused && isActive) {
                        delay(50)
                    }
                    if (!isActive) break

                    // Clear buffer for new read
                    directBuffer.clear()

                    // NIO read - no 128KB cap like InputStream
                    val bytesRead = try {
                        channel.read(directBuffer)
                    } catch (_: IOException) {
                        -1
                    }

                    if (bytesRead < 0) break  // EOF or error
                    if (bytesRead == 0) continue  // No data available (shouldn't happen in blocking mode)

                    totalBytesRead += bytesRead

                    // Track stats
                    statsReadCount++
                    statsBytes += bytesRead
                    if (bytesRead < statsMinRead) statsMinRead = bytesRead
                    if (bytesRead > statsMaxRead) statsMaxRead = bytesRead

                    // Log stats every 5 seconds
                    val now = System.currentTimeMillis()
                    val elapsed = now - statsLastLogTime
                    if (elapsed >= 5000 && statsReadCount > 0) {
                        val readsPerSec = statsReadCount * 1000.0 / elapsed
                        val mbPerSec = statsBytes / (elapsed / 1000.0) / (1024 * 1024)
                        val avgReadSize = statsBytes / statsReadCount
                        val avgCopyUs = statsCopyTimeNs / statsReadCount / 1000
                        val copyPct = (statsCopyTimeNs / 1_000_000.0) / elapsed * 100
                        val currentRcvBuf = channel.socket().receiveBufferSize
                        Log.i(TAG, "Socket $socketId: %.1f reads/s, %.1f MB/s, avg=%d min=%d max=%d bytes/read, copyTime=%dµs (%.1f%%), rcvBuf=%dKB".format(
                            readsPerSec, mbPerSec, avgReadSize, statsMinRead, statsMaxRead, avgCopyUs, copyPct, currentRcvBuf/1024))
                        statsReadCount = 0
                        statsBytes = 0
                        statsMinRead = Int.MAX_VALUE
                        statsMaxRead = 0
                        statsCopyTimeNs = 0
                        statsLastLogTime = now
                    }

                    // Flip buffer for reading
                    directBuffer.flip()

                    // Timing: measure allocation + copy overhead
                    val t0 = System.nanoTime()

                    // Zero-copy framing: allocate with header space
                    // Frame layout: [header:12][data:N]
                    // Header will be filled by IoWebSocketHandler
                    val frame = ByteArray(FRAME_HEADER_SIZE + bytesRead)
                    directBuffer.get(frame, FRAME_HEADER_SIZE, bytesRead)

                    val copyTimeNs = System.nanoTime() - t0

                    // Track copy overhead
                    statsCopyTimeNs += copyTimeNs

                    onDataFramed(frame, FRAME_HEADER_SIZE, bytesRead)
                }
            } catch (e: IOException) {
                Log.d(TAG, "Socket $socketId read error: ${e.message}")
            } finally {
                if (isActive) {
                    onClose(false, 0)
                }
                close()
            }
        }
    }

    private fun startSending() {
        senderJob = scope.launch {
            // Use direct buffer for writes too
            val writeBuffer = ByteBuffer.allocateDirect(WRITE_BUFFER_SIZE)

            try {
                for (data in sendQueue) {
                    // For small messages, write directly
                    if (data.size < SMALL_MESSAGE_SIZE || writeBuffer.position() == 0) {
                        if (data.size <= writeBuffer.remaining()) {
                            writeBuffer.put(data)

                            // Flush if queue empty or buffer getting full
                            if (sendQueue.isEmpty || writeBuffer.position() >= FLUSH_THRESHOLD) {
                                flushWriteBuffer(writeBuffer)
                            }
                        } else {
                            // Data too large for remaining buffer - flush first
                            flushWriteBuffer(writeBuffer)
                            // Write large data directly
                            writeFully(ByteBuffer.wrap(data))
                        }
                    } else {
                        // Accumulated data + new data
                        flushWriteBuffer(writeBuffer)
                        writeFully(ByteBuffer.wrap(data))
                    }
                }
                // Final flush
                if (writeBuffer.position() > 0) {
                    flushWriteBuffer(writeBuffer)
                }
            } catch (_: IOException) {
                // Connection closed during send
            }
        }
    }

    private fun flushWriteBuffer(buffer: ByteBuffer) {
        if (buffer.position() == 0) return
        buffer.flip()
        writeFully(buffer)
        buffer.clear()
    }

    private fun writeFully(buffer: ByteBuffer) {
        while (buffer.hasRemaining()) {
            channel.write(buffer)
        }
    }
}
