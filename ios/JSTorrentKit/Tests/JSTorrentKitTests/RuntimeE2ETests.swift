import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import JSTorrentKit

final class RuntimeE2ETests: XCTestCase {
    private final class LogCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [String] = []

        func append(level: String, message: String) {
            lock.lock()
            entries.append("[\(level)] \(message)")
            if entries.count > 200 {
                entries.removeFirst(entries.count - 200)
            }
            lock.unlock()
        }

        func tail(_ count: Int = 40) -> String {
            lock.lock()
            let snapshot = entries.suffix(count)
            lock.unlock()
            return snapshot.joined(separator: "\n")
        }
    }

    private final class SeederProcess {
        let process: Process
        private let outputPipe: Pipe
        private let lock = NSLock()
        private var buffer = ""

        init(process: Process, outputPipe: Pipe) {
            self.process = process
            self.outputPipe = outputPipe

            outputPipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
                let data = handle.availableData
                guard let self, !data.isEmpty, let chunk = String(data: data, encoding: .utf8) else {
                    return
                }
                self.lock.lock()
                self.buffer.append(chunk)
                self.lock.unlock()
            }
        }

        deinit {
            outputPipe.fileHandleForReading.readabilityHandler = nil
        }

        func output() -> String {
            lock.lock()
            let snapshot = buffer
            lock.unlock()
            return snapshot
        }

        func value(for key: String) -> String? {
            let prefix = "\(key)="
            return output()
                .split(separator: "\n", omittingEmptySubsequences: false)
                .compactMap { line -> String? in
                    guard line.hasPrefix(prefix) else {
                        return nil
                    }
                    return String(line.dropFirst(prefix.count))
                }
                .last
        }

        func stop() {
            outputPipe.fileHandleForReading.readabilityHandler = nil

            guard process.isRunning else {
                return
            }

            process.terminate()
            process.waitUntilExit()
        }
    }

    private func repositoryRootURL() -> URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private func commandExists(_ command: String) -> Bool {
        let process = Process()
        let output = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["which", command]
        process.standardOutput = output
        process.standardError = output

        do {
            try process.run()
            process.waitUntilExit()
            return process.terminationStatus == 0
        } catch {
            return false
        }
    }

    private func startSeeder(
        additionalArguments: [String],
        timeout: TimeInterval = 20.0
    ) throws -> SeederProcess {
        guard commandExists("uv") else {
            throw XCTSkip("Skipping e2e seeder test because `uv` is not available")
        }

        let pythonDir = repositoryRootURL().appendingPathComponent("packages/engine/integration/python")
        let process = Process()
        let outputPipe = Pipe()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.currentDirectoryURL = pythonDir
        process.arguments = ["uv", "run", "python", "-u", "seed_for_test.py"] + additionalArguments
        process.standardOutput = outputPipe
        process.standardError = outputPipe

        try process.run()
        let seeder = SeederProcess(process: process, outputPipe: outputPipe)

        try waitUntil(timeout: timeout, pollInterval: 0.05) {
            if let port = seeder.value(for: "PORT"), tcpPortIsOpen(host: "127.0.0.1", port: Int(port) ?? 0) {
                return true
            }

            if !process.isRunning {
                XCTFail("Seeder exited early:\n\(seeder.output())")
                return true
            }

            return false
        }

        guard process.isRunning else {
            throw XCTSkip("Seeder failed to stay running:\n\(seeder.output())")
        }

        return seeder
    }

    private func makeRuntimeEnvironment(
        logCapture: LogCapture
    ) throws -> (runtime: JSTorrentRuntime, baseDirectory: URL, userDefaults: UserDefaults, suiteName: String) {
        let suiteName = "JSTorrentKitE2E.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            throw XCTSkip("Failed to create isolated UserDefaults suite")
        }

        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let runtime = try JSTorrentRuntime(
            userDefaults: userDefaults,
            fileBaseDirectory: baseDirectory,
            defaultRootKey: "default",
            logHandler: { level, message in
                logCapture.append(level: level, message: message)
            }
        )

        return (runtime, baseDirectory, userDefaults, suiteName)
    }

    private func waitUntil(
        timeout: TimeInterval = 5.0,
        pollInterval: TimeInterval = 0.02,
        condition: () throws -> Bool
    ) throws {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if try condition() {
                return
            }

            RunLoop.current.run(until: Date().addingTimeInterval(pollInterval))
        }

        XCTFail("Timed out waiting for condition")
    }

    private func sha1Hex(for url: URL) throws -> String {
        let data = try Data(contentsOf: url)
        return Insecure.SHA1.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private func tcpPortIsOpen(host: String, port: Int) -> Bool {
        guard !host.isEmpty, (1...Int(UInt16.max)).contains(port) else {
            return false
        }

        let socketFD = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socketFD >= 0 else {
            return false
        }
        defer {
            Darwin.close(socketFD)
        }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        let conversionResult = host.withCString { inet_pton(AF_INET, $0, &address.sin_addr) }
        guard conversionResult == 1 else {
            return false
        }

        let originalFlags = fcntl(socketFD, F_GETFL, 0)
        _ = fcntl(socketFD, F_SETFL, originalFlags | O_NONBLOCK)

        let connectResult = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                Darwin.connect(socketFD, pointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if connectResult == 0 {
            return true
        }

        guard errno == EINPROGRESS else {
            return false
        }

        var pollDescriptor = pollfd(fd: socketFD, events: Int16(POLLOUT), revents: 0)
        let pollResult = Darwin.poll(&pollDescriptor, 1, 100)
        guard pollResult > 0, (pollDescriptor.revents & Int16(POLLOUT)) != 0 else {
            return false
        }

        var socketError: Int32 = 0
        var socketErrorLength = socklen_t(MemoryLayout<Int32>.size)
        let getSockOptResult = withUnsafeMutablePointer(to: &socketError) { pointer in
            getsockopt(socketFD, SOL_SOCKET, SO_ERROR, pointer, &socketErrorLength)
        }
        return getSockOptResult == 0 && socketError == 0
    }

    private func debugSnapshot(
        runtime: JSTorrentRuntime,
        infoHash: String,
        logs: LogCapture,
        seeder: SeederProcess
    ) -> String {
        var sections: [String] = []

        if let torrents = try? runtime.queryTorrentList().torrents {
            let summaries = torrents.map {
                "\($0.infoHash) status=\($0.status) progress=\($0.progress) peers=\($0.numPeers) down=\($0.downloadSpeed)"
            }
            sections.append("Torrents:\n" + summaries.joined(separator: "\n"))
        }

        if let trackers = try? runtime.queryTrackers(infoHash).trackers {
            let trackerSummary = trackers.map {
                "\($0.url) status=\($0.status) peers=\($0.lastPeersReceived ?? -1) error=\($0.lastError ?? "-")"
            }
            sections.append("Trackers:\n" + trackerSummary.joined(separator: "\n"))
        }

        if let peers = try? runtime.queryPeers(infoHash).peers {
            let peerSummary = peers.prefix(10).map {
                "\($0.ip):\($0.port) state=\($0.state) down=\($0.downloadSpeed) up=\($0.uploadSpeed) " +
                "progress=\($0.progress) pending=\($0.requestsPending ?? -1) " +
                "amInterested=\($0.amInterested) peerChoking=\($0.peerChoking) " +
                "peerInterested=\($0.peerInterested) amChoking=\($0.amChoking)"
            }
            sections.append("Peers:\n" + peerSummary.joined(separator: "\n"))
        }

        if let details = try? runtime.queryDetails(infoHash) {
            sections.append(
                "Details:\nsize=\(details.totalSize) pieceSize=\(details.pieceSize) rootKey=\(details.rootKey ?? "-")"
            )
        }

        if
            let piecesJSON = try? runtime.engine.evaluate(
                "__jstorrent_query_pieces(\(String(reflecting: infoHash)))",
                filename: "runtime-e2e-pieces-raw.js"
            )?.toString(),
            !piecesJSON.isEmpty
        {
            sections.append("Pieces raw:\n" + piecesJSON)
        }

        if
            let engineStatsJSON = try? runtime.engine.evaluate(
                "__jstorrent_query_engine_stats()",
                filename: "runtime-e2e-engine-stats.js"
            )?.toString(),
            !engineStatsJSON.isEmpty
        {
            sections.append("Engine stats:\n" + engineStatsJSON)
        }

        if
            let fileCallbackDebugJSON = try? runtime.engine.evaluate(
                """
                JSON.stringify({
                  hasDispatchBatch: typeof __jstorrent_file_dispatch_batch,
                  hasReadDispatchBatch: typeof __jstorrent_file_dispatch_read_batch,
                  hasWriteCallbackRegistry: typeof __jstorrent_file_write_callbacks,
                  hasReadCallbackRegistry: typeof __jstorrent_file_read_callbacks,
                  pendingWriteCallbacks: typeof __jstorrent_file_write_callbacks === "object"
                    ? Object.keys(__jstorrent_file_write_callbacks).length
                    : -1,
                  pendingReadCallbacks: typeof __jstorrent_file_read_callbacks === "object"
                    ? Object.keys(__jstorrent_file_read_callbacks).length
                    : -1
                })
                """,
                filename: "runtime-e2e-file-callback-debug.js"
            )?.toString(),
            !fileCallbackDebugJSON.isEmpty
        {
            sections.append("File callback debug:\n" + fileCallbackDebugJSON)
        }

        if
            let swarmDebugJSON = try? runtime.engine.evaluate(
                "__jstorrent_query_swarm_debug(\(String(reflecting: infoHash)))",
                filename: "runtime-e2e-swarm-debug.js"
            )?.toString(),
            !swarmDebugJSON.isEmpty
        {
            sections.append("Swarm debug:\n" + swarmDebugJSON)
        }

        let logTail = logs.tail(120)
        if !logTail.isEmpty {
            sections.append("Engine logs:\n" + logTail)
        }

        let seederOutput = seeder.output()
        if !seederOutput.isEmpty {
            sections.append("Seeder output:\n" + seederOutput)
        }

        return sections.joined(separator: "\n\n")
    }

    func testRuntimeCompletesSmallDownloadFromLocalSeeder() throws {
        let sourceDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)
        defer {
            try? FileManager.default.removeItem(at: sourceDirectory)
        }

        let sourceFileURL = sourceDirectory.appendingPathComponent("runtime-e2e.bin")
        let payload = Data((0..<(512 * 1024)).map { UInt8($0 % 251) })
        try payload.write(to: sourceFileURL)
        let expectedSHA1 = try sha1Hex(for: sourceFileURL)

        let seeder = try startSeeder(
            additionalArguments: [
                "--file", sourceFileURL.path,
                "--host", "127.0.0.1",
                "--port", "16881",
                "--quiet",
            ]
        )
        defer {
            seeder.stop()
        }

        try waitUntil(timeout: 10.0, pollInterval: 0.05) {
            seeder.value(for: "INFOHASH") != nil && seeder.value(for: "MAGNET_LOCALHOST") != nil
        }

        let infoHash = try XCTUnwrap(seeder.value(for: "INFOHASH"))
        let magnet = try XCTUnwrap(seeder.value(for: "MAGNET_LOCALHOST"))

        let logs = LogCapture()
        let (runtime, baseDirectory, userDefaults, suiteName) = try makeRuntimeEnvironment(logCapture: logs)
        defer {
            try? runtime.shutdown()
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        let bundleURL = repositoryRootURL().appendingPathComponent("packages/engine/dist/engine.native.js")
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundleURL.path))

        try runtime.loadBundle(from: bundleURL)
        _ = try runtime.engine.evaluate(
            """
            __jstorrent_cmd_set_log_level(
              "debug",
              JSON.stringify([
                "client",
                "torrent",
                "peer",
                "peer-handler",
                "piece-requester",
                "tick-loop",
                "tracker-manager",
                "udp-tracker",
                "http-tracker"
              ])
            );
            """,
            filename: "runtime-e2e-log-level.js"
        )
        try runtime.initialize(
            with: EngineBootstrapConfig(
                contentRoots: [ContentRoot(key: "default", label: "Default")],
                defaultContentRoot: "default",
                shouldRemainSuspended: false
            )
        )

        try waitUntil(timeout: 2.0) {
            try runtime.isInitialized()
        }

        try runtime.setTickMode(.host)
        try runtime.subscribe(type: "torrents", hash: "", intervalMs: 50)
        try runtime.addTorrent(magnet)

        try waitUntil(timeout: 5.0) {
            _ = try runtime.tick()
            let torrents = try runtime.queryTorrentList().torrents ?? []
            return torrents.contains(where: { $0.infoHash == infoHash })
        }

        let completionDeadline = Date().addingTimeInterval(30.0)
        var completed = false
        while Date() < completionDeadline {
            _ = try runtime.tick()
            let torrent = try runtime.queryTorrentList().torrents?.first(where: { $0.infoHash == infoHash })
            if let torrent, torrent.progress >= 0.99 {
                completed = true
                break
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.02))
        }

        if !completed {
            XCTFail(
                "Timed out waiting for local-seeder download to complete.\n\n" +
                debugSnapshot(runtime: runtime, infoHash: infoHash, logs: logs, seeder: seeder)
            )
            return
        }

        let downloadedURL = baseDirectory.appendingPathComponent(sourceFileURL.lastPathComponent)
        XCTAssertTrue(
            FileManager.default.fileExists(atPath: downloadedURL.path),
            "Expected downloaded file at \(downloadedURL.path)"
        )
        XCTAssertEqual(try sha1Hex(for: downloadedURL), expectedSHA1)
    }
}
