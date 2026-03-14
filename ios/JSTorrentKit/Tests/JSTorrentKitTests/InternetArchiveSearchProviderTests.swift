import Foundation
import XCTest
@testable import JSTorrentKit

final class InternetArchiveSearchProviderTests: XCTestCase {
    private final class MockNetworking: TorrentSearchNetworking {
        var lastRequest: URLRequest?
        var nextData = Data()
        var nextResponse: URLResponse = HTTPURLResponse(
            url: URL(string: "https://archive.org/advancedsearch.php")!,
            statusCode: 200,
            httpVersion: nil,
            headerFields: nil
        )!

        func data(for request: URLRequest) async throws -> (Data, URLResponse) {
            lastRequest = request
            return (nextData, nextResponse)
        }
    }

    func testSearchBuildsAdvancedSearchRequestAndMapsResults() async throws {
        let networking = MockNetworking()
        networking.nextData = Data(
            """
            {
              "response": {
                "docs": [
                  {
                    "identifier": "ubuntu-archive",
                    "title": "Ubuntu ISO",
                    "publicdate": "2024-03-10T00:00:00Z",
                    "downloads": 42,
                    "item_size": 2048
                  }
                ]
              }
            }
            """.utf8
        )

        let provider = InternetArchiveSearchProvider(networking: networking)
        let results = try await provider.search(query: "ubuntu linux", categoryID: "software")

        XCTAssertEqual(results.count, 1)
        XCTAssertEqual(results.first?.name, "Ubuntu ISO")
        XCTAssertEqual(results.first?.providerID, "org.archive.search")
        XCTAssertEqual(results.first?.seeds, 42)
        XCTAssertEqual(results.first?.size, 2048)
        XCTAssertEqual(
            results.first?.torrentURL?.absoluteString,
            "https://archive.org/download/ubuntu-archive/ubuntu-archive_archive.torrent"
        )
        XCTAssertEqual(
            results.first?.detailsURL?.absoluteString,
            "https://archive.org/details/ubuntu-archive"
        )

        let request = try XCTUnwrap(networking.lastRequest)
        XCTAssertEqual(request.httpMethod, "GET")
        XCTAssertEqual(request.value(forHTTPHeaderField: "Accept"), "application/json")
        XCTAssertEqual(request.url?.host, "archive.org")

        let components = try XCTUnwrap(URLComponents(url: try XCTUnwrap(request.url), resolvingAgainstBaseURL: false))
        let queryItems = components.queryItems ?? []
        XCTAssertTrue(queryItems.contains(URLQueryItem(name: "output", value: "json")))
        XCTAssertTrue(queryItems.contains(URLQueryItem(name: "rows", value: "20")))

        let queryValue = queryItems.first(where: { $0.name == "q" })?.value ?? ""
        XCTAssertTrue(queryValue.contains("format:\"Archive BitTorrent\""))
        XCTAssertTrue(queryValue.contains("title:\"ubuntu linux\""))
        XCTAssertTrue(queryValue.contains("mediatype:(software)"))
    }

    func testSearchRejectsEmptyQueries() async {
        let provider = InternetArchiveSearchProvider(networking: MockNetworking())

        do {
            _ = try await provider.search(query: "   ", categoryID: "all")
            XCTFail("Expected empty query to throw")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Search query must not be empty.")
        }
    }
}
