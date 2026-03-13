import SwiftUI
import JSTorrentKit

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var controller = EngineController(
        bootstrapConfig: EngineBootstrapConfig(
            contentRoots: [
                ContentRoot(key: "documents", label: "Documents")
            ],
            defaultContentRoot: "documents"
        )
    )

    var body: some View {
        NavigationStack {
            List {
                Section("Runtime") {
                    LabeledContent("Status", value: controller.status.label)
                    LabeledContent("Torrents", value: String(controller.torrents.count))
                }

                Section("Add Torrent") {
                    TextField("Paste magnet link", text: $controller.magnetInput, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button("Add Magnet") {
                        controller.addMagnet()
                    }
                    .disabled(controller.magnetInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

                    Button("Add Test Torrent") {
                        controller.addTestTorrent()
                    }
                }

                if let lastError = controller.lastError {
                    Section("Error") {
                        Text(lastError)
                            .foregroundStyle(.red)
                    }
                }

                Section("Torrents") {
                    if controller.torrents.isEmpty {
                        Text("No torrents yet.")
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(controller.torrents) { torrent in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(torrent.name)
                                    .font(.headline)
                                Text(torrent.status.capitalized)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                HStack {
                                    Text("\(Int(torrent.progress * 100))%")
                                    Spacer()
                                    Text("Peers \(torrent.numPeers)")
                                }
                                .font(.caption)
                            }
                            .padding(.vertical, 4)
                        }
                    }
                }
            }
            .navigationTitle("JSTorrent")
            .task {
                controller.startIfNeeded()
                if scenePhase == .active {
                    controller.resume()
                }
            }
            .onChange(of: scenePhase) { newPhase in
                switch newPhase {
                case .active:
                    controller.startIfNeeded()
                    controller.resume()
                case .inactive, .background:
                    controller.suspend()
                @unknown default:
                    break
                }
            }
        }
    }
}

#Preview {
    ContentView()
}
