/**
 * TauriChannel — HostChannel implementation for the Tauri desktop app (context 4).
 *
 * Communicates with the system-bridge via the Tauri Rust backend, which relays
 * messages over stdin/stdout using the native messaging protocol.
 *
 * KV storage is routed through the native host to SQLite on disk,
 * shared with the Chrome extension when installed.
 *
 * Accesses the Tauri runtime directly via window.__TAURI_INTERNALS__ to avoid
 * an npm dependency on @tauri-apps/api in the shared client package.
 */

import type { HostChannel } from './host-channel'
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
  UpdateCheckResult,
} from './types'

// --- Tauri IPC helpers ---

interface TauriInternals {
  invoke: <T>(cmd: string, args?: Record<string, unknown>) => Promise<T>
  transformCallback: (callback: (...args: unknown[]) => void, once?: boolean) => number
}

function getTauriInternals(): TauriInternals {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const internals = (window as any).__TAURI_INTERNALS__ as TauriInternals | undefined
  if (!internals) throw new Error('Not running in Tauri context')
  return internals
}

function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return getTauriInternals().invoke<T>(cmd, args)
}

/**
 * Listen for Tauri events using the internal IPC mechanism.
 * Equivalent to `listen()` from @tauri-apps/api/event.
 */
function tauriListen<T>(
  event: string,
  handler: (event: { payload: T }) => void,
): Promise<() => void> {
  const internals = getTauriInternals()
  const callbackId = internals.transformCallback((rawEvent: unknown) => {
    handler(rawEvent as { payload: T })
  })
  return internals
    .invoke<number>('plugin:event|listen', {
      event,
      target: { kind: 'Any' },
      handler: callbackId,
    })
    .then((eventId) => {
      return () => {
        internals.invoke('plugin:event|unlisten', { event, eventId }).catch(() => {})
      }
    })
}

/**
 * Emit a Tauri event. Equivalent to `emit()` from @tauri-apps/api/event.
 */
function tauriEmit(event: string, payload?: unknown): Promise<void> {
  return tauriInvoke('plugin:event|emit', { event, payload })
}

// --- Host message helper ---

interface HostResponse {
  ok: boolean
  type?: string
  payload?: Record<string, unknown>
  error?: string
}

async function hostMessage(message: Record<string, unknown>): Promise<HostResponse> {
  return tauriInvoke<HostResponse>('host_message', { message })
}

// --- TauriChannel ---

export class TauriChannel implements HostChannel {
  private currentState: HostState = {
    status: 'connecting',
    platform: 'tauri',
    daemonInfo: null,
    roots: [],
    lastError: null,
  }
  private stateListeners = new Set<(state: HostState) => void>()
  private eventListeners = new Set<(event: NativeEvent) => void>()
  private eventUnlisten: (() => void) | null = null
  private daemonInfo: { port: number; token: string } | null = null

  // --- Power management state ---
  private keepAwakeEnabled = false
  private activeDownloadCount = 0
  private isBlocking = false

  // --- Lifecycle ---

  async connect(): Promise<void> {
    try {
      const response = await tauriInvoke<{
        ok: boolean
        type?: string
        payload?: { port: number; token: string; version?: string; roots?: DownloadRoot[] }
        error?: string
      }>('host_handshake')

      if (response.ok && response.type === 'DaemonInfo' && response.payload) {
        const { port, token, version, roots } = response.payload
        this.daemonInfo = { port, token }
        this.updateState({
          status: 'connected',
          platform: 'tauri',
          daemonInfo: { port, token, version, roots: roots ?? [], host: '127.0.0.1' },
          roots: roots ?? [],
          lastError: null,
        })
      } else {
        this.updateState({
          ...this.currentState,
          status: 'disconnected',
          lastError: response.error ?? 'Handshake failed',
        })
      }

      // Listen for events from system-bridge (MagnetAdded, TorrentAdded)
      this.eventUnlisten = await tauriListen<{ event?: string; payload?: unknown }>(
        'host-event',
        (event) => {
          const data = event.payload
          if (data?.event) {
            const nativeEvent: NativeEvent = { event: data.event, payload: data.payload }
            for (const cb of this.eventListeners) {
              cb(nativeEvent)
            }
          }
        },
      )

      // Retrieve any deep link events that arrived before the frontend was ready
      // (e.g., app was launched by clicking a magnet link)
      this.drainPendingDeepLinks()

      // Load keepAwake setting from persisted config
      this.kvGet<boolean>('keepAwake', { keyPrefix: 'config:' })
        .then((enabled) => {
          if (enabled) this.setKeepAwake(true)
        })
        .catch(() => {})
    } catch (e) {
      this.updateState({
        ...this.currentState,
        status: 'disconnected',
        lastError: String(e),
      })
    }
  }

