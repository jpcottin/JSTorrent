import Foundation

public enum EngineBundleError: Error, LocalizedError {
    case fileNotFound(URL)
    case unreadable(URL)

    public var errorDescription: String? {
        switch self {
        case .fileNotFound(let url):
            return "Engine bundle not found at \(url.path)."
        case .unreadable(let url):
            return "Engine bundle could not be read at \(url.path)."
        }
    }
}

public enum EngineBundle {
    public static func load(from url: URL) throws -> String {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw EngineBundleError.fileNotFound(url)
        }

        guard let source = try? String(contentsOf: url, encoding: .utf8) else {
            throw EngineBundleError.unreadable(url)
        }

        return source
    }
}
