import SwiftUI
import JSTorrentKit

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var controller: EngineController
    @State private var path: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            TorrentListScreen(controller: controller) { infoHash in
                path.append(infoHash)
            }
            .navigationDestination(for: String.self) { infoHash in
                TorrentDetailScreen(controller: controller, infoHash: infoHash)
            }
        }
        .task {
            if scenePhase == .active {
                controller.resumeIfStarted()
            }
        }
        .onChange(of: scenePhase) { newPhase in
            switch newPhase {
            case .active:
                controller.resumeIfStarted()
            case .inactive:
                break
            case .background:
                controller.shutdown()
            @unknown default:
                break
            }
        }
    }
}

#Preview {
    ContentView(
        controller: EngineController(
            bootstrapConfig: EngineBootstrapConfig(
                contentRoots: [
                    ContentRoot(key: "documents", label: L10n.string("content_root_documents_label"))
                ],
                defaultContentRoot: "documents"
            )
        )
    )
}
