/**
 * Daemon Bridge
 *
 * Simplified connection management for both desktop and ChromeOS.
 * Replaces the complex IOBridge state machine with 3 simple states.
 */

import type { Platform } from './platform'
import { detectPlatform } from './platform'
import type { DaemonInfo, DownloadRoot } from './native-connection'
import { getOrCreateTelemetryId } from './telemetry-id'
import { buildControlFrame } from './daemon-bridge/protocol/control-frame'
import {
  sendNativeRequest as sendNativeRequestViaPort,
  sendNativeRequestFull as sendNativeRequestFullViaPort,
} from './daemon-bridge/desktop/native-requests'
import { connectDesktopHandshake } from './daemon-bridge/desktop/desktop-connector'
import { requestDesktopTakeOver } from './daemon-bridge/desktop/takeover'
import {
  pickDownloadFolderDesktop,
  removeDownloadRootDesktop,
} from './daemon-bridge/desktop/root-ops'
import { parseControlEventFrame, parseRootsChangedFrame } from './daemon-bridge/chromeos/ws-events'
import {
  fetchChromeosStatus,
  findChromeosDaemonPort,
  requestChromeosPairing,
} from './daemon-bridge/chromeos/http-api'
import {
  buildConnectedDaemonInfo,
  buildDaemonCapabilities,
  fetchChromeosRoots,
} from './daemon-bridge/chromeos/connection-complete'
import {
  handleControlResponseFrame,
  handleKvResponseFrame,
  sendControlRequestOverWebSocket,
  sendKvRequestOverWebSocket,
} from './daemon-bridge/chromeos/ws-requests'
import { connectChromeosControlWebSocket } from './daemon-bridge/chromeos/ws-connect'
import { restartHealthCheck } from './daemon-bridge/shared/health-check'
import { ensureChromeosPairedAndConnect } from './daemon-bridge/chromeos/pairing'

// Re-export types for convenience
export type { DaemonCapabilities, DaemonInfo, DownloadRoot } from './native-connection'

/**
 * Stats from the daemon about socket and connection state
 */
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

// ============================================================================
// Types
// ============================================================================

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected'

export interface ProfileInUseInfo {
  clientType?: string
  clientVersion?: string
  browserName?: string
  pid?: number
  started?: number
}

export interface DaemonBridgeState {
  status: ConnectionStatus
  platform: Platform
  daemonInfo: DaemonInfo | null
  roots: DownloadRoot[]
  lastError: string | null
  /** Metadata about the client currently using the profile (set when lastError === 'profile_in_use') */
  profileInUseInfo?: ProfileInUseInfo | null
}

export interface NativeEvent {
  event: string
  payload: unknown
}

export type StateListener = (state: DaemonBridgeState) => void
export type EventListener = (event: NativeEvent) => void

// ============================================================================
// Storage Keys
// ============================================================================

const STORAGE_KEY_TOKEN = 'android:authToken'
const STORAGE_KEY_PORT = 'android:daemonPort'
const STORAGE_KEY_HAS_CONNECTED = 'daemon:hasConnectedSuccessfully'
const STORAGE_KEY_LAST_CONNECTED = 'daemon:lastConnectedTime'

// ============================================================================
// Host Constants
// ============================================================================

/** Host for desktop (macOS/Windows/Linux) native messaging daemon */
const DESKTOP_HOST = '127.0.0.1'

/** Host for ChromeOS Android app daemon (ARC container IP) */
const CHROMEOS_ANDROID_HOST = '100.115.92.2'

/** Host for ChromeOS Crostini standalone daemon (Linux VM hostname) */
const CHROMEOS_CROSTINI_HOST = 'penguin.linux.test'

/** All ChromeOS hosts to try, in order of preference */
const CHROMEOS_HOSTS = [CHROMEOS_ANDROID_HOST, CHROMEOS_CROSTINI_HOST]

/** Storage key for last successful host */
const STORAGE_KEY_HOST = 'android:daemonHost'

// ============================================================================
// DaemonBridge Class
// ============================================================================

export class DaemonBridge {
  private state: DaemonBridgeState
  private stateListeners = new Set<StateListener>()
  private eventListeners = new Set<EventListener>()

  // Platform-specific
  private nativePort: chrome.runtime.Port | null = null
  private ws: WebSocket | null = null
  private healthCheckInterval: ReturnType<typeof setInterval> | null = null

  // Pending KV requests (for request/response correlation)
  private pendingKvRequests = new Map<
    number,
    { resolve: (response: unknown) => void; reject: (error: Error) => void }
  >()

