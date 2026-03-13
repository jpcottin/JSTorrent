import CryptoKit
import Darwin
import Foundation

private enum FileResultCode: UInt8 {
    case success = 0
    case hashMismatch = 1
    case ioError = 2
    case invalidArgs = 3
    case diskFull = 4
    case permissionDenied = 5
}

private enum FileBindingError: Error {
    case invalidArguments
    case invalidFrame
}

private struct FileStatPayload: Encodable {
    let size: UInt64
    let mtime: Int64
    let isDirectory: Bool
    let isFile: Bool
}

private struct TreeEntry: Encodable {
    let path: String
    let size: UInt64
}

private struct BatchDeleteRequest: Decodable {
    let directory: String
    let entries: [String]
}

private struct VerifyChunkFile: Decodable {
    let path: String
    let length: Int64
}

private struct VerifyChunksRequestPayload: Decodable {
    let files: [VerifyChunkFile]
    let chunkSize: Int64
    let hashes: String
    let startChunk: Int64?
    let chunkCount: Int64?
}

private struct VerifiedWriteRequest {
    let rootKey: String
    let path: String
    let position: UInt64
    let data: Data
    let expectedHashHex: String
    let callbackID: String
}

private struct AsyncReadRequest {
    let rootKey: String
    let path: String
    let position: UInt64
    let length: Int
    let callbackID: String
}

private struct PendingWriteResult {
    let callbackID: String
    let bytesWritten: Int32
    let resultCode: FileResultCode
}

private struct PendingReadResult {
    let callbackID: String
    let resultCode: FileResultCode
    let data: Data
}

private final class FileAsyncState: @unchecked Sendable {
    private let lock = NSLock()
    private var writeResults: [PendingWriteResult] = []
    private var readResults: [PendingReadResult] = []

    func enqueueWrite(_ result: PendingWriteResult) {
        lock.lock()
        writeResults.append(result)
        lock.unlock()
    }

    func enqueueRead(_ result: PendingReadResult) {
        lock.lock()
        readResults.append(result)
        lock.unlock()
    }

    func drainWriteResults() -> [PendingWriteResult] {
        lock.lock()
        let drained = writeResults
        writeResults.removeAll(keepingCapacity: true)
        lock.unlock()
        return drained
    }

    func drainReadResults() -> [PendingReadResult] {
        lock.lock()
        let drained = readResults
        readResults.removeAll(keepingCapacity: true)
        lock.unlock()
        return drained
    }
}

private struct DataReader {
    let data: Data
    var offset = 0

    mutating func readUInt8() throws -> UInt8 {
        guard offset < data.count else {
            throw FileBindingError.invalidFrame
        }

        let value = data[offset]
        offset += 1
        return value
    }

    mutating func readUInt16LE() throws -> UInt16 {
        let b0 = UInt16(try readUInt8())
        let b1 = UInt16(try readUInt8())
        return b0 | (b1 << 8)
    }

    mutating func readUInt32LE() throws -> UInt32 {
        let b0 = UInt32(try readUInt8())
        let b1 = UInt32(try readUInt8())
        let b2 = UInt32(try readUInt8())
        let b3 = UInt32(try readUInt8())
        return b0 | (b1 << 8) | (b2 << 16) | (b3 << 24)
    }

    mutating func readUInt64LE() throws -> UInt64 {
        let low = UInt64(try readUInt32LE())
        let high = UInt64(try readUInt32LE())
        return low | (high << 32)
    }

    mutating func readData(count: Int) throws -> Data {
        guard count >= 0, offset + count <= data.count else {
            throw FileBindingError.invalidFrame
        }

        let value = data.subdata(in: offset..<(offset + count))
        offset += count
        return value
    }

    mutating func readUTF8(count: Int) throws -> String {
        let value = try readData(count: count)
        guard let string = String(data: value, encoding: .utf8) else {
            throw FileBindingError.invalidFrame
        }

        return string
    }
}

public final class FileBindings: @unchecked Sendable {
    private let fileManager: FileManager
    private let baseDirectory: URL
    private let defaultRootKey: String
    private let workQueue: DispatchQueue
    private let asyncState: FileAsyncState

