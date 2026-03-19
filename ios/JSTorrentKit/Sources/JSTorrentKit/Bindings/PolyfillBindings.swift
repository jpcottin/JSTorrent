import Foundation
import JavaScriptCore
import Security

public final class PolyfillBindings {
    private let engine: JSEngine
    private let timerRegistry: TimerRegistry
    private let logHandler: @Sendable (String, String) -> Void

    public init(
        engine: JSEngine,
        logHandler: @escaping @Sendable (String, String) -> Void = { level, message in
            NSLog("[JSTorrent:%@] %@", level, message)
        }
    ) {
        self.engine = engine
        self.timerRegistry = TimerRegistry(engine: engine)
        self.logHandler = logHandler
    }

    public func register() {
        maybeForceBase64Polyfill()
        registerTextBindings()
        registerRandomBindings()
        registerConsoleBindings()
        registerTimerBindings()
    }

    private func maybeForceBase64Polyfill() {
#if DEBUG
        guard ProcessInfo.processInfo.environment["JST_FORCE_BASE64_POLYFILL"] == "1" else {
            return
        }

        do {
            _ = try engine.evaluate(
                """
                delete globalThis.atob;
                delete globalThis.btoa;
                """,
                filename: "force-base64-polyfill.js"
            )
            logHandler("info", "Forcing JS base64 polyfill for debugging")
        } catch {
            logHandler(
                "warn",
                "Failed to force JS base64 polyfill: \(error.localizedDescription)"
            )
        }
#endif
    }

    private func registerTextBindings() {
        engine.setGlobalFunction("__jstorrent_text_encode") { arguments in
            let value = arguments.first?.toString() ?? ""
            return .binary(Data(value.utf8))
        }

        engine.setGlobalFunction("__jstorrent_text_decode") { [weak engine] arguments in
            guard
                let engine,
                let data = try engine.data(from: arguments.first)
            else {
                return .value("")
            }

            return .value(String(decoding: data, as: UTF8.self))
        }
    }

    private func registerRandomBindings() {
        engine.setGlobalFunction("__jstorrent_random_bytes") { arguments in
            let requestedLength = max(arguments.first?.toInt32() ?? 0, 0)
            let count = Int(requestedLength)
            var bytes = [UInt8](repeating: 0, count: count)
            let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
            if status != errSecSuccess {
                throw NSError(
                    domain: NSOSStatusErrorDomain,
                    code: Int(status),
                    userInfo: [NSLocalizedDescriptionKey: "SecRandomCopyBytes failed with status \(status)"]
                )
            }
            return .binary(Data(bytes))
        }
    }

    private func registerConsoleBindings() {
        engine.setGlobalFunction("__jstorrent_console_log") { [logHandler] arguments in
            let level = arguments.first?.toString() ?? "info"
            let message = arguments.dropFirst().first?.toString() ?? ""
            logHandler(level, message)
            return .undefined
        }
    }

    private func registerTimerBindings() {
        engine.setGlobalFunction("__jstorrent_set_timeout") { [timerRegistry] arguments in
            guard let callback = arguments.first, callback.isObject else {
                throw JSEngineError.javaScriptException("__jstorrent_set_timeout requires a callback")
            }
            let delay = Int(arguments.dropFirst().first?.toInt32() ?? 0)
            return .value(timerRegistry.setTimeout(callback: callback, delayMilliseconds: delay))
        }

        engine.setGlobalFunction("__jstorrent_clear_timeout") { [timerRegistry] arguments in
            let id = Int(arguments.first?.toInt32() ?? 0)
            timerRegistry.clearTimer(id)
            return .undefined
        }

        engine.setGlobalFunction("__jstorrent_set_interval") { [timerRegistry] arguments in
            guard let callback = arguments.first, callback.isObject else {
                throw JSEngineError.javaScriptException("__jstorrent_set_interval requires a callback")
            }
            let delay = Int(arguments.dropFirst().first?.toInt32() ?? 0)
            return .value(timerRegistry.setInterval(callback: callback, intervalMilliseconds: delay))
        }

        engine.setGlobalFunction("__jstorrent_clear_interval") { [timerRegistry] arguments in
            let id = Int(arguments.first?.toInt32() ?? 0)
            timerRegistry.clearTimer(id)
            return .undefined
        }
    }
}