  disconnect(): void {
    if (this.eventUnlisten) {
      this.eventUnlisten()
      this.eventUnlisten = null
    }
  }

  // --- Connection state ---

  getState(): HostState {
    return this.currentState
  }

  onStateChanged(cb: (state: HostState) => void): Unsubscribe {
    this.stateListeners.add(cb)
    return () => {
      this.stateListeners.delete(cb)
    }
  }

  // --- Events ---

  onEvent(cb: (event: NativeEvent) => void): Unsubscribe {
    this.eventListeners.add(cb)
    return () => {
      this.eventListeners.delete(cb)
    }
  }

  // --- Capabilities ---

  get capabilities(): HostCapabilities {
    return {
      rootsManageable: true,
      hasSync: false,
      hasNativeNotifications: true,
      hasBackgroundPersistence: true,
    }
  }

  // --- KV storage (routed through native host → SQLite) ---

  async kvGet<T = unknown>(key: string, opts?: KVOpts): Promise<T | undefined> {
    const prefixed = (opts?.keyPrefix ?? 'session:') + key
    const resp = await hostMessage({ op: 'kvGet', key: prefixed })
    if (resp.ok && resp.payload) {
      const value = resp.payload.value as string | null
      if (value != null) return JSON.parse(value) as T
    }
    return undefined
  }

  async kvGetMulti(keys: string[], opts?: KVOpts): Promise<Record<string, unknown>> {
    if (keys.length === 0) return {}
    const prefix = opts?.keyPrefix ?? 'session:'
    const prefixedKeys = keys.map((k) => prefix + k)
    const resp = await hostMessage({ op: 'kvGetMulti', keys: prefixedKeys })
    const result: Record<string, unknown> = {}
    if (resp.ok && resp.payload) {
      const entries = resp.payload.entries as Record<string, string> | undefined
      if (entries) {
        for (const [k, v] of Object.entries(entries)) {
          result[k.slice(prefix.length)] = JSON.parse(v)
        }
      }
    }
    return result
  }

  async kvSet(key: string, value: unknown, opts?: KVOpts): Promise<void> {
    const prefixed = (opts?.keyPrefix ?? 'session:') + key
    await hostMessage({ op: 'kvSet', key: prefixed, value: JSON.stringify(value) })
  }

  async kvDelete(key: string, opts?: KVOpts): Promise<void> {
    const prefixed = (opts?.keyPrefix ?? 'session:') + key
    await hostMessage({ op: 'kvDelete', key: prefixed })
  }

  async kvKeys(prefix?: string, opts?: KVOpts): Promise<string[]> {
    const keyPrefix = opts?.keyPrefix ?? 'session:'
    const fullPrefix = keyPrefix + (prefix ?? '')
    const resp = await hostMessage({ op: 'kvKeys', prefix: fullPrefix })
    if (resp.ok && resp.payload) {
      const keys = resp.payload.keys as string[] | undefined
      if (keys) return keys.map((k) => k.slice(keyPrefix.length))
    }
    return []
  }

  async kvClear(prefix?: string, opts?: KVOpts): Promise<void> {
    const keyPrefix = opts?.keyPrefix ?? 'session:'
    const fullPrefix = keyPrefix + (prefix ?? '')
    await hostMessage({ op: 'kvClear', prefix: fullPrefix })
  }

  // --- File operations ---

  async pickDownloadFolder(): Promise<DownloadRoot | null> {
    const response = await tauriInvoke<{
      ok: boolean
      type?: string
      payload?: { root: DownloadRoot }
    }>('host_message', {
      message: { op: 'pickDownloadDirectory' },
    })
    if (response.ok && response.payload?.root) {
      const newRoots = [...this.currentState.roots, response.payload.root]
      this.updateState({ ...this.currentState, roots: newRoots })
      return response.payload.root
    }
    return null
  }

  async removeDownloadRoot(key: string): Promise<void> {
    await tauriInvoke('host_message', {
      message: { op: 'deleteDownloadRoot', key },
    })
    const newRoots = this.currentState.roots.filter((r) => r.key !== key)
    this.updateState({ ...this.currentState, roots: newRoots })
  }

  async openFile(rootKey: string, path: string): Promise<void> {
    await tauriInvoke('host_message', {
      message: { op: 'openFile', rootKey, path },
    })
  }

  async revealInFolder(rootKey: string, path: string): Promise<void> {
    await tauriInvoke('host_message', {
      message: { op: 'revealInFolder', rootKey, path },
    })
  }

  // --- Notifications ---

