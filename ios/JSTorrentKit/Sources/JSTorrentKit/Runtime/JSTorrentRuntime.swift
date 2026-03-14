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
    case queryFailed(String)

    public var errorDescription: String? {
        switch self {
        case .invalidTickFrame(let size):
            return "Expected 40 bytes from __jstorrent_engine_tick(), got \(size)."
        case .queryFailed(let message):
            return message
        }
    }
}

private struct RuntimeQueryErrorPayload: Decodable {
    let error: String
}

private struct RuntimeSetFilePrioritiesPayload: Decodable {
    let ok: Bool
    let applied: Int?
    let error: String?
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
        bindings.configureFileRoots(config.contentRoots, defaultRootKey: config.defaultContentRoot)
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

    public func unsubscribe(type: String, hash: String) throws {
        let typeLiteral = try jsonLiteral(type)
        let hashLiteral = try jsonLiteral(hash)
        _ = try engine.evaluate(
            "__jstorrent_unsubscribe(\(typeLiteral), \(hashLiteral));",
            filename: "runtime-unsubscribe.js"
        )
    }

    public func unsubscribeAll(hash: String) throws {
        let hashLiteral = try jsonLiteral(hash)
        _ = try engine.evaluate(
            "__jstorrent_unsubscribe_all(\(hashLiteral));",
            filename: "runtime-unsubscribe-all.js"
        )
    }

    public func setTickMode(_ mode: EngineTickMode) throws {
        let modeLiteral = try jsonLiteral(mode.rawValue)
        _ = try engine.evaluate(
            "__jstorrent_set_tick_mode(\(modeLiteral));",
            filename: "runtime-set-tick-mode.js"
        )
    }

    public func addTorrent(_ magnetOrBase64: String) throws {
        let inputLiteral = try jsonLiteral(magnetOrBase64)
        _ = try engine.evaluate(
            "__jstorrent_cmd_add_torrent(\(inputLiteral))",
            filename: "runtime-add-torrent.js"
        )
    }

    public func addTestTorrent() throws {
        _ = try engine.evaluate(
            "__jstorrent_cmd_add_test_torrent()",
            filename: "runtime-add-test-torrent.js"
        )
    }

    public func queryTorrentList() throws -> EngineStatePayload {
        let payload = try engine.evaluate(
            "__jstorrent_query_torrent_list()",
            filename: "runtime-query-torrent-list.js"
        )?.toString() ?? "{\"torrents\":[]}"

        return try decodePayload(EngineStatePayload.self, from: payload)
    }

    public func queryFiles(_ infoHash: String) throws -> TorrentFilesPayload {
        let infoHashLiteral = try jsonLiteral(infoHash)
        let payload = try engine.evaluate(
            "__jstorrent_query_files(\(infoHashLiteral))",
            filename: "runtime-query-files.js"
        )?.toString() ?? "{\"files\":[]}"

        return try decodePayload(TorrentFilesPayload.self, from: payload)
    }

    public func queryTrackers(_ infoHash: String) throws -> TorrentTrackersPayload {
        let infoHashLiteral = try jsonLiteral(infoHash)
        let payload = try engine.evaluate(
            "__jstorrent_query_trackers(\(infoHashLiteral))",
            filename: "runtime-query-trackers.js"
        )?.toString() ?? "{\"trackers\":[]}"

        return try decodePayload(TorrentTrackersPayload.self, from: payload)
    }

    public func queryPeers(_ infoHash: String) throws -> TorrentPeersPayload {
        let infoHashLiteral = try jsonLiteral(infoHash)
        let payload = try engine.evaluate(
            "__jstorrent_query_peers(\(infoHashLiteral))",
            filename: "runtime-query-peers.js"
        )?.toString() ?? "{\"peers\":[]}"

        return try decodePayload(TorrentPeersPayload.self, from: payload)
    }

    public func queryPieces(_ infoHash: String) throws -> TorrentPiecesPayload {
        let infoHashLiteral = try jsonLiteral(infoHash)
        let payload = try engine.evaluate(
            "__jstorrent_query_pieces(\(infoHashLiteral))",
            filename: "runtime-query-pieces.js"
        )?.toString() ?? "{\"error\":\"Missing pieces payload\"}"

        return try decodePayload(TorrentPiecesPayload.self, from: payload)
    }

    public func queryDetails(_ infoHash: String) throws -> TorrentDetailsPayload {
        let infoHashLiteral = try jsonLiteral(infoHash)
        let payload = try engine.evaluate(
            "__jstorrent_query_details(\(infoHashLiteral))",
            filename: "runtime-query-details.js"
        )?.toString() ?? "{\"error\":\"Missing details payload\"}"

        return try decodePayload(TorrentDetailsPayload.self, from: payload)
    }

    public func pauseTorrent(_ infoHash: String) throws {
        let infoHashLiteral = try jsonLiteral(infoHash)
        _ = try engine.evaluate(
            "__jstorrent_cmd_pause(\(infoHashLiteral))",
            filename: "runtime-pause-torrent.js"
        )
    }

    public func resumeTorrent(_ infoHash: String) throws {
        let infoHashLiteral = try jsonLiteral(infoHash)
        _ = try engine.evaluate(
            "__jstorrent_cmd_resume(\(infoHashLiteral))",
            filename: "runtime-resume-torrent.js"
        )
    }

    public func removeTorrent(_ infoHash: String, deleteFiles: Bool = false) throws {
        let infoHashLiteral = try jsonLiteral(infoHash)
        let deleteFilesLiteral = deleteFiles ? "true" : "false"
        _ = try engine.evaluate(
            "__jstorrent_cmd_remove(\(infoHashLiteral), \(deleteFilesLiteral))",
            filename: "runtime-remove-torrent.js"
        )
    }

    @discardableResult
    public func setFilePriorities(_ infoHash: String, priorities: [Int: Int]) throws -> Int {
        let infoHashLiteral = try jsonLiteral(infoHash)
        let stringKeyedPriorities = Dictionary(
            uniqueKeysWithValues: priorities.map { (String($0.key), $0.value) }
        )
        let prioritiesData = try JSONEncoder().encode(stringKeyedPriorities)
        let prioritiesJSONString = String(decoding: prioritiesData, as: UTF8.self)
        let prioritiesLiteral = try jsonLiteral(prioritiesJSONString)
        let payload = try engine.awaitPromise(
            expression: """
            (async () => JSON.stringify(
              await __jstorrent_cmd_set_file_priorities(\(infoHashLiteral), \(prioritiesLiteral))
            ))()
            """,
            filename: "runtime-set-file-priorities.js"
        )?.toString() ?? "{\"ok\":false,\"error\":\"Missing set_file_priorities response\"}"

        let response = try decodePayload(RuntimeSetFilePrioritiesPayload.self, from: payload)
        guard response.ok else {
            throw JSTorrentRuntimeError.queryFailed(
                response.error ?? "Failed to set file priorities."
            )
        }

        return response.applied ?? 0
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
        _ = try engine.awaitPromise(
            expression: "__jstorrent_cmd_shutdown()",
            filename: "runtime-shutdown.js"
        )
    }

    private func jsonLiteral<T: Encodable>(_ value: T) throws -> String {
        let data = try JSONEncoder().encode(value)
        return String(decoding: data, as: UTF8.self)
    }

    private func decodePayload<T: Decodable>(_ type: T.Type, from payload: String) throws -> T {
        let data = Data(payload.utf8)

        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            if let queryError = try? JSONDecoder().decode(RuntimeQueryErrorPayload.self, from: data) {
                throw JSTorrentRuntimeError.queryFailed(queryError.error)
            }
            throw error
        }
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