    public init(
        baseDirectory: URL,
        defaultRootKey: String = "default",
        fileManager: FileManager = .default,
        workQueue: DispatchQueue = DispatchQueue(label: "com.jstorrent.ios.file", qos: .utility, attributes: .concurrent)
    ) {
        self.baseDirectory = baseDirectory.standardizedFileURL
        self.defaultRootKey = defaultRootKey
        self.fileManager = fileManager
        self.workQueue = workQueue
        self.asyncState = FileAsyncState()
    }

    public func register(on engine: JSEngine) {
        registerReadWrite(on: engine)
        registerAsyncOperations(on: engine)
        registerPathFunctions(on: engine)
    }

    private func registerReadWrite(on engine: JSEngine) {
        engine.setGlobalFunction("__jstorrent_file_read") { arguments in
            guard
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString()
            else {
                return .binary(Data())
            }

            let offset = UInt64(max(arguments.dropFirst(2).first?.toInt32() ?? 0, 0))
            let length = Int(max(arguments.dropFirst(3).first?.toInt32() ?? 0, 0))
            guard length > 0 else {
                return .binary(Data())
            }

            do {
                return .binary(try self.readFile(rootKey: rootKey, path: path, offset: offset, length: length))
            } catch {
                return .binary(Data())
            }
        }

        engine.setGlobalFunction("__jstorrent_file_write") { [weak engine] arguments in
            guard
                let engine,
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString(),
                let data = try engine.data(from: arguments.dropFirst(3).first)
            else {
                return .value(-1)
            }

            let offset = UInt64(max(arguments.dropFirst(2).first?.toInt32() ?? 0, 0))

            do {
                let bytesWritten = try self.writeFile(rootKey: rootKey, path: path, offset: offset, data: data)
                return .value(bytesWritten)
            } catch {
                return .value(-1)
            }
        }
    }

    private func registerAsyncOperations(on engine: JSEngine) {
        engine.setGlobalFunction("__jstorrent_file_write_verified") { [weak engine] arguments in
            let callbackID = arguments.dropFirst(5).first?.toString() ?? ""
            guard
                let engine,
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString(),
                let data = try engine.data(from: arguments.dropFirst(3).first),
                let expectedHashHex = arguments.dropFirst(4).first?.toString(),
                !callbackID.isEmpty
            else {
                if !callbackID.isEmpty {
                    self.asyncState.enqueueWrite(
                        PendingWriteResult(callbackID: callbackID, bytesWritten: -1, resultCode: .invalidArgs)
                    )
                }
                return .undefined
            }

            self.queueVerifiedWrite(
                VerifiedWriteRequest(
                    rootKey: rootKey,
                    path: path,
                    position: UInt64(max(arguments.dropFirst(2).first?.toInt32() ?? 0, 0)),
                    data: data,
                    expectedHashHex: expectedHashHex,
                    callbackID: callbackID
                )
            )
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_file_write_verified_batch") { [weak engine] arguments in
            guard
                let engine,
                let packed = try engine.data(from: arguments.first),
                let requests = try? self.parseVerifiedWriteBatch(packed)
            else {
                return .undefined
            }

            for request in requests {
                self.queueVerifiedWrite(request)
            }

            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_file_read_batch") { [weak engine] arguments in
            guard
                let engine,
                let packed = try engine.data(from: arguments.first),
                let requests = try? self.parseReadBatch(packed)
            else {
                return .undefined
            }

            for request in requests {
                self.queueAsyncRead(request)
            }

            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_file_flush") { [weak engine] _ in
            guard let engine else {
                return .undefined
            }

            if self.hasGlobalFunction("__jstorrent_file_dispatch_batch", on: engine) {
                let results = self.asyncState.drainWriteResults()
                if !results.isEmpty {
                    _ = try? engine.callGlobalFunction(
                        "__jstorrent_file_dispatch_batch",
                        arguments: [.binary(self.packWriteResults(results))]
                    )
                }
            }

            if self.hasGlobalFunction("__jstorrent_file_dispatch_read_batch", on: engine) {
                let results = self.asyncState.drainReadResults()
                if !results.isEmpty {
                    _ = try? engine.callGlobalFunction(
                        "__jstorrent_file_dispatch_read_batch",
                        arguments: [.binary(self.packReadResults(results))]
                    )
                }
            }

            return .undefined
        }
    }

