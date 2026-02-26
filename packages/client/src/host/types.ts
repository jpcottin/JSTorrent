/**
 * Shared types for the HostChannel abstraction.
 *
 * Consolidates types previously scattered across useIOBridgeState.ts,
 * SystemBridgePanel.tsx, and notification-bridge.ts.
 */

// Re-export canonical types from the package-level types file
export type { DaemonInfo, DownloadRoot, DaemonCapabilities } from '../types'

import type { DaemonInfo, DownloadRoot } from '../types'

// --- Connection & Platform ---

/** Port connection status (UI to Service Worker) */
export type PortStatus = 'connected' | 'disconnected' | 'reconnecting'

/** Platform type */
export type Platform = 'desktop' | 'chromeos' | 'tauri'

/** Connection status */
export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

// --- Daemon Stats ---

/** Stats from the daemon about socket and connection state */
export interface DaemonStats {
  tcp_sockets: number
  pending_connects: number
  pending_tcp: number
  udp_sockets: number
  tcp_servers: number
  ws_connections: number
  bytes_sent: number
  bytes_received: number
  uptime_secs: number
}

// --- Profile In Use ---

/** Metadata about the client currently using a profile (returned on profile_in_use error). */
export interface ProfileInUseInfo {
  clientType?: string
  clientVersion?: string
  browserName?: string
  pid?: number
  started?: number
}

// --- Host State ---

/** Host state — the unified state object for all host channel implementations. */
export interface HostState {
  status: ConnectionStatus
  platform: Platform
  daemonInfo: DaemonInfo | null
  roots: DownloadRoot[]
  lastError: string | null
  /** Metadata about the client currently using the profile (set when lastError === 'profile_in_use') */
  profileInUseInfo?: ProfileInUseInfo | null
}

/**
 * @deprecated Use {@link HostState} instead. Kept for backward compatibility.
 */
export type DaemonBridgeState = HostState

// --- Host Capabilities ---

/** Capabilities of the current host environment. */
export interface HostCapabilities {
  /** Can add/remove download roots */
  rootsManageable: boolean
  /** KV sync storage available (chrome.storage.sync) */
  hasSync: boolean
  /** Can show OS-level notifications */
  hasNativeNotifications: boolean
  /** Stays alive without UI tricks (e.g., SW suspension) */
  hasBackgroundPersistence: boolean
}

// --- KV Storage ---

/** Options for KV storage operations. */
export interface KVOpts {
  /** Key namespace (default: 'session:') */
  keyPrefix?: string
}

// --- Notifications ---

/** Progress stats for notification updates. */
export interface ProgressStats {
  activeCount: number
  errorCount: number
  downloadSpeed: number // bytes per second
  uploadSpeed?: number // bytes per second
  eta: number | null // seconds, null if unknown
  singleTorrentName?: string // set when activeCount === 1
}

/** Notification from UI to host. */
export type HostNotification =
  | { type: 'visibility'; visible: boolean }
  | { type: 'stats'; stats: ProgressStats }
  | { type: 'torrent-complete'; infoHash: string; name: string }
  | { type: 'torrent-error'; infoHash: string; name: string; error: string }
  | { type: 'duplicate-torrent'; name: string }
  | { type: 'torrent-added' }

// --- Events ---

/** Unsolicited event pushed from host (e.g., MagnetAdded, TorrentAdded). */
export interface NativeEvent {
  event: string
  payload: unknown
}

// --- Profiles ---

/** Entry in the profile list returned by listProfiles(). */
export interface ProfileListEntry {
  profileId: string
  displayName: string
  created: number
  lastUsed: number
  clientType?: string
  clientVersion?: string
  live: boolean
}

// --- Updates ---

/** Result of a desktop app update check. */
export interface UpdateCheckResult {
  available: boolean
  version?: string
  currentVersion?: string
  body?: string
}

// --- Usage Metrics ---

/** Aggregate usage metrics for bug reports (extension-only, from chrome.storage.sync). */
export interface UsageMetrics {
  completedDownloads: number
  torrentsAdded: number
  sessionsStarted: number
  devices: number
  daysInstalled?: number
}

// --- Utility ---

/** Unsubscribe function returned by event listeners. */
export type Unsubscribe = () => void
