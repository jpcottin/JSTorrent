import Foundation

public final class NativeBindings {
    public let polyfills: PolyfillBindings
    public let eventSink: NativeEventSink

    private let engine: JSEngine

    public init(
        engine: JSEngine,
        eventSink: NativeEventSink = NativeEventSink(),
        logHandler: @escaping @Sendable (String, String) -> Void = { level, message in
            NSLog("[JSTorrent:%@] %@", level, message)
        }
    ) {
        self.engine = engine
        self.eventSink = eventSink
        self.polyfills = PolyfillBindings(engine: engine, logHandler: logHandler)
    }

    public func registerCoreBindings() {
        polyfills.register()
        registerEventCallbacks()
    }

    private func registerEventCallbacks() {
        engine.setGlobalFunction("__jstorrent_on_state_update") { [eventSink] arguments in
            let payload = arguments.first?.toString() ?? ""
            eventSink.recordStateUpdate(payload)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_on_error") { [eventSink] arguments in
            let payload = arguments.first?.toString() ?? ""
            eventSink.recordError(payload)
            return .undefined
        }
    }
}
