import SwiftUI
import JSTorrentKit

struct ContentView: View {
    private let bootstrapConfig = EngineBootstrapConfig(
        contentRoots: [
            ContentRoot(key: "documents", label: "Documents")
        ]
    )

    var body: some View {
        NavigationStack {
            List {
                Section("Runtime") {
                    LabeledContent("Platform", value: bootstrapConfig.platformType.rawValue)
                    LabeledContent("Roots", value: String(bootstrapConfig.contentRoots.count))
                }

                Section("Status") {
                    Text("iOS scaffold ready for JSCore host implementation.")
                        .foregroundStyle(.secondary)
                }
            }
            .navigationTitle("JSTorrent")
        }
    }
}

#Preview {
    ContentView()
}
