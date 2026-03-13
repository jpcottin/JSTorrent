import Combine
import Foundation

@MainActor
final class AppSettings: ObservableObject {
    enum DownloadLocation: Equatable {
        case internalStorage
        case externalFolder(displayName: String)
    }

    @Published private(set) var downloadLocation: DownloadLocation = .internalStorage
    @Published private(set) var downloadBaseDirectoryURL: URL
    @Published private(set) var locationChangeToken: String
    @Published var lastError: String?

    private let userDefaults: UserDefaults
    private let fileManager: FileManager
    private var activeSecurityScopedURL: URL?

    private static let downloadFolderBookmarkKey = "settings.download-folder-bookmark"
    private static let downloadFolderDisplayNameKey = "settings.download-folder-display-name"
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
        self.locationChangeToken = "internal:\(internalURL.path)"

        restoreDownloadFolder()
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

    var usesExternalDownloadFolder: Bool {
        if case .externalFolder = downloadLocation {
            return true
        }

        return false
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

            try activateExternalFolder(directory, displayName: displayName)
            userDefaults.set(bookmark, forKey: Self.downloadFolderBookmarkKey)
            userDefaults.set(displayName, forKey: Self.downloadFolderDisplayNameKey)
            lastError = nil
        } catch {
            lastError = L10n.formatted(
                "settings_download_folder_save_error",
                error.localizedDescription
            )
        }
    }

    func resetDownloadFolderToInternal() {
        stopAccessingSecurityScopedFolder()
        userDefaults.removeObject(forKey: Self.downloadFolderBookmarkKey)
        userDefaults.removeObject(forKey: Self.downloadFolderDisplayNameKey)

        let internalURL = Self.internalDocumentsDirectory(fileManager: fileManager)
        downloadLocation = .internalStorage
        downloadBaseDirectoryURL = internalURL
        locationChangeToken = "internal:\(internalURL.path)"
        lastError = nil
    }

    private func restoreDownloadFolder() {
        guard let bookmark = userDefaults.data(forKey: Self.downloadFolderBookmarkKey) else {
            resetDownloadFolderToInternal()
            return
        }

        do {
            var isStale = false
            let resolvedURL = try URL(
                resolvingBookmarkData: bookmark,
                options: Self.bookmarkResolutionOptions,
                relativeTo: nil,
                bookmarkDataIsStale: &isStale
            )
            let directory = try validateDirectory(resolvedURL)

            if isStale {
                let refreshedBookmark = try directory.bookmarkData(
                    options: Self.bookmarkCreationOptions,
                    includingResourceValuesForKeys: [.nameKey],
                    relativeTo: nil
                )
                userDefaults.set(refreshedBookmark, forKey: Self.downloadFolderBookmarkKey)
            }

            let storedName = userDefaults.string(forKey: Self.downloadFolderDisplayNameKey)
            try activateExternalFolder(directory, displayName: storedName ?? Self.displayName(for: directory))
            lastError = nil
        } catch {
            resetDownloadFolderToInternal()
            lastError = L10n.formatted(
                "settings_download_folder_permission_error",
                error.localizedDescription
            )
        }
    }

    private func activateExternalFolder(_ url: URL, displayName: String) throws {
        stopAccessingSecurityScopedFolder()

        let folderURL = url.standardizedFileURL
        if Self.requiresSecurityScopedAccess(folderURL) {
            guard folderURL.startAccessingSecurityScopedResource() else {
                throw CocoaError(.fileReadNoPermission)
            }
            activeSecurityScopedURL = folderURL
        } else {
            activeSecurityScopedURL = nil
        }
        downloadLocation = .externalFolder(displayName: displayName)
        downloadBaseDirectoryURL = folderURL
        locationChangeToken = "external:\(folderURL.path)"
    }

    private func stopAccessingSecurityScopedFolder() {
        guard let activeSecurityScopedURL else {
            return
        }

        activeSecurityScopedURL.stopAccessingSecurityScopedResource()
        self.activeSecurityScopedURL = nil
    }

    private func validateDirectory(_ url: URL) throws -> URL {
        let standardizedURL = url.standardizedFileURL
        let values = try standardizedURL.resourceValues(forKeys: [.isDirectoryKey])
        guard values.isDirectory == true else {
            throw CocoaError(.fileReadUnsupportedScheme)
        }

        return standardizedURL
    }

    private static func internalDocumentsDirectory(fileManager: FileManager) -> URL {
        fileManager.urls(for: .documentDirectory, in: .userDomainMask).first
        ?? fileManager.temporaryDirectory
    }

    private static func displayName(for url: URL) -> String {
        let values = try? url.resourceValues(forKeys: [.nameKey, .localizedNameKey])
        return values?.localizedName ?? values?.name ?? url.lastPathComponent
    }

    private static func requiresSecurityScopedAccess(_ url: URL) -> Bool {
        let sandboxPath = URL(fileURLWithPath: NSHomeDirectory(), isDirectory: true)
            .standardizedFileURL
            .path
        let folderPath = url.standardizedFileURL.path
        return folderPath != sandboxPath && !folderPath.hasPrefix(sandboxPath + "/")
    }
}
