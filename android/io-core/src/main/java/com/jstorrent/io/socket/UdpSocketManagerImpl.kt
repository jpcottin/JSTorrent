package com.jstorrent.io.socket

import android.content.Context
import android.net.wifi.WifiManager
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import java.net.InetAddress
import java.net.MulticastSocket
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicInteger

/**
 * Implementation of [UdpSocketManager] for UDP socket operations.
 *
 * Uses [MulticastSocket] internally to support both unicast and multicast
 * operations. All sockets are configured with reuseAddress for compatibility.
 *
 * IMPORTANT: On Android, receiving multicast traffic (e.g., SSDP for UPnP)
 * requires a [WifiManager.MulticastLock]. This class acquires the lock when
 * [joinMulticast] is called and releases it when all multicast groups are left
 * or when [shutdown] is called.
 *
 * @param scope CoroutineScope for all socket operations
 * @param context Android context (optional, needed for multicast lock acquisition)
 */
class UdpSocketManagerImpl(
    private val scope: CoroutineScope,
    context: Context? = null
) : UdpSocketManager {

    companion object {
        private const val TAG = "UdpSocketManager"
    }

    private var callback: UdpSocketCallback? = null
    private val sockets = ConcurrentHashMap<Int, UdpConnection>()

    // Multicast lock management
    private val multicastLock: WifiManager.MulticastLock? = context?.let {
        val wifiManager = it.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        wifiManager?.createMulticastLock("JSTorrent-SSDP")
    }
    private val multicastRefCount = AtomicInteger(0)

    override fun bind(socketId: Int, port: Int) {
        scope.launch {
            try {
                // Use MulticastSocket instead of DatagramSocket to support multicast
                val socket = MulticastSocket(port)
                socket.reuseAddress = true

                val boundPort = socket.localPort

                val connection = UdpConnection(
                    socketId = socketId,
                    socket = socket,
                    scope = scope,
                    onMessage = { srcAddr, srcPort, data ->
                        callback?.onUdpMessage(socketId, srcAddr, srcPort, data)
                    },
                    onClose = { hadError, errorCode ->
                        sockets.remove(socketId)
                        callback?.onUdpClose(socketId, hadError, errorCode)
                    }
                )
                sockets[socketId] = connection
                connection.start()

                callback?.onUdpBound(socketId, true, boundPort, 0)

            } catch (e: Exception) {
                android.util.Log.e("UdpSocketManager", "Failed to bind socket $socketId to port $port", e)
                callback?.onUdpBound(socketId, false, 0, 1)
            }
        }
    }

    override fun send(socketId: Int, destAddr: String, destPort: Int, data: ByteArray) {
        sockets[socketId]?.send(destAddr, destPort, data)
    }

    override fun close(socketId: Int) {
        sockets.remove(socketId)?.close()
    }

    override fun joinMulticast(socketId: Int, groupAddr: String) {
        sockets[socketId]?.let { connection ->
            try {
                // Acquire multicast lock before joining (Android requires this to receive multicast)
                acquireMulticastLock()
                val group = InetAddress.getByName(groupAddr)
                connection.joinMulticast(group)
                Log.d(TAG, "Joined multicast group $groupAddr on socket $socketId")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to join multicast group $groupAddr: ${e.message}")
                releaseMulticastLock()
            }
        }
    }

    override fun leaveMulticast(socketId: Int, groupAddr: String) {
        sockets[socketId]?.let { connection ->
            try {
                val group = InetAddress.getByName(groupAddr)
                connection.leaveMulticast(group)
                Log.d(TAG, "Left multicast group $groupAddr on socket $socketId")
            } catch (e: Exception) {
                Log.e(TAG, "Failed to leave multicast group $groupAddr: ${e.message}")
            } finally {
                releaseMulticastLock()
            }
        }
    }

    /**
     * Acquire the multicast lock if not already held.
     * Uses reference counting to handle multiple concurrent multicast operations.
     */
    private fun acquireMulticastLock() {
        multicastLock?.let { lock ->
            if (multicastRefCount.incrementAndGet() == 1) {
                lock.setReferenceCounted(false)
                lock.acquire()
                Log.d(TAG, "Acquired multicast lock")
            }
        }
    }

    /**
     * Release the multicast lock when no longer needed.
     */
    private fun releaseMulticastLock() {
        multicastLock?.let { lock ->
            if (multicastRefCount.decrementAndGet() == 0) {
                if (lock.isHeld) {
                    lock.release()
                    Log.d(TAG, "Released multicast lock")
                }
            }
        }
    }

    override fun setCallback(callback: UdpSocketCallback) {
        this.callback = callback
    }

    /**
     * Shutdown the manager, closing all sockets.
     */
    fun shutdown() {
        sockets.values.forEach { it.close() }
        sockets.clear()

        // Release multicast lock if still held
        multicastLock?.let { lock ->
            if (lock.isHeld) {
                lock.release()
                Log.d(TAG, "Released multicast lock on shutdown")
            }
        }
        multicastRefCount.set(0)
    }
}
