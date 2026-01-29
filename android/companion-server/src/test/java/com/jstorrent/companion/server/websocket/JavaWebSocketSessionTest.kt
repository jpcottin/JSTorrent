package com.jstorrent.companion.server.websocket

import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.java_websocket.WebSocket
import org.java_websocket.drafts.Draft
import org.java_websocket.framing.Framedata
import org.junit.Test
import java.net.InetSocketAddress
import java.nio.ByteBuffer
import kotlin.test.assertContentEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Tests for JavaWebSocketSession - the java-websocket adapter.
 */
class JavaWebSocketSessionTest {

    /**
     * Test that onMessage delivers data to receive()
     */
    @Test
    fun `onMessage delivers data to receive`() = runBlocking {
        val mockConn = MockWebSocket(isOpen = true)
        val session = JavaWebSocketSession(mockConn)

        val testData = byteArrayOf(1, 2, 3, 4, 5)
        session.onMessage(testData)

        val received = withTimeout(1000) { session.receive() }
        assertContentEquals(testData, received)
    }

    /**
     * Test that onClose causes receive to return null
     */
    @Test
    fun `onClose causes receive to return null`() = runBlocking {
        val mockConn = MockWebSocket(isOpen = true)
        val session = JavaWebSocketSession(mockConn)

        session.onClose()

        val received = withTimeout(1000) { session.receive() }
        assertNull(received)
    }

    /**
     * Test that multiple messages can be queued and received in order
     */
    @Test
    fun `multiple messages received in order`() = runBlocking {
        val mockConn = MockWebSocket(isOpen = true)
        val session = JavaWebSocketSession(mockConn)

        val data1 = byteArrayOf(1, 2)
        val data2 = byteArrayOf(3, 4)
        val data3 = byteArrayOf(5, 6)

        session.onMessage(data1)
        session.onMessage(data2)
        session.onMessage(data3)

        assertContentEquals(data1, withTimeout(1000) { session.receive() })
        assertContentEquals(data2, withTimeout(1000) { session.receive() })
        assertContentEquals(data3, withTimeout(1000) { session.receive() })
    }

    /**
     * Test that isOpen reflects connection state
     */
    @Test
    fun `isOpen reflects connection state`() {
        val openConn = MockWebSocket(isOpen = true)
        val closedConn = MockWebSocket(isOpen = false)

        assertTrue(JavaWebSocketSession(openConn).isOpen)
        assertFalse(JavaWebSocketSession(closedConn).isOpen)
    }

    /**
     * Test that send calls through to connection
     */
    @Test
    fun `send calls connection send`() = runBlocking {
        val mockConn = MockWebSocket(isOpen = true)
        val session = JavaWebSocketSession(mockConn)

        val testData = byteArrayOf(10, 20, 30)
        session.send(testData)

        assertContentEquals(testData, mockConn.lastSentData)
    }

    /**
     * Test that send does nothing when connection is closed
     */
    @Test
    fun `send does nothing when closed`() = runBlocking {
        val mockConn = MockWebSocket(isOpen = false)
        val session = JavaWebSocketSession(mockConn)

        session.send(byteArrayOf(1, 2, 3))

        assertNull(mockConn.lastSentData)
    }

    /**
     * Test that close calls connection close
     */
    @Test
    fun `close calls connection close`() = runBlocking {
        val mockConn = MockWebSocket(isOpen = true)
        val session = JavaWebSocketSession(mockConn)

        session.close(1000, "normal")

        assertTrue(mockConn.closeCalled)
        kotlin.test.assertEquals(1000, mockConn.closeCode)
        kotlin.test.assertEquals("normal", mockConn.closeReason)
    }
}

/**
 * Mock WebSocket for testing JavaWebSocketSession.
 */
private class MockWebSocket(
    isOpen: Boolean
) : WebSocket {

    private var _isOpen: Boolean = isOpen
    var lastSentData: ByteArray? = null
    var closeCalled = false
    var closeCode = 0
    var closeReason: String? = null

    override fun isOpen(): Boolean = _isOpen

    override fun send(bytes: ByteArray) {
        lastSentData = bytes
    }

    override fun close(code: Int, reason: String?) {
        closeCalled = true
        closeCode = code
        closeReason = reason
        _isOpen = false
    }

    // Unused methods - provide minimal implementations
    override fun close() { close(1000, "") }
    override fun close(code: Int) { close(code, "") }
    override fun closeConnection(code: Int, message: String?) {}
    override fun send(text: String?) {}
    override fun send(bytes: ByteBuffer?) {}
    override fun sendPing() {}
    override fun sendFrame(framedata: Framedata?) {}
    override fun sendFrame(frames: MutableCollection<Framedata>?) {}
    override fun sendFragmentedFrame(p0: org.java_websocket.enums.Opcode?, p1: ByteBuffer?, p2: Boolean) {}
    override fun hasBufferedData(): Boolean = false
    override fun getRemoteSocketAddress(): InetSocketAddress = InetSocketAddress(0)
    override fun getLocalSocketAddress(): InetSocketAddress = InetSocketAddress(0)
    override fun getDraft(): Draft? = null
    override fun isClosed(): Boolean = !_isOpen
    override fun isClosing(): Boolean = false
    override fun isFlushAndClose(): Boolean = false
    override fun getReadyState(): org.java_websocket.enums.ReadyState =
        if (_isOpen) org.java_websocket.enums.ReadyState.OPEN else org.java_websocket.enums.ReadyState.CLOSED
    override fun <T> getAttachment(): T? = null
    override fun <T> setAttachment(attachment: T) {}
    override fun getResourceDescriptor(): String = "/io"
    override fun getProtocol(): org.java_websocket.protocols.IProtocol? = null
    override fun hasSSLSupport(): Boolean = false
    override fun getSSLSession(): javax.net.ssl.SSLSession? = null
}