    private func registerPathFunctions(on engine: JSEngine) {
        engine.setGlobalFunction("__jstorrent_file_stat") { arguments in
            guard
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString(),
                let fileURL = self.resolveFileURL(rootKey: rootKey, relativePath: path)
            else {
                return .value(nil)
            }

            do {
                let attributes = try self.fileManager.attributesOfItem(atPath: fileURL.path)
                let type = attributes[.type] as? FileAttributeType
                let isDirectory = type == .typeDirectory
                let size = (attributes[.size] as? NSNumber)?.uint64Value ?? 0
                let mtime = (attributes[.modificationDate] as? Date) ?? Date.distantPast
                let payload = FileStatPayload(
                    size: size,
                    mtime: Int64(mtime.timeIntervalSince1970 * 1000),
                    isDirectory: isDirectory,
                    isFile: !isDirectory
                )
                let data = try JSONEncoder().encode(payload)
                return .value(String(decoding: data, as: UTF8.self))
            } catch {
                return .value(nil)
            }
        }

        engine.setGlobalFunction("__jstorrent_file_mkdir") { arguments in
            guard
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString(),
                let fileURL = self.resolveFileURL(rootKey: rootKey, relativePath: path)
            else {
                return .value(false)
            }

            do {
                try self.fileManager.createDirectory(at: fileURL, withIntermediateDirectories: true)
                return .value(true)
            } catch {
                return .value(false)
            }
        }

        engine.setGlobalFunction("__jstorrent_file_exists") { arguments in
            guard
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString(),
                let fileURL = self.resolveFileURL(rootKey: rootKey, relativePath: path)
            else {
                return .value(false)
            }

            return .value(self.fileManager.fileExists(atPath: fileURL.path))
        }

        engine.setGlobalFunction("__jstorrent_file_readdir") { arguments in
            guard
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString(),
                let fileURL = self.resolveFileURL(rootKey: rootKey, relativePath: path)
            else {
                return .value("[]")
            }

            do {
                let entries = try self.fileManager.contentsOfDirectory(atPath: fileURL.path).sorted()
                let data = try JSONSerialization.data(withJSONObject: entries, options: [])
                return .value(String(decoding: data, as: UTF8.self))
            } catch {
                return .value("[]")
            }
        }

        engine.setGlobalFunction("__jstorrent_file_delete") { arguments in
            guard
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString(),
                let fileURL = self.resolveFileURL(rootKey: rootKey, relativePath: path)
            else {
                return .value(false)
            }

            guard self.fileManager.fileExists(atPath: fileURL.path) else {
                return .value(false)
            }

            do {
                try self.fileManager.removeItem(at: fileURL)
                return .value(true)
            } catch {
                return .value(false)
            }
        }

        engine.setGlobalFunction("__jstorrent_file_batch_delete") { arguments in
            guard
                let rootKey = arguments.first?.toString(),
                let requestString = arguments.dropFirst().first?.toString(),
                let requestData = requestString.data(using: .utf8),
                let request = try? JSONDecoder().decode(BatchDeleteRequest.self, from: requestData),
                let directoryURL = self.resolveFileURL(rootKey: rootKey, relativePath: request.directory)
            else {
                return .value("[]")
            }

            var failed: [String] = []
            for entry in request.entries {
                let entryURL = directoryURL.appendingPathComponent(entry, isDirectory: false).standardizedFileURL
                guard entryURL.path.hasPrefix(directoryURL.standardizedFileURL.path) else {
                    failed.append(entry)
                    continue
                }
                guard self.fileManager.fileExists(atPath: entryURL.path) else {
                    continue
                }
                do {
                    try self.fileManager.removeItem(at: entryURL)
                } catch {
                    failed.append(entry)
                }
            }

            let data = try JSONSerialization.data(withJSONObject: failed, options: [])
            return .value(String(decoding: data, as: UTF8.self))
        }

        engine.setGlobalFunction("__jstorrent_file_list_tree") { arguments in
            guard
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString(),
                let directoryURL = self.resolveFileURL(rootKey: rootKey, relativePath: path)
            else {
                return .value("[]")
            }

            guard self.fileManager.fileExists(atPath: directoryURL.path) else {
                return .value("[]")
            }

            do {
                let entries = try self.listTree(at: directoryURL)
                let data = try JSONEncoder().encode(entries)
                return .value(String(decoding: data, as: UTF8.self))
            } catch {
                return .value("[]")
            }
        }

        engine.setGlobalFunction("__jstorrent_file_verify_chunks") { arguments in
            guard
                let rootKey = arguments.first?.toString(),
                let requestString = arguments.dropFirst().first?.toString(),
                let requestData = requestString.data(using: .utf8),
                let request = try? JSONDecoder().decode(VerifyChunksRequestPayload.self, from: requestData)
            else {
                return .binary(Data())
            }

            do {
                return .binary(try self.verifyChunks(rootKey: rootKey, request: request))
            } catch {
                return .binary(Data())
            }
        }
    }

