package com.jstorrent.io.socket

/**
 * Callback interface for TCP client socket events.
 *
 * Implementations receive notifications about socket lifecycle events
 * and incoming data. The companion-server module implements this to
 * translate events into WebSocket protocol messages.
 */
interface TcpSocketCallback {
    /**
     * Called when a TCP connect attempt completes.
     *
     * @param socketId The socket identifier
     * @param success True if connection succeeded
     * @param errorCode Error code if failed (0 on success)
     */
    fun onTcpConnected(socketId: Int, success: Boolean, errorCode: Int)

    /**
     * Called when data is received on a TCP socket.
     *
     * @param socketId The socket identifier
     * @param data The received bytes
     */
    fun onTcpData(socketId: Int, data: ByteArray)

    /**
     * Called when data is received with pre-allocated frame space.
     *
     * This is an optimization for WebSocket forwarding - the frame buffer
     * has [dataOffset] bytes of header space before the data, allowing
     * the implementer to fill in protocol headers without copying.
     *
     * Default implementation extracts data and calls [onTcpData].
     *
     * @param socketId The socket identifier
     * @param frame Buffer with header space + data
     * @param dataOffset Offset where data starts (header space before this)
     * @param dataLen Length of data
     */
    fun onTcpDataFramed(socketId: Int, frame: ByteArray, dataOffset: Int, dataLen: Int) {
        // Default: extract data and use regular callback
        val data = frame.copyOfRange(dataOffset, dataOffset + dataLen)
        onTcpData(socketId, data)
    }

    /**
     * Called when a TCP socket is closed.
     *
     * @param socketId The socket identifier
     * @param hadError True if closed due to an error
     * @param errorCode Error code if applicable (0 otherwise)
     */
    fun onTcpClose(socketId: Int, hadError: Boolean, errorCode: Int)

    /**
     * Called when a TLS upgrade completes.
     *
     * @param socketId The socket identifier
     * @param success True if TLS handshake succeeded
     */
    fun onTcpSecured(socketId: Int, success: Boolean)
}