  // Pending control requests (for open file/folder response correlation)
  private pendingControlRequests = new Map<
    number,
    { resolve: (response: { ok: boolean; error?: string }) => void }
  >()

  constructor() {
    const platform = detectPlatform()
    this.state = {
      status: 'disconnected',
      platform,
      daemonInfo: null,
      roots: [],
      lastError: null,
    }
  }

  // ==========================================================================
  // Public API
  // ==========================================================================

  getState(): DaemonBridgeState {
    return this.state
  }

  getPlatform(): Platform {
    return this.state.platform
  }

  subscribe(listener: StateListener): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  // Guard against concurrent connect() calls
  private connectPromise: Promise<boolean> | null = null

  /**
   * Attempt to connect to the daemon.
   * Returns true if connection succeeded.
   * Serializes concurrent calls - if already connecting, returns the existing promise.
   */
  async connect(): Promise<boolean> {
    // If already connecting, return existing promise to avoid race conditions
    if (this.connectPromise) {
      console.log('[DaemonBridge] connect() already in progress, returning existing promise')
      return this.connectPromise
    }

    // If already connected, return immediately
    if (this.state.status === 'connected') {
      console.log('[DaemonBridge] connect() called but already connected')
      return true
    }

    this.connectPromise = this.doConnect()
    try {
      return await this.connectPromise
    } finally {
      this.connectPromise = null
    }
  }

  private async doConnect(): Promise<boolean> {
    this.updateState({ status: 'connecting', lastError: null })

    try {
      if (this.state.platform === 'desktop') {
        await this.connectDesktop()
      } else {
        await this.connectChromeos()
      }

      await chrome.storage.local.set({
        [STORAGE_KEY_HAS_CONNECTED]: true,
        [STORAGE_KEY_LAST_CONNECTED]: Date.now(),
      })
      return true
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown error'
      this.updateState({ status: 'disconnected', lastError: error })
      return false
    }
  }

  /**
   * Disconnect from the daemon.
   */
  disconnect(): void {
    this.cleanup()
    this.updateState({
      status: 'disconnected',
      daemonInfo: null,
      roots: [],
    })
  }

  /**
   * Check if we've ever successfully connected (for install prompt logic).
   */
  async hasEverConnected(): Promise<boolean> {
    const result = await chrome.storage.local.get(STORAGE_KEY_HAS_CONNECTED)
    return result[STORAGE_KEY_HAS_CONNECTED] === true
  }

  /**
   * Get the timestamp of the last successful connection (epoch ms).
   */
  async getLastConnectedTime(): Promise<number | null> {
    const result = await chrome.storage.local.get(STORAGE_KEY_LAST_CONNECTED)
    const value = result[STORAGE_KEY_LAST_CONNECTED]
    return typeof value === 'number' ? value : null
  }

  /**
   * Get the add_token for validating launch page requests.
   * Returns the token from the native host handshake, or null if not connected.
   */
  getAddToken(): string | null {
    return this.state.daemonInfo?.addToken ?? null
  }

