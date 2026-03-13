import SwiftUI
import JSTorrentKit

private enum TorrentDetailSection: CaseIterable, Identifiable {
    case status
    case files
    case trackers
    case peers
    case pieces

    var id: Self { self }

    var titleKey: String {
        switch self {
        case .status:
            return "tab_status"
        case .files:
            return "tab_files"
        case .trackers:
            return "tab_trackers"
        case .peers:
            return "tab_peers"
        case .pieces:
            return "tab_pieces"
        }
    }
}

struct TorrentDetailScreen: View {
    @ObservedObject var controller: EngineController
    let infoHash: String

    @State private var selectedSection: TorrentDetailSection = .status

    private var torrent: TorrentListItem? {
        controller.torrents.first(where: { $0.infoHash == infoHash })
    }

    var body: some View {
        Group {
            if let torrent {
                ScrollView {
                    VStack(alignment: .leading, spacing: 20) {
                        TorrentOverviewCard(torrent: torrent)
                        DetailSectionPicker(selectedSection: $selectedSection)
                        detailSectionContent(for: torrent)
                    }
                    .padding(20)
                }
                .navigationTitle(torrentDisplayName(torrent))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItemGroup(placement: .navigationBarTrailing) {
                        Button {
                            controller.toggleTorrent(torrent)
                        } label: {
                            Image(systemName: torrent.isStopped ? "play.fill" : "pause.fill")
                        }
                        .accessibilityLabel(torrent.isStopped ? L10n.string("torrent_detail_resume_button") : L10n.string("torrent_detail_pause_button"))

                        Button(role: .destructive) {
                            controller.removeTorrent(torrent)
                        } label: {
                            Image(systemName: "trash")
                        }
                        .accessibilityLabel(L10n.string("torrent_detail_remove_button"))
                    }
                }
                .task {
                    controller.startIfNeeded()
                    controller.resumeIfStarted()
                }
            } else {
                VStack(alignment: .center, spacing: 10) {
                    Text(L10n.string("torrent_detail_error_title"))
                        .font(.headline)
                    Text(infoHash)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .padding(24)
                .navigationTitle(L10n.string("torrent_detail_error_title"))
            }
        }
    }

    @ViewBuilder
    private func detailSectionContent(for torrent: TorrentListItem) -> some View {
        switch selectedSection {
        case .status:
            TorrentStatusSection(torrent: torrent)
        case .files:
            DetailPlaceholderCard(
                titleKey: "tab_files_empty_title",
                messageKey: "tab_files_empty_description"
            )
        case .trackers:
            DetailPlaceholderCard(titleKey: "tab_trackers_empty")
        case .peers:
            DetailPlaceholderCard(
                titleKey: "tab_peers_empty_title",
                messageKey: "tab_peers_empty_description"
            )
        case .pieces:
            DetailPlaceholderCard(
                titleKey: "tab_pieces_no_info_title",
                messageKey: "tab_pieces_no_info_description"
            )
        }
    }
}

private struct TorrentOverviewCard: View {
    let torrent: TorrentListItem

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(localizedTorrentStatus(torrent.status))
                        .font(.headline)
                    Text(torrentDisplayName(torrent))
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer()

                Text(formattedProgress(torrent.progress))
                    .font(.title3.monospacedDigit().weight(.semibold))
            }

            ProgressView(value: min(max(torrent.progress, 0), 1))

            HStack(spacing: 12) {
                OverviewPill(
                    title: L10n.string("ios_torrent_row_download_label"),
                    value: formattedBytesPerSecond(torrent.downloadSpeed)
                )
                OverviewPill(
                    title: L10n.string("ios_torrent_row_upload_label"),
                    value: formattedBytesPerSecond(torrent.uploadSpeed)
                )
                OverviewPill(
                    title: L10n.string("ios_torrent_row_peers_label"),
                    value: String(torrent.numPeers)
                )
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }
}

private struct OverviewPill: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(.systemBackground))
        )
    }
}

private struct DetailSectionPicker: View {
    @Binding var selectedSection: TorrentDetailSection

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(TorrentDetailSection.allCases) { section in
                    Button {
                        selectedSection = section
                    } label: {
                        Text(L10n.string(section.titleKey))
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 14)
                            .padding(.vertical, 8)
                            .background(
                                Capsule(style: .continuous)
                                    .fill(section == selectedSection ? Color.accentColor : Color(.secondarySystemFill))
                            )
                            .foregroundStyle(section == selectedSection ? Color.white : Color.primary)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

private struct TorrentStatusSection: View {
    let torrent: TorrentListItem

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text(L10n.string("tab_status"))
                .font(.headline)

            LazyVGrid(columns: columns, spacing: 12) {
                DetailMetricCard(
                    title: L10n.string("tab_status_download_label"),
                    value: formattedBytesPerSecond(torrent.downloadSpeed)
                )
                DetailMetricCard(
                    title: L10n.string("tab_status_upload_label"),
                    value: formattedBytesPerSecond(torrent.uploadSpeed)
                )
                DetailMetricCard(
                    title: L10n.string("tab_status_connected_peers_label"),
                    value: String(torrent.numPeers)
                )
                DetailMetricCard(
                    title: L10n.string("tab_pieces_progress"),
                    value: formattedProgress(torrent.progress)
                )
            }

            VStack(alignment: .leading, spacing: 4) {
                Text(L10n.string("tab_details_info_hash"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(torrent.infoHash)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }
}

private struct DetailMetricCard: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.monospacedDigit())
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(Color(.systemBackground))
        )
    }
}

private struct DetailPlaceholderCard: View {
    let titleKey: String
    let messageKey: String?

    init(titleKey: String, messageKey: String? = nil) {
        self.titleKey = titleKey
        self.messageKey = messageKey
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(L10n.string(titleKey))
                .font(.headline)

            if let messageKey {
                Text(L10n.string(messageKey))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .fill(Color(.secondarySystemGroupedBackground))
        )
    }
}
