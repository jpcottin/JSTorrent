import Foundation

public struct TorrentFileItem: Decodable, Equatable, Identifiable, Sendable {
    public let index: Int
    public let path: String
    public let size: Int
    public let downloaded: Int
    public let progress: Double
    public let priority: Int

    public var id: Int { index }
}

public struct TorrentFilesPayload: Decodable, Equatable, Sendable {
    public let files: [TorrentFileItem]
    public let rootKey: String?
}

public struct TorrentTrackerItem: Decodable, Equatable, Identifiable, Sendable {
    public let url: String
    public let type: String
    public let status: String
    public let seeders: Int?
    public let leechers: Int?
    public let lastPeersReceived: Int?
    public let uniquePeersDiscovered: Int?
    public let lastError: String?
    public let connectionFamily: String?

    public var id: String { url }
}

public struct TorrentTrackersPayload: Decodable, Equatable, Sendable {
    public let trackers: [TorrentTrackerItem]
}

public struct TorrentPeerItem: Decodable, Equatable, Identifiable, Sendable {
    public let key: String
    public let ip: String
    public let port: Int
    public let state: String
    public let kind: String?
    public let source: String?
    public let downloadSpeed: Int
    public let uploadSpeed: Int
    public let downloaded: Int?
    public let uploaded: Int?
    public let requestsPending: Int?
    public let progress: Double
    public let isEncrypted: Bool
    public let isIncoming: Bool
    public let clientName: String?
    public let amInterested: Bool
    public let peerChoking: Bool
    public let peerInterested: Bool
    public let amChoking: Bool
    public let webSeedUrl: String?
    public let webSeedRetryAt: Int?

    public var id: String { key }
}

public struct TorrentPeersPayload: Decodable, Equatable, Sendable {
    public let peers: [TorrentPeerItem]
}

public struct TorrentPiecesPayload: Decodable, Equatable, Sendable {
    public let piecesTotal: Int
    public let piecesCompleted: Int
    public let pieceSize: Int
    public let lastPieceSize: Int
    public let bitfield: String
    public let recentChanges: [Int]
    public let activePieceStates: String?

    public init(
        piecesTotal: Int,
        piecesCompleted: Int,
        pieceSize: Int,
        lastPieceSize: Int,
        bitfield: String,
        recentChanges: [Int] = [],
        activePieceStates: String? = nil
    ) {
        self.piecesTotal = piecesTotal
        self.piecesCompleted = piecesCompleted
        self.pieceSize = pieceSize
        self.lastPieceSize = lastPieceSize
        self.bitfield = bitfield
        self.recentChanges = recentChanges
        self.activePieceStates = activePieceStates
    }
}

public struct TorrentDetailsPayload: Decodable, Equatable, Sendable {
    public let infoHash: String
    public let addedAt: Int
    public let completedAt: Int?
    public let totalSize: Int
    public let pieceSize: Int
    public let pieceCount: Int
    public let magnetUrl: String
    public let rootKey: String?
    public let comment: String?
    public let createdBy: String?
    public let creationDate: Int?
    public let isPrivate: Bool
}
