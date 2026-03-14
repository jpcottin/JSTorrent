import Combine
import Foundation
import JSTorrentKit

@MainActor
final class AppSettings: ObservableObject {
    enum DownloadLocation: Equatable {
        case internalStorage
        case externalFolder(displayName: String)
    }

    private struct PersistedDownloadRoot: Codable, Equatable {
        var key: String
        var displayName: String
        var path: String
        var bookmarkData: Data?
        var isInternal: Bool
    }

    private struct PersistedDownloadRootState: Codable {
        var version: Int
        var roots: [PersistedDownloadRoot]
        var defaultRootKey: String
    }

    @Published private(set) var downloadLocation: DownloadLocation = .internalStorage
    @Published private(set) var downloadBaseDirectoryURL: URL
    @Published private(set) var defaultContentRootKey: String
    @Published private(set) var contentRoots: [ContentRoot] = []
    @Published private(set) var locationChangeToken: String
    @Published var lastError: String?

    private let userDefaults: UserDefaults
    private let fileManager: FileManager
    private var persistedRoots: [PersistedDownloadRoot] = []
    private var activeSecurityScopedURLs: [String: URL] = [:]

    private static let rootsStateKey = "settings.download-roots-state"
    private static let legacyDownloadFolderBookmarkKey = "settings.download-folder-bookmark"
    private static let legacyDownloadFolderDisplayNameKey = "settings.download-folder-display-name"
    private static let legacyDefaultRootKey = "documents"
    private static let internalRootFallbackKey = "internal-documents"
#if os(iOS)
    private static let bookmarkCreationOptions: URL.BookmarkCreationOptions = []
    private static let bookmarkResolutionOptions: URL.BookmarkResolutionOptions = []
#else
    private static let bookmarkCreationOptions: URL.BookmarkCreationOptions = [.withSecurityScope]
    private static let bookmarkResolutionOptions: URL.BookmarkResolutionOptions = [.withSecurityScope]
#endif

    init(
        userDefaults: UserDefaults = .standard,
        fileManager: FileManager = .default
    ) {
        self.userDefaults = userDefaults
        self.fileManager = fileManager

        let internalURL = Self.internalDocumentsDirectory(fileManager: fileManager)
        self.downloadBaseDirectoryURL = internalURL
        self.defaultContentRootKey = Self.legacyDefaultRootKey
        self.locationChangeToken = "initial:\(internalURL.path)"

        restoreDownloadRoots()
    }

    var downloadFolderDisplayName: String {
        switch downloadLocation {
        case .internalStorage:
            return L10n.string("settings_download_folder_internal")
        case .externalFolder(let displayName):
            return displayName
        }
    }

    var downloadFolderPath: String {
        downloadBaseDirectoryURL.path
    }

    var downloadFolderDisplayPath: String {
        switch downloadLocation {
        case .internalStorage:
            return "~/\(downloadFolderDisplayName)"
        case .externalFolder:
            return Self.displayPath(for: downloadBaseDirectoryURL)
        }
    }

    var usesExternalDownloadFolder: Bool {
        if case .externalFolder = downloadLocation {
            return true
        }

        return false
    }

    func resolveDownloadedFileURL(rootKey: String?, relativePath: String) -> URL? {
        let normalizedPath = relativePath.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !normalizedPath.isEmpty else {
            return nil
        }

        let resolvedRootKey = rootKey ?? defaultContentRootKey
        guard
            let root = persistedRoots.first(where: { $0.key == resolvedRootKey })
            ?? persistedRoots.first(where: { $0.key == defaultContentRootKey })
        else {
            return nil
        }

        let rootURL = URL(fileURLWithPath: root.path, isDirectory: true).standardizedFileURL
        let candidateURL = rootURL.appendingPathComponent(normalizedPath, isDirectory: false).standardizedFileURL
        let rootPath = rootURL.path
        let candidatePath = candidateURL.path
        guard candidatePath == rootPath || candidatePath.hasPrefix(rootPath + "/") else {
            return nil
        }

        return candidateURL
    }

