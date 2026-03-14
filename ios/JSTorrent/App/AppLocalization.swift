import Foundation

enum L10n {
    static func string(_ key: String) -> String {
        LocalizationStore.shared.string(for: key)
    }

    static func formatted(_ key: String, _ arguments: CVarArg...) -> String {
        let format = string(key)
        return String(format: format, locale: Locale.current, arguments: arguments)
    }
}

private final class LocalizationStore {
    static let shared = LocalizationStore()

    private let bundle: Bundle
    private let baseStrings: [String: String]
    private let localizedStrings: [String: String]

    private init(bundle: Bundle = .main) {
        self.bundle = bundle
        self.baseStrings = Self.loadLocale("en", bundle: bundle)
        self.localizedStrings = Self.loadBestAvailableLocale(bundle: bundle) ?? [:]
    }

    func string(for key: String) -> String {
        localizedStrings[key] ?? baseStrings[key] ?? key
    }

    private static func loadBestAvailableLocale(bundle: Bundle) -> [String: String]? {
        for preferredLanguage in Locale.preferredLanguages {
            for candidate in candidateLocaleTags(for: preferredLanguage) {
                let strings = loadLocale(candidate, bundle: bundle)
                if !strings.isEmpty {
                    return strings
                }
            }
        }

        return nil
    }

    private static func candidateLocaleTags(for preferredLanguage: String) -> [String] {
        let normalized = preferredLanguage.replacingOccurrences(of: "_", with: "-")
        var candidates: [String] = []

        func append(_ candidate: String?) {
            guard let candidate, !candidate.isEmpty, !candidates.contains(candidate) else {
                return
            }
            candidates.append(candidate)
        }

        append(normalized)

        let components = normalized.split(separator: "-")
        if let language = components.first {
            let languageCode = String(language)

            if languageCode == "zh" {
                if normalized.localizedCaseInsensitiveContains("Hant") {
                    append("zh-TW")
                } else if normalized.localizedCaseInsensitiveContains("Hans") {
                    append("zh-CN")
                }
            }

            if components.count >= 2 {
                let region = String(components[1]).uppercased()
                if region.count == 2 {
                    append("\(languageCode)-\(region)")
                }
            }

            append(languageCode)
        }

        append("en")
        return candidates
    }

    private static func loadLocale(_ localeTag: String, bundle: Bundle) -> [String: String] {
        let resourceURLs = [
            bundle.url(forResource: localeTag, withExtension: "json", subdirectory: "Localization"),
            bundle.url(forResource: localeTag, withExtension: "json")
        ]

        for url in resourceURLs.compactMap({ $0 }) {
            if
                let data = try? Data(contentsOf: url),
                let dictionary = try? JSONDecoder().decode([String: String].self, from: data)
            {
                return dictionary
            }
        }

        return [:]
    }
}
