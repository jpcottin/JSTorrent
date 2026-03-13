import Combine
import Foundation

protocol EngineRuntimeHandling: AnyObject {
    func prepareDefaultBundle(in bundle: Bundle) throws
    func bootstrap(with config: EngineBootstrapConfig) throws
    func subscribe(type: String, hash: String, intervalMs: Int) throws
    func setTickMode(_ mode: EngineTickMode) throws
    func addTorrent(_ magnetOrBase64: String) throws
    func addTestTorrent() throws
    func queryTorrentList() throws -> EngineStatePayload
    func pauseTorrent(_ infoHash: String) throws
    func resumeTorrent(_ infoHash: String) throws
    func removeTorrent(_ infoHash: String, deleteFiles: Bool) throws
    func tick() throws -> EngineTickResult
}

extension JSTorrentRuntime: EngineRuntimeHandling {
    func prepareDefaultBundle(in bundle: Bundle) throws {
        _ = try loadDefaultBundle(in: bundle)
    }

    func bootstrap(with config: EngineBootstrapConfig) throws {
        try initialize(with: config)
    }
}

enum EngineControllerIntakeError: LocalizedError {
    case emptyImportSelection
    case unsupportedURL(URL)

    var errorDescription: String? {
        switch self {
        case .emptyImportSelection:
            return "No torrent file was selected."
        case .unsupportedURL(let url):
            return "Unsupported torrent input: \(url.absoluteString)"
        }
    }
}

public enum EngineControllerStatus: Equatable, Sendable {
    case idle
    case starting
    case running
    case suspended
    case failed(String)

    public var label: String {
        switch self {
        case .idle:
            return "Idle"
        case .starting:
            return "Starting"
        case .running:
            return "Running"
        case .suspended:
            return "Suspended"
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
    private let runtimeFactory: (NativeEventSink, URL?) throws -> any EngineRuntimeHandling
    private let tickQueue = DispatchQueue(label: "com.jstorrent.ios.tick")
    private var tickTimer: DispatchSourceTimer?
    private let minimumTickDelayMs: Int32 = 1
    private let subscriptionIntervalMs = 100
    private var runtime: (any EngineRuntimeHandling)?
    private var pendingTorrentPayloads: [String] = []

    public init(
        bootstrapConfig: EngineBootstrapConfig,
        bundle: Bundle = .main,
        fileBaseDirectory: URL? = nil
    ) {
        self.bootstrapConfig = bootstrapConfig
        self.bundle = bundle
        self.fileBaseDirectory = fileBaseDirectory
        self.runtimeFactory = { sink, fileBaseDirectory in
            try JSTorrentRuntime(
                eventSink: sink,
                fileBaseDirectory: fileBaseDirectory
            )
        }
    }

    init(
        bootstrapConfig: EngineBootstrapConfig,
        bundle: Bundle = .main,
        fileBaseDirectory: URL? = nil,
        runtimeFactory: @escaping (NativeEventSink, URL?) throws -> any EngineRuntimeHandling
    ) {
        self.bootstrapConfig = bootstrapConfig
        self.bundle = bundle
        self.fileBaseDirectory = fileBaseDirectory
        self.runtimeFactory = runtimeFactory
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

            let runtime = try runtimeFactory(sink, fileBaseDirectory)
            try runtime.prepareDefaultBundle(in: bundle)
            try runtime.bootstrap(with: bootstrapConfig)
            try runtime.subscribe(type: "torrents", hash: "", intervalMs: subscriptionIntervalMs)

            self.runtime = runtime
            resume()
            processPendingTorrentPayloads()
            scheduleTorrentRefreshes()
        } catch {
            handle(error)
        }
    }

    public func resume() {
        guard let runtime else {
            return
        }

        guard tickTimer == nil else {
            if status == .suspended {
                status = .running
            }
            return
        }

        do {
            try runtime.setTickMode(.host)
            startTickLoop()
            status = .running
        } catch {
            handle(error)
        }
    }

    public func suspend() {
        stopTickLoop()

        guard let runtime else {
            return
        }

        do {
            try runtime.setTickMode(.js)
            if case .failed = status {
                return
            }
            status = .suspended
        } catch {
            handle(error)
        }
    }

    public func addMagnet() {
        let input = magnetInput.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else {
            return
        }

        addTorrent(input)
        magnetInput = ""
    }

    public func addTorrent(_ magnetOrBase64: String) {
        let input = magnetOrBase64.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !input.isEmpty else {
            return
        }

        submitTorrentPayload(input)
    }

    public func addTorrentFileData(_ data: Data) {
        guard !data.isEmpty else {
            handle(NSError(domain: "JSTorrent.EngineController", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Selected torrent file was empty."
            ]))
            return
        }

        submitTorrentPayload(data.base64EncodedString())
    }

