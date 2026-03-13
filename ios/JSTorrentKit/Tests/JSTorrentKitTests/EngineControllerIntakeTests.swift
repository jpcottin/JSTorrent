import Foundation
import XCTest
@testable import JSTorrentKit

@MainActor
final class EngineControllerIntakeTests: XCTestCase {
    private final class MockRuntime: EngineRuntimeHandling {
        var addedTorrentInputs: [String] = []

        func prepareDefaultBundle(in bundle: Bundle) throws {}
        func bootstrap(with config: EngineBootstrapConfig) throws {}
        func subscribe(type: String, hash: String, intervalMs: Int) throws {}
        func setTickMode(_ mode: EngineTickMode) throws {}

        func addTorrent(_ magnetOrBase64: String) throws {
            addedTorrentInputs.append(magnetOrBase64)
        }

        func addTestTorrent() throws {}

        func queryTorrentList() throws -> EngineStatePayload {
            EngineStatePayload(torrents: [])
        }

        func pauseTorrent(_ infoHash: String) throws {}
        func resumeTorrent(_ infoHash: String) throws {}
        func removeTorrent(_ infoHash: String, deleteFiles: Bool) throws {}

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
}
