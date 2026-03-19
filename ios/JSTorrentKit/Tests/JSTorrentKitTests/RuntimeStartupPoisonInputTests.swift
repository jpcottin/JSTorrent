import Foundation
import XCTest
@testable import JSTorrentKit

final class RuntimeStartupPoisonInputTests: XCTestCase {
    private final class LogCapture: @unchecked Sendable {
        private let lock = NSLock()
        private var entries: [(String, String)] = []

        func append(level: String, message: String) {
            lock.lock()
            entries.append((level, message))
            lock.unlock()
        }

        func messages() -> [String] {
            lock.lock()
            let snapshot = entries.map(\.1)
            lock.unlock()
            return snapshot
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

    private func waitUntil(
        timeout: TimeInterval = 2.0,
        pollInterval: TimeInterval = 0.01,
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

    private func makeRuntimeEnvironment(
        logCapture: LogCapture? = nil
    ) throws -> (runtime: JSTorrentRuntime, sink: NativeEventSink, userDefaults: UserDefaults, suiteName: String, baseDirectory: URL) {
        let suiteName = "JSTorrentKitTests.\(UUID().uuidString)"
        guard let userDefaults = UserDefaults(suiteName: suiteName) else {
            throw XCTSkip("Failed to create isolated UserDefaults suite")
        }

        let baseDirectory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: baseDirectory, withIntermediateDirectories: true)

        let sink = NativeEventSink()
        let runtime = try JSTorrentRuntime(
            eventSink: sink,
            userDefaults: userDefaults,
            fileBaseDirectory: baseDirectory,
            defaultRootKey: "default",
            logHandler: { level, message in
                logCapture?.append(level: level, message: message)
            }
        )

        return (runtime, sink, userDefaults, suiteName, baseDirectory)
    }

    private func prepareRealRuntime(
        runtime: JSTorrentRuntime
    ) throws {
        let bundleURL = repositoryRootURL()
            .appendingPathComponent("packages/engine/dist/engine.native.js")
        XCTAssertTrue(FileManager.default.fileExists(atPath: bundleURL.path))

        // Simulate older JavaScriptCore where the JS polyfill installs.
        _ = try runtime.engine.evaluate(
            """
            delete globalThis.atob;
            delete globalThis.btoa;
            """,
            filename: "force-base64-polyfill-test.js"
        )

        try runtime.loadBundle(from: bundleURL)
        try runtime.initialize(
            with: EngineBootstrapConfig(
                contentRoots: [ContentRoot(key: "default", label: "Default")],
                defaultContentRoot: "default",
                shouldRemainSuspended: true
            )
        )

        try waitUntil {
            try runtime.isInitialized()
        }
    }

    func testPoisonedPersistedTorrentBase64DoesNotFailRuntimeInitialization() throws {
        let logs = LogCapture()
        let env = try makeRuntimeEnvironment(logCapture: logs)
        defer {
            try? FileManager.default.removeItem(at: env.baseDirectory)
            env.userDefaults.removePersistentDomain(forName: env.suiteName)
        }

        env.userDefaults.set(
            """
            {"version":2,"torrents":[{"infoHash":"abababababababababababababababababababab","source":"file","addedAt":1702300000000}]}
            """,
            forKey: "session:torrents"
        )
        env.userDefaults.set(
            "\"$$$\"",
            forKey: "session:torrent:abababababababababababababababababababab:torrentfile"
        )

        try prepareRealRuntime(runtime: env.runtime)
        try env.runtime.setTickMode(.host)

        let payload = try env.runtime.queryTorrentList()

        XCTAssertEqual(payload.torrents?.count ?? 0, 0)
        XCTAssertTrue(env.sink.errors.isEmpty)
        XCTAssertFalse(logs.messages().contains { $0.contains("Failed to initialize engine") })
    }

    func testInvalidAddPayloadEmitsUnsupportedInputError() throws {
        let env = try makeRuntimeEnvironment()
        defer {
            try? FileManager.default.removeItem(at: env.baseDirectory)
            env.userDefaults.removePersistentDomain(forName: env.suiteName)
        }

        try prepareRealRuntime(runtime: env.runtime)

        try env.runtime.addTorrent("$$$")

        let errorPayload = try XCTUnwrap(env.sink.errors.first)
        XCTAssertTrue(errorPayload.contains("Unsupported torrent input"))
        XCTAssertFalse(errorPayload.contains("atob: Invalid base64 character"))
    }

    func testRemoteTorrentURLEmitsFriendlyErrorInsteadOfAtob() throws {
        let env = try makeRuntimeEnvironment()
        defer {
            try? FileManager.default.removeItem(at: env.baseDirectory)
            env.userDefaults.removePersistentDomain(forName: env.suiteName)
        }

        try prepareRealRuntime(runtime: env.runtime)

        try env.runtime.addTorrent("https://webtorrent.io/torrents/big-buck-bunny.torrent")

        let errorPayload = try XCTUnwrap(env.sink.errors.first)
        XCTAssertTrue(errorPayload.contains("Remote torrent URLs are not supported here"))
        XCTAssertFalse(errorPayload.contains("atob: Invalid base64 character"))
    }

    func testInvalidTorrentBytesDoNotEmitAtobError() throws {
        let env = try makeRuntimeEnvironment()
        defer {
            try? FileManager.default.removeItem(at: env.baseDirectory)
            env.userDefaults.removePersistentDomain(forName: env.suiteName)
        }

        try prepareRealRuntime(runtime: env.runtime)

        let invalidTorrentBase64 = Data("not a torrent".utf8).base64EncodedString()
        try env.runtime.addTorrent(invalidTorrentBase64)

        let errorPayload = try XCTUnwrap(env.sink.errors.first)
        XCTAssertFalse(errorPayload.contains("atob: Invalid base64 character"))
    }
}
