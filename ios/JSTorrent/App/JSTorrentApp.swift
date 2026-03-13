import SwiftUI

@main
struct JSTorrentApp: App {
    @StateObject private var appModel = AppModel()

    var body: some Scene {
        WindowGroup {
            ContentView(appModel: appModel)
                .onOpenURL { url in
                    appModel.handleIncomingURL(url)
                }
        }
    }
}
