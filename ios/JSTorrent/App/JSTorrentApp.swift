import SwiftUI
import JSTorrentKit

@main
struct JSTorrentApp: App {
    @StateObject private var controller = EngineController(
        bootstrapConfig: EngineBootstrapConfig(
            contentRoots: [
                ContentRoot(key: "documents", label: L10n.string("content_root_documents_label"))
            ],
            defaultContentRoot: "documents"
        )
    )

    var body: some Scene {
        WindowGroup {
            ContentView(controller: controller)
                .onOpenURL { url in
                    controller.handleIncomingURL(url)
                }
        }
    }
}