  /**
   * Send a power hint to the companion, indicating how many downloads are active.
   * The companion uses this to acquire/release wake locks (prevents ARCVM Doze on ChromeOS).
   * Only effective on ChromeOS when connected via WebSocket.
   */
  sendPowerHint(activeDownloads: number): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    const payload = new TextEncoder().encode(JSON.stringify({ activeDownloads }))
    this.ws.send(buildControlFrame(0xeb, 0, payload))
  }

  /**
   * Read a .torrent file via the native host.
   * Desktop only — returns error on ChromeOS.
   */
  async readTorrentFile(
    path: string,
  ): Promise<{ ok: boolean; name?: string; contentsBase64?: string; error?: string }> {
    if (this.state.platform !== 'desktop') {
      return { ok: false, error: 'readTorrentFile only available on desktop' }
    }
    const response = await this.sendNativeRequestFull('readTorrentFile', { path })
    if (response.ok && response.type === 'TorrentFileContents') {
      const payload = response.payload as { name?: string; contentsBase64?: string }
      return { ok: true, name: payload?.name, contentsBase64: payload?.contentsBase64 }
    }
    return { ok: false, error: (response.error as string) ?? 'Unknown error' }
  }

  /**
   * Trigger Android app launch (ChromeOS only).
   * Opens launch intent then polls for daemon and initiates pairing.
   */
  async triggerLaunch(): Promise<boolean> {
    if (this.state.platform !== 'chromeos') return false

    try {
      // Launch intent - starts the app in companion mode
      const intentUrl =
        'intent://launch#Intent;scheme=jstorrent;package=com.jstorrent.app;S.force_companion=true;end'

      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
      if (tab?.id) {
        await chrome.tabs.update(tab.id, { url: intentUrl })
      } else {
        await chrome.tabs.create({ url: intentUrl })
      }

      this.updateState({ status: 'connecting', lastError: null })
      this.waitForDaemonAndPair()

      return true
    } catch (e) {
      console.error('[DaemonBridge] Failed to trigger launch:', e)
      return false
    }
  }

  /**
   * Wait for daemon to become reachable after launch, then pair if needed.
   */
  private async waitForDaemonAndPair(): Promise<void> {
    const maxWaitAttempts = 30 // 30s to wait for daemon to start
    const pollInterval = 1000

    // Phase 1: Wait for daemon to become reachable
    let found: { host: string; port: number } | null = null
    for (let i = 0; i < maxWaitAttempts; i++) {
      found = await this.findDaemonPort()
      if (found) break
      await new Promise((r) => setTimeout(r, pollInterval))
    }

    if (!found) {
      this.updateState({
        status: 'disconnected',
        lastError: 'Companion app did not start',
      })
      return
    }

    // Phase 2: Check status and pair if needed
    await this.checkStatusAndPair(found.host, found.port)
  }

  /**
   * Check pairing status and initiate pairing flow if needed.
   */
  private async checkStatusAndPair(host: string, port: number): Promise<void> {
    const installId = await getOrCreateTelemetryId()
    const extensionId = chrome.runtime.id

    const result = await ensureChromeosPairedAndConnect({
      host,
      port,
      extensionId,
      installId,
      fetchStatus: (h, p) => this.fetchStatus(h, p),
      requestPairing: (h, p) => this.requestPairing(h, p),
      completeConnection: (h, p, version, capabilities, ioPort, streamingPort) =>
        this.completeConnection(h, p, version, capabilities, ioPort, streamingPort),
      wait: (ms) => new Promise((r) => setTimeout(r, ms)),
      conflictRetryMs: 2000,
      pollIntervalMs: 1000,
      maxPollAttempts: 60,
    })

    if (result === 'timeout') {
      this.updateState({
        status: 'disconnected',
        lastError: 'Pairing timed out',
      })
    }
  }

  /**
   * Build standard headers for all HTTP requests.
   */
  private async buildHeaders(includeAuth: boolean = false): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'X-JST-ExtensionId': chrome.runtime.id,
      'X-JST-InstallId': await getOrCreateTelemetryId(),
    }
    if (includeAuth) {
      const token = await this.getOrCreateToken()
      headers['X-JST-Auth'] = token
    }
    return headers
  }

  /**
   * Fetch status from daemon (POST for Origin header).
   */
  private async fetchStatus(
    host: string,
    port: number,
  ): Promise<{
    port: number
    paired: boolean
    extensionId: string | null
    installId: string | null
    version: string | null
    capabilities?: { roots_manageable?: boolean }
    ioPort?: number
    streamingPort?: number
  }> {
    const headers = await this.buildHeaders()
    return fetchChromeosStatus({
      fetchImpl: fetch,
      host,
      port,
      headers,
    })
  }

  /**
   * Request pairing via POST /pair.
   * Returns 'approved', 'pending', or 'conflict'.
   */
  private async requestPairing(
    host: string,
    port: number,
  ): Promise<'approved' | 'pending' | 'conflict'> {
    const token = await this.getOrCreateToken()
    const headers = await this.buildHeaders()
    return requestChromeosPairing({
      fetchImpl: fetch,
      host,
      port,
      headers,
      token,
    })
  }

  /**
   * Complete connection after pairing confirmed.
   */
  private async completeConnection(
    host: string,
    port: number,
    version?: string | null,
    capabilities?: { roots_manageable?: boolean },
    ioPort?: number,
    streamingPort?: number,
  ): Promise<void> {
    const token = await this.getOrCreateToken()
    const headers = await this.buildHeaders(true)

    const roots = await fetchChromeosRoots({
      fetchImpl: fetch,
      host,
      port,
      headers,
    })

    // Connect WebSocket to ioPort (where /control now lives after Ktor->Netty migration)
    if (!ioPort) {
      throw new Error('ioPort not provided - daemon may need update')
    }
    await this.connectWebSocket(host, ioPort, token)

    const daemonCapabilities = buildDaemonCapabilities(capabilities)
    const daemonInfo = buildConnectedDaemonInfo({
      port,
      token,
      version,
      roots,
      host,
      capabilities,
      ioPort,
      streamingPort,
    })

    this.updateState({
      status: 'connected',
      daemonInfo,
      roots,
      lastError: null,
    })

    await chrome.storage.local.set({ [STORAGE_KEY_HAS_CONNECTED]: true })
    this.startHealthCheck(host, port)
    console.log(
      `[DaemonBridge] Connected successfully to ${host}:${port} (roots_manageable: ${daemonCapabilities.roots_manageable})`,
    )
  }

  /**
   * Trigger folder picker.
   * Desktop: via native messaging
   * ChromeOS: via Android intent, returns when ROOTS_CHANGED received
   */
  async pickDownloadFolder(): Promise<DownloadRoot | null> {
    if (this.state.platform === 'desktop') {
      return this.pickFolderDesktop()
    } else {
      return this.pickFolderChromeos()
    }
  }

  /**
   * Remove a download root.
   * Desktop: via native messaging
   * ChromeOS: via HTTP DELETE to Android daemon
   */
  async removeDownloadRoot(key: string): Promise<boolean> {
    if (this.state.platform === 'desktop') {
      return this.removeRootDesktop(key)
    } else {
      return this.removeRootChromeos(key)
    }
  }

  /**
   * Open a file with the system's default application.
   * Desktop: via native messaging. ChromeOS: via Android companion WebSocket.
   */
  async openFile(rootKey: string, path: string): Promise<{ ok: boolean; error?: string }> {
    if (this.state.platform === 'desktop') {
      return this.sendNativeRequest('openFile', { rootKey, path })
    }
    return this.sendControlRequest(0xe9, { rootKey, path })
  }

  /**
   * Reveal a file in the system file manager.
   * Desktop: via native messaging. ChromeOS: via Android companion WebSocket.
   */
  async revealInFolder(rootKey: string, path: string): Promise<{ ok: boolean; error?: string }> {
    if (this.state.platform === 'desktop') {
      return this.sendNativeRequest('revealInFolder', { rootKey, path })
    }
    return this.sendControlRequest(0xea, { rootKey, path })
  }

  /**
   * Check for desktop app updates via the native host.
   * Spawns the Tauri app in headless mode to query the update endpoint.
   * Desktop only.
   */
  async checkForUpdates(): Promise<{
    ok: boolean
    available?: boolean
    version?: string
    currentVersion?: string
    body?: string
    error?: string
  }> {
    if (this.state.platform !== 'desktop') {
      return { ok: false, error: 'Updates only available for desktop' }
    }
    const response = await this.sendNativeRequestFull('checkForUpdates', {})
    if (response.ok && response.type === 'UpdateCheck') {
      const payload = response.payload as {
        available?: boolean
        version?: string
        currentVersion?: string
        body?: string
      }
      return {
        ok: true,
        available: payload?.available ?? false,
        version: payload?.version ?? undefined,
        currentVersion: payload?.currentVersion ?? undefined,
        body: payload?.body ?? undefined,
      }
    }
    return { ok: false, error: (response.error as string) ?? 'Unknown error' }
  }

  /**
   * Download and install a desktop app update via the native host.
   * Spawns the Tauri app in headless mode to download, install, and restart.
   * Desktop only.
   */
  async installUpdate(): Promise<{ ok: boolean; error?: string }> {
    if (this.state.platform !== 'desktop') {
      return { ok: false, error: 'Updates only available for desktop' }
    }
    return this.sendNativeRequest('installUpdate', {})
  }

  /**
   * Launch the Tauri desktop app via the native host.
   * Desktop only — returns false on ChromeOS.
   */
  async launchDesktop(): Promise<boolean> {
    if (this.state.platform !== 'desktop') return false
    const response = await this.sendNativeRequest('launchDesktop', {})
    return response.ok
  }

  /**
   * List all profiles from the native host discovery file.
   * Desktop only — returns empty array on ChromeOS.
   */
  async listProfiles(): Promise<
    Array<{
      profileId: string
      displayName: string
      created: number
      lastUsed: number
      clientType?: string
      clientVersion?: string
      live: boolean
    }>
  > {
    if (this.state.platform !== 'desktop') return []
    const response = await this.sendNativeKvRequest('listProfiles', {})
    if (response.ok && response.type === 'ProfileList') {
      const payload = response.payload as {
        profiles?: Array<{
          profileId: string
          displayName: string
          created: number
          lastUsed: number
          clientType?: string
          clientVersion?: string
          live: boolean
        }>
      }
      return payload?.profiles ?? []
    }
    return []
  }

  /**
   * Rename a profile's display name.
   * Desktop only — no-op on ChromeOS.
   */
  async renameProfile(profileId: string, displayName: string): Promise<boolean> {
    if (this.state.platform !== 'desktop') return false
    const response = await this.sendNativeKvRequest('renameProfile', { profileId, displayName })
    return (response.ok as boolean) ?? false
  }

  async deleteProfile(profileId: string): Promise<boolean> {
    if (this.state.platform !== 'desktop') return false
    const response = await this.sendNativeKvRequest('deleteProfile', { profileId })
    return (response.ok as boolean) ?? false
  }

  /**
   * Get stats from the daemon about socket and connection state.
   * Useful for debugging.
   */
  async getStats(): Promise<DaemonStats | null> {
    if (this.state.status !== 'connected' || !this.state.daemonInfo) {
      return null
    }

    const { port, token, host } = this.state.daemonInfo
    const baseHost = host ?? '127.0.0.1'

    try {
      const response = await fetch(`http://${baseHost}:${port}/stats`, {
        headers: {
          'X-JST-Auth': token,
        },
      })
      if (!response.ok) {
        console.error('[DaemonBridge] getStats failed:', response.status)
        return null
      }
      return (await response.json()) as DaemonStats
    } catch (e) {
      console.error('[DaemonBridge] getStats error:', e)
      return null
    }
  }

  /**
   * Helper to send a request to the native host and wait for response.
   */
  private async sendNativeRequest(
    op: string,
    params: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    return sendNativeRequestViaPort(this.nativePort, op, params)
  }

  /**
   * Helper to send a request to the native host and return the full response object.
   */
  private async sendNativeRequestFull(
    op: string,
    params: Record<string, unknown>,
    timeoutMs = 10000,
  ): Promise<Record<string, unknown>> {
    return sendNativeRequestFullViaPort(this.nativePort, op, params, timeoutMs)
  }

  // ==========================================================================
  // Desktop Implementation
  // ==========================================================================

  private async connectDesktop(): Promise<void> {
    const stored = await chrome.storage.local.get('profileId')
    console.log('[DaemonBridge] connectDesktop() called, profileId:', stored.profileId ?? 'none')

    await connectDesktopHandshake({
      connectNative: () => {
        console.log('[DaemonBridge] Calling chrome.runtime.connectNative("com.jstorrent.native")')
        const port = chrome.runtime.connectNative('com.jstorrent.native')
        console.log('[DaemonBridge] connectNative returned port:', !!port)
        return port
      },
      getDisconnectError: () => chrome.runtime.lastError?.message || 'Disconnected',
      runtimeId: chrome.runtime.id,
      clientVersion: chrome.runtime.getManifest().version,
      storedProfileId: (stored.profileId as string) ?? null,
      isDaemonInfoMessage: (msg) => this.isDaemonInfoMessage(msg),
      isProfileInUseMessage: (msg) => this.isProfileInUseMessage(msg),
      onConnected: (port, payload) => {
        console.log(
          '[DaemonBridge] Got DaemonInfo, version:',
          payload.version,
          'roots:',
          payload.roots?.length,
          'profileId:',
          payload.profileId,
        )
        this.nativePort = port

        // Store profileId for future handshakes
        if (payload.profileId) {
          chrome.storage.local.set({ profileId: payload.profileId })
        }

        this.updateState({
          status: 'connected',
          daemonInfo: {
            ...payload,
            version: payload.version ?? 'unknown',
            roots: payload.roots || [],
            host: DESKTOP_HOST,
          },
          roots: payload.roots || [],
          profileInUseInfo: null,
        })
        this.startHealthCheck(DESKTOP_HOST, payload.port)
      },
      onProfileInUse: (port, info) => {
        // Keep port alive for potential TakeOver
        this.nativePort = port
        this.updateState({ profileInUseInfo: info })
      },
      onDisconnectedAfterConnected: () => {
        this.handleDisconnect()
      },
      onPostConnectionMessage: (msg) => {
        this.handleDesktopMessage(msg)
      },
      onMessageReceived: (msg) => {
        console.log('[DaemonBridge] Received message from native host:', msg)
      },
      onHandshakeBuilt: (handshakeMsg) => {
        console.log('[DaemonBridge] Sending handshake:', handshakeMsg)
      },
      timeoutMs: 10000,
    })
  }

  private handleDesktopMessage(msg: unknown): void {
    if (typeof msg !== 'object' || msg === null) return

    // Handle native events (TorrentAdded, MagnetAdded, etc.)
    if ('event' in msg) {
      this.emitEvent(msg as NativeEvent)
    }

    // Handle RootAdded response
    if ('type' in msg && (msg as { type: string }).type === 'RootAdded') {
      const payload = (msg as { payload?: { root?: DownloadRoot } }).payload
      if (payload?.root) {
        this.addRoot(payload.root)
      }
    }
  }

  private async pickFolderDesktop(): Promise<DownloadRoot | null> {
    const root = await pickDownloadFolderDesktop(this.nativePort)
    if (root) {
      this.addRoot(root)
    }
    return root
  }

  private async removeRootDesktop(key: string): Promise<boolean> {
    const result = await removeDownloadRootDesktop(this.nativePort, key)
    if (result.ok) {
      this.updateState({
        roots: this.state.roots.filter((r) => r.key !== key),
      })
      return true
    }

    if (result.reason === 'timeout') {
      console.error('[DaemonBridge] removeRootDesktop timed out')
    } else {
      console.error('[DaemonBridge] removeRootDesktop failed:', result.response)
    }
    return false
  }

  // ==========================================================================
  // ChromeOS Implementation
  // ==========================================================================

  private async connectChromeos(): Promise<void> {
    const found = await this.findDaemonPort()
    if (!found) {
      throw new Error('Companion daemon not reachable')
    }

    const { host, port } = found
    const telemetryId = await getOrCreateTelemetryId()
    const extensionId = chrome.runtime.id
    const status = await this.fetchStatus(host, port)

    // Already paired with us? Try connecting
    if (status.paired && status.extensionId === extensionId && status.installId === telemetryId) {
      await this.completeConnection(
        host,
        port,
        status.version,
        status.capabilities,
        status.ioPort,
        status.streamingPort,
      )
      return
    }

    // For Crostini standalone daemon, try to pair directly (it auto-approves)
    // For Android daemon, pairing requires user interaction via triggerLaunch()
    if (host === CHROMEOS_CROSTINI_HOST) {
      console.log('[DaemonBridge] Crostini daemon found, attempting direct pairing...')
      await this.checkStatusAndPair(host, port)
      return
    }

    // Need to pair with Android - requires launching the app
    throw new Error('Not paired - use triggerLaunch()')
  }

  private async connectWebSocket(host: string, port: number, token: string): Promise<void> {
    const telemetryId = await getOrCreateTelemetryId()
    const ws = await connectChromeosControlWebSocket({
      host,
      port,
      token,
      extensionId: chrome.runtime.id,
      telemetryId,
      onRootsChanged: (frame) => this.handleRootsChanged(frame),
      onControlEvent: (frame) => this.handleControlEvent(frame),
      onKvResponse: (frame) => this.handleKvResponse(frame),
      onControlResponse: (frame) => this.handleControlResponse(frame),
      onDisconnected: () => this.handleDisconnect(),
      timeoutMs: 10000,
    })
    this.ws = ws as WebSocket
  }

  private handleRootsChanged(frame: Uint8Array): void {
    try {
      const mapped = parseRootsChangedFrame(frame)

      this.updateState({ roots: mapped })
      console.log('[DaemonBridge] Roots updated:', mapped.length)
    } catch (e) {
      console.error('[DaemonBridge] Failed to parse ROOTS_CHANGED:', e)
    }
  }

  private handleControlEvent(frame: Uint8Array): void {
    try {
      const event = parseControlEventFrame(frame)
      this.emitEvent(event)
    } catch (e) {
      console.error('[DaemonBridge] Failed to parse EVENT:', e)
    }
  }

  private async pickFolderChromeos(): Promise<DownloadRoot | null> {
    const existingKeys = new Set(this.state.roots.map((r) => r.key))

    // Send command to open folder picker via WebSocket
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      console.error('[DaemonBridge] WebSocket not connected')
      return null
    }

    const requestId = Math.floor(Math.random() * 0xffffffff)
    this.ws.send(buildControlFrame(0xe2, requestId, new Uint8Array(0))) // OP_CTRL_OPEN_FOLDER_PICKER

    // Wait for ROOTS_CHANGED with new root (via WebSocket)
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        unsubscribe()
        resolve(null)
      }, 60000) // 60s timeout for user to pick folder

      const unsubscribe = this.subscribe((state) => {
        const newRoot = state.roots.find((r) => !existingKeys.has(r.key))
        if (newRoot) {
          clearTimeout(timeout)
          unsubscribe()
          resolve(newRoot)
        }
      })
    })
  }

  private async removeRootChromeos(key: string): Promise<boolean> {
    const { host, port } = this.state.daemonInfo ?? {}
    if (!host || !port) return false

    try {
      const headers = await this.buildHeaders(true)
      const response = await fetch(`http://${host}:${port}/roots/${encodeURIComponent(key)}`, {
        method: 'DELETE',
        headers,
      })

      if (response.ok) {
        // Root will be updated via ROOTS_CHANGED WebSocket message
        // but we can optimistically update local state
        this.updateState({
          roots: this.state.roots.filter((r) => r.key !== key),
        })
        return true
      }
      return false
    } catch (e) {
      console.error('[DaemonBridge] Failed to remove root:', e)
      return false
    }
  }

  // ==========================================================================
  // KV Storage over WebSocket (for Android companion)
  // ==========================================================================

  /**
   * Check if connected to Android companion (vs Crostini Rust daemon).
   * When true, KV operations should go through WebSocket to Android SQLite.
   */
  isAndroidCompanion(): boolean {
    return (
      this.state.status === 'connected' && this.state.daemonInfo?.host === CHROMEOS_ANDROID_HOST
    )
  }

  /**
   * Check if connected to desktop native host (jstorrent-host via native messaging).
   * When true, KV operations should go through native messaging to SQLite.
   */
  isDesktopHost(): boolean {
    return this.state.status === 'connected' && this.state.platform === 'desktop'
  }

  /**
   * Send a KV request over WebSocket and wait for response.
   * Only works when connected to Android companion.
   */
  async sendKvRequest(opcode: number, payload: Record<string, unknown>): Promise<unknown> {
    return sendKvRequestOverWebSocket({
      ws: this.ws,
      pendingKvRequests: this.pendingKvRequests,
      opcode,
      payload,
      timeoutMs: 10000,
    })
  }

  /**
   * Send a KV request to the desktop native host via native messaging.
   * Returns the full response object (including payload fields like value, entries, keys).
   * Only works when connected to desktop native host.
   */
  async sendNativeKvRequest(
    op: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    return sendNativeRequestFullViaPort(this.nativePort, op, params)
  }

  /**
   * Send a control request over WebSocket (for ChromeOS open file/folder).
   */
  private async sendControlRequest(
    opcode: number,
    payload: Record<string, unknown>,
  ): Promise<{ ok: boolean; error?: string }> {
    return sendControlRequestOverWebSocket({
      ws: this.ws,
      pendingControlRequests: this.pendingControlRequests,
      opcode,
      payload,
      timeoutMs: 10000,
    })
  }

  /**
   * Handle control response from WebSocket (open file/folder results).
   */
  private handleControlResponse(frame: Uint8Array): void {
    const result = handleControlResponseFrame(frame, this.pendingControlRequests)
    if (result.kind === 'missing') {
      console.warn('[DaemonBridge] No pending control request for requestId:', result.requestId)
    }
  }

  /**
   * Handle KV response from WebSocket.
   */
  private handleKvResponse(frame: Uint8Array): void {
    const result = handleKvResponseFrame(frame, this.pendingKvRequests)
    if (result.kind === 'missing') {
      console.warn('[DaemonBridge] No pending KV request for requestId:', result.requestId)
    }
  }

  /**
   * Find a reachable daemon on ChromeOS.
   * Tries both Android (ARC) and Crostini hosts.
   * Returns the host and port if found.
   */
  private async findDaemonPort(): Promise<{ host: string; port: number } | null> {
    const found = await findChromeosDaemonPort({
      storage: chrome.storage.local,
      fetchImpl: fetch,
      storageKeyPort: STORAGE_KEY_PORT,
      storageKeyHost: STORAGE_KEY_HOST,
      hosts: CHROMEOS_HOSTS,
      fallbackPorts: [7800, 7805, 7814, 7827, 7844],
      timeoutMs: 2000,
    })
    if (found) {
      console.log(`[DaemonBridge] Found daemon at ${found.host}:${found.port}`)
    }
    return found
  }

  private async getOrCreateToken(): Promise<string> {
    const stored = await chrome.storage.local.get([STORAGE_KEY_TOKEN])
    if (stored[STORAGE_KEY_TOKEN]) {
      return stored[STORAGE_KEY_TOKEN] as string
    }
    const token = crypto.randomUUID()
    await chrome.storage.local.set({ [STORAGE_KEY_TOKEN]: token })
    return token
  }

  private startHealthCheck(host: string, port: number): void {
    this.healthCheckInterval = restartHealthCheck({
      existingInterval: this.healthCheckInterval,
      fetchImpl: fetch,
      host,
      port,
      onUnhealthy: () => this.handleDisconnect(),
      intervalMs: 5000,
    })
  }

  // ==========================================================================
  // Shared Helpers
  // ==========================================================================

  private isDaemonInfoMessage(msg: unknown): boolean {
    return (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      (msg as { type: string }).type === 'DaemonInfo' &&
      'payload' in msg
    )
  }

  private isProfileInUseMessage(msg: unknown): boolean {
    return (
      typeof msg === 'object' &&
      msg !== null &&
      'ok' in msg &&
      (msg as { ok: boolean }).ok === false &&
      'error' in msg &&
      (msg as { error: string }).error === 'profile_in_use'
    )
  }

  /**
   * Take over from the desktop Tauri app.
   * Sends TakeOver to the native host which kills the Tauri sidecar,
   * waits for the daemon to start, and completes the handshake.
   */
  async takeOver(): Promise<boolean> {
    const stored = await chrome.storage.local.get('profileId')

    return requestDesktopTakeOver({
      nativePort: this.nativePort,
      runtimeId: chrome.runtime.id,
      clientVersion: chrome.runtime.getManifest().version,
      profileId: (stored.profileId as string) ?? null,
      isDaemonInfoMessage: (msg) => this.isDaemonInfoMessage(msg),
      onSuccess: (payload) => {
        console.log('[DaemonBridge] TakeOver succeeded, version:', payload.version)

        // Store profileId for future handshakes
        if (payload.profileId) {
          chrome.storage.local.set({ profileId: payload.profileId })
        }

        this.updateState({
          status: 'connected',
          daemonInfo: {
            ...payload,
            version: payload.version ?? 'unknown',
            roots: payload.roots || [],
            host: DESKTOP_HOST,
          },
          roots: payload.roots || [],
          lastError: null,
          profileInUseInfo: null,
        })
        this.startHealthCheck(DESKTOP_HOST, payload.port)
      },
      timeoutMs: 15000,
    })
  }

  private handleDisconnect(): void {
    const wasConnected = this.state.status === 'connected'
    this.cleanup()
    this.updateState({
      status: 'disconnected',
      lastError: 'Connection lost',
    })
    // On desktop, auto-reconnect once to detect if Tauri took over.
    // A new native host will check for a live Tauri incumbent and
    // return profile_in_use, giving the UI the right state.
    if (wasConnected && this.state.platform === 'desktop') {
      setTimeout(() => {
        if (this.state.status === 'disconnected') {
          console.log('[DaemonBridge] Auto-reconnecting after disconnect to detect Tauri')
          this.connect()
        }
      }, 1000)
    }
  }

  private cleanup(): void {
    console.log('[DaemonBridge] cleanup() called')
    if (this.healthCheckInterval) {
      console.log('[DaemonBridge] Clearing health check interval')
      clearInterval(this.healthCheckInterval)
      this.healthCheckInterval = null
    }
    if (this.ws) {
      console.log('[DaemonBridge] Closing WebSocket')
      this.ws.close()
      this.ws = null
    }
    if (this.nativePort) {
      console.log('[DaemonBridge] Disconnecting native port')
      this.nativePort.disconnect()
      this.nativePort = null
      console.log('[DaemonBridge] Native port disconnected and nulled')
    } else {
      console.log('[DaemonBridge] No native port to disconnect')
    }
  }

  private updateState(partial: Partial<DaemonBridgeState>): void {
    this.state = { ...this.state, ...partial }
    this.notifyStateListeners()
  }

  private addRoot(root: DownloadRoot): void {
    const exists = this.state.roots.some((r) => r.key === root.key)
    if (!exists) {
      this.updateState({ roots: [...this.state.roots, root] })
    }
  }

  private notifyStateListeners(): void {
    for (const listener of this.stateListeners) {
      try {
        listener(this.state)
      } catch (e) {
        console.error('[DaemonBridge] Listener error:', e)
      }
    }
  }

  private emitEvent(event: NativeEvent): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event)
      } catch (e) {
        console.error('[DaemonBridge] Event listener error:', e)
      }
    }
  }
}

// ============================================================================
// Singleton
// ============================================================================

let bridge: DaemonBridge | null = null

export function getDaemonBridge(): DaemonBridge {
  if (!bridge) {
    bridge = new DaemonBridge()
  }
  return bridge
}
