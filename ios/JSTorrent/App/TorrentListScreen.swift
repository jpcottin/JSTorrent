import SwiftUI
import JSTorrentKit
import UniformTypeIdentifiers

private enum TorrentListFilter: CaseIterable, Identifiable {
    case all
    case active
    case finished

    var id: Self { self }

    var titleKey: String {
        switch self {
        case .all:
            return "filter_all"
        case .active:
            return "filter_active"
        case .finished:
            return "filter_finished"
        }
    }

    var emptyTitleKey: String {
        switch self {
        case .all:
            return "torrent_list_empty_all"
        case .active:
            return "torrent_list_empty_active"
        case .finished:
            return "torrent_list_empty_finished"
        }
    }

    var emptyHintKey: String {
        switch self {
        case .all:
            return "torrent_list_hint_all"
        case .active:
            return "torrent_list_hint_active"
        case .finished:
            return "torrent_list_hint_finished"
        }
    }

    func includes(_ torrent: TorrentListItem) -> Bool {
        switch self {
        case .all:
            return true
        case .active:
            return !torrent.isStopped && torrent.progress < 1
        case .finished:
            return torrent.progress >= 1 || torrent.status == "done" || torrent.status == "seeding"
        }
    }
}

struct TorrentListScreen: View {
    @ObservedObject var controller: EngineController
    let onTorrentSelected: (String) -> Void

    @State private var selectedFilter: TorrentListFilter = .all
    @State private var isPresentingAddTorrent = false
    @State private var isImportingTorrent = false

    private var filteredTorrents: [TorrentListItem] {
        controller.torrents.filter(selectedFilter.includes)
    }

    var body: some View {
        List {
            Section {
                FilterBar(selectedFilter: $selectedFilter)
                    .listRowInsets(EdgeInsets(top: 8, leading: 0, bottom: 8, trailing: 0))
                    .listRowBackground(Color.clear)

                RuntimeSummaryCard(
                    status: controller.status,
                    torrentCount: controller.torrents.count
                )
            }

            if let lastError = controller.lastError {
                Section(L10n.string("torrent_list_error")) {
                    Text(lastError)
                        .foregroundStyle(.red)
                }
            }

            Section(L10n.string("ios_runtime_torrents_label")) {
                if filteredTorrents.isEmpty {
                    EmptyTorrentState(filter: selectedFilter)
                } else {
                    ForEach(filteredTorrents) { torrent in
                        TorrentRowView(
                            torrent: torrent,
                            onOpen: {
                                onTorrentSelected(torrent.infoHash)
                            },
                            onToggle: {
                                controller.toggleTorrent(torrent)
                            },
                            onRemove: {
                                controller.removeTorrent(torrent)
                            }
                        )
                        .swipeActions {
                            Button(torrent.isStopped ? L10n.string("torrent_detail_resume_button") : L10n.string("torrent_detail_pause_button")) {
                                controller.toggleTorrent(torrent)
                            }
                            .tint(.blue)

                            Button(L10n.string("dialog_remove_confirm_button"), role: .destructive) {
                                controller.removeTorrent(torrent)
                            }
                        }
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(L10n.string("app_name"))
        .toolbar {
            ToolbarItem(placement: .navigationBarTrailing) {
                Button {
                    isPresentingAddTorrent = true
                } label: {
                    Image(systemName: "plus")
                }
                .accessibilityLabel(L10n.string("torrent_list_add_torrent"))
            }
        }
        .sheet(isPresented: $isPresentingAddTorrent) {
            AddTorrentSheet(
                magnetInput: $controller.magnetInput,
                onAdd: {
                    controller.addMagnet()
                },
                onBrowse: {
                    isImportingTorrent = true
                },
                onAddTestTorrent: {
                    controller.addTestTorrent()
                }
            )
        }
        .fileImporter(
            isPresented: $isImportingTorrent,
            allowedContentTypes: [.torrentFile],
            allowsMultipleSelection: false
        ) { result in
            controller.handleFileImportResult(result)
        }
        .refreshable {
            controller.startIfNeeded()
            controller.resumeIfStarted()
        }
    }
}

private struct FilterBar: View {
    @Binding var selectedFilter: TorrentListFilter

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TorrentListFilter.allCases) { filter in
                    Button {
                        selectedFilter = filter
                    } label: {
                        Text(L10n.string(filter.titleKey))
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(filter == selectedFilter ? Color.accentColor : Color(.secondarySystemFill))
                            )
                            .foregroundStyle(filter == selectedFilter ? Color.white : Color.primary)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, 20)
        }
    }
}

private struct RuntimeSummaryCard: View {
    let status: EngineControllerStatus
    let torrentCount: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(L10n.string("ios_runtime_section_title"))
                .font(.headline)

            HStack(spacing: 12) {
                RuntimeMetricPill(
                    title: L10n.string("ios_runtime_status_label"),
                    value: localizedEngineStatus(status)
                )
                RuntimeMetricPill(
                    title: L10n.string("ios_runtime_torrents_label"),
                    value: String(torrentCount)
                )
            }
        }
        .padding(16)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }
}

private struct RuntimeMetricPill: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.body.weight(.semibold))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(.systemBackground))
        )
    }
}

private struct EmptyTorrentState: View {
    let filter: TorrentListFilter

    var body: some View {
        VStack(alignment: .center, spacing: 6) {
            Text(L10n.string(filter.emptyTitleKey))
                .font(.headline)
            Text(L10n.string(filter.emptyHintKey))
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 24)
    }
}

private extension UTType {
    static let torrentFile = UTType(importedAs: "org.bittorrent.torrent")
}
