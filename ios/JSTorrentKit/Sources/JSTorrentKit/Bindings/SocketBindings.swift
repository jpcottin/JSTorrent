import Foundation
import JavaScriptCore

private final class SocketCallbackStore {
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

public final class SocketBindings {
    private let engine: JSEngine
    private let callbacks = SocketCallbackStore()

    public init(engine: JSEngine) {
        self.engine = engine
    }

    public func register() {
        registerTcpBindings()
        registerUdpBindings()
    }

    private func registerTcpBindings() {
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
            self.dispatch(
                self.callbacks.tcpOnConnected,
                arguments: [socketID, false, "TCP bindings are not implemented on iOS yet."]
            )
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_send") { _ in
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_send_batch") { _ in
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_close") { arguments in
            let socketID = Int(arguments.first?.toInt32() ?? 0)
            self.dispatch(self.callbacks.tcpOnClose, arguments: [socketID, false])
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_secure") { arguments in
            let socketID = Int(arguments.first?.toInt32() ?? 0)
            self.dispatch(self.callbacks.tcpOnSecured, arguments: [socketID, false])
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_set_backpressure") { _ in
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_flush") { _ in
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_listen") { arguments in
            let serverID = Int(arguments.first?.toInt32() ?? 0)
            let port = Int(arguments.dropFirst().first?.toInt32() ?? 0)
            self.dispatch(self.callbacks.tcpOnListening, arguments: [serverID, false, port])
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_tcp_server_close") { _ in
            return .undefined
        }
    }

    private func registerUdpBindings() {
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
            self.dispatch(self.callbacks.udpOnBound, arguments: [socketID, false, port])
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

    private func dispatch(_ callback: JSValue?, arguments: [Any]) {
        guard let callback else {
            return
        }

        engine.jsQueue.async {
            callback.call(withArguments: arguments)
        }
    }
}
