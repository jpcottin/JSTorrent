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
        var setFilePrioritiesCalls: [(infoHash: String, priorities: [Int: Int])] = []
        var unsubscribedHashes: [String] = []
        var subscribedTypes: [(type: String, hash: String, intervalMs: Int)] = []
        var shutdownCallCount = 0
        var queryPiecesCallCount = 0
        var queryDetailsCallCount = 0
        var nextFilesPayload = TorrentFilesPayload(files: [], rootKey: nil)
        var nextPiecesPayload = TorrentPiecesPayload(
            piecesTotal: 0,
            piecesCompleted: 0,
            pieceSize: 0,
            lastPieceSize: 0,
            bitfield: ""
        )
        var nextDetailsPayload: TorrentDetailsPayload?

        func prepareDefaultBundle(in bundle: Bundle) throws {}
        func bootstrap(with config: EngineBootstrapConfig) throws {}
        func subscribe(type: String, hash: String, intervalMs: Int) throws {
            subscribedTypes.append((type, hash, intervalMs))
        }
        func unsubscribe(type: String, hash: String) throws {}
        func unsubscribeAll(hash: String) throws {
            unsubscribedHashes.append(hash)
        }
        func setTickMode(_ mode: EngineTickMode) throws {}

        func addTorrent(_ magnetOrBase64: String, optionsJson: String? = nil) throws {
            addedTorrentInputs.append(magnetOrBase64)
        }

        func setTorrentRoot(_ infoHash: String, rootKey: String) throws -> Bool {
            return true
        }

        func addTestTorrent() throws {
            addTestTorrentCallCount += 1
        }

        func queryTorrentList() throws -> EngineStatePayload {
            EngineStatePayload(torrents: [])
        }

        func queryFiles(_ infoHash: String) throws -> TorrentFilesPayload {
            nextFilesPayload
        }

        func queryTrackers(_ infoHash: String) throws -> TorrentTrackersPayload {
            TorrentTrackersPayload(trackers: [])
        }

        func queryPeers(_ infoHash: String) throws -> TorrentPeersPayload {
            TorrentPeersPayload(peers: [])
        }

        func queryPieces(_ infoHash: String) throws -> TorrentPiecesPayload {
            queryPiecesCallCount += 1
            return nextPiecesPayload
        }

        func queryDetails(_ infoHash: String) throws -> TorrentDetailsPayload {
            queryDetailsCallCount += 1
            return nextDetailsPayload ?? TorrentDetailsPayload(
                infoHash: infoHash,
                addedAt: 0,
                completedAt: nil,
                totalSize: 0,
                pieceSize: 0,
                pieceCount: 0,
                magnetUrl: "magnet:?xt=urn:btih:\(infoHash)",
                rootKey: nil,
                comment: nil,
                createdBy: nil,
                creationDate: nil,
                isPrivate: false
            )
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

        func setFilePriorities(_ infoHash: String, priorities: [Int: Int]) throws -> Int {
            setFilePrioritiesCalls.append((infoHash, priorities))
            return priorities.count
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

    func testObserveTorrentDetailSubscribesAndHydratesRequestedSection() {
        let runtime = MockRuntime()
        let controller = makeController(runtime: runtime)
        let infoHash = "abcdef0123456789abcdef0123456789abcdef01"

        controller.observeTorrentDetail(infoHash, section: .files)

        XCTAssertTrue(controller.isStarted)
        XCTAssertEqual(
            runtime.subscribedTypes.map(\.type),
            ["torrents", "torrent", "files"]
        )
        XCTAssertEqual(controller.torrentFiles[infoHash]?.files, [])

        controller.shutdown()
    }

    func testStopObservingTorrentDetailUnsubscribesAllForHash() {
        let runtime = MockRuntime()
        let controller = makeController(runtime: runtime)
        let infoHash = "abcdef0123456789abcdef0123456789abcdef01"

        controller.startIfNeeded()
        controller.stopObservingTorrentDetail(infoHash)

        XCTAssertEqual(runtime.unsubscribedHashes, [infoHash])
        controller.shutdown()
    }

    func testPiecesObservationRehydratesWhenMetadataArrives() {
        let runtime = MockRuntime()
        let controller = makeController(runtime: runtime)
        let infoHash = "abcdef0123456789abcdef0123456789abcdef01"

        controller.observeTorrentDetail(infoHash, section: .pieces)
        XCTAssertEqual(controller.torrentPieces[infoHash]?.piecesTotal, 0)
        XCTAssertEqual(runtime.queryPiecesCallCount, 1)

        runtime.nextPiecesPayload = TorrentPiecesPayload(
            piecesTotal: 8,
            piecesCompleted: 3,
            pieceSize: 1024,
            lastPieceSize: 1024,
            bitfield: "e0"
        )
        runtime.nextDetailsPayload = TorrentDetailsPayload(
            infoHash: infoHash,
            addedAt: 0,
            completedAt: nil,
            totalSize: 8192,
            pieceSize: 1024,
            pieceCount: 8,
            magnetUrl: "magnet:?xt=urn:btih:\(infoHash)",
            rootKey: nil,
            comment: nil,
            createdBy: nil,
            creationDate: nil,
            isPrivate: false
        )

        controller.applyStateUpdate(
            payload: """
            {
              "torrent": {
                "\(infoHash)": {
                  "infoHash": "\(infoHash)",
                  "name": "Ubuntu",
                  "progress": 0.1,
                  "downloadSpeed": 1024,
                  "uploadSpeed": 0,
                  "status": "downloading",
                  "numPeers": 3,
                  "hasMetadata": true
                }
              }
            }
            """
        )

        XCTAssertEqual(controller.torrentPieces[infoHash]?.piecesTotal, 8)
        XCTAssertEqual(controller.torrentDetails[infoHash]?.pieceCount, 8)
        XCTAssertEqual(runtime.queryPiecesCallCount, 2)
        XCTAssertEqual(runtime.queryDetailsCallCount, 2)

        controller.shutdown()
    }

    func testSetFilePrioritiesRefreshesFilePayload() {
        let runtime = MockRuntime()
        let controller = makeController(runtime: runtime)
        let infoHash = "abcdef0123456789abcdef0123456789abcdef01"

        runtime.nextFilesPayload = TorrentFilesPayload(
            files: [
                TorrentFileItem(
                    index: 0,
                    path: "ubuntu.iso",
                    size: 4096,
                    downloaded: 1024,
                    progress: 0.25,
                    priority: 1
                )
            ],
            rootKey: "default"
        )

        let success = controller.setFilePriorities(infoHash, priorities: [0: 1])

        XCTAssertTrue(success)
        XCTAssertEqual(runtime.setFilePrioritiesCalls.count, 1)
        XCTAssertEqual(runtime.setFilePrioritiesCalls.first?.infoHash, infoHash)
        XCTAssertEqual(runtime.setFilePrioritiesCalls.first?.priorities[0], 1)
        XCTAssertEqual(controller.torrentFiles[infoHash]?.files.first?.priority, 1)

        controller.shutdown()
    }
}
