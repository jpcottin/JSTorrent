import SwiftUI
import JSTorrentKit
import UIKit

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
    @Environment(\.openURL) private var openURL
    @ObservedObject var controller: EngineController
    @ObservedObject var settings: AppSettings
    let infoHash: String

    @State private var selectedSection: TorrentDetailSection = .status
    @State private var sharedItem: SharedURLItem?
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
                    let section = selectedSection.subscriptionSection
                    controller.observeTorrentDetail(infoHash, section: section)
                    controller.resumeIfStarted()

                    guard selectedSection == .pieces else {
                        return
                    }

                    while !Task.isCancelled {
                        try? await Task.sleep(nanoseconds: 500_000_000)
                        guard !Task.isCancelled else {
                            return
                        }
                        controller.refreshTorrentDetail(infoHash, section: section)
                    }
                }
                .onDisappear {
                    controller.stopObservingTorrentDetail(infoHash)
                }
                .sheet(item: $sharedItem) { item in
                    ShareSheet(item: item)
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
                onOpenFile: openFile,
                onOpenFolder: openFolder
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

        openExternalURL(fileURL)
    }

    private func openFolder(_ rootKey: String?) {
        guard let rootURL = settings.resolveDownloadedRootURL(rootKey: rootKey) else {
            return
        }

        openExternalURL(rootURL)
    }

    private func openExternalURL(_ url: URL) {
        openURL(url) { accepted in
            if !accepted {
                sharedItem = SharedURLItem(url: url)
            }
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
    let onOpenFolder: (String?) -> Void

    var body: some View {
        if let filesPayload, !filesPayload.files.isEmpty {
            VStack(alignment: .leading, spacing: 16) {
                let resolvedRootKey = filesPayload.rootKey ?? details?.rootKey

                if let rootKey = resolvedRootKey {
                    DetailFactRow(
                        title: L10n.string("tab_files_save_location"),
                        value: rootKey
                    )

                    Button {
                        onOpenFolder(rootKey)
                    } label: {
                        Label(L10n.string("tab_files_open_folder"), systemImage: "folder")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
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

private struct SharedURLItem: Identifiable {
    let url: URL
    var id: String { url.path }
}

private struct ShareSheet: UIViewControllerRepresentable {
    let item: SharedURLItem

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [item.url], applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {
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

                Text(L10n.string("tab_pieces_progress").uppercased())
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                PieceProgressBar(pieces: pieces)

                Text(L10n.string("tab_pieces_piece_map").uppercased())
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)

                PieceMapView(pieces: pieces)

                PieceLegend()
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

private struct PieceProgressBar: View {
    let pieces: TorrentPiecesPayload

    private let maxSegments = 100

    private var segmentStates: [PieceVisualState] {
        makeSegmentStates(
            piecesTotal: pieces.piecesTotal,
            bitfieldHex: pieces.bitfield,
            activePieceStatesHex: pieces.activePieceStates,
            maxSegments: maxSegments
        )
    }

    var body: some View {
        GeometryReader { geometry in
            let height = geometry.size.height
            let segmentWidth = max(geometry.size.width / CGFloat(max(segmentStates.count, 1)), 1)

            HStack(spacing: 1) {
                ForEach(Array(segmentStates.enumerated()), id: \.offset) { _, state in
                    Rectangle()
                        .fill(state.color.opacity(state == .missing ? 1 : 0.85))
                        .frame(width: max(segmentWidth - 1, 1), height: height)
                }
            }
        }
        .frame(height: 12)
    }
}

private struct PieceMapView: View {
    @Environment(\.displayScale) private var displayScale

    let pieces: TorrentPiecesPayload
    @State private var containerWidth: CGFloat = max(UIScreen.main.bounds.width - 76, 1)
    @State private var renderedImage: UIImage?

    private var minCellSize: CGFloat {
        switch pieces.piecesTotal {
        case ...10:
            return 24
        case ...50:
            return 16
        case ...200:
            return 10
        case ...1000:
            return 6
        case ...5000:
            return 4
        default:
            return 3
        }
    }

    private var gap: CGFloat {
        pieces.piecesTotal > 1000 ? 0.5 : 1
    }

    private var layout: PieceMapLayout {
        PieceMapLayout(
            piecesTotal: pieces.piecesTotal,
            containerWidth: containerWidth,
            minCellSize: minCellSize,
            gap: gap
        )
    }

    private var renderKey: PieceMapRenderKey {
        PieceMapRenderKey(
            piecesTotal: pieces.piecesTotal,
            bitfieldHex: pieces.bitfield,
            activePieceStatesHex: pieces.activePieceStates,
            width: Int(containerWidth.rounded(.up)),
            scale: Int(displayScale.rounded(.up))
        )
    }

    var body: some View {
        Group {
            if let renderedImage {
                Image(uiImage: renderedImage)
                    .resizable()
                    .interpolation(.none)
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(height: layout.height, alignment: .topLeading)
        .task(id: renderKey) {
            let image = await renderPieceMapImage(
                piecesTotal: pieces.piecesTotal,
                bitfieldHex: pieces.bitfield,
                activePieceStatesHex: pieces.activePieceStates,
                layout: layout,
                scale: displayScale
            )
            guard !Task.isCancelled else {
                return
            }
            renderedImage = image
        }
        .background {
            GeometryReader { geometry in
                Color.clear
                    .onAppear {
                        containerWidth = max(geometry.size.width, 1)
                    }
                    .onChange(of: geometry.size.width) { newWidth in
                        containerWidth = max(newWidth, 1)
                    }
            }
        }
    }
}

private struct PieceMapRenderKey: Hashable {
    let piecesTotal: Int
    let bitfieldHex: String
    let activePieceStatesHex: String?
    let width: Int
    let scale: Int
}

private struct PieceMapLayout {
    let columns: Int
    let rows: Int
    let cellSize: CGFloat
    let gap: CGFloat

    init(piecesTotal: Int, containerWidth: CGFloat, minCellSize: CGFloat, gap: CGFloat) {
        guard piecesTotal > 0, containerWidth > 0 else {
            self.columns = 0
            self.rows = 0
            self.cellSize = 0
            self.gap = gap
            return
        }

        let maxColumns = max(Int(floor((containerWidth + gap) / (minCellSize + gap))), 1)
        let columns = min(piecesTotal, maxColumns)
        let resolvedCellSize = max(
            minCellSize,
            (containerWidth - CGFloat(max(columns - 1, 0)) * gap) / CGFloat(columns)
        )

        self.columns = columns
        self.rows = Int(ceil(Double(piecesTotal) / Double(columns)))
        self.cellSize = resolvedCellSize
        self.gap = gap
    }

    var height: CGFloat {
        guard rows > 0 else {
            return 0
        }

        return CGFloat(rows) * cellSize + CGFloat(max(rows - 1, 0)) * gap
    }
}

private func renderPieceMapImage(
    piecesTotal: Int,
    bitfieldHex: String,
    activePieceStatesHex: String?,
    layout: PieceMapLayout,
    scale: CGFloat
) async -> UIImage? {
    guard piecesTotal > 0, layout.columns > 0, layout.height > 0 else {
        return nil
    }

    return await withCheckedContinuation { continuation in
        DispatchQueue.global(qos: .userInitiated).async {
            let imageSize = CGSize(
                width: CGFloat(layout.columns) * layout.cellSize + CGFloat(max(layout.columns - 1, 0)) * layout.gap,
                height: layout.height
            )
            let format = UIGraphicsImageRendererFormat()
            format.scale = max(scale, 1)
            format.opaque = false

            let bitfield = decodeBitfield(hex: bitfieldHex, piecesTotal: piecesTotal)
            let activeStates = ActivePieceStateCode.fromHex(activePieceStatesHex)

            let image = UIGraphicsImageRenderer(size: imageSize, format: format).image { context in
                for index in 0..<piecesTotal {
                    let state: PieceVisualState
                    if bitfield.indices.contains(index), bitfield[index] {
                        state = .completed
                    } else if activeStates.responded.contains(index) {
                        state = .responded
                    } else if activeStates.requested.contains(index) {
                        state = .requested
                    } else if activeStates.partial.contains(index) {
                        state = .partial
                    } else {
                        state = .missing
                    }

                    let column = index % layout.columns
                    let row = index / layout.columns
                    let originX = CGFloat(column) * (layout.cellSize + layout.gap)
                    let originY = CGFloat(row) * (layout.cellSize + layout.gap)
                    let rect = CGRect(x: originX, y: originY, width: layout.cellSize, height: layout.cellSize)

                    state.uiColor.setFill()
                    context.fill(rect)
                }
            }

            continuation.resume(returning: image)
        }
    }
}

private struct PieceLegend: View {
    private let items: [(String, PieceVisualState)] = [
        ("tab_pieces_legend_complete", .completed),
        ("tab_pieces_legend_verifying", .responded),
        ("tab_pieces_legend_receiving", .requested),
        ("tab_pieces_legend_requesting", .partial),
        ("tab_pieces_legend_missing", .missing)
    ]

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 8) {
                    RoundedRectangle(cornerRadius: 3, style: .continuous)
                        .fill(item.1.color)
                        .frame(width: 12, height: 12)
                    Text(L10n.string(item.0))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }
}

private enum ActivePieceStateCode {
    static func fromHex(_ hex: String?) -> (partial: Set<Int>, requested: Set<Int>, responded: Set<Int>) {
        guard let hex, !hex.isEmpty else {
            return ([], [], [])
        }

        let bytes = decodeHexBytes(hex)
        guard bytes.count >= 6 else {
            return ([], [], [])
        }

        func readUInt16LE(at offset: Int) -> Int {
            guard offset + 1 < bytes.count else { return 0 }
            return Int(bytes[offset]) | (Int(bytes[offset + 1]) << 8)
        }

        let partialCount = readUInt16LE(at: 0)
        let requestedCount = readUInt16LE(at: 2)
        let respondedCount = readUInt16LE(at: 4)

        var cursor = 6

        func readSet(count: Int) -> Set<Int> {
            var result = Set<Int>()
            result.reserveCapacity(count)
            for _ in 0..<count {
                guard cursor + 1 < bytes.count else {
                    break
                }
                result.insert(readUInt16LE(at: cursor))
                cursor += 2
            }
            return result
        }

        let partial = readSet(count: partialCount)
        let requested = readSet(count: requestedCount)
        let responded = readSet(count: respondedCount)
        return (partial, requested, responded)
    }
}

private enum PieceVisualState: CaseIterable {
    case completed
    case responded
    case requested
    case partial
    case missing

    var color: Color {
        switch self {
        case .completed:
            return Color(red: 0.04, green: 0.52, blue: 1.0)
        case .responded:
            return Color(red: 0.30, green: 0.69, blue: 0.31)
        case .requested:
            return Color(red: 0.00, green: 0.74, blue: 0.83)
        case .partial:
            return Color(red: 1.00, green: 0.60, blue: 0.00)
        case .missing:
            return Color(.tertiarySystemFill)
        }
    }

    var uiColor: UIColor {
        switch self {
        case .completed:
            return UIColor(red: 0.04, green: 0.52, blue: 1.0, alpha: 1)
        case .responded:
            return UIColor(red: 0.30, green: 0.69, blue: 0.31, alpha: 1)
        case .requested:
            return UIColor(red: 0.00, green: 0.74, blue: 0.83, alpha: 1)
        case .partial:
            return UIColor(red: 1.00, green: 0.60, blue: 0.00, alpha: 1)
        case .missing:
            return UIColor.tertiarySystemFill
        }
    }
}

private func makePieceStates(
    piecesTotal: Int,
    bitfieldHex: String,
    activePieceStatesHex: String?
) -> [PieceVisualState] {
    let bitfield = decodeBitfield(hex: bitfieldHex, piecesTotal: piecesTotal)
    let activeStates = ActivePieceStateCode.fromHex(activePieceStatesHex)

    return (0..<piecesTotal).map { index in
        if bitfield.indices.contains(index), bitfield[index] {
            return .completed
        }
        if activeStates.responded.contains(index) {
            return .responded
        }
        if activeStates.requested.contains(index) {
            return .requested
        }
        if activeStates.partial.contains(index) {
            return .partial
        }
        return .missing
    }
}

private func makeSegmentStates(
    piecesTotal: Int,
    bitfieldHex: String,
    activePieceStatesHex: String?,
    maxSegments: Int
) -> [PieceVisualState] {
    let pieceStates = makePieceStates(
        piecesTotal: piecesTotal,
        bitfieldHex: bitfieldHex,
        activePieceStatesHex: activePieceStatesHex
    )

    guard !pieceStates.isEmpty else {
        return []
    }

    let segmentCount = min(maxSegments, pieceStates.count)
    let piecesPerSegment = Double(pieceStates.count) / Double(segmentCount)

    return (0..<segmentCount).map { segmentIndex in
        let start = Int(floor(Double(segmentIndex) * piecesPerSegment))
        let end = min(Int(ceil(Double(segmentIndex + 1) * piecesPerSegment)), pieceStates.count)
        let slice = pieceStates[start..<max(start + 1, end)]
        return slice.contains(.completed) ? .completed
            : slice.contains(.responded) ? .responded
            : slice.contains(.requested) ? .requested
            : slice.contains(.partial) ? .partial
            : .missing
    }
}

private func decodeBitfield(hex: String, piecesTotal: Int) -> [Bool] {
    let bytes = decodeHexBytes(hex)
    guard !bytes.isEmpty else {
        return Array(repeating: false, count: piecesTotal)
    }

    var bits: [Bool] = []
    bits.reserveCapacity(min(bytes.count * 8, piecesTotal))

    for byte in bytes {
        for shift in (0..<8).reversed() {
            bits.append((byte & (1 << shift)) != 0)
            if bits.count == piecesTotal {
                return bits
            }
        }
    }

    if bits.count < piecesTotal {
        bits.append(contentsOf: repeatElement(false, count: piecesTotal - bits.count))
    }
    return bits
}

private func decodeHexBytes(_ hex: String) -> [UInt8] {
    guard hex.count.isMultiple(of: 2) else {
        return []
    }

    var bytes: [UInt8] = []
    bytes.reserveCapacity(hex.count / 2)

    var index = hex.startIndex
    while index < hex.endIndex {
        let nextIndex = hex.index(index, offsetBy: 2)
        let byteString = String(hex[index..<nextIndex])
        guard let byte = UInt8(byteString, radix: 16) else {
            return []
        }
        bytes.append(byte)
        index = nextIndex
    }

    return bytes
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
