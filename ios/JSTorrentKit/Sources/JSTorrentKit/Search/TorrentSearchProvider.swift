import Foundation

public struct TorrentSearchCategory: Hashable, Identifiable {
    public let id: String
    public let title: String

    public init(id: String, title: String) {
        self.id = id
        self.title = title
    }
}

public struct TorrentSearchProviderDescriptor: Hashable, Identifiable {
    public let id: String
    public let name: String
    public let description: String?
    public let categories: [TorrentSearchCategory]

    public init(
        id: String,
        name: String,
        description: String? = nil,
        categories: [TorrentSearchCategory] = []
    ) {
        self.id = id
        self.name = name
        self.description = description
        self.categories = categories
    }
}

public struct TorrentSearchResult: Hashable, Identifiable {
    public let id: String
    public let providerID: String
    public let providerName: String
    public let name: String
    public let source: String
    public let size: Int64?
    public let seeds: Int?
    public let magnetURL: URL?
    public let torrentURL: URL?
    public let detailsURL: URL?
    public let publishedAt: Date?

    public init(
        id: String,
        providerID: String,
        providerName: String,
        name: String,
        source: String,
        size: Int64? = nil,
        seeds: Int? = nil,
        magnetURL: URL? = nil,
        torrentURL: URL? = nil,
        detailsURL: URL? = nil,
        publishedAt: Date? = nil
    ) {
        self.id = id
        self.providerID = providerID
        self.providerName = providerName
        self.name = name
        self.source = source
        self.size = size
        self.seeds = seeds
        self.magnetURL = magnetURL
        self.torrentURL = torrentURL
        self.detailsURL = detailsURL
        self.publishedAt = publishedAt
    }
}

public enum TorrentSearchProviderError: LocalizedError {
    case emptyQuery
    case invalidResponse
    case requestFailed(statusCode: Int)

    public var errorDescription: String? {
        switch self {
        case .emptyQuery:
            return "Search query must not be empty."
        case .invalidResponse:
            return "Search provider returned an invalid response."
        case .requestFailed(let statusCode):
            return "Search request failed with HTTP \(statusCode)."
        }
    }
}

public protocol TorrentSearchProvider {
    var descriptor: TorrentSearchProviderDescriptor { get }
    func search(query: String, categoryID: String?) async throws -> [TorrentSearchResult]
}

public protocol TorrentSearchNetworking {
    func data(for request: URLRequest) async throws -> (Data, URLResponse)
}

public struct URLSessionTorrentSearchNetworking: TorrentSearchNetworking {
    public let session: URLSession

    public init(session: URLSession = .shared) {
        self.session = session
    }

    public func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        try await session.data(for: request)
    }
}
