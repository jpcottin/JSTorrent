package com.jstorrent.io.socket

/**
 * Common interface for TCP connections.
 * Implemented by both TcpConnection (InputStream-based) and TcpConnectionNio (SocketChannel-based).
 */
internal interface TcpConnectionBase {
    val socketId: Int

    /** Start the read/write loops. */
    fun activate()

    /** Queue data for transmission. */
    fun send(data: ByteArray)

    /** Close the connection. */
    fun close()

    /** Pause reads for backpressure. */
    fun pauseReads()

    /** Resume reads after backpressure. */
    fun resumeReads()
}
