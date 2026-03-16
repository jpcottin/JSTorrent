/**
 * Shared types for @jstorrent/client
 * These are Chrome-free and can be used in standalone contexts.
 */

/** Daemon capabilities - indicates what features are available */
export interface DaemonCapabilities {
  /** Whether download roots can be added/removed. False for standalone Crostini mode. */
  roots_manageable: boolean
  /** Whether the daemon can mint LAN share / direct playback URLs for completed files. */
  lan_share_urls: boolean
  /** Whether the backend supports getFreeDiskSpace() on storage roots. */
  free_space: boolean
}

export interface DaemonInfo {
  port: number
  token: string
  version?: string
  protocolVersion?: number
  behaviorVersion?: number
  roots: Array<{
    key: string
    path: string
    display_name: string
    removable: boolean
    last_stat_ok: boolean
    last_checked: number
  }>
  /** Host address for daemon connection. Defaults to 127.0.0.1 on desktop, but differs on ChromeOS. */
  host?: string
  /** Daemon capabilities - indicates what features are available */
  capabilities?: DaemonCapabilities
  /** Separate port for /io WebSocket endpoint (high-throughput data plane). If set, /io connects here instead of main port. */
  ioPort?: number
  /** Separate port for streaming batch writes. Uses memory-efficient streaming instead of buffering entire request. */
  streamingPort?: number
  /** Profile ID assigned by the native host */
  profileId?: string
  /** Tauri desktop app version (if installed), reported by native host */
  desktopVersion?: string
}

export interface DownloadRoot {
  key: string
  path: string
  display_name: string
  removable: boolean
  last_stat_ok: boolean
  last_checked: number
}
