import Darwin
import Foundation

private struct NetworkInterfacePayload: Encodable {
    let name: String
    let address: String
    let prefixLength: Int
}

public final class NetworkInfoBindings {
    public init() {}

    public func register(on engine: JSEngine) {
        engine.setGlobalFunction("__jstorrent_get_network_interfaces") { _ in
            let interfaces = self.getNetworkInterfaces()
            let data = try JSONEncoder().encode(interfaces)
            return .value(String(decoding: data, as: UTF8.self))
        }

        engine.setGlobalFunction("__jstorrent_get_default_gateway") { _ in
            // iOS does not expose a stable public API for default-route lookup.
            // Return JSON null so the engine can fall back cleanly.
            return .value("null")
        }
    }

    private func getNetworkInterfaces() -> [NetworkInterfacePayload] {
        var list: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&list) == 0, let first = list else {
            return []
        }
        defer {
            freeifaddrs(list)
        }

        var results: [NetworkInterfacePayload] = []
        var cursor: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = cursor?.pointee {
            defer {
                cursor = interface.ifa_next
            }

            guard
                let addressPointer = interface.ifa_addr,
                addressPointer.pointee.sa_family == UInt8(AF_INET)
            else {
                continue
            }

            let flags = Int32(interface.ifa_flags)
            if (flags & IFF_UP) == 0 || (flags & IFF_LOOPBACK) != 0 {
                continue
            }

            guard
                let address = ipv4String(from: addressPointer),
                let name = String(validatingUTF8: interface.ifa_name)
            else {
                continue
            }

            let prefixLength = prefixLength(from: interface.ifa_netmask)
            results.append(
                NetworkInterfacePayload(
                    name: name,
                    address: address,
                    prefixLength: prefixLength
                )
            )
        }

        results.sort {
            if $0.name == $1.name {
                return $0.address < $1.address
            }
            return $0.name < $1.name
        }
        return results
    }

    private func ipv4String(from address: UnsafeMutablePointer<sockaddr>) -> String? {
        var storage = address.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
            $0.pointee.sin_addr
        }
        var buffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
        guard inet_ntop(AF_INET, &storage, &buffer, socklen_t(buffer.count)) != nil else {
            return nil
        }
        return String(cString: buffer)
    }

    private func prefixLength(from netmaskPointer: UnsafeMutablePointer<sockaddr>?) -> Int {
        guard let netmaskPointer else {
            return 24
        }

        let netmask = netmaskPointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) {
            $0.pointee.sin_addr.s_addr
        }

        return Int(netmask.bigEndian.nonzeroBitCount)
    }
}
