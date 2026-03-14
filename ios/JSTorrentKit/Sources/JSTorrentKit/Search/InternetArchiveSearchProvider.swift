import Foundation

public struct InternetArchiveSearchProvider: TorrentSearchProvider {
    public static let allCategory = TorrentSearchCategory(id: "all", title: "All")
    public static let providerDescriptor = TorrentSearchProviderDescriptor(
        id: "org.archive.search",
        name: "Internet Archive",
        description: "Search public-domain and openly licensed media on the Internet Archive.",
        categories: [
            InternetArchiveSearchProvider.allCategory,
            TorrentSearchCategory(id: "movies", title: "Movies"),
            TorrentSearchCategory(id: "music", title: "Music"),
            TorrentSearchCategory(id: "books", title: "Books"),
            TorrentSearchCategory(id: "software", title: "Software")
        ]
    )

    public let descriptor: TorrentSearchProviderDescriptor = Self.providerDescriptor

    private let networking: any TorrentSearchNetworking
    private let userAgent: String

    public init(
        networking: any TorrentSearchNetworking = URLSessionTorrentSearchNetworking(),
        userAgent: String = "JSTorrent-iOS/1.0 (+https://jstorrent.com)"
    ) {
        self.networking = networking
        self.userAgent = userAgent
    }

    public func search(query: String, categoryID: String?) async throws -> [TorrentSearchResult] {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else {
            throw TorrentSearchProviderError.emptyQuery
        }

        let request = try buildRequest(query: trimmedQuery, categoryID: categoryID)
        let (data, response) = try await networking.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw TorrentSearchProviderError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw TorrentSearchProviderError.requestFailed(statusCode: httpResponse.statusCode)
        }

        let payload = try JSONDecoder().decode(ArchiveSearchResponse.self, from: data)
        return payload.response.docs.compactMap { makeResult(from: $0) }
    }

    private func buildRequest(query: String, categoryID: String?) throws -> URLRequest {
        var components = URLComponents(string: "https://archive.org/advancedsearch.php")
        components?.queryItems = [
            URLQueryItem(name: "q", value: buildQuery(query: query, categoryID: categoryID)),
            URLQueryItem(name: "fl[]", value: "identifier"),
            URLQueryItem(name: "fl[]", value: "title"),
            URLQueryItem(name: "fl[]", value: "mediatype"),
            URLQueryItem(name: "fl[]", value: "publicdate"),
            URLQueryItem(name: "fl[]", value: "downloads"),
            URLQueryItem(name: "fl[]", value: "item_size"),
            URLQueryItem(name: "sort[]", value: "downloads desc"),
            URLQueryItem(name: "rows", value: "20"),
            URLQueryItem(name: "page", value: "1"),
            URLQueryItem(name: "output", value: "json")
        ]

        guard let url = components?.url else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(userAgent, forHTTPHeaderField: "User-Agent")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        return request
    }

    private func buildQuery(query: String, categoryID: String?) -> String {
        let phrase = escapePhrase(query)
        var clauses = [
            "format:\"Archive BitTorrent\"",
            "(title:\"\(phrase)\" OR subject:\"\(phrase)\" OR description:\"\(phrase)\")"
        ]

        if let filter = categoryFilter(for: categoryID) {
            clauses.append(filter)
        }

        return clauses.joined(separator: " AND ")
    }

    private func categoryFilter(for categoryID: String?) -> String? {
        switch normalizeCategory(categoryID) {
        case nil, "", "all":
            return nil
        case "movies":
            return "mediatype:(movies)"
        case "music":
            return "mediatype:(audio)"
        case "books":
            return "mediatype:(texts)"
        case "software":
            return "mediatype:(software)"
        default:
            return nil
        }
    }

    private func normalizeCategory(_ categoryID: String?) -> String? {
        guard let categoryID else {
            return nil
        }

        let normalized = categoryID.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized.isEmpty ? nil : normalized
    }

    private func escapePhrase(_ value: String) -> String {
        value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
    }

    private func makeResult(from document: ArchiveSearchDocument) -> TorrentSearchResult? {
        let identifier = document.identifier.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !identifier.isEmpty else {
            return nil
        }

        let title = document.title?.trimmingCharacters(in: .whitespacesAndNewlines)
        let displayName = (title?.isEmpty == false ? title : nil) ?? identifier
        let torrentURL = URL(string: "https://archive.org/download/\(identifier)/\(identifier)_archive.torrent")
        let detailsURL = URL(string: "https://archive.org/details/\(identifier)")

        return TorrentSearchResult(
            id: "\(descriptor.id)|\(identifier)",
            providerID: descriptor.id,
            providerName: descriptor.name,
            name: displayName,
            source: descriptor.name,
            size: document.itemSize,
            seeds: document.downloads,
            torrentURL: torrentURL,
            detailsURL: detailsURL,
            publishedAt: document.publicDate.flatMap(DateParser.parse)
        )
    }
}

private enum DateParser {
    static func parse(_ value: String) -> Date? {
        ISO8601DateFormatter.full.date(from: value) ?? ISO8601DateFormatter.fallback.date(from: value)
    }
}

private extension ISO8601DateFormatter {
    static let full: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    static let fallback: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()
}

private struct ArchiveSearchResponse: Decodable {
    let response: ArchiveSearchDocsResponse
}

private struct ArchiveSearchDocsResponse: Decodable {
    let docs: [ArchiveSearchDocument]
}

private struct ArchiveSearchDocument: Decodable {
    let identifier: String
    let title: String?
    let publicDate: String?
    let downloads: Int?
    let itemSize: Int64?

    private enum CodingKeys: String, CodingKey {
        case identifier
        case title
        case publicDate = "publicdate"
        case downloads
        case itemSize = "item_size"
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        identifier = try container.decode(String.self, forKey: .identifier)
        title = try container.decodeIfPresent(String.self, forKey: .title)
        publicDate = try container.decodeIfPresent(String.self, forKey: .publicDate)
        downloads = Self.decodeIntegerIfPresent(Int.self, forKey: .downloads, from: container)
        itemSize = Self.decodeIntegerIfPresent(Int64.self, forKey: .itemSize, from: container)
    }

    private static func decodeIntegerIfPresent<T: Decodable & LosslessStringConvertible>(
        _ type: T.Type,
        forKey key: CodingKeys,
        from container: KeyedDecodingContainer<CodingKeys>
    ) -> T? {
        if let value = try? container.decode(T.self, forKey: key) {
            return value
        }
        if let stringValue = try? container.decode(String.self, forKey: key) {
            return T(stringValue)
        }
        return nil
    }
}
