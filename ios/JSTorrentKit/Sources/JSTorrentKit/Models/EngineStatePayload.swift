import Foundation

public struct TorrentListItem: Decodable, Equatable, Identifiable, Sendable {
    public let infoHash: String
    public let name: String
    public let progress: Double
    public let downloadSpeed: Int
    public let uploadSpeed: Int
    public let status: String
    public let numPeers: Int

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
