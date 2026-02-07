/**
 * TauriChannel — HostChannel implementation for the Tauri desktop app (context 4).
 *
 * Communicates with the system-bridge via the Tauri Rust backend, which relays
 * messages over stdin/stdout using the native messaging protocol.
 *
 * KV storage uses localStorage with `jst:` prefix (no sync storage in Tauri).
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
      hasNativeNotifications: false,
      hasBackgroundPersistence: true,
    }
  }

  // --- KV storage (localStorage with jst: prefix) ---

  async kvGet<T = unknown>(key: string, opts?: KVOpts): Promise<T | undefined> {
    const prefixed = (opts?.keyPrefix ?? 'session:') + key
    const raw = localStorage.getItem(`jst:${prefixed}`)
    return raw != null ? (JSON.parse(raw) as T) : undefined
  }

  async kvGetMulti(keys: string[], opts?: KVOpts): Promise<Record<string, unknown>> {
    const prefix = opts?.keyPrefix ?? 'session:'
    const result: Record<string, unknown> = {}
    for (const key of keys) {
      const raw = localStorage.getItem(`jst:${prefix}${key}`)
      if (raw != null) result[key] = JSON.parse(raw)
    }
    return result
  }

  async kvSet(key: string, value: unknown, opts?: KVOpts): Promise<void> {
    const prefixed = (opts?.keyPrefix ?? 'session:') + key
    localStorage.setItem(`jst:${prefixed}`, JSON.stringify(value))
  }

  async kvDelete(key: string, opts?: KVOpts): Promise<void> {
    const prefixed = (opts?.keyPrefix ?? 'session:') + key
    localStorage.removeItem(`jst:${prefixed}`)
  }

  async kvKeys(prefix?: string, opts?: KVOpts): Promise<string[]> {
    const keyPrefix = opts?.keyPrefix ?? 'session:'
    const fullPrefix = `jst:${keyPrefix}${prefix ?? ''}`
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(fullPrefix)) {
        // Strip the jst:{keyPrefix} prefix to return the bare key
        keys.push(k.slice(`jst:${keyPrefix}`.length))
      }
    }
    return keys
  }

  async kvClear(prefix?: string, opts?: KVOpts): Promise<void> {
    const keyPrefix = opts?.keyPrefix ?? 'session:'
    const fullPrefix = `jst:${keyPrefix}${prefix ?? ''}`
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(fullPrefix)) keysToRemove.push(k)
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k))
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

  notify(_notification: HostNotification): void {
    // No-op initially; later can be wired to Tauri notification plugin
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
    const keysToRemove: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith('jst:session:')) keysToRemove.push(key)
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k))
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

  // --- Private helpers ---

  private updateState(newState: HostState): void {
    this.currentState = newState
    for (const cb of this.stateListeners) {
      cb(newState)
    }
  }
}