    private func queueVerifiedWrite(_ request: VerifiedWriteRequest) {
        workQueue.async {
            let result = self.performVerifiedWrite(request)
            self.asyncState.enqueueWrite(result)
        }
    }

    private func queueAsyncRead(_ request: AsyncReadRequest) {
        workQueue.async {
            let result = self.performAsyncRead(request)
            self.asyncState.enqueueRead(result)
        }
    }

    private func performVerifiedWrite(_ request: VerifiedWriteRequest) -> PendingWriteResult {
        guard request.expectedHashHex.count == 40 else {
            return PendingWriteResult(callbackID: request.callbackID, bytesWritten: -1, resultCode: .invalidArgs)
        }

        let actualHash = Data(Insecure.SHA1.hash(data: request.data)).hexString
        guard actualHash.caseInsensitiveCompare(request.expectedHashHex) == .orderedSame else {
            return PendingWriteResult(callbackID: request.callbackID, bytesWritten: 0, resultCode: .hashMismatch)
        }

        do {
            let bytesWritten = try writeFile(
                rootKey: request.rootKey,
                path: request.path,
                offset: request.position,
                data: request.data
            )
            return PendingWriteResult(
                callbackID: request.callbackID,
                bytesWritten: Int32(clamping: bytesWritten),
                resultCode: .success
            )
        } catch {
            return PendingWriteResult(
                callbackID: request.callbackID,
                bytesWritten: -1,
                resultCode: mapFileError(error)
            )
        }
    }

    private func performAsyncRead(_ request: AsyncReadRequest) -> PendingReadResult {
        do {
            let data = try readFile(
                rootKey: request.rootKey,
                path: request.path,
                offset: request.position,
                length: request.length
            )
            return PendingReadResult(callbackID: request.callbackID, resultCode: .success, data: data)
        } catch {
            return PendingReadResult(callbackID: request.callbackID, resultCode: mapFileError(error), data: Data())
        }
    }

    private func parseVerifiedWriteBatch(_ packed: Data) throws -> [VerifiedWriteRequest] {
        var reader = DataReader(data: packed)
        let count = Int(try reader.readUInt32LE())
        guard count >= 0, count <= 1024 else {
            throw FileBindingError.invalidFrame
        }

        var requests: [VerifiedWriteRequest] = []
        requests.reserveCapacity(count)

        for _ in 0..<count {
            let rootKey = try reader.readUTF8(count: Int(try reader.readUInt8()))
            let path = try reader.readUTF8(count: Int(try reader.readUInt16LE()))
            let position = try reader.readUInt64LE()
            let dataLength = Int(try reader.readUInt32LE())
            let data = try reader.readData(count: dataLength)
            let expectedHashHex = try reader.readUTF8(count: 40)
            let callbackID = try reader.readUTF8(count: Int(try reader.readUInt8()))

            requests.append(
                VerifiedWriteRequest(
                    rootKey: rootKey,
                    path: path,
                    position: position,
                    data: data,
                    expectedHashHex: expectedHashHex,
                    callbackID: callbackID
                )
            )
        }

        return requests
    }

    private func parseReadBatch(_ packed: Data) throws -> [AsyncReadRequest] {
        var reader = DataReader(data: packed)
        let count = Int(try reader.readUInt32LE())
        guard count >= 0, count <= 1024 else {
            throw FileBindingError.invalidFrame
        }

        var requests: [AsyncReadRequest] = []
        requests.reserveCapacity(count)

        for _ in 0..<count {
            let rootKey = try reader.readUTF8(count: Int(try reader.readUInt8()))
            let path = try reader.readUTF8(count: Int(try reader.readUInt16LE()))
            let position = try reader.readUInt64LE()
            let length = Int(try reader.readUInt32LE())
            let callbackID = try reader.readUTF8(count: Int(try reader.readUInt8()))

            requests.append(
                AsyncReadRequest(
                    rootKey: rootKey,
                    path: path,
                    position: position,
                    length: length,
                    callbackID: callbackID
                )
            )
        }

        return requests
    }

