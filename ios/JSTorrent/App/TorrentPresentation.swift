import Foundation
import JSTorrentKit

private let speedFormatter: ByteCountFormatter = {
    let formatter = ByteCountFormatter()
    formatter.allowedUnits = [.useBytes, .useKB, .useMB, .useGB]
    formatter.countStyle = .file
    formatter.includesUnit = true
    formatter.isAdaptive = true
    return formatter
}()

func localizedEngineStatus(_ status: EngineControllerStatus) -> String {
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

func localizedTorrentStatus(_ status: String) -> String {
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

func torrentDisplayName(_ torrent: TorrentListItem) -> String {
    if torrent.name.isEmpty {
        return L10n.string("component_torrent_card_unknown_name")
    }

    return torrent.name
}

func formattedProgress(_ progress: Double) -> String {
    let percent = Int((progress * 100).rounded())
    return "\(percent)%"
}

func formattedBytesPerSecond(_ value: Int) -> String {
    let formatted = speedFormatter.string(fromByteCount: Int64(max(value, 0)))
    return L10n.formatted("ios_speed_value", formatted)
}
