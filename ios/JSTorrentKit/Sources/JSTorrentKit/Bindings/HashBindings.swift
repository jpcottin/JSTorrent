import CryptoKit
import Foundation

private struct PendingHashResult {
    let callbackID: String
    let hash: Data
}

private final class HashAsyncState: @unchecked Sendable {
    private let lock = NSLock()
    private var pendingResults: [PendingHashResult] = []

    func enqueue(_ result: PendingHashResult) {
        lock.lock()
        pendingResults.append(result)
        lock.unlock()
    }

    func drain() -> [PendingHashResult] {
        lock.lock()
        let drained = pendingResults
        pendingResults.removeAll(keepingCapacity: true)
        lock.unlock()
        return drained
    }
}

public final class HashBindings: @unchecked Sendable {
    private let engine: JSEngine
    private let workQueue: DispatchQueue
    private let asyncState: HashAsyncState

    public init(
        engine: JSEngine,
        workQueue: DispatchQueue = DispatchQueue(label: "com.jstorrent.ios.hash", qos: .userInitiated)
    ) {
        self.engine = engine
        self.workQueue = workQueue
        self.asyncState = HashAsyncState()
    }

    public func register() {
        registerSyncHashBindings()
        registerAsyncHashBinding()
        registerFlushBinding()
    }

    private func registerSyncHashBindings() {
        engine.setGlobalFunction("__jstorrent_sha1") { [weak engine] arguments in
            guard
                let engine,
                let data = try engine.data(from: arguments.first)
            else {
                return .binary(Data())
            }

            return .binary(Data(Insecure.SHA1.hash(data: data)))
        }

        engine.setGlobalFunction("__jstorrent_sha1_batch_sync") { [weak engine] arguments in
            guard
                let engine,
                let packed = try engine.data(from: arguments.first)
            else {
                return .binary(Data())
            }

            return .binary(try self.hashBatch(packed))
        }
    }

    private func registerAsyncHashBinding() {
        engine.setGlobalFunction("__jstorrent_sha1_async") { [weak self, weak engine] arguments in
            guard
                let self,
                let engine,
                let data = try engine.data(from: arguments.first)
            else {
                return .undefined
            }

            let callbackID = arguments.dropFirst().first?.toString() ?? ""
            guard !callbackID.isEmpty else {
                return .undefined
            }

            self.workQueue.async { [asyncState] in
                let hash = Data(Insecure.SHA1.hash(data: data))
                asyncState.enqueue(PendingHashResult(callbackID: callbackID, hash: hash))
            }

            return .undefined
        }
    }

    private func registerFlushBinding() {
        engine.setGlobalFunction("__jstorrent_hash_flush") { [weak self, weak engine] _ in
            guard let self, let engine else {
                return .undefined
            }

            let hasBatchDispatcher = self.hasGlobalFunction("__jstorrent_hash_dispatch_batch", on: engine)
            let hasSingleDispatcher = self.hasGlobalFunction("__jstorrent_hash_dispatch_result", on: engine)
            guard hasBatchDispatcher || hasSingleDispatcher else {
                return .undefined
            }

            let results = self.asyncState.drain()
            guard !results.isEmpty else {
                return .undefined
            }

            if hasBatchDispatcher {
                _ = try? engine.callGlobalFunction(
                    "__jstorrent_hash_dispatch_batch",
                    arguments: [.binary(self.packHashResults(results))]
                )
                return .undefined
            }

            for result in results {
                _ = try? engine.callGlobalFunction(
                    "__jstorrent_hash_dispatch_result",
                    arguments: [.value(result.callbackID), .binary(result.hash)]
                )
            }

            return .undefined
        }
    }

    private func hashBatch(_ packed: Data) throws -> Data {
        guard packed.count >= 4 else {
            return Data()
        }

        var offset = 0
        let count = Int(readUInt32(from: packed, offset: &offset))
        if count <= 0 || count > 100 {
            return Data()
        }

        var output = Data(capacity: count * 20)
        for _ in 0..<count {
            guard offset + 4 <= packed.count else {
                return Data()
            }

            let length = Int(readUInt32(from: packed, offset: &offset))
            guard length >= 0, offset + length <= packed.count else {
                return Data()
            }

            let item = packed.subdata(in: offset..<(offset + length))
            offset += length
            output.append(contentsOf: Insecure.SHA1.hash(data: item))
        }

        return output
    }

    private func hasGlobalFunction(_ name: String, on engine: JSEngine) -> Bool {
        guard let function = engine.context.globalObject.forProperty(name) else {
            return false
        }

        return !function.isUndefined
    }

    private func packHashResults(_ results: [PendingHashResult]) -> Data {
        var packed = Data()
        packed.reserveCapacity(4 + results.reduce(0) { $0 + 1 + $1.callbackID.utf8.count + 1 + $1.hash.count })
        packed.appendUInt32LE(UInt32(results.count))

        for result in results {
            let callbackBytes = Array(result.callbackID.utf8)
            packed.appendUInt8(UInt8(callbackBytes.count))
            packed.append(contentsOf: callbackBytes)
            packed.appendUInt8(UInt8(result.hash.count))
            packed.append(result.hash)
        }

        return packed
    }

    private func readUInt32(from data: Data, offset: inout Int) -> UInt32 {
        let range = offset..<(offset + 4)
        let value = data[range].enumerated().reduce(UInt32(0)) { partial, pair in
            let (index, byte) = pair
            return partial | (UInt32(byte) << (UInt32(index) * 8))
        }
        offset += 4
        return value
    }
}

private extension Data {
    mutating func appendUInt8(_ value: UInt8) {
        append(value)
    }

    mutating func appendUInt32LE(_ value: UInt32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { buffer in
            append(buffer.bindMemory(to: UInt8.self))
        }
    }
}
