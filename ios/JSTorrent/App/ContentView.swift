import SwiftUI
import JSTorrentKit
import UniformTypeIdentifiers

struct ContentView: View {
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var controller: EngineController
    @State private var isImportingTorrent = false

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
                    .buttonStyle(.bordered)

                    Button("Import .torrent") {
                        isImportingTorrent = true
                    }
                    .buttonStyle(.bordered)

                    Button("Add Test Torrent") {
                        controller.addTestTorrent()
                    }
                    .buttonStyle(.bordered)
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
                                Text(torrent.displayStatus)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                HStack {
                                    Text("\(torrent.progressPercent)%")
                                    Spacer()
                                    Text("Peers \(torrent.numPeers)")
                                }
                                .font(.caption)
                                HStack {
                                    Text("Down \(torrent.downloadSpeed) B/s")
                                    Spacer()
                                    Text("Up \(torrent.uploadSpeed) B/s")
                                }
                                .font(.caption2)
                                .foregroundStyle(.secondary)

                                HStack(spacing: 10) {
                                    Button(torrent.isStopped ? "Resume" : "Pause") {
                                        controller.toggleTorrent(torrent)
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)

                                    Button("Remove", role: .destructive) {
                                        controller.removeTorrent(torrent)
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                }
                            }
                            .padding(.vertical, 4)
                            .swipeActions {
                                Button("Remove", role: .destructive) {
                                    controller.removeTorrent(torrent)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("JSTorrent")
            .fileImporter(
                isPresented: $isImportingTorrent,
                allowedContentTypes: [.torrentFile],
                allowsMultipleSelection: false
            ) { result in
                controller.handleFileImportResult(result)
            }
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
    ContentView(
        controller: EngineController(
            bootstrapConfig: EngineBootstrapConfig(
                contentRoots: [
                    ContentRoot(key: "documents", label: "Documents")
                ],
                defaultContentRoot: "documents"
            )
        )
    )
}

private extension UTType {
    static let torrentFile = UTType(importedAs: "org.bittorrent.torrent")
}
