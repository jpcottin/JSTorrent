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
 *
 * Threading model: Same as TcpConnection - blocking reads on coroutine dispatcher.
 *
 * @param socketId Unique identifier for this socket
 * @param channel The underlying connected SocketChannel (blocking mode)
 * @param scope CoroutineScope for I/O operations
 * @param onData Callback when data is received
 * @param onClose Callback when socket closes (hadError, errorCode)
 */
internal class TcpConnectionNio(
    override val socketId: Int,
    private var channel: SocketChannel,
    private val scope: CoroutineScope,
    private val onData: (ByteArray) -> Unit,
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
            var statsLastLogTime = System.currentTimeMillis()

            try {
                // Log buffer info once at start
                val socket = channel.socket()
                Log.i(TAG, "Socket $socketId: SO_RCVBUF=${socket.receiveBufferSize}, " +
                        "READ_BUFFER=$READ_BUFFER_SIZE (direct), NIO mode")

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
                        Log.i(TAG, "Socket $socketId: %.1f reads/s, %.1f MB/s, avg=%d min=%d max=%d bytes/read".format(
                            readsPerSec, mbPerSec, avgReadSize, statsMinRead, statsMaxRead))
                        statsReadCount = 0
                        statsBytes = 0
                        statsMinRead = Int.MAX_VALUE
                        statsMaxRead = 0
                        statsLastLogTime = now
                    }

                    // Flip buffer for reading
                    directBuffer.flip()

                    // Copy to ByteArray for queue
                    // TODO: Buffer pool to eliminate this allocation
                    val data = ByteArray(bytesRead)
                    directBuffer.get(data)

                    onData(data)
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
