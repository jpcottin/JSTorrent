import SwiftUI
import JSTorrentKit

@main
struct JSTorrentApp: App {
    @StateObject private var controller = EngineController(
        bootstrapConfig: EngineBootstrapConfig(
            contentRoots: [
                ContentRoot(key: "documents", label: "Documents")
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