    func selectDownloadFolder(_ url: URL) {
        do {
            let directory = try validateDirectory(url)
            let displayName = Self.displayName(for: directory)
            let bookmark = try directory.bookmarkData(
                options: Self.bookmarkCreationOptions,
                includingResourceValuesForKeys: [.nameKey],
                relativeTo: nil
            )

            var roots = persistedRoots
            let normalizedPath = directory.standardizedFileURL.path
            if let existingIndex = roots.firstIndex(where: { !$0.isInternal && $0.path == normalizedPath }) {
                roots[existingIndex].displayName = displayName
                roots[existingIndex].path = normalizedPath
                roots[existingIndex].bookmarkData = bookmark
                persistAndApply(roots: roots, defaultRootKey: roots[existingIndex].key)
            } else {
                let key = makeExternalRootKey(existingRoots: roots)
                roots.append(
                    PersistedDownloadRoot(
                        key: key,
                        displayName: displayName,
                        path: normalizedPath,
                        bookmarkData: bookmark,
                        isInternal: false
                    )
                )
                persistAndApply(roots: roots, defaultRootKey: key)
            }

            lastError = nil
        } catch {
            lastError = L10n.formatted(
                "settings_download_folder_save_error",
                error.localizedDescription
            )
        }
    }

    func resetDownloadFolderToInternal() {
        var roots = persistedRoots
        let internalKey = ensureInternalRoot(in: &roots).key
        persistAndApply(roots: roots, defaultRootKey: internalKey)
        lastError = nil
    }

    private func restoreDownloadRoots() {
        let initialState = loadPersistedRootState() ?? migrateLegacyRootState()
        applyPersistedRootState(initialState, persistChanges: loadPersistedRootState() == nil)
    }

    private func loadPersistedRootState() -> PersistedDownloadRootState? {
        guard let data = userDefaults.data(forKey: Self.rootsStateKey) else {
            return nil
        }

        return try? JSONDecoder().decode(PersistedDownloadRootState.self, from: data)
    }

    private func migrateLegacyRootState() -> PersistedDownloadRootState {
        let internalRoot = PersistedDownloadRoot(
            key: Self.legacyDefaultRootKey,
            displayName: L10n.string("settings_download_folder_internal"),
            path: Self.internalDocumentsDirectory(fileManager: fileManager).path,
            bookmarkData: nil,
            isInternal: true
        )

        guard let bookmark = userDefaults.data(forKey: Self.legacyDownloadFolderBookmarkKey) else {
            return PersistedDownloadRootState(
                version: 1,
                roots: [internalRoot],
                defaultRootKey: internalRoot.key
            )
        }

        var stale = false
        if let resolvedURL = try? URL(
            resolvingBookmarkData: bookmark,
            options: Self.bookmarkResolutionOptions,
            relativeTo: nil,
            bookmarkDataIsStale: &stale
        ) {
            let standardizedURL = resolvedURL.standardizedFileURL
            let legacyRoot = PersistedDownloadRoot(
                key: Self.legacyDefaultRootKey,
                displayName: userDefaults.string(forKey: Self.legacyDownloadFolderDisplayNameKey)
                    ?? Self.displayName(for: standardizedURL),
                path: standardizedURL.path,
                bookmarkData: bookmark,
                isInternal: false
            )
            let internalFallback = PersistedDownloadRoot(
                key: Self.internalRootFallbackKey,
                displayName: L10n.string("settings_download_folder_internal"),
                path: internalRoot.path,
                bookmarkData: nil,
                isInternal: true
            )
            return PersistedDownloadRootState(
                version: 1,
                roots: [legacyRoot, internalFallback],
                defaultRootKey: legacyRoot.key
            )
        }

        return PersistedDownloadRootState(
            version: 1,
            roots: [internalRoot],
            defaultRootKey: internalRoot.key
        )
    }

    private func persistAndApply(roots: [PersistedDownloadRoot], defaultRootKey: String) {
        applyPersistedRootState(
            PersistedDownloadRootState(version: 1, roots: roots, defaultRootKey: defaultRootKey),
            persistChanges: true
        )
    }

