import Foundation
import JavaScriptCore
import Network
import Security
import Darwin

private struct PendingTCPFrame {
    let socketID: Int
    let data: Data
}

private struct PendingUDPFrame {
    let socketID: Int
    let sourceAddress: String
    let sourcePort: Int
    let data: Data
}

private final class SocketCallbackStore: @unchecked Sendable {
    var tcpOnData: JSValue?
    var tcpOnClose: JSValue?
    var tcpOnError: JSValue?
    var tcpOnConnected: JSValue?
    var tcpOnSecured: JSValue?
    var tcpOnListening: JSValue?
    var tcpOnAccept: JSValue?
    var udpOnBound: JSValue?
    var udpOnMessage: JSValue?
}

private final class ManagedTCPConnection {
    let socketID: Int
    var connection: NWConnection
    var remoteAddress: String?
    var remotePort: Int?
    var receivedAnyData = false
    var sentAnyData = false
    var receiveArmed = false
    var connectCallbackDelivered = false
    var secureUpgradeInFlight = false
    var secureCallbackDelivered = false
    var suppressNextCancelClose = false
    var closeDelivered = false
    var userInitiatedClose = false

    init(
        socketID: Int,
        connection: NWConnection,
        remoteAddress: String? = nil,
        remotePort: Int? = nil,
        connectCallbackDelivered: Bool = false
    ) {
        self.socketID = socketID
        self.connection = connection
        self.remoteAddress = remoteAddress
        self.remotePort = remotePort
        self.connectCallbackDelivered = connectCallbackDelivered
    }
}

private final class ManagedTCPServer {
    let serverID: Int
    let listener: NWListener

    init(serverID: Int, listener: NWListener) {
        self.serverID = serverID
        self.listener = listener
    }
}

private final class ManagedUDPSocket {
    let socketID: Int
    let fileDescriptor: Int32
    let readSource: DispatchSourceRead

    init(socketID: Int, fileDescriptor: Int32, readSource: DispatchSourceRead) {
        self.socketID = socketID
        self.fileDescriptor = fileDescriptor
        self.readSource = readSource
    }
}

private struct TCPSendBatchReader {
    let data: Data
    var offset = 0

    mutating func readUInt32LE() -> UInt32? {
        guard offset + 4 <= data.count else {
            return nil
        }

        let b0 = UInt32(data[offset])
        let b1 = UInt32(data[offset + 1]) << 8
        let b2 = UInt32(data[offset + 2]) << 16
        let b3 = UInt32(data[offset + 3]) << 24
        offset += 4
        return b0 | b1 | b2 | b3
    }

    mutating func readData(count: Int) -> Data? {
        guard count >= 0, offset + count <= data.count else {
            return nil
        }

        let result = data.subdata(in: offset..<(offset + count))
        offset += count
        return result
    }
}

public final class SocketBindings: @unchecked Sendable {
    private let engine: JSEngine
    private let callbacks = SocketCallbackStore()
    private let stateQueue = DispatchQueue(label: "com.jstorrent.ios.socket")
    private var tcpConnections: [Int: ManagedTCPConnection] = [:]
    private var tcpServers: [Int: ManagedTCPServer] = [:]
    private var udpSockets: [Int: ManagedUDPSocket] = [:]
    private var pendingTCPFrames: [PendingTCPFrame] = []
    private var pendingUDPFrames: [PendingUDPFrame] = []
    private var tcpBackpressureActive = false
    private var nextAcceptedSocketID: UInt32 = 0xF0000000

    public init(engine: JSEngine) {
        self.engine = engine
    }

    public func register() {
        registerTCPBindings()
        registerUDPBindings()
    }

