import Foundation
import JavaScriptCore
import Network
import Security

private struct PendingTCPFrame {
    let socketID: Int
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
    private var pendingTCPFrames: [PendingTCPFrame] = []
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
            let port = Int(arguments.dropFirst(2).first?.toInt32() ?? 0)
            self.dispatchValueCallback(self.callbacks.udpOnBound, arguments: [socketID, false, port])
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_send") { _ in
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_close") { _ in
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_join_multicast") { _ in
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_leave_multicast") { _ in
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_udp_flush") { _ in
            return .undefined
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
}

private extension Data {
    mutating func appendUInt32LE(_ value: UInt32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { buffer in
            append(buffer.bindMemory(to: UInt8.self))
        }
    }
}