    private func applyPersistedRootState(
        _ state: PersistedDownloadRootState,
        persistChanges: Bool
    ) {
        stopAccessingSecurityScopedFolders()

        var normalizedRoots = deduplicateRoots(state.roots)
        let internalRoot = ensureInternalRoot(in: &normalizedRoots)
        if normalizedRoots.isEmpty {
            normalizedRoots = [internalRoot]
        }

        var resolvedContentRoots: [ContentRoot] = []
        var restoredRoots: [PersistedDownloadRoot] = []
        var firstError: String?

        for root in normalizedRoots {
            do {
                let resolved = try resolvePersistedRoot(root)
                restoredRoots.append(resolved.root)
                resolvedContentRoots.append(
                    ContentRoot(
                        key: resolved.root.key,
                        label: resolved.root.displayName,
                        path: resolved.url.path
                    )
                )
            } catch {
                if firstError == nil {
                    firstError = L10n.formatted(
                        "settings_download_folder_permission_error",
                        error.localizedDescription
                    )
                }

                let fallbackURL = URL(fileURLWithPath: root.path, isDirectory: true).standardizedFileURL
                restoredRoots.append(root)
                resolvedContentRoots.append(
                    ContentRoot(
                        key: root.key,
                        label: root.displayName,
                        path: fallbackURL.path
                    )
                )
            }
        }

        let resolvedDefaultRootKey: String
        if restoredRoots.contains(where: { $0.key == state.defaultRootKey }) {
            resolvedDefaultRootKey = state.defaultRootKey
        } else if restoredRoots.contains(where: { $0.key == internalRoot.key }) {
            resolvedDefaultRootKey = internalRoot.key
        } else {
            resolvedDefaultRootKey = restoredRoots.first?.key ?? Self.legacyDefaultRootKey
        }

        persistedRoots = restoredRoots
        contentRoots = resolvedContentRoots
        defaultContentRootKey = resolvedDefaultRootKey

        let selectedRoot = restoredRoots.first(where: { $0.key == resolvedDefaultRootKey }) ?? internalRoot
        let selectedURL = URL(fileURLWithPath: selectedRoot.path, isDirectory: true).standardizedFileURL
        downloadBaseDirectoryURL = selectedURL
        downloadLocation = selectedRoot.isInternal
            ? .internalStorage
            : .externalFolder(displayName: selectedRoot.displayName)
        locationChangeToken = UUID().uuidString
        lastError = firstError

        if persistChanges {
            savePersistedRootState(
                PersistedDownloadRootState(
                    version: 1,
                    roots: restoredRoots,
                    defaultRootKey: resolvedDefaultRootKey
                )
            )
            clearLegacyRootKeys()
        }
    }

    private func savePersistedRootState(_ state: PersistedDownloadRootState) {
        guard let data = try? JSONEncoder().encode(state) else {
            return
        }
        userDefaults.set(data, forKey: Self.rootsStateKey)
    }

    private func clearLegacyRootKeys() {
        userDefaults.removeObject(forKey: Self.legacyDownloadFolderBookmarkKey)
        userDefaults.removeObject(forKey: Self.legacyDownloadFolderDisplayNameKey)
    }

    private func deduplicateRoots(_ roots: [PersistedDownloadRoot]) -> [PersistedDownloadRoot] {
        var seenKeys = Set<String>()
        var deduplicated: [PersistedDownloadRoot] = []

        for root in roots {
            guard !root.key.isEmpty, !seenKeys.contains(root.key) else {
                continue
            }
            seenKeys.insert(root.key)
            deduplicated.append(root)
        }

        return deduplicated
    }

    private func ensureInternalRoot(in roots: inout [PersistedDownloadRoot]) -> PersistedDownloadRoot {
        let internalURL = Self.internalDocumentsDirectory(fileManager: fileManager).standardizedFileURL

        if let documentsIndex = roots.firstIndex(where: { $0.key == Self.legacyDefaultRootKey && $0.isInternal }) {
            roots[documentsIndex].displayName = L10n.string("settings_download_folder_internal")
            roots[documentsIndex].path = internalURL.path
            roots[documentsIndex].bookmarkData = nil
            return roots[documentsIndex]
        }

        if let internalIndex = roots.firstIndex(where: { $0.isInternal }) {
            roots[internalIndex].displayName = L10n.string("settings_download_folder_internal")
            roots[internalIndex].path = internalURL.path
            roots[internalIndex].bookmarkData = nil
            return roots[internalIndex]
        }

        let key = roots.contains(where: { $0.key == Self.legacyDefaultRootKey })
            ? Self.internalRootFallbackKey
            : Self.legacyDefaultRootKey
        let internalRoot = PersistedDownloadRoot(
            key: key,
            displayName: L10n.string("settings_download_folder_internal"),
            path: internalURL.path,
            bookmarkData: nil,
            isInternal: true
        )
        roots.append(internalRoot)
        return internalRoot
    }