    public func importTorrentFile(from url: URL) {
        do {
            let data = try loadFileData(from: url)
            addTorrentFileData(data)
        } catch {
            handle(error)
        }
    }

    public func handleIncomingURL(_ url: URL) {
        if url.isFileURL {
            importTorrentFile(from: url)
            return
        }

        if url.scheme?.caseInsensitiveCompare("magnet") == .orderedSame {
            addTorrent(url.absoluteString)
            return
        }

        handle(EngineControllerIntakeError.unsupportedURL(url))
    }

    public func handleFileImportResult(_ result: Result<[URL], Error>) {
        switch result {
        case .success(let urls):
            guard let url = urls.first else {
                handle(EngineControllerIntakeError.emptyImportSelection)
                return
            }
            importTorrentFile(from: url)
        case .failure(let error):
            handle(error)
        }
    }

    public func addTestTorrent() {
        guard let runtime else {
            return
        }

        do {
            try runtime.addTestTorrent()
            noteSuccessfulCommand()
            scheduleTorrentRefreshes()
        } catch {
            handle(error)
        }
    }

    public func toggleTorrent(_ torrent: TorrentListItem) {
        guard let runtime else {
            return
        }

        do {
            if torrent.isStopped {
                try runtime.resumeTorrent(torrent.infoHash)
            } else {
                try runtime.pauseTorrent(torrent.infoHash)
            }
            noteSuccessfulCommand()
            scheduleTorrentRefreshes()
        } catch {
            handle(error)
        }
    }

    public func removeTorrent(_ torrent: TorrentListItem) {
        guard let runtime else {
            return
        }

        do {
            try runtime.removeTorrent(torrent.infoHash, deleteFiles: false)
            noteSuccessfulCommand()
            scheduleTorrentRefreshes()
        } catch {
            handle(error)
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

    private func refreshTorrentList() {
        guard let runtime else {
            return
        }

        do {
            let payload = try runtime.queryTorrentList()
            torrents = payload.torrents ?? []
        } catch {
            handle(error)
        }
    }

    private func submitTorrentPayload(_ payload: String) {
        guard let runtime else {
            pendingTorrentPayloads.append(payload)
            startIfNeeded()
            return
        }

        executeTorrentPayload(payload, using: runtime)
    }

    private func processPendingTorrentPayloads() {
        guard let runtime, !pendingTorrentPayloads.isEmpty else {
            return
        }

        let pendingPayloads = pendingTorrentPayloads
        pendingTorrentPayloads.removeAll(keepingCapacity: true)
        for payload in pendingPayloads {
            executeTorrentPayload(payload, using: runtime)
        }
    }

    private func executeTorrentPayload(
        _ payload: String,
        using runtime: any EngineRuntimeHandling
    ) {
        do {
            try runtime.addTorrent(payload)
            noteSuccessfulCommand()
            scheduleTorrentRefreshes()
        } catch {
            handle(error)
        }
    }

    private func loadFileData(from url: URL) throws -> Data {
        let didAccessSecurityScopedResource = url.startAccessingSecurityScopedResource()
        defer {
            if didAccessSecurityScopedResource {
                url.stopAccessingSecurityScopedResource()
            }
        }

        return try Data(contentsOf: url)
    }

    private func noteSuccessfulCommand() {
        lastError = nil

        if case .failed = status {
            status = tickTimer == nil ? .suspended : .running
        }
    }

    private func handle(_ error: Error) {
        let message = error.localizedDescription
        lastError = message
        status = .failed(message)
    }

    private func scheduleTorrentRefreshes() {
        for delayMs in [0, 150, 500] {
            Task { @MainActor [weak self] in
                guard let self else {
                    return
                }

                if delayMs > 0 {
                    try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                }

                self.refreshTorrentList()
            }
        }
    }

    private func startTickLoop() {
        guard tickTimer == nil else {
            return
        }

        let timer = DispatchSource.makeTimerSource(queue: tickQueue)
        timer.schedule(deadline: .now())
        timer.setEventHandler { [weak self, weak timer] in
            guard let self, let timer else {
                return
            }

            do {
                let tick = try self.runtime?.tick()
                let nextDelayMs = max(self.minimumTickDelayMs, tick?.delayMs ?? 100)
                timer.schedule(deadline: .now() + .milliseconds(Int(nextDelayMs)))
                Task { @MainActor in
                    if self.status == .suspended {
                        self.status = .running
                    }
                }
            } catch {
                Task { @MainActor in
                    self.lastError = error.localizedDescription
                    self.status = .failed(error.localizedDescription)
                    self.stopTickLoop()
                }
            }
        }
        tickTimer = timer
        timer.resume()
    }

    private func stopTickLoop() {
        guard let timer = tickTimer else {
            return
        }

        tickTimer = nil
        timer.setEventHandler {}
        timer.cancel()
    }
}
