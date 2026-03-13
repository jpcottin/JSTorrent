import Combine
import Foundation
import JSTorrentKit

@MainActor
final class AppModel: ObservableObject {
    @Published private(set) var controller: EngineController
    let settings: AppSettings

    private var cancellables: Set<AnyCancellable> = []

    convenience init() {
        self.init(settings: AppSettings())
    }

    init(settings: AppSettings) {
        self.settings = settings
        self.controller = Self.makeController(settings: settings)

        settings.$locationChangeToken
            .dropFirst()
            .removeDuplicates()
            .sink { [weak self] _ in
                self?.rebuildController()
            }
            .store(in: &cancellables)
    }

    func handleIncomingURL(_ url: URL) {
        controller.handleIncomingURL(url)
    }

    private func rebuildController() {
        controller.shutdown()
        controller = Self.makeController(settings: settings)
    }

    private static func makeController(settings: AppSettings) -> EngineController {
        EngineController(
            bootstrapConfig: EngineBootstrapConfig(
                contentRoots: settings.contentRoots,
                defaultContentRoot: settings.defaultContentRootKey
            ),
            fileBaseDirectory: settings.downloadBaseDirectoryURL
        )
    }
}
