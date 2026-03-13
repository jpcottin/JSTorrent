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
        self.controller = Self.makeController(downloadBaseDirectory: settings.downloadBaseDirectoryURL)

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
        controller = Self.makeController(downloadBaseDirectory: settings.downloadBaseDirectoryURL)
    }

    private static func makeController(downloadBaseDirectory: URL) -> EngineController {
        EngineController(
            bootstrapConfig: EngineBootstrapConfig(
                contentRoots: [
                    ContentRoot(key: "documents", label: L10n.string("content_root_documents_label"))
                ],
                defaultContentRoot: "documents"
            ),
            fileBaseDirectory: downloadBaseDirectory
        )
    }
}
