import Foundation

public final class StorageBindings {
    private let userDefaults: UserDefaults

    public init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults
    }

    public func register(on engine: JSEngine) {
        engine.setGlobalFunction("__jstorrent_storage_get") { [userDefaults] arguments in
            let key = arguments.first?.toString() ?? ""
            guard !key.isEmpty else {
                return .value(nil)
            }
            return .value(userDefaults.string(forKey: key))
        }

        engine.setGlobalFunction("__jstorrent_storage_set") { [userDefaults] arguments in
            guard
                let key = arguments.first?.toString(),
                !key.isEmpty,
                let value = arguments.dropFirst().first?.toString()
            else {
                return .undefined
            }

            userDefaults.set(value, forKey: key)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_storage_delete") { [userDefaults] arguments in
            guard let key = arguments.first?.toString(), !key.isEmpty else {
                return .undefined
            }

            userDefaults.removeObject(forKey: key)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_storage_keys") { [userDefaults] arguments in
            let prefix = arguments.first?.toString() ?? ""
            let keys = userDefaults.dictionaryRepresentation().keys
                .filter { $0.hasPrefix(prefix) }
                .sorted()
            let data = try JSONSerialization.data(withJSONObject: keys, options: [])
            return .value(String(decoding: data, as: UTF8.self))
        }
    }
}
