package com.jstorrent.quickjs.bindings

import com.jstorrent.quickjs.QuickJsContext
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.net.Inet4Address
import java.net.NetworkInterface

/**
 * Network bindings for QuickJS.
 *
 * Implements the following native functions:
 * - __jstorrent_get_network_interfaces() -> string (JSON array)
 * - __jstorrent_get_default_gateway() -> string (JSON object or "null")
 *
 * Returns network interface information needed for port mapping (UPnP/NAT-PMP/PCP).
 */
class NetworkBindings {

    /**
     * Register all network bindings on the given context.
     */
    fun register(ctx: QuickJsContext) {
        // __jstorrent_get_network_interfaces(): string (JSON array)
        ctx.setGlobalFunction("__jstorrent_get_network_interfaces") { _ ->
            val interfaces = JSONArray()

            try {
                val netInterfaces = NetworkInterface.getNetworkInterfaces()
                while (netInterfaces.hasMoreElements()) {
                    val iface = netInterfaces.nextElement()
                    if (iface.isLoopback || !iface.isUp) continue

                    for (addr in iface.interfaceAddresses) {
                        val inet = addr.address
                        // Only include IPv4 addresses for UPnP
                        if (inet is Inet4Address) {
                            val obj = JSONObject().apply {
                                put("name", iface.name)
                                put("address", inet.hostAddress)
                                put("prefixLength", addr.networkPrefixLength.toInt())
                            }
                            interfaces.put(obj)
                        }
                    }
                }
            } catch (e: Exception) {
                // Return empty array on error
            }

            interfaces.toString()
        }

        // __jstorrent_get_default_gateway(): string (JSON object or "null")
        ctx.setGlobalFunction("__jstorrent_get_default_gateway") { _ ->
            getDefaultGatewayJson()
        }
    }

    companion object {
        /**
         * Parse /proc/net/route to find the default gateway.
         * Returns JSON string: { "ip": "x.x.x.x", "interfaceName": "wlan0" } or "null".
         */
        fun getDefaultGatewayJson(): String {
            try {
                val lines = File("/proc/net/route").readLines()
                for (line in lines.drop(1)) { // Skip header
                    val parts = line.split(Regex("\\s+"))
                    if (parts.size >= 3 && parts[1] == "00000000") {
                        val hex = parts[2]
                        if (hex.length < 8 || hex == "00000000") continue
                        // /proc/net/route stores IPs in little-endian hex
                        val b0 = hex.substring(6, 8).toInt(16)
                        val b1 = hex.substring(4, 6).toInt(16)
                        val b2 = hex.substring(2, 4).toInt(16)
                        val b3 = hex.substring(0, 2).toInt(16)
                        val obj = JSONObject().apply {
                            put("ip", "$b0.$b1.$b2.$b3")
                            put("interfaceName", parts[0])
                        }
                        return obj.toString()
                    }
                }
            } catch (_: Exception) {
                // /proc/net/route not available
            }
            return "null"
        }
    }
}
