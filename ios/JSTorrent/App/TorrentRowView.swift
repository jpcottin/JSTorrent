import SwiftUI
import JSTorrentKit

struct TorrentRowView: View {
    let torrent: TorrentListItem
    let onOpen: () -> Void
    let onToggle: () -> Void
    let onRemove: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Text(torrentDisplayName(torrent))
                            .font(.headline)
                            .multilineTextAlignment(.leading)
                            .lineLimit(2)
                            .frame(maxWidth: .infinity, alignment: .leading)

                        Text(formattedProgress(torrent.progress))
                            .font(.subheadline.monospacedDigit())
                            .foregroundStyle(.secondary)
                    }

                    ProgressView(value: min(max(torrent.progress, 0), 1))
                        .tint(torrent.isStopped ? .orange : .accentColor)

                    HStack(spacing: 12) {
                        Label(localizedTorrentStatus(torrent.status), systemImage: torrentStatusSymbol(torrent))
                            .lineLimit(1)
                        Label(String(torrent.numPeers), systemImage: "person.2")
                            .lineLimit(1)
                    }
                    .font(.caption)
                    .foregroundStyle(.secondary)

                    HStack(spacing: 16) {
                        TorrentMetricView(
                            title: L10n.string("ios_torrent_row_download_label"),
                            value: formattedBytesPerSecond(torrent.downloadSpeed)
                        )
                        TorrentMetricView(
                            title: L10n.string("ios_torrent_row_upload_label"),
                            value: formattedBytesPerSecond(torrent.uploadSpeed)
                        )
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            VStack(spacing: 8) {
                Button(action: onToggle) {
                    Image(systemName: torrent.isStopped ? "play.fill" : "pause.fill")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(torrent.isStopped ? L10n.string("torrent_detail_resume_button") : L10n.string("torrent_detail_pause_button"))

                Button(role: .destructive, action: onRemove) {
                    Image(systemName: "trash")
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(L10n.string("dialog_remove_confirm_button"))
            }
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 6)
    }
}

private struct TorrentMetricView: View {
    let title: String
    let value: String

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.monospacedDigit())
                .foregroundStyle(.primary)
        }
    }
}

private func torrentStatusSymbol(_ torrent: TorrentListItem) -> String {
    switch torrent.status {
    case "seeding", "done":
        return "checkmark.circle"
    case "checking":
        return "checkmark.arrow.trianglehead.counterclockwise"
    case "downloading", "downloading_metadata":
        return "arrow.down.circle"
    case "error":
        return "exclamationmark.triangle"
    default:
        return torrent.isStopped ? "pause.circle" : "bolt.horizontal.circle"
    }
}