    private func packWriteResults(_ results: [PendingWriteResult]) -> Data {
        var packed = Data()
        packed.reserveCapacity(4 + results.reduce(0) { $0 + 1 + $1.callbackID.utf8.count + 4 + 1 })
        packed.appendUInt32LE(UInt32(results.count))

        for result in results {
            let callbackBytes = Array(result.callbackID.utf8)
            packed.appendUInt8(UInt8(callbackBytes.count))
            packed.append(contentsOf: callbackBytes)
            packed.appendInt32LE(result.bytesWritten)
            packed.appendUInt8(result.resultCode.rawValue)
        }

        return packed
    }

    private func packReadResults(_ results: [PendingReadResult]) -> Data {
        var packed = Data()
        packed.reserveCapacity(4 + results.reduce(0) { $0 + 1 + $1.callbackID.utf8.count + 1 + 4 + $1.data.count })
        packed.appendUInt32LE(UInt32(results.count))

        for result in results {
            let callbackBytes = Array(result.callbackID.utf8)
            packed.appendUInt8(UInt8(callbackBytes.count))
            packed.append(contentsOf: callbackBytes)
            packed.appendUInt8(result.resultCode.rawValue)
            packed.appendUInt32LE(UInt32(result.data.count))
            packed.append(result.data)
        }

        return packed
    }

    private func readFile(rootKey: String, path: String, offset: UInt64, length: Int) throws -> Data {
        guard length >= 0, let fileURL = resolveFileURL(rootKey: rootKey, relativePath: path) else {
            throw FileBindingError.invalidArguments
        }

        guard fileManager.fileExists(atPath: fileURL.path) else {
            throw CocoaError(.fileNoSuchFile)
        }

        let handle = try FileHandle(forReadingFrom: fileURL)
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        return try handle.read(upToCount: length) ?? Data()
    }

    private func writeFile(rootKey: String, path: String, offset: UInt64, data: Data) throws -> Int {
        guard let fileURL = resolveFileURL(rootKey: rootKey, relativePath: path) else {
            throw FileBindingError.invalidArguments
        }

        try ensureParentDirectoryExists(for: fileURL)
        if !fileManager.fileExists(atPath: fileURL.path) {
            fileManager.createFile(atPath: fileURL.path, contents: nil)
        }

        let handle = try FileHandle(forUpdating: fileURL)
        defer { try? handle.close() }
        try handle.seek(toOffset: offset)
        try handle.write(contentsOf: data)
        try handle.synchronize()
        return data.count
    }

    private func mapFileError(_ error: Error) -> FileResultCode {
        if case FileBindingError.invalidArguments = error {
            return .invalidArgs
        }

        let nsError = error as NSError
        if nsError.domain == NSPOSIXErrorDomain {
            switch nsError.code {
            case Int(ENOSPC):
                return .diskFull
            case Int(EACCES), Int(EPERM):
                return .permissionDenied
            default:
                return .ioError
            }
        }

        if nsError.domain == NSCocoaErrorDomain {
            switch nsError.code {
            case CocoaError.fileWriteOutOfSpace.rawValue:
                return .diskFull
            case CocoaError.fileWriteNoPermission.rawValue:
                return .permissionDenied
            default:
                return .ioError
            }
        }

        return .ioError
    }

    private func verifyChunks(rootKey: String, request: VerifyChunksRequestPayload) throws -> Data {
        let hashes = Data(base64Encoded: request.hashes) ?? Data()
        let chunkSize = Int(request.chunkSize)
        guard chunkSize > 0 else {
            return Data()
        }

        let totalLength = request.files.reduce(Int64(0)) { $0 + max($1.length, 0) }
        let totalChunks = hashes.count / 20
        let startChunk = Int(max(request.startChunk ?? 0, 0))
        let requestedChunkCount = Int(request.chunkCount ?? Int64(max(totalChunks - startChunk, 0)))
        guard requestedChunkCount >= 0 else {
            return Data()
        }

        var results = Data(capacity: requestedChunkCount)
        for chunkOffset in 0..<requestedChunkCount {
            let chunkIndex = startChunk + chunkOffset
            let hashStart = chunkIndex * 20
            guard hashStart + 20 <= hashes.count else {
                break
            }

            let startByte = Int64(chunkIndex * chunkSize)
            if startByte >= totalLength {
                break
            }

            let remaining = Int(totalLength - startByte)
            let readLength = min(chunkSize, remaining)

            do {
                let chunk = try readConcatenatedChunk(
                    rootKey: rootKey,
                    files: request.files,
                    startOffset: startByte,
                    length: readLength
                )
                if chunk.count != readLength {
                    results.append(2)
                    continue
                }

                let expected = hashes.subdata(in: hashStart..<(hashStart + 20))
                let actual = Data(Insecure.SHA1.hash(data: chunk))
                results.append(actual == expected ? 0 : 1)
            } catch {
                results.append(2)
            }
        }

        return results
    }