    private func resolvePersistedRoot(
        _ root: PersistedDownloadRoot
    ) throws -> (root: PersistedDownloadRoot, url: URL) {
        if root.isInternal {
            let internalURL = Self.internalDocumentsDirectory(fileManager: fileManager).standardizedFileURL
            return (
                PersistedDownloadRoot(
                    key: root.key,
                    displayName: L10n.string("settings_download_folder_internal"),
                    path: internalURL.path,
                    bookmarkData: nil,
                    isInternal: true
                ),
                internalURL
            )
        }

        var resolvedRoot = root
        let resolvedURL: URL

        if let bookmarkData = root.bookmarkData {
            var isStale = false
            let url = try URL(
                resolvingBookmarkData: bookmarkData,
                options: Self.bookmarkResolutionOptions,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            let directory = try validateDirectory(url)
            resolvedURL = directory
            resolvedRoot.path = directory.path
            resolvedRoot.displayName = root.displayName.isEmpty ? Self.displayName(for: directory) : root.displayName
            if isStale {
                resolvedRoot.bookmarkData = try directory.bookmarkData(
                    options: Self.bookmarkCreationOptions,
                    includingResourceValuesForKeys: [.nameKey],
                    relativeTo: nil
                )
            }
            if Self.requiresSecurityScopedAccess(directory) {
                guard directory.startAccessingSecurityScopedResource() else {
                    throw CocoaError(.fileReadNoPermission)
                }
                activeSecurityScopedURLs[root.key] = directory
            }
        } else {
            resolvedURL = URL(fileURLWithPath: root.path, isDirectory: true).standardizedFileURL
        }

        return (resolvedRoot, resolvedURL)
    }

    private func stopAccessingSecurityScopedFolders() {
        for url in activeSecurityScopedURLs.values {
            url.stopAccessingSecurityScopedResource()
        }
        activeSecurityScopedURLs.removeAll()
    }

    private func validateDirectory(_ url: URL) throws -> URL {
        let standardizedURL = url.standardizedFileURL
        let values = try standardizedURL.resourceValues(forKeys: [.isDirectoryKey])
        guard values.isDirectory == true else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }

        return standardizedURL
    }

    private func makeExternalRootKey(existingRoots: [PersistedDownloadRoot]) -> String {
        while true {
            let candidate = "root-" + UUID().uuidString.lowercased()
            if !existingRoots.contains(where: { $0.key == candidate }) {
                return candidate
            }
        }
    }

    private static func internalDocumentsDirectory(fileManager: FileManager) -> URL {
        fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
        ?? fileManager.temporaryDirectory
    }

    private static func displayName(for url: URL) -> String {
        let values = try? url.resourceValues(forKeys: [.nameKey, .localizedNameKey])
        return values?.localizedName ?? values?.name ?? url.lastPathComponent
    }

    private static func displayPath(for url: URL) -> String {
        let standardizedURL = url.standardizedFileURL
        let homeURL = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true).standardizedFileURL
        let path = standardizedURL.path
        let homePath = homeURL.path

        if path == homePath {
            return "~"
        }

        if path.hasPrefix(homePath + "/") {
            return "~/" + path.dropFirst(homePath.count + 1)
        }

        let components = standardizedURL.pathComponents.filter { $0 != "/" }
        guard components.count > 2 else {
            return path
        }

        return "…/" + components.suffix(2).joined(separator: "/")
    }

    private static func requiresSecurityScopedAccess(_ url: URL) -> Bool {
        let sandboxPath = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .standardizedFileURL
            .path
        let folderPath = url.standardizedFileURL.path
        return folderPath != sandboxPath && !folderPath.hasPrefix(sandboxPath + "/")
    }
}
