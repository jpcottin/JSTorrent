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
                Section(L10n.string("ios_runtime_section_title")) {
                    LabeledContent(
                        L10n.string("ios_runtime_status_label"),
                        value: localizedEngineStatus(controller.status)
                    )
                    LabeledContent(
                        L10n.string("ios_runtime_torrents_label"),
                        value: String(controller.torrents.count)
                    )
                }

                Section(L10n.string("dialog_add_torrent_title")) {
                    TextField(L10n.string("dialog_add_torrent_magnet_hint"), text: $controller.magnetInput, axis: .vertical)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()

                    Button(L10n.string("dialog_add_torrent_add_button")) {
                        controller.addMagnet()
                    }
                    .disabled(controller.magnetInput.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .buttonStyle(.bordered)

                    Button(L10n.string("dialog_add_torrent_browse_button")) {
                        isImportingTorrent = true
                    }
                    .buttonStyle(.bordered)

                    Button(L10n.string("ios_add_test_torrent")) {
                        controller.addTestTorrent()
                    }
                    .buttonStyle(.bordered)
                }

                if let lastError = controller.lastError {
                    Section(L10n.string("torrent_list_error")) {
                        Text(lastError)
                            .foregroundStyle(.red)
                    }
                }

                Section(L10n.string("ios_runtime_torrents_label")) {
                    if controller.torrents.isEmpty {
                        Text(L10n.string("torrent_list_empty_all"))
                            .foregroundStyle(.secondary)
                    } else {
                        ForEach(controller.torrents) { torrent in
                            VStack(alignment: .leading, spacing: 6) {
                                Text(torrent.name.isEmpty ? L10n.string("component_torrent_card_unknown_name") : torrent.name)
                                    .font(.headline)
                                Text(localizedTorrentStatus(torrent.status))
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                HStack {
                                    Text("\(torrent.progressPercent)%")
                                    Spacer()
                                    Text(L10n.string("ios_torrent_row_peers_label"))
                                    Text(String(torrent.numPeers))
                                }
                                .font(.caption)
                                HStack {
                                    Text(L10n.string("ios_torrent_row_download_label"))
                                    Text("\(torrent.downloadSpeed) B/s")
                                    Spacer()
                                    Text(L10n.string("ios_torrent_row_upload_label"))
                                    Text("\(torrent.uploadSpeed) B/s")
                                }
                                .font(.caption2)
                                .foregroundStyle(.secondary)

                                HStack(spacing: 10) {
                                    Button(torrent.isStopped ? L10n.string("torrent_detail_resume_button") : L10n.string("torrent_detail_pause_button")) {
                                        controller.toggleTorrent(torrent)
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)

                                    Button(L10n.string("dialog_remove_confirm_button"), role: .destructive) {
                                        controller.removeTorrent(torrent)
                                    }
                                    .buttonStyle(.bordered)
                                    .controlSize(.small)
                                }
                            }
                            .padding(.vertical, 4)
                            .swipeActions {
                                Button(L10n.string("dialog_remove_confirm_button"), role: .destructive) {
                                    controller.removeTorrent(torrent)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(L10n.string("app_name"))
            .fileImporter(
                isPresented: $isImportingTorrent,
                allowedContentTypes: [.torrentFile],
                allowsMultipleSelection: false
            ) { result in
                controller.handleFileImportResult(result)
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

private extension UTType {
    static let torrentFile = UTType(importedAs: "org.bittorrent.torrent")
}

private func localizedEngineStatus(_ status: EngineControllerStatus) -> String {
    switch status {
    case .idle:
        return L10n.string("engine_status_idle")
    case .starting:
        return L10n.string("engine_status_starting")
    case .running:
        return L10n.string("engine_status_running")
    case .suspended:
        return L10n.string("engine_status_suspended")
    case .failed:
        return L10n.string("engine_status_failed")
    }
}

private func localizedTorrentStatus(_ status: String) -> String {
    switch status {
    case "stopped":
        return L10n.string("torrent_status_stopped")
    case "downloading":
        return L10n.string("torrent_status_downloading")
    case "downloading_metadata":
        return L10n.string("torrent_status_downloading_metadata")
    case "checking":
        return L10n.string("torrent_status_checking")
    case "seeding":
        return L10n.string("torrent_status_seeding")
    case "done":
        return L10n.string("torrent_status_done")
    case "queued":
        return L10n.string("torrent_status_queued")
    case "error":
        return L10n.string("torrent_status_error")
    default:
        return status.replacingOccurrences(of: "_", with: " ").localizedCapitalized
    }
}
