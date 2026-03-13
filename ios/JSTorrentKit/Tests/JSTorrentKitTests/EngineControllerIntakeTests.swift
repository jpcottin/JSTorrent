import Foundation
import XCTest
@testable import JSTorrentKit

@MainActor
final class EngineControllerIntakeTests: XCTestCase {
    private final class MockRuntime: EngineRuntimeHandling {
        var addedTorrentInputs: [String] = []
        var addTestTorrentCallCount = 0
        var pausedInfoHashes: [String] = []
        var resumedInfoHashes: [String] = []
        var removedInfoHashes: [String] = []
        var shutdownCallCount = 0

        func prepareDefaultBundle(in bundle: Bundle) throws {}
        func bootstrap(with config: EngineBootstrapConfig) throws {}
        func subscribe(type: String, hash: String, intervalMs: Int) throws {}
        func setTickMode(_ mode: EngineTickMode) throws {}

        func addTorrent(_ magnetOrBase64: String) throws {
            addedTorrentInputs.append(magnetOrBase64)
        }

        func addTestTorrent() throws {
            addTestTorrentCallCount += 1
        }

        func queryTorrentList() throws -> EngineStatePayload {
            EngineStatePayload(torrents: [])
        }

        func pauseTorrent(_ infoHash: String) throws {
            pausedInfoHashes.append(infoHash)
        }

        func resumeTorrent(_ infoHash: String) throws {
            resumedInfoHashes.append(infoHash)
        }

        func removeTorrent(_ infoHash: String, deleteFiles: Bool) throws {
            removedInfoHashes.append(infoHash)
        }

        func tick() throws -> EngineTickResult {
            EngineTickResult(
                delayMs: 250,
                blocksRecv: 0,
                blocksSent: 0,
                elapsedMs: 0,
                activePieces: 0,
                connectedPeers: 0,
                bufferedBytes: 0,
                pipelineFilled: 0,
                pipelineMax: 0,
                pendingHashes: 0
            )
        }

        func shutdown() throws {
            shutdownCallCount += 1
        }
    }

    private func makeController(runtime: MockRuntime) -> EngineController {
        EngineController(
            bootstrapConfig: EngineBootstrapConfig(contentRoots: []),
            bundle: .main,
            runtimeFactory: { _, _ in runtime }
        )
    }

    func testHandleIncomingMagnetURLStartsRuntimeAndForwardsInput() throws {
        let runtime = MockRuntime()
        let controller = makeController(runtime: runtime)
        let magnetURL = try XCTUnwrap(
            URL(string: "magnet:?xt=urn:btih:abcdef0123456789abcdef0123456789abcdef01&dn=Ubuntu")
        )

        controller.handleIncomingURL(magnetURL)

        XCTAssertEqual(runtime.addedTorrentInputs, [magnetURL.absoluteString])

        controller.suspend()
    }

    func testHandleIncomingTorrentFileURLBase64EncodesData() throws {
        let runtime = MockRuntime()
        let controller = makeController(runtime: runtime)
        let torrentData = Data([0x64, 0x31, 0x3A, 0x61, 0x31, 0x3A, 0x62, 0x65])
        let torrentURL = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString)
            .appendingPathExtension("torrent")

        try torrentData.write(to: torrentURL)
        defer {
            try? FileManager.default.removeItem(at: torrentURL)
            controller.suspend()
        }

        controller.startIfNeeded()
        controller.handleIncomingURL(torrentURL)

        XCTAssertEqual(runtime.addedTorrentInputs, [torrentData.base64EncodedString()])
    }

    func testAddTestTorrentStartsRuntimeOnDemand() {
        let runtime = MockRuntime()
        let controller = makeController(runtime: runtime)

        controller.addTestTorrent()

        XCTAssertEqual(runtime.addTestTorrentCallCount, 1)
        XCTAssertTrue(controller.isStarted)

        controller.shutdown()
    }

    func testToggleTorrentStartsRuntimeOnDemand() {
        let runtime = MockRuntime()
        let controller = makeController(runtime: runtime)
        let torrent = TorrentListItem(
            infoHash: "abcdef0123456789abcdef0123456789abcdef01",
            name: "Ubuntu",
            progress: 0.5,
            downloadSpeed: 0,
            uploadSpeed: 0,
            status: "stopped",
            numPeers: 0
        )

        controller.toggleTorrent(torrent)

        XCTAssertEqual(runtime.resumedInfoHashes, [torrent.infoHash])
        XCTAssertTrue(controller.isStarted)

        controller.shutdown()
    }

    func testShutdownReleasesRuntime() {
        let runtime = MockRuntime()
        let controller = makeController(runtime: runtime)

        controller.startIfNeeded()
        XCTAssertTrue(controller.isStarted)

        controller.shutdown()

        XCTAssertEqual(runtime.shutdownCallCount, 1)
        XCTAssertFalse(controller.isStarted)
        XCTAssertEqual(controller.status, .idle)
    }
}
