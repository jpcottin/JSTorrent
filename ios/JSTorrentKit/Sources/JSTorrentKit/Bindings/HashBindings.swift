import CryptoKit
import Foundation

public final class HashBindings {
    private let engine: JSEngine
    private let workQueue: DispatchQueue

    public init(
        engine: JSEngine,
        workQueue: DispatchQueue = DispatchQueue(label: "com.jstorrent.ios.hash", qos: .userInitiated)
    ) {
        self.engine = engine
        self.workQueue = workQueue
    }

    public func register() {
        registerSyncHashBindings()
        registerAsyncHashBinding()
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

            workQueue.async { [weak engine] in
                let hash = Data(Insecure.SHA1.hash(data: data))
                engine?.jsQueue.async {
                    _ = try? engine?.callGlobalFunction(
                        "__jstorrent_hash_dispatch_result",
                        arguments: [.value(callbackID), .binary(hash)]
                    )
                }
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
