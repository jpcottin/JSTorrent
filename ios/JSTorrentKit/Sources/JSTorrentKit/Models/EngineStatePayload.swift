import Foundation

public struct TorrentListItem: Decodable, Equatable, Identifiable, Sendable {
    public let infoHash: String
    public let name: String
    public let progress: Double
    public let downloadSpeed: Int
    public let uploadSpeed: Int
    public let status: String
    public let numPeers: Int

    private enum CodingKeys: String, CodingKey {
        case infoHash
        case name
        case progress
        case downloadSpeed
        case uploadSpeed
        case status
        case numPeers
        case peersConnected
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
}