    private func registerTCPBindings() {
        engine.setGlobalFunction("__jstorrent_tcp_on_data") { arguments in
            self.callbacks.tcpOnData = arguments.first
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_on_close") { arguments in
            self.callbacks.tcpOnClose = arguments.first
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_on_error") { arguments in
            self.callbacks.tcpOnError = arguments.first
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_on_connected") { arguments in
            self.callbacks.tcpOnConnected = arguments.first
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_on_secured") { arguments in
            self.callbacks.tcpOnSecured = arguments.first
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_on_listening") { arguments in
            self.callbacks.tcpOnListening = arguments.first
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_on_accept") { arguments in
            self.callbacks.tcpOnAccept = arguments.first
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_connect") { arguments in
            let socketID = Int(arguments.first?.toInt32() ?? 0)
            let host = arguments.dropFirst().first?.toString() ?? ""
            let port = Int(arguments.dropFirst(2).first?.toInt32() ?? 0)
            self.connectTCP(socketID: socketID, host: host, port: port)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_send") { [weak engine] arguments in
            guard
                let engine,
                let data = try engine.data(from: arguments.dropFirst().first)
            else {
                return .undefined
            }

            let socketID = Int(arguments.first?.toInt32() ?? 0)
            self.sendTCP(socketID: socketID, data: data)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_send_batch") { [weak engine] arguments in
            guard
                let engine,
                let packed = try engine.data(from: arguments.first)
            else {
                return .undefined
            }

            self.sendTCPBatch(packed)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_close") { arguments in
            let socketID = Int(arguments.first?.toInt32() ?? 0)
            self.closeTCP(socketID: socketID)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_secure") { arguments in
            let socketID = Int(arguments.first?.toInt32() ?? 0)
            let hostname = arguments.dropFirst().first?.toString() ?? ""
            self.secureTCP(socketID: socketID, hostname: hostname)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_set_backpressure") { arguments in
            let active = arguments.first?.toBool() ?? false
            self.setTCPBackpressure(active)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_flush") { _ in
            self.flushTCP()
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_listen") { arguments in
            let serverID = Int(arguments.first?.toInt32() ?? 0)
            let port = Int(arguments.dropFirst().first?.toInt32() ?? 0)
            self.listenTCP(serverID: serverID, port: port)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_server_close") { arguments in
            let serverID = Int(arguments.first?.toInt32() ?? 0)
            self.closeTCPServer(serverID: serverID)
            return .undefined
        }
    }

    private func registerUDPBindings() {
        engine.setGlobalFunction("__jstorrent_udp_on_bound") { arguments in
            self.callbacks.udpOnBound = arguments.first
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_on_message") { arguments in
            self.callbacks.udpOnMessage = arguments.first
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_bind") { arguments in
            let socketID = Int(arguments.first?.toInt32() ?? 0)
            let address = arguments.dropFirst().first?.toString() ?? ""
            let port = Int(arguments.dropFirst(2).first?.toInt32() ?? 0)
            self.bindUDP(socketID: socketID, address: address, port: port)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_send") { [weak engine] arguments in
            guard
                let engine,
                let data = try engine.data(from: arguments.dropFirst(3).first)
            else {
                return .undefined
            }

            let socketID = Int(arguments.first?.toInt32() ?? 0)
            let address = arguments.dropFirst().first?.toString() ?? ""
            let port = Int(arguments.dropFirst(2).first?.toInt32() ?? 0)
            self.sendUDP(socketID: socketID, address: address, port: port, data: data)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_close") { arguments in
            let socketID = Int(arguments.first?.toInt32() ?? 0)
            self.closeUDP(socketID: socketID)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_join_multicast") { arguments in
            let socketID = Int(arguments.first?.toInt32() ?? 0)
            let group = arguments.dropFirst().first?.toString() ?? ""
            self.joinUDPMulticast(socketID: socketID, group: group)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_leave_multicast") { arguments in
            let socketID = Int(arguments.first?.toInt32() ?? 0)
            let group = arguments.dropFirst().first?.toString() ?? ""
            self.leaveUDPMulticast(socketID: socketID, group: group)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_flush") { _ in
            self.flushUDP()
            return .undefined
        }
    }

