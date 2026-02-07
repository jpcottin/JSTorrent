/**
 * HostChannel — host-agnostic interface for all UI-to-host communication.
 *
 * Implementations:
 * - ChromeExtensionChannel: wraps chrome.runtime messaging (contexts 1–3, 5)
 * - TauriChannel: wraps Tauri invoke/listen (context 4)
 */

import type {
  HostState,
  HostCapabilities,
  KVOpts,
  HostNotification,
  NativeEvent,
  Unsubscribe,
  DaemonStats,
  DaemonInfo,
  DownloadRoot,
} from './types'

export interface HostChannel {
  // --- Lifecycle ---
  connect(): Promise<void>
  disconnect(): void

  // --- Connection state (reactive) ---
  getState(): HostState
  onStateChanged(cb: (state: HostState) => void): Unsubscribe

  // --- Events from host (TorrentAdded, MagnetAdded) ---
  onEvent(cb: (event: NativeEvent) => void): Unsubscribe

  // --- Capabilities ---
  readonly capabilities: HostCapabilities

  // --- KV storage ---
  kvGet<T = unknown>(key: string, opts?: KVOpts): Promise<T | undefined>
  kvGetMulti(keys: string[], opts?: KVOpts): Promise<Record<string, unknown>>
  kvSet(key: string, value: unknown, opts?: KVOpts): Promise<void>
  kvDelete(key: string, opts?: KVOpts): Promise<void>
  kvKeys(prefix?: string, opts?: KVOpts): Promise<string[]>
  kvClear(prefix?: string, opts?: KVOpts): Promise<void>

  // --- File operations ---
  pickDownloadFolder(): Promise<DownloadRoot | null>
  removeDownloadRoot(key: string): Promise<void>
  openFile(rootKey: string, path: string): Promise<void>
  revealInFolder(rootKey: string, path: string): Promise<void>

  // --- Notifications (UI → host, for native OS notifications) ---
  notify(notification: HostNotification): void

  // --- Host actions ---
  retryConnection(): void
  triggerLaunch(): void

  // --- Debug / admin ---
  getStats(): Promise<DaemonStats | null>
  getDaemonInfo(): Promise<DaemonInfo | null>
  clearSessionStorage(): Promise<void>
  notifyClosing(): void

  // --- App info ---
  getVersion(): string | null
  isDevMode(): boolean
  requestPermission(permission: string): Promise<boolean>
}