    private func readConcatenatedChunk(
        rootKey: String,
        files: [VerifyChunkFile],
        startOffset: Int64,
        length: Int
    ) throws -> Data {
        var remainingOffset = startOffset
        var remainingLength = length
        var output = Data(capacity: length)

        for file in files {
            let fileLength = max(file.length, 0)
            if remainingOffset >= fileLength {
                remainingOffset -= fileLength
                continue
            }

            let bytesFromFile = min(Int(fileLength - remainingOffset), remainingLength)
            guard bytesFromFile > 0 else {
                continue
            }

            let data = try readFile(
                rootKey: rootKey,
                path: file.path,
                offset: UInt64(remainingOffset),
                length: bytesFromFile
            )
            if data.count != bytesFromFile {
                throw CocoaError(.fileReadUnknown)
            }

            output.append(data)
            remainingLength -= bytesFromFile
            remainingOffset = 0

            if remainingLength == 0 {
                break
            }
        }

        return output
    }

    private func listTree(at directoryURL: URL) throws -> [TreeEntry] {
        let rootPath = directoryURL.resolvingSymlinksInPath().standardizedFileURL.path
        guard let enumerator = fileManager.enumerator(
            at: directoryURL,
            includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey],
            options: []
        ) else {
            return []
        }

        var results: [TreeEntry] = []
        for case let fileURL as URL in enumerator {
            let values = try fileURL.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey])
            if values.isDirectory == true {
                continue
            }
            let filePath = fileURL.resolvingSymlinksInPath().standardizedFileURL.path
            let relativePath: String
            if filePath == rootPath {
                relativePath = fileURL.lastPathComponent
            } else if filePath.hasPrefix(rootPath + "/") {
                relativePath = String(filePath.dropFirst(rootPath.count + 1))
            } else {
                relativePath = fileURL.lastPathComponent
            }
            results.append(TreeEntry(path: relativePath, size: UInt64(values.fileSize ?? 0)))
        }
        return results.sorted { $0.path < $1.path }
    }

    private func hasGlobalFunction(_ name: String, on engine: JSEngine) -> Bool {
        guard let function = engine.context.globalObject.forProperty(name) else {
            return false
        }

        return !function.isUndefined
    }

    private func ensureParentDirectoryExists(for url: URL) throws {
        try fileManager.createDirectory(
            at: url.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
    }

    private func resolveFileURL(rootKey: String, relativePath: String) -> URL? {
        let rootURL = resolveRootURL(rootKey: rootKey)
        let candidate = rootURL.appendingPathComponent(relativePath, isDirectory: false).standardizedFileURL
        let rootPath = rootURL.standardizedFileURL.path
        let candidatePath = candidate.path

        if candidatePath == rootPath || candidatePath.hasPrefix(rootPath + "/") {
            return candidate
        }

        return nil
    }

    private func resolveRootURL(rootKey: String) -> URL {
        let resolvedKey: String
        if rootKey.isEmpty || rootKey == "default" {
            resolvedKey = defaultRootKey
        } else {
            resolvedKey = rootKey
        }

        return baseDirectory.appendingPathComponent(resolvedKey, isDirectory: true).standardizedFileURL
    }
}

private extension Data {
    var hexString: String {
        map { String(format: "%02x", $0) }.joined()
    }

    mutating func appendUInt8(_ value: UInt8) {
        append(value)
    }

    mutating func appendUInt32LE(_ value: UInt32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { buffer in
            append(buffer.bindMemory(to: UInt8.self))
        }
    }

    mutating func appendInt32LE(_ value: Int32) {
        var littleEndian = value.littleEndian
        Swift.withUnsafeBytes(of: &littleEndian) { buffer in
            append(buffer.bindMemory(to: UInt8.self))
        }
    }
}
