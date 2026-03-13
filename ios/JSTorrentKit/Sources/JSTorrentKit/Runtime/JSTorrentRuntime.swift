import Foundation
import JavaScriptCore

public enum EngineTickMode: String, Sendable {
    case js
    case host
}

public struct EngineTickResult: Equatable, Sendable {
    public let delayMs: Int32
    public let blocksRecv: Int32
    public let blocksSent: Int32
    public let elapsedMs: Int32
    public let activePieces: Int32
    public let connectedPeers: Int32
    public let bufferedBytes: Int32
    public let pipelineFilled: Int32
    public let pipelineMax: Int32
    public let pendingHashes: Int32
}

public enum JSTorrentRuntimeError: Error, LocalizedError {
    case invalidTickFrame(Int)

    public var errorDescription: String? {
        switch self {
        case .invalidTickFrame(let size):
            return "Expected 40 bytes from __jstorrent_engine_tick(), got \(size)."
        }
    }
}

public final class JSTorrentRuntime {
    public let engine: JSEngine
    public let bindings: NativeBindings
    public let socketBindings: SocketBindings
    public let eventSink: NativeEventSink

    public init(
        eventSink: NativeEventSink = NativeEventSink(),
        userDefaults: UserDefaults = .standard,
        fileBaseDirectory: URL? = nil,
        defaultRootKey: String = "default",
        logHandler: @escaping @Sendable (String, String) -> Void = { level, message in
            NSLog("[JSTorrent:%@] %@", level, message)
        }
    ) throws {
        let engine = try JSEngine()
        self.engine = engine
        self.eventSink = eventSink
        self.bindings = NativeBindings(
            engine: engine,
            eventSink: eventSink,
            userDefaults: userDefaults,
            fileBaseDirectory: fileBaseDirectory,
            defaultRootKey: defaultRootKey,
            logHandler: logHandler
        )
        self.socketBindings = SocketBindings(engine: engine)
        socketBindings.register()
        bindings.registerCoreBindings()
    }

    @discardableResult
    public func loadBundle(from url: URL) throws -> JSValue? {
        try engine.evaluateBundle(at: url)
    }

    @discardableResult
    public func loadDefaultBundle(in bundle: Bundle = .main) throws -> JSValue? {
        guard let url = bundle.url(forResource: "engine.bundle", withExtension: "js") else {
            throw EngineBundleError.fileNotFound(
                bundle.bundleURL.appendingPathComponent("engine.bundle.js")
            )
        }

        return try loadBundle(from: url)
    }

    public func initialize(with config: EngineBootstrapConfig) throws {
        let literal = try jsonLiteral(config)
        _ = try engine.evaluate(
            "jstorrent.init(\(literal));",
            filename: "runtime-init.js"
        )
    }

    public func isInitialized() throws -> Bool {
        let result = try engine.evaluate(
            "Boolean(globalThis.jstorrent && jstorrent.isInitialized())",
            filename: "runtime-is-initialized.js"
        )

        return result?.toBool() ?? false
    }

    public func subscribe(type: String, hash: String = "", intervalMs: Int = 500) throws {
        let typeLiteral = try jsonLiteral(type)
        let hashLiteral = try jsonLiteral(hash)
        _ = try engine.evaluate(
            "__jstorrent_subscribe(\(typeLiteral), \(hashLiteral), \(intervalMs));",
            filename: "runtime-subscribe.js"
        )
    }

    public func setTickMode(_ mode: EngineTickMode) throws {
        let modeLiteral = try jsonLiteral(mode.rawValue)
        _ = try engine.evaluate(
            "__jstorrent_set_tick_mode(\(modeLiteral));",
            filename: "runtime-set-tick-mode.js"
        )
    }

    public func tick() throws -> EngineTickResult {
        let value = try engine.callGlobalFunction("__jstorrent_engine_tick")
        let packed = try engine.data(from: value) ?? Data()
        guard packed.count == 40 else {
            throw JSTorrentRuntimeError.invalidTickFrame(packed.count)
        }

        var reader = TickReader(data: packed)
        return try EngineTickResult(
            delayMs: reader.readInt32LE(),
            blocksRecv: reader.readInt32LE(),
            blocksSent: reader.readInt32LE(),
            elapsedMs: reader.readInt32LE(),
            activePieces: reader.readInt32LE(),
            connectedPeers: reader.readInt32LE(),
            bufferedBytes: reader.readInt32LE(),
            pipelineFilled: reader.readInt32LE(),
            pipelineMax: reader.readInt32LE(),
            pendingHashes: reader.readInt32LE()
        )
    }

    public func shutdown() throws {
        _ = try engine.evaluate(
            "jstorrent.shutdown()",
            filename: "runtime-shutdown.js"
        )
    }

    private func jsonLiteral<T: Encodable>(_ value: T) throws -> String {
        let data = try JSONEncoder().encode(value)
        return String(decoding: data, as: UTF8.self)
    }
}

private struct TickReader {
    let data: Data
    var offset = 0

    mutating func readInt32LE() throws -> Int32 {
        guard offset + 4 <= data.count else {
            throw JSTorrentRuntimeError.invalidTickFrame(data.count)
        }

        let b0 = UInt32(data[offset])
        let b1 = UInt32(data[offset + 1]) << 8
        let b2 = UInt32(data[offset + 2]) << 16
        let b3 = UInt32(data[offset + 3]) << 24
        offset += 4
        return Int32(bitPattern: b0 | b1 | b2 | b3)
    }
}
