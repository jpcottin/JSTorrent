import CryptoKit
import Darwin
import Foundation
import XCTest
@testable import JSTorrentKit

final class RuntimePerformanceBenchmarkTests: XCTestCase {
    private struct BenchmarkConfiguration {
        let fileSizeMB: Int
        let pieceLength: Int
        let recheckIterations: Int
        let timeout: TimeInterval
        let pollInterval: TimeInterval

        init(environment: [String: String]) {
            fileSizeMB = max(1, Int(environment["JSTORRENT_BENCHMARK_SIZE_MB"] ?? "") ?? 64)
            pieceLength = max(16 * 1024, Int(environment["JSTORRENT_BENCHMARK_PIECE_LENGTH"] ?? "") ?? (256 * 1024))
            recheckIterations = max(1, Int(environment["JSTORRENT_BENCHMARK_RECHECK_ITERATIONS"] ?? "") ?? 3)
            timeout = max(30, Double(environment["JSTORRENT_BENCHMARK_TIMEOUT_SECONDS"] ?? "") ?? 240)
            pollInterval = 0.01
        }
    }

    private struct DownloadBenchmarkReport: Encodable {
        let name: String
        let storageMode: String
        let fileSizeBytes: Int64
        let pieceLength: Int
        let elapsedSeconds: Double
        let throughputMBps: Double
        let peakTorrentDownloadBps: Int
        let tickCount: Int
        let averageTickElapsedMs: Double
        let maxTickElapsedMs: Int32
        let engineStats: String
    }

    private struct RecheckBenchmarkReport: Encodable {
        let name: String
        let fileSizeBytes: Int64
        let pieceLength: Int
        let iterations: Int
        let iterationSeconds: [Double]
        let averageSeconds: Double
        let maxSeconds: Double
        let engineStats: String
    }

    private struct TickAccumulator {
        var count = 0
        var totalElapsedMs = 0.0
        var maxElapsedMs: Int32 = 0

        mutating func record(_ tick: EngineTickResult) {
            count += 1
            totalElapsedMs += Double(tick.elapsedMs)
            maxElapsedMs = max(maxElapsedMs, tick.elapsedMs)
        }

        var averageElapsedMs: Double {
            guard count > 0 else {
                return 0
            }
            return totalElapsedMs / Double(count)
        }
    }

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

    private final class RuntimeHarness {
        let runtime: JSTorrentRuntime
        let baseDirectory: URL
        let userDefaults: UserDefaults
        let suiteName: String
        let logs: LogCapture

        init(storageMode: NativeStorageMode) throws {
            logs = LogCapture()
            suiteName = "JSTorrentKitPerf.\(UUID().uuidString)"
            guard let userDefaults = UserDefaults(suiteName: suiteName) else {
                throw XCTSkip("Failed to create isolated UserDefaults suite")
            }
            self.userDefaults = userDefaults

            baseDirectory = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString, isDirectory: true)
            try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

            runtime = try JSTorrentRuntime(
                userDefaults: userDefaults,
                fileBaseDirectory: baseDirectory,
                defaultRootKey: "default",
                logHandler: { [logs] level, message in
                    logs.append(level: level, message: message)
                }
            )

            let bundleURL = Self.repositoryRootURL()
                .appendingPathComponent("packages/engine/dist/engine.native.js")
            guard FileManager.default.fileExists(atPath: bundleURL.path) else {
                throw XCTSkip("Missing engine bundle at \(bundleURL.path)")
            }

            try runtime.loadBundle(from: bundleURL)
             try runtime.initialize(
                 with: EngineBootstrapConfig(
                     contentRoots: [ContentRoot(key: "default", label: "Default", path: baseDirectory.path)],
                    defaultContentRoot: "default",
                     storageMode: storageMode,
                     shouldRemainSuspended: false
                 )
             )
        }

        deinit {
            try? runtime.shutdown()
            try? FileManager.default.removeItem(at: baseDirectory)
            userDefaults.removePersistentDomain(forName: suiteName)
        }

        private static func repositoryRootURL() -> URL {
            URL(fileURLWithPath: #filePath)
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
        }
    }

