import Foundation
import JSTorrentKit

@MainActor
final class SearchViewModel: ObservableObject {
    @Published var query = ""
    @Published var selectedProviderID: String
    @Published var selectedCategoryID: String
    @Published private(set) var results: [TorrentSearchResult] = []
    @Published private(set) var isSearching = false
    @Published private(set) var hasSearched = false
    @Published private(set) var activeAddResultIDs: Set<String> = []
    @Published private(set) var errorMessage: String?
    @Published private(set) var statusMessage: String?

    let providerDescriptors: [TorrentSearchProviderDescriptor]

    private var controller: EngineController
    private let providersByID: [String: any TorrentSearchProvider]
    private let downloader: URLSession
    private var searchTask: Task<Void, Never>?

    init(
        controller: EngineController,
        providers: [any TorrentSearchProvider] = [InternetArchiveSearchProvider()],
        downloader: URLSession = .shared
    ) {
        self.controller = controller
        self.providerDescriptors = providers.map { $0.descriptor }
        self.providersByID = Dictionary(uniqueKeysWithValues: providers.map { ($0.descriptor.id, $0) })
        self.downloader = downloader

        let initialProvider = self.providerDescriptors.first
        self.selectedProviderID = initialProvider?.id ?? ""
        self.selectedCategoryID = initialProvider?.categories.first?.id ?? ""
    }

    var selectedProvider: TorrentSearchProviderDescriptor? {
        providerDescriptors.first { $0.id == selectedProviderID }
    }

    var availableCategories: [TorrentSearchCategory] {
        selectedProvider?.categories ?? []
    }

    func updateController(_ controller: EngineController) {
        self.controller = controller
    }

    func selectProvider(_ providerID: String) {
        guard providerID != selectedProviderID else {
            return
        }

        selectedProviderID = providerID
        selectedCategoryID = providersByID[providerID]?.descriptor.categories.first?.id ?? ""
        errorMessage = nil
        statusMessage = nil
    }

    func selectCategory(_ categoryID: String) {
        selectedCategoryID = categoryID
    }

    func runSearch() {
        let trimmedQuery = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedQuery.isEmpty else {
            results = []
            hasSearched = false
            errorMessage = L10n.string("search_query_required")
            statusMessage = nil
            return
        }

        guard let provider = providersByID[selectedProviderID] else {
            errorMessage = "Search provider is unavailable."
            return
        }

        searchTask?.cancel()
        results = []
        hasSearched = false
        isSearching = true
        errorMessage = nil
        statusMessage = nil

        let categoryID = selectedCategoryID.isEmpty ? nil : selectedCategoryID
        searchTask = Task { @MainActor [weak self] in
            guard let self else {
                return
            }

            do {
                let results = try await provider.search(query: trimmedQuery, categoryID: categoryID)
                guard !Task.isCancelled else {
                    return
                }

                self.results = results
                self.hasSearched = true
                self.isSearching = false
            } catch is CancellationError {
                self.isSearching = false
            } catch {
                self.results = []
                self.hasSearched = true
                self.isSearching = false
                self.errorMessage = error.localizedDescription
            }
        }
    }

    func add(_ result: TorrentSearchResult) {
        guard !activeAddResultIDs.contains(result.id) else {
            return
        }

        activeAddResultIDs.insert(result.id)
        errorMessage = nil
        statusMessage = nil

        Task { @MainActor [weak self] in
            guard let self else {
                return
            }

            defer {
                self.activeAddResultIDs.remove(result.id)
            }

            do {
                if let magnetURL = result.magnetURL {
                    controller.addTorrent(magnetURL.absoluteString)
                } else if let torrentURL = result.torrentURL {
                    let data = try await downloadTorrentData(from: torrentURL)
                    controller.addTorrentFileData(data)
                } else {
                    throw SearchAddError.missingTorrentSource
                }

                if let controllerError = controller.lastError, !controllerError.isEmpty {
                    throw SearchAddError.controllerError(controllerError)
                }

                statusMessage = L10n.string("search_result_added")
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }

    func isAdding(_ result: TorrentSearchResult) -> Bool {
        activeAddResultIDs.contains(result.id)
    }

    private func downloadTorrentData(from url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue("JSTorrent-iOS/1.0 (+https://jstorrent.com)", forHTTPHeaderField: "User-Agent")

        let (data, response) = try await downloader.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse else {
            throw SearchAddError.invalidResponse
        }
        guard (200..<300).contains(httpResponse.statusCode) else {
            throw SearchAddError.httpFailure(httpResponse.statusCode)
        }
        guard !data.isEmpty else {
            throw SearchAddError.emptyTorrentData
        }
        return data
    }
}

private enum SearchAddError: LocalizedError {
    case missingTorrentSource
    case invalidResponse
    case httpFailure(Int)
    case emptyTorrentData
    case controllerError(String)

    var errorDescription: String? {
        switch self {
        case .missingTorrentSource:
            return "Search result does not include a torrent to add."
        case .invalidResponse:
            return "Torrent download returned an invalid response."
        case .httpFailure(let statusCode):
            return "Torrent download failed with HTTP \(statusCode)."
        case .emptyTorrentData:
            return "Torrent download returned an empty file."
        case .controllerError(let message):
            return message
        }
    }
}
