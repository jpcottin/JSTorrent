import SwiftUI

private enum AppRoute: Hashable {
    case torrent(String)
    case search
    case settings
}

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var appModel: AppModel
    @State private var path: [AppRoute] = []

    var body: some View {
        NavigationStack(path: $path) {
            TorrentListScreen(
                controller: appModel.controller,
                settings: appModel.settings,
                onOpenSearch: {
                    path.append(.search)
                },
                onOpenSettings: {
                    path.append(.settings)
                },
                onTorrentSelected: { infoHash in
                    path.append(.torrent(infoHash))
                }
            )
            .navigationDestination(for: AppRoute.self) { route in
                switch route {
                case .torrent(let infoHash):
                    TorrentDetailScreen(
                        controller: appModel.controller,
                        settings: appModel.settings,
                        infoHash: infoHash
                    )
                case .search:
                    SearchScreen(controller: appModel.controller)
                case .settings:
                    SettingsScreen(settings: appModel.settings)
                }
            }
        }
        .task {
            if scenePhase == .active {
                appModel.controller.resumeIfStarted()
            }
        }
        .onChange(of: scenePhase) { newPhase in
            switch newPhase {
            case .active:
                appModel.controller.resumeIfStarted()
            case .inactive:
                break
            case .background:
                appModel.controller.shutdown()
            @unknown default:
                break
            }
        }
    }
}

#Preview {
    ContentView(appModel: AppModel())
}
