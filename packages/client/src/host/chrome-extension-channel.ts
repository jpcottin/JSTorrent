/**
 * ChromeExtensionChannel — HostChannel implementation for Chrome extension contexts.
 *
 * Two modes:
 * - Internal (no extensionId): uses chrome.runtime.sendMessage(msg) — inside extension
 * - External (with extensionId): uses chrome.runtime.sendMessage(id, msg) — website/dev server
 *
 * Port management with auto-reconnect extracted from useIOBridgeState.ts.
 */

import type { BootstrapState } from '../../../../extension/src/lib/chromeos-bootstrap'
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

export class ChromeExtensionChannel implements HostChannel {
  private extensionId: string | null
  private port: chrome.runtime.Port | null = null
  private stateListeners = new Set<(state: HostState) => void>()
  private eventListeners = new Set<(event: NativeEvent) => void>()
  private chromeosBootstrapListeners = new Set<(state: BootstrapState) => void>()
  private currentState: HostState = {
    status: 'connecting',
    platform: 'desktop',
    daemonInfo: null,
    roots: [],
    lastError: null,
  }
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private chromeosBootstrapState: BootstrapState | null = null
  private visibilityHandler: (() => void) | null = null
  private connected = false

  constructor(extensionId?: string) {
    this.extensionId = extensionId ?? null
  }

  // --- Lifecycle ---

