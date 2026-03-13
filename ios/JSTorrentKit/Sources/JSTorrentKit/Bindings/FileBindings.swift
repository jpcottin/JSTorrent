import CryptoKit
import Foundation

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

public final class FileBindings {
    private let fileManager: FileManager
    private let baseDirectory: URL
    private let defaultRootKey: String

    public init(
        baseDirectory: URL,
        defaultRootKey: String = "default",
        fileManager: FileManager = .default
    ) {
        self.baseDirectory = baseDirectory.standardizedFileURL
        self.defaultRootKey = defaultRootKey
        self.fileManager = fileManager
    }

    public func register(on engine: JSEngine) {
        registerReadWrite(on: engine)
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
            guard length > 0, let fileURL = self.resolveFileURL(rootKey: rootKey, relativePath: path) else {
                return .binary(Data())
            }

            do {
                guard self.fileManager.fileExists(atPath: fileURL.path) else {
                    return .binary(Data())
                }

                let handle = try FileHandle(forReadingFrom: fileURL)
                defer { try? handle.close() }
                try handle.seek(toOffset: offset)
                let data = try handle.read(upToCount: length) ?? Data()
                return .binary(data)
            } catch {
                return .binary(Data())
            }
        }

        engine.setGlobalFunction("__jstorrent_file_write") { [weak engine] arguments in
            guard
                let engine,
                let rootKey = arguments.first?.toString(),
                let path = arguments.dropFirst().first?.toString(),
                let fileURL = self.resolveFileURL(rootKey: rootKey, relativePath: path),
                let data = try engine.data(from: arguments.dropFirst(3).first)
            else {
                return .value(-1)
            }

            let offset = UInt64(max(arguments.dropFirst(2).first?.toInt32() ?? 0, 0))

            do {
                try self.ensureParentDirectoryExists(for: fileURL)
                if !self.fileManager.fileExists(atPath: fileURL.path) {
                    self.fileManager.createFile(atPath: fileURL.path, contents: nil)
                }
                let handle = try FileHandle(forUpdating: fileURL)
                defer { try? handle.close() }
                try handle.seek(toOffset: offset)
                try handle.write(contentsOf: data)
                try handle.synchronize()
                return .value(data.count)
            } catch {
                return .value(-1)
            }
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
            guard
                bytesFromFile > 0,
                let fileURL = resolveFileURL(rootKey: rootKey, relativePath: file.path)
            else {
                throw CocoaError(.fileNoSuchFile)
            }

            let handle = try FileHandle(forReadingFrom: fileURL)
            defer { try? handle.close() }
            try handle.seek(toOffset: UInt64(remainingOffset))
            let data = try handle.read(upToCount: bytesFromFile) ?? Data()
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
