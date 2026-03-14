import SwiftUI
import JSTorrentKit
import QuickLook

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

    var subscriptionSection: TorrentDetailSubscriptionSection {
        switch self {
        case .status:
            return .status
        case .files:
            return .files
        case .trackers:
            return .trackers
        case .peers:
            return .peers
        case .pieces:
            return .pieces
        }
    }
}

struct TorrentDetailScreen: View {
    @Environment(\.dismiss) private var dismiss
    @ObservedObject var controller: EngineController
    @ObservedObject var settings: AppSettings
    let infoHash: String

    @State private var selectedSection: TorrentDetailSection = .status
    @State private var previewItem: PreviewItem?
    @State private var pendingRemovalTorrent: TorrentListItem?

    private var torrent: TorrentListItem? {
        controller.torrents.first(where: { $0.infoHash == infoHash })
    }

    private var details: TorrentDetailsPayload? {
        controller.torrentDetails[infoHash]
    }

    private var filesPayload: TorrentFilesPayload? {
        controller.torrentFiles[infoHash]
    }

    private var trackers: [TorrentTrackerItem] {
        controller.torrentTrackers[infoHash] ?? []
    }

    private var peers: [TorrentPeerItem] {
        controller.torrentPeers[infoHash] ?? []
    }

    private var pieces: TorrentPiecesPayload? {
        controller.torrentPieces[infoHash]
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
                            pendingRemovalTorrent = torrent
                        } label: {
                            Image(systemName: "trash")
                        }
                        .accessibilityLabel(L10n.string("torrent_detail_remove_button"))
                    }
                }
                .task(id: selectedSection) {
                    controller.observeTorrentDetail(infoHash, section: selectedSection.subscriptionSection)
                    controller.resumeIfStarted()
                }
                .onDisappear {
                    controller.stopObservingTorrentDetail(infoHash)
                }
                .sheet(item: $previewItem) { item in
                    FilePreviewSheet(item: item)
                }
                .sheet(item: $pendingRemovalTorrent) { torrent in
                    RemoveTorrentSheet(
                        torrent: torrent,
                        onConfirm: { deleteFiles in
                            controller.removeTorrent(torrent, deleteFiles: deleteFiles)
                            pendingRemovalTorrent = nil
                            dismiss()
                        },
                        onCancel: {
                            pendingRemovalTorrent = nil
                        }
                    )
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
            TorrentStatusSection(
                torrent: torrent,
                details: details,
                pieces: pieces
            )
        case .files:
            TorrentFilesSection(
                filesPayload: filesPayload,
                details: details,
                onOpenFile: openFile
            )
        case .trackers:
            TorrentTrackersSection(trackers: trackers)
        case .peers:
            TorrentPeersSection(peers: peers)
        case .pieces:
            TorrentPiecesSection(pieces: pieces)
        }
    }

    private func openFile(_ file: TorrentFileItem, rootKey: String?) {
        guard let fileURL = settings.resolveDownloadedFileURL(rootKey: rootKey, relativePath: file.path) else {
            return
        }

        guard FileManager.default.fileExists(atPath: fileURL.path) else {
            return
        }

        previewItem = PreviewItem(url: fileURL)
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
    let details: TorrentDetailsPayload?
    let pieces: TorrentPiecesPayload?

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
                DetailMetricCard(
                    title: L10n.string("tab_details_total_size"),
                    value: formattedByteCount(details?.totalSize)
                )
                DetailMetricCard(
                    title: L10n.string("tab_details_piece_count"),
                    value: pieces.map { "\($0.piecesCompleted) / \($0.piecesTotal)" } ?? L10n.string("tab_details_unknown")
                )
            }

            VStack(alignment: .leading, spacing: 10) {
                DetailFactRow(
                    title: L10n.string("tab_details_piece_size"),
                    value: formattedByteCount(details?.pieceSize ?? pieces?.pieceSize)
                )
                DetailFactRow(
                    title: L10n.string("tab_details_date_added"),
                    value: formattedDateTime(millisecondsSinceEpoch: details?.addedAt)
                )
                DetailFactRow(
                    title: L10n.string("tab_details_save_location"),
                    value: details?.rootKey ?? L10n.string("tab_details_unknown")
                )
                DetailFactRow(
                    title: L10n.string("tab_details_info_hash"),
                    value: torrent.infoHash
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

private struct TorrentFilesSection: View {
    let filesPayload: TorrentFilesPayload?
    let details: TorrentDetailsPayload?
    let onOpenFile: (TorrentFileItem, String?) -> Void

    var body: some View {
        if let filesPayload, !filesPayload.files.isEmpty {
            VStack(alignment: .leading, spacing: 16) {
                let resolvedRootKey = filesPayload.rootKey ?? details?.rootKey

                if let rootKey = resolvedRootKey {
                    DetailFactRow(
                        title: L10n.string("tab_files_save_location"),
                        value: rootKey
                    )
                }

                ForEach(filesPayload.files) { file in
                    Button {
                        onOpenFile(file, resolvedRootKey)
                    } label: {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(alignment: .top, spacing: 12) {
                                Text(file.path)
                                    .font(.subheadline.weight(.medium))
                                    .lineLimit(2)

                                Spacer()

                                Image(systemName: "chevron.right")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.tertiary)
                            }

                            ProgressView(value: min(max(file.progress, 0), 1))

                            HStack {
                                Text(formattedProgress(file.progress))
                                Spacer()
                                Text(formattedByteCount(file.downloaded))
                                Text("/")
                                Text(formattedByteCount(file.size))
                            }
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(.secondary)
                        }
                        .padding(14)
                        .background(
                            RoundedRectangle(cornerRadius: 16, style: .continuous)
                                .fill(Color(.secondarySystemGroupedBackground))
                        )
                    }
                    .buttonStyle(.plain)
                }
            }
        } else {
            DetailPlaceholderCard(
                titleKey: "tab_files_empty_title",
                messageKey: "tab_files_empty_description"
            )
        }
    }
}