  notify(notification: HostNotification): void {
    if (notification.type === 'stats') {
      tauriInvoke('update_tray_stats', { stats: notification.stats }).catch(() => {})
      this.activeDownloadCount = notification.stats.activeCount
      this.updateNoSleep()
    } else if (notification.type === 'torrent-complete') {
      this.showNotificationIfEnabled(
        'notifyOnTorrentComplete',
        'Download Complete',
        notification.name,
      )
    } else if (notification.type === 'torrent-error') {
      this.showNotificationIfEnabled(
        'notifyOnError',
        'Download Error',
        `${notification.name}: ${notification.error}`,
      )
    } else if (notification.type === 'duplicate-torrent') {
      tauriInvoke('show_notification', {
        title: 'Already Added',
        body: `"${notification.name}" is already in your torrent list`,
      }).catch(() => {})
    }
  }

  private showNotificationIfEnabled(settingKey: string, title: string, body: string): void {
    this.kvGet<boolean>(settingKey, { keyPrefix: 'config:' })
      .then((enabled) => {
        if (enabled !== false) {
          tauriInvoke('show_notification', { title, body }).catch(() => {})
        }
      })
      .catch(() => {
        // Setting not found, default to enabled
        tauriInvoke('show_notification', { title, body }).catch(() => {})
      })
  }

  // --- Host actions ---

  retryConnection(): void {
    this.connect().catch((e) => {
      console.error('[TauriChannel] Retry failed:', e)
    })
  }

  triggerLaunch(): void {
    // No-op — daemon is always launched by system-bridge
  }

  // --- Debug / admin ---

  async getStats(): Promise<DaemonStats | null> {
    if (!this.daemonInfo) return null
    const { port, token } = this.daemonInfo
    try {
      const response = await fetch(`http://127.0.0.1:${port}/stats`, {
        headers: { 'X-JST-Auth': token },
      })
      return response.ok ? ((await response.json()) as DaemonStats) : null
    } catch {
      return null
    }
  }

  async getDaemonInfo(): Promise<DaemonInfo | null> {
    return this.currentState.daemonInfo
  }

  async clearSessionStorage(): Promise<void> {
    try {
      await this.kvClear(undefined, { keyPrefix: 'session:' })
    } catch (e) {
      console.warn('[TauriChannel] Failed to clear session storage:', e)
    }
  }

  notifyClosing(): void {
    // No-op — Tauri handles app lifecycle natively
  }

  // --- App info ---

  getVersion(): string | null {
    // Set in Tauri app's vite.config.ts via define: { 'import.meta.env.PACKAGE_VERSION': ... }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (import.meta as any).env?.PACKAGE_VERSION ?? null
  }

  isDevMode(): boolean {
    return import.meta.env?.DEV ?? false
  }

  requestPermission(_permission: string): Promise<boolean> {
    return Promise.resolve(true) // Desktop apps have full permissions
  }

  setKeepAwake(enabled: boolean): void {
    this.keepAwakeEnabled = enabled
    this.updateNoSleep()
  }

  async checkForUpdates(): Promise<UpdateCheckResult | null> {
    tauriEmit('check-for-updates')
    return null // Tauri handles updates via its own JS-side dialog
  }

  async installUpdate(): Promise<boolean> {
    // Tauri handles install via its own dialog triggered by checkForUpdates
    return false
  }

  // --- Private helpers ---

  private drainPendingDeepLinks(): void {
    tauriInvoke<{ event: string; payload: unknown }[]>('get_pending_deep_links')
      .then((events) => {
        for (const evt of events) {
          if (evt.event) {
            const nativeEvent: NativeEvent = { event: evt.event, payload: evt.payload }
            for (const cb of this.eventListeners) {
              cb(nativeEvent)
            }
          }
        }
      })
      .catch((e) => {
        console.warn('[TauriChannel] Failed to get pending deep links:', e)
      })
  }

  private updateNoSleep(): void {
    const shouldBlock = this.keepAwakeEnabled && this.activeDownloadCount > 0
    if (shouldBlock && !this.isBlocking) {
      tauriInvoke('plugin:nosleep|block', {
        noSleepType: 'PreventUserIdleSystemSleep',
      }).catch((e) => console.warn('[TauriChannel] Failed to block sleep:', e))
      this.isBlocking = true
    } else if (!shouldBlock && this.isBlocking) {
      tauriInvoke('plugin:nosleep|unblock').catch((e) =>
        console.warn('[TauriChannel] Failed to unblock sleep:', e),
      )
      this.isBlocking = false
    }
  }

  private updateState(newState: HostState): void {
    this.currentState = newState
    for (const cb of this.stateListeners) {
      cb(newState)
    }
  }
}
