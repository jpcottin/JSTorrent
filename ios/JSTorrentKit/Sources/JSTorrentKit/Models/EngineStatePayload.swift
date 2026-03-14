import Foundation

public struct TorrentListItem: Decodable, Equatable, Identifiable, Sendable {
    public let infoHash: String
    public let name: String
    public let progress: Double
    public let downloadSpeed: Int
    public let uploadSpeed: Int
    public let status: String
    public let numPeers: Int
    public let hasMetadata: Bool

    private enum CodingKeys: String, CodingKey {
        case infoHash
        case name
        case progress
        case downloadSpeed
        case uploadSpeed
        case status
        case numPeers
        case peersConnected
        case hasMetadata
    }

    public init(
        infoHash: String,
        name: String,
        progress: Double,
        downloadSpeed: Int,
        uploadSpeed: Int,
        status: String,
        numPeers: Int,
        hasMetadata: Bool = false
    ) {
        self.infoHash = infoHash
        self.name = name
        self.progress = progress
        self.downloadSpeed = downloadSpeed
        self.uploadSpeed = uploadSpeed
        self.status = status
        self.numPeers = numPeers
        self.hasMetadata = hasMetadata
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        infoHash = try container.decode(String.self, forKey: .infoHash)
        name = try container.decode(String.self, forKey: .name)
        progress = try container.decode(Double.self, forKey: .progress)
        downloadSpeed = try container.decodeIfPresent(Int.self, forKey: .downloadSpeed) ?? 0
        uploadSpeed = try container.decodeIfPresent(Int.self, forKey: .uploadSpeed) ?? 0
        status = try container.decode(String.self, forKey: .status)
        numPeers =
            try container.decodeIfPresent(Int.self, forKey: .numPeers)
            ?? container.decodeIfPresent(Int.self, forKey: .peersConnected)
            ?? 0
        hasMetadata = try container.decodeIfPresent(Bool.self, forKey: .hasMetadata) ?? false
    }

    public var id: String { infoHash }

    public var isStopped: Bool {
        status == "stopped"
    }

    public var displayStatus: String {
        status.replacingOccurrences(of: "_", with: " ").localizedCapitalized
    }

    public var progressPercent: Int {
        Int(progress * 100)
    }
}

public struct EngineStatePayload: Decodable, Equatable, Sendable {
    public let torrents: [TorrentListItem]?
    public let torrent: [String: TorrentListItem]?
    public let pieceChanges: [String: [Int]]?
    public let activePieceStates: [String: String]?
    public let peers: [String: [TorrentPeerItem]]?
    public let files: [String: TorrentFilesPayload]?
    public let trackers: [String: [TorrentTrackerItem]]?
    public let pieces: [String: TorrentPiecesPayload]?
    public let details: [String: TorrentDetailsPayload]?

    public init(
        torrents: [TorrentListItem]? = nil,
        torrent: [String: TorrentListItem]? = nil,
        pieceChanges: [String: [Int]]? = nil,
        activePieceStates: [String: String]? = nil,
        peers: [String: [TorrentPeerItem]]? = nil,
        files: [String: TorrentFilesPayload]? = nil,
        trackers: [String: [TorrentTrackerItem]]? = nil,
        pieces: [String: TorrentPiecesPayload]? = nil,
        details: [String: TorrentDetailsPayload]? = nil
    ) {
        self.torrents = torrents
        self.torrent = torrent
        self.pieceChanges = pieceChanges
        self.activePieceStates = activePieceStates
        self.peers = peers
        self.files = files
        self.trackers = trackers
        self.pieces = pieces
        self.details = details
    }
}
