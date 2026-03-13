import Foundation

public final class NativeBindings {
    public let polyfills: PolyfillBindings
    public let storage: StorageBindings
    public let files: FileBindings
    public let hashes: HashBindings
    public let eventSink: NativeEventSink

    private let engine: JSEngine

    public init(
        engine: JSEngine,
        eventSink: NativeEventSink = NativeEventSink(),
        userDefaults: UserDefaults = .standard,
        fileBaseDirectory: URL? = nil,
        defaultRootKey: String = "default",
        logHandler: @escaping @Sendable (String, String) -> Void = { level, message in
            NSLog("[JSTorrent:%@] %@", level, message)
        }
    ) {
        self.engine = engine
        self.eventSink = eventSink
        self.polyfills = PolyfillBindings(engine: engine, logHandler: logHandler)
        self.storage = StorageBindings(userDefaults: userDefaults)
        self.files = FileBindings(
            baseDirectory: fileBaseDirectory ?? FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first ?? FileManager.default.temporaryDirectory,
            defaultRootKey: defaultRootKey
        )
        self.hashes = HashBindings(engine: engine)
    }

    public func registerCoreBindings() {
        polyfills.register()
        registerEventCallbacks()
        storage.register(on: engine)
        files.register(on: engine)
        hashes.register()
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