private struct PreviewItem: Identifiable {
    let url: URL
    var id: String { url.path }
}

private struct FilePreviewSheet: UIViewControllerRepresentable {
    let item: PreviewItem

    func makeCoordinator() -> Coordinator {
        Coordinator(item: item)
    }

    func makeUIViewController(context: Context) -> QLPreviewController {
        let controller = QLPreviewController()
        controller.dataSource = context.coordinator
        return controller
    }

    func updateUIViewController(_ uiViewController: QLPreviewController, context: Context) {
        context.coordinator.item = item
        uiViewController.reloadData()
    }

    final class Coordinator: NSObject, QLPreviewControllerDataSource {
        var item: PreviewItem

        init(item: PreviewItem) {
            self.item = item
        }

        func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
            1
        }

        func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
            item.url as NSURL
        }
    }
}

private struct TorrentTrackersSection: View {
    let trackers: [TorrentTrackerItem]

    var body: some View {
        if trackers.isEmpty {
            DetailPlaceholderCard(titleKey: "tab_trackers_empty")
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(trackers) { tracker in
                    VStack(alignment: .leading, spacing: 8) {
                        Text(tracker.url)
                            .font(.subheadline.weight(.medium))
                            .textSelection(.enabled)

                        HStack(spacing: 10) {
                            Text(localizedTrackerStatus(tracker.status))
                            if let uniquePeersDiscovered = tracker.uniquePeersDiscovered {
                                Text(L10n.formatted("tab_trackers_peers_count", uniquePeersDiscovered))
                            }
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)

                        if let lastError = tracker.lastError, !lastError.isEmpty {
                            Text(lastError)
                                .font(.caption)
                                .foregroundStyle(.red)
                        }
                    }
                    .padding(14)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color(.secondarySystemGroupedBackground))
                    )
                }
            }
        }
    }
}

private struct TorrentPeersSection: View {
    let peers: [TorrentPeerItem]