    private struct DownloadFixture {
        let sourceFileURL: URL
        let expectedSHA1: String
        let seeder: SeederProcess
        let magnet: String
        let infoHash: String
    }

    override func setUpWithError() throws {
        try super.setUpWithError()
        try requireBenchmarksEnabled()
    }

    func testDownloadThroughputNativeStorage() throws {
        let configuration = BenchmarkConfiguration(environment: ProcessInfo.processInfo.environment)
        let fixture = try makeDownloadFixture(configuration: configuration, label: "native")
        defer {
            fixture.seeder.stop()
            try? FileManager.default.removeItem(at: fixture.sourceFileURL.deletingLastPathComponent())
        }

        let harness = try RuntimeHarness(storageMode: .native)
        let report = try runDownloadBenchmark(
            name: "download_throughput_native_storage",
            storageMode: .native,
            harness: harness,
            fixture: fixture,
            configuration: configuration
        )

        let downloadedURL = harness.baseDirectory.appendingPathComponent(fixture.sourceFileURL.lastPathComponent)
        XCTAssertTrue(FileManager.default.fileExists(atPath: downloadedURL.path))
        XCTAssertEqual(try sha1Hex(for: downloadedURL), fixture.expectedSHA1)
        emit(report)
    }

    func testDownloadThroughputNullStorageBaseline() throws {
        let configuration = BenchmarkConfiguration(environment: ProcessInfo.processInfo.environment)
        let fixture = try makeDownloadFixture(configuration: configuration, label: "null")
        defer {
            fixture.seeder.stop()
            try? FileManager.default.removeItem(at: fixture.sourceFileURL.deletingLastPathComponent())
        }

        let harness = try RuntimeHarness(storageMode: .null)
        let report = try runDownloadBenchmark(
            name: "download_throughput_null_storage_baseline",
            storageMode: .null,
            harness: harness,
            fixture: fixture,
            configuration: configuration
        )

        emit(report)
    }

    func testNativeStorageRecheckPerformance() throws {
        let configuration = BenchmarkConfiguration(environment: ProcessInfo.processInfo.environment)
        let fixture = try makeDownloadFixture(configuration: configuration, label: "recheck")
        defer {
            fixture.seeder.stop()
            try? FileManager.default.removeItem(at: fixture.sourceFileURL.deletingLastPathComponent())
        }

        let harness = try RuntimeHarness(storageMode: .native)
        _ = try runDownloadBenchmark(
            name: "download_setup_for_recheck",
            storageMode: .native,
            harness: harness,
            fixture: fixture,
            configuration: configuration
        )

        let report = try runRecheckBenchmark(
            harness: harness,
            infoHash: fixture.infoHash,
            fileSizeBytes: fileSize(of: fixture.sourceFileURL),
            pieceLength: configuration.pieceLength,
            iterations: configuration.recheckIterations,
            timeout: configuration.timeout
        )

        let downloadedURL = harness.baseDirectory.appendingPathComponent(fixture.sourceFileURL.lastPathComponent)
        XCTAssertEqual(try sha1Hex(for: downloadedURL), fixture.expectedSHA1)
        emit(report)
    }

    private func requireBenchmarksEnabled() throws {
        let environment = ProcessInfo.processInfo.environment
        guard environment["JSTORRENT_ENABLE_PERF_BENCHMARKS"] == "1" else {
            throw XCTSkip(
                """
                Manual benchmark suite. Set JSTORRENT_ENABLE_PERF_BENCHMARKS=1 to run.
                Optional overrides: JSTORRENT_BENCHMARK_SIZE_MB, JSTORRENT_BENCHMARK_PIECE_LENGTH, JSTORRENT_BENCHMARK_RECHECK_ITERATIONS, JSTORRENT_BENCHMARK_TIMEOUT_SECONDS.
                """
            )
        }
    }

