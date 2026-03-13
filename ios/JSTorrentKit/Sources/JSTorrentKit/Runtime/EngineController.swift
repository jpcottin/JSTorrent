import Combine
import Foundation

public enum EngineControllerStatus: Equatable, Sendable {
    case idle
    case starting
    case running
    case failed(String)

    public var label: String {
        switch self {
        case .idle:
            return "Idle"
        case .starting:
            return "Starting"
        case .running:
            return "Running"
        case .failed(let message):
            return "Failed: \(message)"
        }
    }
}

@MainActor
public final class EngineController: ObservableObject {
    @Published public private(set) var status: EngineControllerStatus = .idle
    @Published public private(set) var torrents: [TorrentListItem] = []
    @Published public private(set) var lastError: String?
    @Published public var magnetInput = ""

    private let bootstrapConfig: EngineBootstrapConfig
    private let bundle: Bundle
    private let fileBaseDirectory: URL?
    private let tickQueue = DispatchQueue(label: "com.jstorrent.ios.tick")
    private var tickTimer: DispatchSourceTimer?
    private var runtime: JSTorrentRuntime?

    public init(
        bootstrapConfig: EngineBootstrapConfig,
        bundle: Bundle = .main,
        fileBaseDirectory: URL? = nil
    ) {
        self.bootstrapConfig = bootstrapConfig
        self.bundle = bundle
        self.fileBaseDirectory = fileBaseDirectory
    }

    public func startIfNeeded() {
        guard runtime == nil else {
            return
        }

        status = .starting
        lastError = nil

        do {
            let sink = NativeEventSink(
                onStateUpdate: { [weak self] payload in
                    Task { @MainActor in
                        self?.applyStateUpdate(payload: payload)
                    }
                },
                onError: { [weak self] payload in
                    Task { @MainActor in
                        self?.applyRuntimeError(payload: payload)
                    }
                }
            )

            let runtime = try JSTorrentRuntime(
                eventSink: sink,
                fileBaseDirectory: fileBaseDirectory
            )
            try runtime.loadDefaultBundle(in: bundle)
            try runtime.initialize(with: bootstrapConfig)
            try runtime.setTickMode(.host)
            try runtime.subscribe(type: "torrents", intervalMs: 500)

            self.runtime = runtime
            startTickLoop()
            status = .running
        } catch {
            status = .failed(error.localizedDescription)
            lastError = error.localizedDescription
        }
    }

    public func addMagnet() {
        let input = magnetInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty, let runtime else {
            return
        }

        do {
            try runtime.addTorrent(input)
            magnetInput = ""
        } catch {
            lastError = error.localizedDescription
            status = .failed(error.localizedDescription)
        }
    }

    public func addTestTorrent() {
        guard let runtime else {
            return
        }

        do {
            try runtime.addTestTorrent()
        } catch {
            lastError = error.localizedDescription
            status = .failed(error.localizedDescription)
        }
    }

    func applyStateUpdate(payload: String) {
        guard let data = payload.data(using: .utf8) else {
            return
        }

        guard let decoded = try? JSONDecoder().decode(EngineStatePayload.self, from: data) else {
            return
        }

        if let torrents = decoded.torrents {
            self.torrents = torrents
        }
    }

    func applyRuntimeError(payload: String) {
        if let data = payload.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let error = object["error"] as? String {
            lastError = error
            status = .failed(error)
            return
        }

        lastError = payload
        status = .failed(payload)
    }

    private func startTickLoop() {
        let timer = DispatchSource.makeTimerSource(queue: tickQueue)
        timer.schedule(deadline: .now(), repeating: .milliseconds(100))
        timer.setEventHandler { [weak self] in
            guard let self else {
                return
            }

            do {
                _ = try self.runtime?.tick()
            } catch {
                Task { @MainActor in
                    self.lastError = error.localizedDescription
                    self.status = .failed(error.localizedDescription)
                }
            }
        }
        tickTimer = timer
        timer.resume()
    }

    deinit {
        tickTimer?.cancel()
    }
}