    var body: some View {
        if peers.isEmpty {
            DetailPlaceholderCard(
                titleKey: "tab_peers_empty_title",
                messageKey: "tab_peers_empty_description"
            )
        } else {
            VStack(alignment: .leading, spacing: 12) {
                ForEach(peers) { peer in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline) {
                            Text("\(peer.ip):\(peer.port)")
                                .font(.subheadline.weight(.medium))
                            Spacer()
                            Text(formattedProgress(peer.progress))
                                .font(.caption.monospacedDigit())
                                .foregroundStyle(.secondary)
                        }

                        HStack(spacing: 10) {
                            Text(peer.clientName ?? peer.state.localizedCapitalized)
                        }
                        .font(.caption)
                        .foregroundStyle(.secondary)

                        HStack(spacing: 16) {
                            MetricInlineView(
                                title: L10n.string("ios_torrent_row_download_label"),
                                value: formattedBytesPerSecond(peer.downloadSpeed)
                            )
                            MetricInlineView(
                                title: L10n.string("ios_torrent_row_upload_label"),
                                value: formattedBytesPerSecond(peer.uploadSpeed)
                            )
                        }
                    }
                    .padding(14)
                    .background(
                        RoundedRectangle(cornerRadius: 16, style: .continuous)
                            .fill(Color(.secondarySystemGroupedBackground))
                    )
                }
            }
        }
    }
}

private struct TorrentPiecesSection: View {
    let pieces: TorrentPiecesPayload?

    var body: some View {
        if let pieces, pieces.piecesTotal > 0 {
            VStack(alignment: .leading, spacing: 16) {
                LazyVGrid(
                    columns: [
                        GridItem(.flexible(), spacing: 12),
                        GridItem(.flexible(), spacing: 12)
                    ],
                    spacing: 12
                ) {
                    DetailMetricCard(
                        title: L10n.string("tab_pieces_count_label"),
                        value: "\(pieces.piecesCompleted) / \(pieces.piecesTotal)"
                    )
                    DetailMetricCard(
                        title: L10n.string("tab_pieces_piece_size"),
                        value: formattedByteCount(pieces.pieceSize)
                    )
                }

                ProgressView(
                    value: pieces.piecesTotal > 0
                        ? Double(pieces.piecesCompleted) / Double(pieces.piecesTotal)
                        : 0
                )

                PiecePreviewStrip(bitfieldHex: pieces.bitfield)
            }
            .padding(18)
            .background(
                RoundedRectangle(cornerRadius: 20, style: .continuous)
                    .fill(Color(.secondarySystemGroupedBackground))
            )
        } else {
            DetailPlaceholderCard(
                titleKey: "tab_pieces_no_info_title",
                messageKey: "tab_pieces_no_info_description"
            )
        }
    }
}

private struct PiecePreviewStrip: View {
    let bitfieldHex: String

    private var sample: [Bool] {
        let bits = decodeBitfield(hex: bitfieldHex)
        if bits.isEmpty {
            return Array(repeating: false, count: 48)
        }

        let chunkSize = max(1, bits.count / 48)
        return stride(from: 0, to: bits.count, by: chunkSize).map { start in
            let end = min(bits.count, start + chunkSize)
            return bits[start..<end].contains(true)
        }
    }

    var body: some View {
        HStack(spacing: 3) {
            ForEach(Array(sample.enumerated()), id: \.offset) { _, complete in
                RoundedRectangle(cornerRadius: 2, style: .continuous)
                    .fill(complete ? Color.accentColor : Color(.tertiarySystemFill))
                    .frame(height: 10)
            }
        }
    }

    private func decodeBitfield(hex: String) -> [Bool] {
        guard hex.count.isMultiple(of: 2) else {
            return []
        }

        var bits: [Bool] = []
        bits.reserveCapacity(hex.count * 4)

        var index = hex.startIndex
        while index < hex.endIndex {
            let nextIndex = hex.index(index, offsetBy: 2)
            let byteString = String(hex[index..<nextIndex])
            guard let byte = UInt8(byteString, radix: 16) else {
                return []
            }

            for shift in (0..<8).reversed() {
                bits.append((byte & (1 << shift)) != 0)
            }

            index = nextIndex
        }

        return bits
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

private struct DetailFactRow: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(title)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.monospacedDigit())
                .textSelection(.enabled)
        }
    }
}

private struct MetricInlineView: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.monospacedDigit())
        }
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