  async connect(): Promise<void> {
    // Fetch initial state
    try {
      const response = await this.sendMessage<{
        ok: boolean
        state?: HostState
        hasEverConnected?: boolean
      }>({ type: 'GET_BRIDGE_STATE' })
      if (response.ok && response.state) {
        this.updateState(response.state)
      }
    } catch (e) {
      console.error('[ChromeExtensionChannel] Failed to get initial state:', e)
    }

    // Open persistent port for streaming updates
    this.connectPort()

    // Listen for visibility changes to reconnect
    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible' && !this.port) {
        console.log('[ChromeExtensionChannel] Tab became visible, reconnecting port')
        this.connectPort()
      }
    }
    document.addEventListener('visibilitychange', this.visibilityHandler)
    this.connected = true
  }

  disconnect(): void {
    this.connected = false
    if (this.visibilityHandler) {
      document.removeEventListener('visibilitychange', this.visibilityHandler)
      this.visibilityHandler = null
    }
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    if (this.port) {
      this.port.disconnect()
      this.port = null
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
      hasSync: true,
      hasNativeNotifications: true,
      hasBackgroundPersistence: false, // SW may suspend
    }
  }

  // --- KV storage ---

  async kvGet<T = unknown>(key: string, opts?: KVOpts): Promise<T | undefined> {
    const response = await this.sendMessage<{ ok: boolean; value?: T }>({
      type: 'KV_GET',
      key,
      keyPrefix: opts?.keyPrefix ?? 'session:',
    })
    return response.ok ? response.value : undefined
  }

  async kvGetMulti(keys: string[], opts?: KVOpts): Promise<Record<string, unknown>> {
    const response = await this.sendMessage<{ ok: boolean; values?: Record<string, unknown> }>({
      type: 'KV_GET_MULTI',
      keys,
      keyPrefix: opts?.keyPrefix ?? 'session:',
    })
    return response.ok && response.values ? response.values : {}
  }

  async kvSet(key: string, value: unknown, opts?: KVOpts): Promise<void> {
    await this.sendMessage({
      type: 'KV_SET',
      key,
      value,
      keyPrefix: opts?.keyPrefix ?? 'session:',
    })
  }

  async kvDelete(key: string, opts?: KVOpts): Promise<void> {
    await this.sendMessage({
      type: 'KV_DELETE',
      key,
      keyPrefix: opts?.keyPrefix ?? 'session:',
    })
  }

  async kvKeys(prefix?: string, opts?: KVOpts): Promise<string[]> {
    const response = await this.sendMessage<{ ok: boolean; keys?: string[] }>({
      type: 'KV_KEYS',
      prefix: prefix ?? '',
      keyPrefix: opts?.keyPrefix ?? 'session:',
    })
    return response.ok && response.keys ? response.keys : []
  }

  async kvClear(prefix?: string, opts?: KVOpts): Promise<void> {
    await this.sendMessage({
      type: 'KV_CLEAR',
      prefix: prefix ?? '',
      keyPrefix: opts?.keyPrefix ?? 'session:',
    })
  }

  // --- File operations ---

  async pickDownloadFolder(): Promise<DownloadRoot | null> {
    const response = await this.sendMessage<{ ok: boolean; root?: DownloadRoot }>({
      type: 'PICK_DOWNLOAD_FOLDER',
    })
    return response.ok && response.root ? response.root : null
  }

  async removeDownloadRoot(key: string): Promise<void> {
    await this.sendMessage({ type: 'REMOVE_DOWNLOAD_ROOT', key })
  }

  async openFile(rootKey: string, path: string): Promise<void> {
    await this.sendMessage({ type: 'OPEN_FILE', rootKey, path })
  }

  async revealInFolder(rootKey: string, path: string): Promise<void> {
    await this.sendMessage({ type: 'REVEAL_IN_FOLDER', rootKey, path })
  }

  // --- Notifications ---

  notify(notification: HostNotification): void {
    const { type, ...rest } = notification
    this.postMessage({ type: 'notification:' + type, ...rest })
  }

  // --- Host actions ---

  retryConnection(): void {
    this.reconnectPort()
    this.postMessage({ type: 'RETRY_CONNECTION' })
  }

  triggerLaunch(): void {
    this.postMessage({ type: 'TRIGGER_LAUNCH' })
  }

  // --- Debug / admin ---

  async getStats(): Promise<DaemonStats | null> {
    try {
      const response = await this.sendMessage<{ ok: boolean; stats?: DaemonStats }>({
        type: 'GET_DAEMON_STATS',
      })
      return response.ok && response.stats ? response.stats : null
    } catch {
      return null
    }
  }

  async getDaemonInfo(): Promise<DaemonInfo | null> {
    try {
      const response = await this.sendMessage<{ ok: boolean; daemonInfo?: DaemonInfo }>({
        type: 'GET_DAEMON_INFO',
      })
      return response.ok && response.daemonInfo ? response.daemonInfo : null
    } catch {
      return null
    }
  }

  async clearSessionStorage(): Promise<void> {
    await this.sendMessage({ type: 'CLEAR_SESSION_STORAGE' })
  }

  notifyClosing(): void {
    this.postMessage({ type: 'UI_CLOSING' })
  }

  // --- App info ---

  getVersion(): string | null {
    try {
      return chrome.runtime.getManifest?.()?.version ?? null
    } catch {
      return null
    }
  }

  isDevMode(): boolean {
    try {
      return !chrome.runtime.getManifest?.()?.update_url
    } catch {
      return false
    }
  }

  async requestPermission(permission: string): Promise<boolean> {
    if (typeof chrome !== 'undefined' && chrome.permissions?.request) {
      return new Promise<boolean>((resolve) => {
        chrome.permissions.request(
          { permissions: [permission as chrome.runtime.ManifestPermission] },
          (granted) => resolve(granted),
        )
      })
    }
    return true
  }

  setKeepAwake(_enabled: boolean): void {
    // No-op — extension handles this via PowerManager in the service worker
  }

  checkForUpdates(): void {
    // No-op — Chrome extensions update through the Web Store
  }

  // --- Desktop mutual exclusion ---

  async takeOverFromDesktop(): Promise<boolean> {
    try {
      const response = await this.sendMessage<{ ok: boolean }>({
        type: 'TAKE_OVER_FROM_DESKTOP',
      })
      return response.ok
    } catch {
      return false
    }
  }

  // --- ChromeOS-specific methods (not on HostChannel interface) ---

  openChromeOSIntent(): void {
    this.postMessage({ type: 'CHROMEOS_OPEN_INTENT' })
  }

  resetChromeOSPairing(): void {
    this.postMessage({ type: 'CHROMEOS_RESET_PAIRING' })
  }

  getChromeOSBootstrapState(): BootstrapState | null {
    return this.chromeosBootstrapState
  }

  onChromeOSBootstrapStateChanged(cb: (state: BootstrapState) => void): Unsubscribe {
    this.chromeosBootstrapListeners.add(cb)
    return () => {
      this.chromeosBootstrapListeners.delete(cb)
    }
  }

  // --- Private helpers ---

  /**
   * Promise wrapper around chrome.runtime.sendMessage, handling extensionId
   * and chrome.runtime.lastError.
   */
  private sendMessage<T = unknown>(message: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!chrome?.runtime?.sendMessage) {
        reject(new Error('chrome.runtime.sendMessage not available'))
        return
      }

      const callback = (response: T) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else {
          resolve(response)
        }
      }

      if (this.extensionId) {
        chrome.runtime.sendMessage(this.extensionId, message, callback)
      } else {
        chrome.runtime.sendMessage(message, callback)
      }
    })
  }

  /**
   * Fire-and-forget via sendMessage. Always uses chrome.runtime.sendMessage
   * (not the port) because the SW only handles these in onMessage, not port.onMessage.
   */
  private postMessage(message: unknown): void {
    if (chrome?.runtime?.sendMessage) {
      if (this.extensionId) {
        chrome.runtime.sendMessage(this.extensionId, message).catch(() => {})
      } else {
        chrome.runtime.sendMessage(message).catch(() => {})
      }
    }
  }

  /**
   * Handle incoming port message. Dispatches to state/event/chromeos listeners.
   */
  private handlePortMessage = (msg: {
    type?: string
    event?: string
    payload?: unknown
    state?: unknown
    hasEverConnected?: boolean
  }): void => {
    if (msg.type === 'BRIDGE_STATE_CHANGED' && msg.state) {
      this.updateState(msg.state as HostState)
    } else if (msg.type === 'CHROMEOS_BOOTSTRAP_STATE' && msg.state) {
      this.chromeosBootstrapState = msg.state as BootstrapState
      for (const cb of this.chromeosBootstrapListeners) {
        cb(this.chromeosBootstrapState)
      }
    } else if (msg.type === 'CLOSE') {
      console.log('[ChromeExtensionChannel] Received CLOSE, closing window')
      window.close()
    } else if (msg.event) {
      const event: NativeEvent = { event: msg.event, payload: msg.payload }
      for (const cb of this.eventListeners) {
        cb(event)
      }
    }
  }

  /**
   * Connect port to service worker. Handles reconnection on disconnect.
   */
  private connectPort(): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }

    // Clean up existing port
    if (this.port) {
      this.port.disconnect()
      this.port = null
    }

    try {
      let port: chrome.runtime.Port
      if (this.extensionId) {
        port = chrome.runtime.connect(this.extensionId, { name: 'ui' })
      } else {
        port = chrome.runtime.connect({ name: 'ui' })
      }

      port.onMessage.addListener(this.handlePortMessage)

      port.onDisconnect.addListener(() => {
        console.log('[ChromeExtensionChannel] Port disconnected')
        this.port = null

        // Don't reconnect if we've been disconnected intentionally
        if (!this.connected) return

        // Visibility-based reconnection
        if (document.visibilityState === 'visible') {
          console.log('[ChromeExtensionChannel] Tab visible, scheduling reconnect')
          this.reconnectTimeout = setTimeout(() => {
            this.connectPort()
          }, 100)
        } else {
          console.log('[ChromeExtensionChannel] Tab hidden, will reconnect when visible')
        }
      })

      this.port = port
      console.log('[ChromeExtensionChannel] Port connected')
    } catch (e) {
      console.error('[ChromeExtensionChannel] Failed to connect port:', e)
    }
  }

  /**
   * Reconnect the port (disconnect existing, open new).
   */
  private reconnectPort(): void {
    this.connectPort()
  }

  /**
   * Update internal state and notify listeners.
   */
  private updateState(newState: HostState): void {
    this.currentState = newState
    for (const cb of this.stateListeners) {
      cb(newState)
    }
  }
}