    private func bindUDP(socketID: Int, address: String, port: Int) {
        guard socketID > 0, let bindAddress = ipv4Address(address, allowEmpty: true) else {
            dispatchValueCallback(callbacks.udpOnBound, arguments: [socketID, false, port])
            return
        }

        stateQueue.async {
            if let existing = self.udpSockets.removeValue(forKey: socketID) {
                existing.readSource.cancel()
            }

            let fileDescriptor = Darwin.socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP)
            guard fileDescriptor >= 0 else {
                self.dispatchValueCallback(self.callbacks.udpOnBound, arguments: [socketID, false, port])
                return
            }

            var reuse: Int32 = 1
            _ = setsockopt(
                fileDescriptor,
                SOL_SOCKET,
                SO_REUSEADDR,
                &reuse,
                socklen_t(MemoryLayout.size(ofValue: reuse))
            )

            _ = fcntl(fileDescriptor, F_SETFL, O_NONBLOCK)

            var socketAddress = sockaddr_in()
            socketAddress.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            socketAddress.sin_family = sa_family_t(AF_INET)
            socketAddress.sin_port = in_port_t(UInt16(port).bigEndian)
            socketAddress.sin_addr = bindAddress

            let bindResult = withUnsafePointer(to: &socketAddress) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                    Darwin.bind(
                        fileDescriptor,
                        pointer,
                        socklen_t(MemoryLayout<sockaddr_in>.size)
                    )
                }
            }

            guard bindResult == 0 else {
                Darwin.close(fileDescriptor)
                self.dispatchValueCallback(self.callbacks.udpOnBound, arguments: [socketID, false, port])
                return
            }

            let readSource = DispatchSource.makeReadSource(fileDescriptor: fileDescriptor, queue: self.stateQueue)
            let managed = ManagedUDPSocket(socketID: socketID, fileDescriptor: fileDescriptor, readSource: readSource)
            readSource.setEventHandler { [weak self] in
                self?.receiveUDP(socketID: socketID)
            }
            readSource.setCancelHandler {
                Darwin.close(fileDescriptor)
            }
            self.udpSockets[socketID] = managed
            readSource.resume()

            var localAddress = sockaddr_in()
            var localLength = socklen_t(MemoryLayout<sockaddr_in>.size)
            let actualPort: Int
            let nameResult = withUnsafeMutablePointer(to: &localAddress) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                    getsockname(fileDescriptor, pointer, &localLength)
                }
            }
            if nameResult == 0 {
                actualPort = Int(UInt16(bigEndian: localAddress.sin_port))
            } else {
                actualPort = port
            }

            self.dispatchValueCallback(self.callbacks.udpOnBound, arguments: [socketID, true, actualPort])
        }
    }

    private func sendUDP(socketID: Int, address: String, port: Int, data: Data) {
        guard socketID > 0, !address.isEmpty, (0...Int(UInt16.max)).contains(port) else {
            return
        }

        stateQueue.async {
            guard let managed = self.udpSockets[socketID] else {
                return
            }

            guard var destination = self.resolveUDPDestination(address: address, port: port) else {
                return
            }

            data.withUnsafeBytes { buffer in
                _ = withUnsafePointer(to: &destination) {
                    $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                        sendto(
                            managed.fileDescriptor,
                            buffer.baseAddress,
                            buffer.count,
                            0,
                            pointer,
                            socklen_t(MemoryLayout<sockaddr_in>.size)
                        )
                    }
                }
            }
        }
    }

    private func closeUDP(socketID: Int) {
        stateQueue.async {
            guard let managed = self.udpSockets.removeValue(forKey: socketID) else {
                return
            }

            managed.readSource.cancel()
        }
    }

    private func joinUDPMulticast(socketID: Int, group: String) {
        updateUDPMembership(socketID: socketID, group: group, option: IP_ADD_MEMBERSHIP)
    }

    private func leaveUDPMulticast(socketID: Int, group: String) {
        updateUDPMembership(socketID: socketID, group: group, option: IP_DROP_MEMBERSHIP)
    }

    private func updateUDPMembership(socketID: Int, group: String, option: Int32) {
        guard let multicastAddress = ipv4Address(group, allowEmpty: false) else {
            return
        }

        stateQueue.async {
            guard let managed = self.udpSockets[socketID] else {
                return
            }

            var membership = ip_mreq(
                imr_multiaddr: multicastAddress,
                imr_interface: in_addr(s_addr: INADDR_ANY)
            )

            _ = withUnsafePointer(to: &membership) { pointer in
                setsockopt(
                    managed.fileDescriptor,
                    IPPROTO_IP,
                    option,
                    pointer,
                    socklen_t(MemoryLayout<ip_mreq>.size)
                )
            }
        }
    }

    private func receiveUDP(socketID: Int) {
        guard let managed = udpSockets[socketID] else {
            return
        }

        while true {
            var buffer = [UInt8](repeating: 0, count: 65_535)
            var sourceAddress = sockaddr_storage()
            var sourceLength = socklen_t(MemoryLayout<sockaddr_storage>.size)

            let bytesRead = withUnsafeMutablePointer(to: &sourceAddress) { storagePointer in
                storagePointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { addressPointer in
                    recvfrom(
                        managed.fileDescriptor,
                        &buffer,
                        buffer.count,
                        0,
                        addressPointer,
                        &sourceLength
                    )
                }
            }

            if bytesRead >= 0 {
                let data = Data(buffer.prefix(Int(bytesRead)))
                let source = udpSource(from: sourceAddress, length: sourceLength)
                pendingUDPFrames.append(
                    PendingUDPFrame(
                        socketID: socketID,
                        sourceAddress: source.address,
                        sourcePort: source.port,
                        data: data
                    )
                )
                continue
            }

            if errno == EWOULDBLOCK || errno == EAGAIN {
                break
            }

            break
        }
    }

    private func flushUDP() {
        let frames = stateQueue.sync {
            let drained = pendingUDPFrames
            pendingUDPFrames.removeAll(keepingCapacity: true)
            return drained
        }

        guard !frames.isEmpty else {
            return
        }

        if hasGlobalFunction("__jstorrent_udp_dispatch_batch") {
            let packed = packUDPBatch(frames)
            _ = try? engine.callGlobalFunction("__jstorrent_udp_dispatch_batch", arguments: [.binary(packed)])
            return
        }

        for frame in frames {
            guard let callback = callbacks.udpOnMessage else {
                continue
            }

            _ = try? engine.callFunction(
                callback,
                arguments: [
                    .value(frame.socketID),
                    .value(frame.sourceAddress),
                    .value(frame.sourcePort),
                    .binary(frame.data),
                ]
            )
        }
    }

    private func connectTCP(socketID: Int, host: String, port: Int) {
        guard socketID > 0, !host.isEmpty, let endpointPort = nwPort(port) else {
            dispatchValueCallback(
                callbacks.tcpOnConnected,
                arguments: [socketID, false, "Invalid TCP connect arguments."]
            )
            return
        }

        let connection = NWConnection(
            host: NWEndpoint.Host(host),
            port: endpointPort,
            using: makeTCPParameters()
        )

        let managed = ManagedTCPConnection(
            socketID: socketID,
            connection: connection,
            remoteAddress: host,
            remotePort: port
        )

        stateQueue.async {
            self.tcpConnections[socketID] = managed
            self.configure(connection: managed, mode: .clientConnect)
            connection.start(queue: self.stateQueue)
        }
    }

    private func sendTCP(socketID: Int, data: Data) {
        stateQueue.async {
            guard let managed = self.tcpConnections[socketID] else {
                return
            }

            managed.sentAnyData = true
            managed.connection.send(content: data, completion: .contentProcessed { error in
                if let error {
                    self.reportTCPError(socketID: socketID, message: error.localizedDescription)
                }
            })
        }
    }

    private func sendTCPBatch(_ packed: Data) {
        var reader = TCPSendBatchReader(data: packed)
        guard let count = reader.readUInt32LE() else {
            return
        }

        for _ in 0..<count {
            guard
                let socketID = reader.readUInt32LE(),
                let length = reader.readUInt32LE(),
                let data = reader.readData(count: Int(length))
            else {
                return
            }

            sendTCP(socketID: Int(socketID), data: data)
        }
    }

    private func closeTCP(socketID: Int) {
        stateQueue.async {
            guard let managed = self.tcpConnections[socketID] else {
                return
            }

            managed.userInitiatedClose = true
            managed.connection.cancel()
        }
    }

    private func secureTCP(socketID: Int, hostname: String) {
        stateQueue.async {
            guard let managed = self.tcpConnections[socketID] else {
                self.dispatchValueCallback(self.callbacks.tcpOnSecured, arguments: [socketID, false])
                return
            }

            guard
                !managed.secureUpgradeInFlight,
                !managed.sentAnyData,
                !managed.receivedAnyData,
                let host = managed.remoteAddress,
                let port = managed.remotePort,
                let endpointPort = self.nwPort(port)
            else {
                self.dispatchValueCallback(self.callbacks.tcpOnSecured, arguments: [socketID, false])
                return
            }

            managed.secureUpgradeInFlight = true
            managed.secureCallbackDelivered = false
            managed.suppressNextCancelClose = true
            managed.receiveArmed = false

            let tlsHost = hostname.isEmpty ? host : hostname
            let upgradedConnection = NWConnection(
                host: NWEndpoint.Host(host),
                port: endpointPort,
                using: self.makeTCPParameters(tlsHostname: tlsHost)
            )

            managed.connection.cancel()
            managed.connection = upgradedConnection
            self.configure(connection: managed, mode: .secureUpgrade)
            upgradedConnection.start(queue: self.stateQueue)
        }
    }

    private func setTCPBackpressure(_ active: Bool) {
        stateQueue.async {
            self.tcpBackpressureActive = active
            guard !active else {
                return
            }

            for managed in self.tcpConnections.values {
                self.armReceiveIfNeeded(for: managed)
            }
        }
    }

    private func flushTCP() {
        let frames = stateQueue.sync {
            let drained = pendingTCPFrames
            pendingTCPFrames.removeAll(keepingCapacity: true)
            return drained
        }

        guard !frames.isEmpty else {
            return
        }

        if hasGlobalFunction("__jstorrent_tcp_dispatch_batch") {
            let packed = packTCPBatch(frames)
            _ = try? engine.callGlobalFunction("__jstorrent_tcp_dispatch_batch", arguments: [.binary(packed)])
            return
        }

        for frame in frames {
            guard let callback = callbacks.tcpOnData else {
                continue
            }
            _ = try? engine.callFunction(
                callback,
                arguments: [.value(frame.socketID), .binary(frame.data)]
            )
        }
    }

    private func listenTCP(serverID: Int, port: Int) {
        let parameters = makeTCPParameters()

        do {
            let listener: NWListener
            if port == 0 {
                listener = try NWListener(using: parameters)
            } else if let endpointPort = nwPort(port) {
                listener = try NWListener(using: parameters, on: endpointPort)
            } else {
                dispatchValueCallback(self.callbacks.tcpOnListening, arguments: [serverID, false, port])
                return
            }
            let managed = ManagedTCPServer(serverID: serverID, listener: listener)

            listener.stateUpdateHandler = { [weak self] (newState: NWListener.State) in
                guard let self else {
                    return
                }

                switch newState {
                case .ready:
                    let boundPort = Int(listener.port?.rawValue ?? 0)
                    self.dispatchValueCallback(self.callbacks.tcpOnListening, arguments: [serverID, true, boundPort])
                case .failed(let error):
                    self.dispatchValueCallback(
                        self.callbacks.tcpOnListening,
                        arguments: [serverID, false, port]
                    )
                    self.reportTCPError(socketID: serverID, message: error.localizedDescription)
                    self.stateQueue.async {
                        self.tcpServers.removeValue(forKey: serverID)
                    }
                default:
                    break
                }
            }

            listener.newConnectionHandler = { [weak self] connection in
                self?.acceptTCPConnection(serverID: serverID, connection: connection)
            }

            stateQueue.async {
                self.tcpServers[serverID] = managed
                listener.start(queue: self.stateQueue)
            }
        } catch {
            dispatchValueCallback(self.callbacks.tcpOnListening, arguments: [serverID, false, port])
        }
    }

    private func closeTCPServer(serverID: Int) {
        stateQueue.async {
            guard let managed = self.tcpServers.removeValue(forKey: serverID) else {
                return
            }

            managed.listener.cancel()
        }
    }

    private func acceptTCPConnection(serverID: Int, connection: NWConnection) {
        stateQueue.async {
            let socketID = Int(self.nextAcceptedSocketID)
            self.nextAcceptedSocketID = self.nextAcceptedSocketID &- 1

            let remote = self.remoteAddressAndPort(for: connection.endpoint)
            let managed = ManagedTCPConnection(
                socketID: socketID,
                connection: connection,
                remoteAddress: remote.address,
                remotePort: remote.port,
                connectCallbackDelivered: true
            )
            self.tcpConnections[socketID] = managed
            self.configure(connection: managed, mode: .accepted)
            connection.start(queue: self.stateQueue)

            self.dispatchValueCallback(
                self.callbacks.tcpOnAccept,
                arguments: [serverID, socketID, remote.address, remote.port]
            )
        }
    }

    private enum ConnectionMode {
        case clientConnect
        case accepted
        case secureUpgrade
    }

    private func configure(connection managed: ManagedTCPConnection, mode: ConnectionMode) {
        managed.connection.stateUpdateHandler = { [weak self, weak managed] newState in
            guard let self, let managed else {
                return
            }

            switch newState {
            case .ready:
                switch mode {
                case .clientConnect:
                    if !managed.connectCallbackDelivered {
                        managed.connectCallbackDelivered = true
                        self.dispatchValueCallback(
                            self.callbacks.tcpOnConnected,
                            arguments: [managed.socketID, true, ""]
                        )
                    }
                case .secureUpgrade:
                    managed.secureUpgradeInFlight = false
                    if !managed.secureCallbackDelivered {
                        managed.secureCallbackDelivered = true
                        self.dispatchValueCallback(self.callbacks.tcpOnSecured, arguments: [managed.socketID, true])
                    }
                case .accepted:
                    break
                }

                self.armReceiveIfNeeded(for: managed)
            case .failed(let error):
                self.handleConnectionFailure(managed, mode: mode, error: error)
            case .cancelled:
                self.handleConnectionCancelled(managed)
            default:
                break
            }
        }
    }

    private func armReceiveIfNeeded(for managed: ManagedTCPConnection) {
        guard !managed.receiveArmed, !tcpBackpressureActive else {
            return
        }

        managed.receiveArmed = true
        managed.connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self, weak managed] data, _, isComplete, error in
            guard let self, let managed else {
                return
            }

            self.stateQueue.async {
                managed.receiveArmed = false

                if let data, !data.isEmpty {
                    managed.receivedAnyData = true
                    self.pendingTCPFrames.append(PendingTCPFrame(socketID: managed.socketID, data: data))
                }

                if let error {
                    self.reportTCPError(socketID: managed.socketID, message: error.localizedDescription)
                    self.finishConnection(managed, hadError: true)
                    return
                }

                if isComplete {
                    self.finishConnection(managed, hadError: false)
                    return
                }

                self.armReceiveIfNeeded(for: managed)
            }
        }
    }

    private func handleConnectionFailure(
        _ managed: ManagedTCPConnection,
        mode: ConnectionMode,
        error: NWError
    ) {
        if mode == .clientConnect, !managed.connectCallbackDelivered {
            managed.connectCallbackDelivered = true
            dispatchValueCallback(
                callbacks.tcpOnConnected,
                arguments: [managed.socketID, false, error.localizedDescription]
            )
        }

        if mode == .secureUpgrade, !managed.secureCallbackDelivered {
            managed.secureUpgradeInFlight = false
            managed.secureCallbackDelivered = true
            dispatchValueCallback(callbacks.tcpOnSecured, arguments: [managed.socketID, false])
        }

        reportTCPError(socketID: managed.socketID, message: error.localizedDescription)
        finishConnection(managed, hadError: true)
    }

    private func handleConnectionCancelled(_ managed: ManagedTCPConnection) {
        if managed.suppressNextCancelClose {
            managed.suppressNextCancelClose = false
            return
        }

        finishConnection(managed, hadError: !managed.userInitiatedClose)
    }

    private func finishConnection(_ managed: ManagedTCPConnection, hadError: Bool) {
        guard !managed.closeDelivered else {
            return
        }

        managed.closeDelivered = true
        tcpConnections.removeValue(forKey: managed.socketID)
        dispatchValueCallback(callbacks.tcpOnClose, arguments: [managed.socketID, hadError])
    }

    private func reportTCPError(socketID: Int, message: String) {
        dispatchValueCallback(callbacks.tcpOnError, arguments: [socketID, message])
    }

    private func hasGlobalFunction(_ name: String) -> Bool {
        guard let function = engine.context.globalObject.forProperty(name) else {
            return false
        }

        return !function.isUndefined
    }

    private func dispatchValueCallback(_ callback: JSValue?, arguments: [Any]) {
        guard let callback else {
            return
        }

        let jsArguments = arguments.map { JSFunctionArgument.value($0) }
        dispatchCallback(callback, arguments: jsArguments)
    }

    private func dispatchCallback(_ callback: JSValue, arguments: [JSFunctionArgument]) {
        engine.jsQueue.async {
            _ = try? self.engine.callFunction(callback, arguments: arguments)
        }
    }

    private func packTCPBatch(_ frames: [PendingTCPFrame]) -> Data {
        var packed = Data()
        packed.reserveCapacity(4 + frames.reduce(0) { $0 + 8 + $1.data.count })
        packed.appendUInt32LE(UInt32(frames.count))

        for frame in frames {
            packed.appendUInt32LE(UInt32(frame.socketID))
            packed.appendUInt32LE(UInt32(frame.data.count))
            packed.append(frame.data)
        }

        return packed
    }

    private func packUDPBatch(_ frames: [PendingUDPFrame]) -> Data {
        var packed = Data()
        packed.reserveCapacity(
            4 + frames.reduce(0) { partial, frame in
                partial + 4 + 2 + 1 + frame.sourceAddress.utf8.count + 4 + frame.data.count
            }
        )
        packed.appendUInt32LE(UInt32(frames.count))

        for frame in frames {
            let addressBytes = Array(frame.sourceAddress.utf8)
            packed.appendUInt32LE(UInt32(frame.socketID))
            packed.appendUInt16LE(UInt16(clamping: frame.sourcePort))
            packed.appendUInt8(UInt8(addressBytes.count))
            packed.append(contentsOf: addressBytes)
            packed.appendUInt32LE(UInt32(frame.data.count))
            packed.append(frame.data)
        }

        return packed
    }

    private func remoteAddressAndPort(for endpoint: NWEndpoint) -> (address: String, port: Int) {
        switch endpoint {
        case .hostPort(let host, let port):
            return (String(describing: host), Int(port.rawValue))
        default:
            return ("", 0)
        }
    }

    private func nwPort(_ port: Int) -> NWEndpoint.Port? {
        guard (0...Int(UInt16.max)).contains(port) else {
            return nil
        }
        return NWEndpoint.Port(rawValue: UInt16(port))
    }

    private func makeTCPParameters(tlsHostname: String? = nil) -> NWParameters {
        let tcpOptions = NWProtocolTCP.Options()
        tcpOptions.noDelay = true

        if let tlsHostname {
            let tlsOptions = NWProtocolTLS.Options()
            sec_protocol_options_set_tls_server_name(tlsOptions.securityProtocolOptions, tlsHostname)
            return NWParameters(tls: tlsOptions, tcp: tcpOptions)
        }

        return NWParameters(tls: nil, tcp: tcpOptions)
    }

    private func resolveUDPDestination(address: String, port: Int) -> sockaddr_in? {
        if let ipv4 = ipv4Address(address, allowEmpty: false) {
            var destination = sockaddr_in()
            destination.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
            destination.sin_family = sa_family_t(AF_INET)
            destination.sin_port = in_port_t(UInt16(port).bigEndian)
            destination.sin_addr = ipv4
            return destination
        }

        var hints = addrinfo(
            ai_flags: AI_NUMERICSERV,
            ai_family: AF_INET,
            ai_socktype: SOCK_DGRAM,
            ai_protocol: IPPROTO_UDP,
            ai_addrlen: 0,
            ai_canonname: nil,
            ai_addr: nil,
            ai_next: nil
        )
        var results: UnsafeMutablePointer<addrinfo>?
        let service = String(port)
        let status = address.withCString { hostCString in
            service.withCString { serviceCString in
                getaddrinfo(hostCString, serviceCString, &hints, &results)
            }
        }
        guard status == 0, let firstResult = results else {
            return nil
        }
        defer {
            freeaddrinfo(firstResult)
        }

        var current: UnsafeMutablePointer<addrinfo>? = firstResult
        while let entry = current {
            if
                entry.pointee.ai_family == AF_INET,
                let aiAddress = entry.pointee.ai_addr,
                entry.pointee.ai_addrlen >= socklen_t(MemoryLayout<sockaddr_in>.size)
            {
                return aiAddress.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { $0.pointee }
            }
            current = entry.pointee.ai_next
        }

        return nil
    }

    private func ipv4Address(_ address: String, allowEmpty: Bool) -> in_addr? {
        if allowEmpty, address.isEmpty {
            return in_addr(s_addr: INADDR_ANY)
        }

        let resolved = address == "localhost" ? "127.0.0.1" : address
        var parsed = in_addr()
        let result = resolved.withCString { cString in
            inet_pton(AF_INET, cString, &parsed)
        }

        return result == 1 ? parsed : nil
    }

    private func udpSource(from storage: sockaddr_storage, length: socklen_t) -> (address: String, port: Int) {
        guard Int(length) >= MemoryLayout<sockaddr>.size else {
            return ("", 0)
        }

        switch Int32(storage.ss_family) {
        case AF_INET:
            var copy = storage
            return withUnsafePointer(to: &copy) { pointer in
                pointer.withMemoryRebound(to: sockaddr_in.self, capacity: 1) { addressPointer in
                    let address = addressPointer.pointee.sin_addr
                    let port = Int(UInt16(bigEndian: addressPointer.pointee.sin_port))
                    var addressBuffer = [CChar](repeating: 0, count: Int(INET_ADDRSTRLEN))
                    var mutableAddress = address
                    let converted = inet_ntop(
                        AF_INET,
                        &mutableAddress,
                        &addressBuffer,
                        socklen_t(addressBuffer.count)
                    )
                    return (converted != nil ? String(cString: addressBuffer) : "", port)
                }
            }
        default:
            return ("", 0)
        }
    }
}

private extension Data {
    mutating func appendUInt8(_ value: UInt8) {
        append(value)
    }

    mutating func appendUInt16LE(_ value: UInt16) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { buffer in
            append(buffer.bindMemory(to: UInt8.self))
        }
    }

    mutating func appendUInt32LE(_ value: UInt32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { buffer in
            append(buffer.bindMemory(to: UInt8.self))
        }
    }
}
