/**
 * Shared types for @jstorrent/client
 * These are Chrome-free and can be used in standalone contexts.
 */

/** Daemon capabilities - indicates what features are available */
export interface DaemonCapabilities {
  /** Whether download roots can be added/removed. False for standalone Crostini mode. */
  roots_manageable: boolean
}

export interface DaemonInfo {
  port: number
  token: string
  version?: number
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
}

export interface DownloadRoot {
  key: string
  path: string
  display_name: string
  removable: boolean
  last_stat_ok: boolean
  last_checked: number
}
