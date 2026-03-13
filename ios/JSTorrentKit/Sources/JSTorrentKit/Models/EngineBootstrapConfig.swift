import Foundation

public enum NativePlatformType: String, Codable, Sendable {
    case androidStandalone = "android-standalone"
    case iosStandalone = "ios-standalone"
}

public enum NativeStorageMode: String, Codable, Sendable {
    case native
    case null
}

public struct ContentRoot: Codable, Hashable, Sendable {
    public var key: String
    public var label: String
    public var path: String?

    public init(key: String, label: String, path: String? = nil) {
        self.key = key
        self.label = label
        self.path = path
    }
}

public struct EngineBootstrapConfig: Codable, Hashable, Sendable {
    public var contentRoots: [ContentRoot]
    public var defaultContentRoot: String?
    public var port: Int?
    public var platformType: NativePlatformType
    public var storageMode: NativeStorageMode?
    public var shouldRemainSuspended: Bool

    public init(
        contentRoots: [ContentRoot],
        defaultContentRoot: String? = nil,
        port: Int? = nil,
        platformType: NativePlatformType = .iosStandalone,
        storageMode: NativeStorageMode? = nil,
        shouldRemainSuspended: Bool = false
    ) {
        self.contentRoots = contentRoots
        self.defaultContentRoot = defaultContentRoot
        self.port = port
        self.platformType = platformType
        self.storageMode = storageMode
        self.shouldRemainSuspended = shouldRemainSuspended
    }
}