    private func makeDownloadFixture(
        configuration: BenchmarkConfiguration,
        label: String
    ) throws -> DownloadFixture {
        let sourceDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent("jstorrent-perf-\(label)-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: sourceDirectory, withIntermediateDirectories: true)

        let sourceFileURL = sourceDirectory.appendingPathComponent("testdata_\(configuration.fileSizeMB)mb.bin")
        try writeDeterministicFile(to: sourceFileURL, sizeBytes: configuration.fileSizeMB * 1024 * 1024)
        let expectedSHA1 = try sha1Hex(for: sourceFileURL)

        let port = try unusedTCPPort()
        let seeder = try startSeeder(
            additionalArguments: [
                "--file", sourceFileURL.path,
                "--piece-length", String(configuration.pieceLength),
                "--host", "127.0.0.1",
                "--port", String(port),
                "--quiet",
            ],
            timeout: 30
        )

        try waitUntil(timeout: 10, pollInterval: 0.05) {
            seeder.value(for: "INFOHASH") != nil && seeder.value(for: "MAGNET_LOCALHOST") != nil
        }

        return DownloadFixture(
            sourceFileURL: sourceFileURL,
            expectedSHA1: expectedSHA1,
            seeder: seeder,
            magnet: try XCTUnwrap(seeder.value(for: "MAGNET_LOCALHOST")),
            infoHash: try XCTUnwrap(seeder.value(for: "INFOHASH"))
        )
    }

    private func runDownloadBenchmark(
        name: String,
        storageMode: NativeStorageMode,
        harness: RuntimeHarness,
        fixture: DownloadFixture,
        configuration: BenchmarkConfiguration
    ) throws -> DownloadBenchmarkReport {
        try waitUntil(timeout: 5, pollInterval: configuration.pollInterval) {
            try harness.runtime.isInitialized()
        }

        try harness.runtime.setTickMode(.host)
        try harness.runtime.subscribe(type: "torrents", hash: "", intervalMs: 50)

        let start = CFAbsoluteTimeGetCurrent()
        try harness.runtime.addTorrent(fixture.magnet)

        try waitUntil(timeout: 10, pollInterval: configuration.pollInterval) {
            _ = try harness.runtime.tick()
            let torrents = try harness.runtime.queryTorrentList().torrents ?? []
            return torrents.contains(where: { $0.infoHash == fixture.infoHash })
        }

        let completionDeadline = Date().addingTimeInterval(configuration.timeout)
        var peakDownloadSpeed = 0
        var ticks = TickAccumulator()

        while Date() < completionDeadline {
            let tick = try harness.runtime.tick()
            ticks.record(tick)

            if let torrent = try harness.runtime.queryTorrentList().torrents?.first(where: { $0.infoHash == fixture.infoHash }) {
                peakDownloadSpeed = max(peakDownloadSpeed, torrent.downloadSpeed)
                if torrent.progress >= 0.999 || torrent.status == "seeding" || torrent.status == "done" {
                    let elapsedSeconds = CFAbsoluteTimeGetCurrent() - start
                    let fileSizeBytes = fileSize(of: fixture.sourceFileURL)
                    return DownloadBenchmarkReport(
                        name: name,
                        storageMode: storageMode.rawValue,
                        fileSizeBytes: fileSizeBytes,
                        pieceLength: configuration.pieceLength,
                        elapsedSeconds: elapsedSeconds,
                        throughputMBps: throughputMBps(bytes: fileSizeBytes, seconds: elapsedSeconds),
                        peakTorrentDownloadBps: peakDownloadSpeed,
                        tickCount: ticks.count,
                        averageTickElapsedMs: ticks.averageElapsedMs,
                        maxTickElapsedMs: ticks.maxElapsedMs,
                        engineStats: try engineStatsJSON(runtime: harness.runtime)
                    )
                }
            }

            RunLoop.current.run(until: Date().addingTimeInterval(configuration.pollInterval))
        }

        XCTFail(
            """
            Timed out waiting for torrent benchmark \(name) to complete.

            Seeder:
            \(fixture.seeder.output())

            Logs:
            \(harness.logs.tail(120))
            """
        )
        throw XCTSkip("Benchmark \(name) did not complete")
    }

    private func runRecheckBenchmark(
        harness: RuntimeHarness,
        infoHash: String,
        fileSizeBytes: Int64,
        pieceLength: Int,
        iterations: Int,
        timeout: TimeInterval
    ) throws -> RecheckBenchmarkReport {
        let infoHashLiteral = try jsonLiteral(infoHash)
        var iterationSeconds: [Double] = []

        for _ in 0..<iterations {
            let start = CFAbsoluteTimeGetCurrent()
            _ = try harness.runtime.engine.awaitPromise(
                expression: "__jstorrent_cmd_recheck(\(infoHashLiteral))",
                timeout: timeout,
                filename: "runtime-perf-recheck.js"
            )
            let elapsed = CFAbsoluteTimeGetCurrent() - start
            iterationSeconds.append(elapsed)

            let torrent = try XCTUnwrap(
                try harness.runtime.queryTorrentList().torrents?.first(where: { $0.infoHash == infoHash })
            )
            XCTAssertGreaterThanOrEqual(torrent.progress, 0.999)
        }

        let average = iterationSeconds.reduce(0, +) / Double(iterationSeconds.count)
        return RecheckBenchmarkReport(
            name: "native_storage_recheck",
            fileSizeBytes: fileSizeBytes,
            pieceLength: pieceLength,
            iterations: iterations,
            iterationSeconds: iterationSeconds,
            averageSeconds: average,
            maxSeconds: iterationSeconds.max() ?? 0,
            engineStats: try engineStatsJSON(runtime: harness.runtime)
        )
    }

    private func startSeeder(
        additionalArguments: [String],
        timeout: TimeInterval
    ) throws -> SeederProcess {
        guard commandExists("uv") else {
            throw XCTSkip("Skipping benchmark because `uv` is not available")
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

    private func writeDeterministicFile(to url: URL, sizeBytes: Int) throws {
        FileManager.default.createFile(atPath: url.path, contents: nil)
        let handle = try FileHandle(forWritingTo: url)
        defer { try? handle.close() }

        let chunkSize = 1 * 1024 * 1024
        var offset = 0
        while offset < sizeBytes {
            let bytesToWrite = min(chunkSize, sizeBytes - offset)
            var chunk = Data(count: bytesToWrite)
            chunk.withUnsafeMutableBytes { rawBuffer in
                guard let buffer = rawBuffer.bindMemory(to: UInt8.self).baseAddress else {
                    return
                }
                for index in 0..<bytesToWrite {
                    buffer[index] = UInt8((offset + index) % 251)
                }
            }
            try handle.write(contentsOf: chunk)
            offset += bytesToWrite
        }
    }

    private func waitUntil(
        timeout: TimeInterval,
        pollInterval: TimeInterval,
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

    private func engineStatsJSON(runtime: JSTorrentRuntime) throws -> String {
        try runtime.engine.evaluate(
            "__jstorrent_query_engine_stats()",
            filename: "runtime-perf-engine-stats.js"
        )?.toString() ?? "{}"
    }

    private func emit<T: Encodable>(_ report: T) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        if let data = try? encoder.encode(report), let json = String(data: data, encoding: .utf8) {
            print("JSTorrentBenchmark \(json)")
        }
    }

    private func throughputMBps(bytes: Int64, seconds: Double) -> Double {
        guard seconds > 0 else {
            return 0
        }
        return (Double(bytes) / 1024.0 / 1024.0) / seconds
    }

    private func fileSize(of url: URL) -> Int64 {
        Int64((try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0)
    }

    private func sha1Hex(for url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }

        var hasher = Insecure.SHA1()
        while true {
            let data = try handle.read(upToCount: 1 * 1024 * 1024) ?? Data()
            if data.isEmpty {
                break
            }
            hasher.update(data: data)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }

    private func jsonLiteral<T: Encodable>(_ value: T) throws -> String {
        let data = try JSONEncoder().encode(value)
        return String(decoding: data, as: UTF8.self)
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

    private func unusedTCPPort() throws -> Int {
        let socketFD = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        guard socketFD >= 0 else {
            throw POSIXError(.EADDRNOTAVAIL)
        }
        defer {
            Darwin.close(socketFD)
        }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(0).bigEndian
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                Darwin.bind(socketFD, pointer, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EADDRNOTAVAIL)
        }

        var boundAddress = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &boundAddress) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { pointer in
                getsockname(socketFD, pointer, &length)
            }
        }
        guard nameResult == 0 else {
            throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EADDRNOTAVAIL)
        }

        return Int(UInt16(bigEndian: boundAddress.sin_port))
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
}
