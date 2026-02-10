import {
  BtEngine,
  DaemonConnection,
  DaemonSocketFactory,
  DaemonFileSystem,
  RoutingHasher,
  WorkerHasher,
  TransferringWorkerHasher,
  StorageRootManager,
  Socks5SocketFactory,
  globalLogStore,
  LogStore,
  ISessionStore,
  Torrent,
  toHex,
  getBatchWriteHistogram,
  type ISocketFactory,
  type CredentialsGetter,
  type EngineLoggingConfig,
  type ConfigHub,
  type StorageRoot as EngineStorageRoot,
} from '@jstorrent/engine'
import type { HostChannel } from '../host/host-channel'
import { markDesktopActivated } from '../host/tauri-channel'
import type { ProgressStats } from '../host/types'
import { HostChannelSessionStore } from '../host/host-channel-session-store'
import { HostChannelConfigHub } from '../host/host-channel-config-hub'
import { createNotificationBridge, type NotificationBridge } from '../chrome/notification-bridge'
import { BackgroundAudioManager } from '../chrome/background-audio'
import { BackgroundWebRTCManager } from '../chrome/background-webrtc'
import type { DaemonInfo, DownloadRoot } from '../types'
import type { IEngineManager, StorageRoot, FileOperationResult } from './types'

// Toggle: true = WebRTC (no audio icon), false = Audio (shows audio icon)
// Recent chrome versions seem to throttle to ~1s with webrtc, but audio seems to
// be completely unthrottled.
const USE_WEBRTC_KEEP_ALIVE = false

// Toggle: true = writes are discarded (not sent to companion), for benchmarking I/O bottlenecks
const NULL_STORAGE = false

// Session store key for default root key
const DEFAULT_ROOT_KEY_KEY = 'settings:defaultRootKey'

function isTauriContext(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// Augment Window interface for debug exports
declare global {
  interface Window {
    engine?: unknown
    getBatchWriteHistogram?: typeof getBatchWriteHistogram
    engineManager?: DaemonEngineManager
  }
}

/**
 * Create credentials getter for DaemonConnection.
 * Reads fresh values via HostChannel KV at connection time.
 */
function createCredentialsGetter(channel: HostChannel): CredentialsGetter {
  return async () => {
    const [token, installId] = await Promise.all([
      channel.kvGet<string>('android:authToken', { keyPrefix: '' }),
      channel.kvGet<string>('telemetryId', { keyPrefix: '' }),
    ])

    if (!token) {
      throw new Error('No auth token in storage')
    }

    return {
      token,
      extensionId: chrome.runtime.id,
      installId: installId || '',
    }
  }
}

/**
 * Daemon engine manager.
 * Manages the BtEngine lifecycle in the UI thread, connecting to an external
 * daemon (system bridge) over WebSocket. Used by both Chrome extension and Tauri contexts.
 */
export class DaemonEngineManager implements IEngineManager {
  engine: BtEngine | null = null
  configHub: ConfigHub | null = null
  daemonConnection: DaemonConnection | null = null
  logStore: LogStore = globalLogStore
  readonly isStandalone = isTauriContext()
  readonly supportsFileOperations = true

  private channel: HostChannel
  private _daemonInfo: DaemonInfo | null = null
  private sessionStore: ISessionStore | null = null
  private notificationBridge: NotificationBridge | null = null

  /**
   * Whether download roots can be added/removed.
   * Reads from daemon capabilities - defaults to true if not explicitly set to false.
   */
  get rootsManageable(): boolean {
    return this._daemonInfo?.capabilities?.roots_manageable !== false
  }
  private initPromise: Promise<BtEngine> | null = null
  private notificationProgressInterval: ReturnType<typeof setInterval> | null = null
  private pendingNativeEvents: Array<{ event: string; payload: unknown }> = []
  private backgroundKeepAlive = USE_WEBRTC_KEEP_ALIVE
    ? new BackgroundWebRTCManager()
    : new BackgroundAudioManager()

  constructor(channel: HostChannel) {
    this.channel = channel
  }

  /**
   * Initialize the engine. Safe to call multiple times - returns cached engine.
   */
  async init(): Promise<BtEngine> {
    if (this.engine) {
      return this.engine
    }

    // Prevent concurrent initialization
    if (this.initPromise) {
      return this.initPromise
    }

    this.initPromise = this.doInit()
    return this.initPromise
  }

  private async doInit(): Promise<BtEngine> {
    console.log('[DaemonEngineManager] Initializing...')

    // 1. Get daemon info from host channel
    const daemonInfo = await this.channel.getDaemonInfo()
    if (!daemonInfo) {
      throw new Error('Failed to get daemon info from host')
    }
    this._daemonInfo = daemonInfo
    const roots: DownloadRoot[] = daemonInfo.roots ?? []
    console.log(
      '[DaemonEngineManager] App version:',
      this.channel.getVersion() ?? 'unknown',
      'System bridge version:',
      daemonInfo.version ?? 'unknown',
    )
    console.log(
      '[DaemonEngineManager] Got daemon info:',
      daemonInfo,
      'roots:',
      roots.length,
      'rootsManageable:',
      this.rootsManageable,
    )
    console.log(
      '[DaemonEngineManager] profileId:',
      daemonInfo.profileId ?? 'none',
      'standalone:',
      this.isStandalone,
    )

    // 2. Create direct WebSocket connection to daemon
    // On ChromeOS, use credentials getter for fresh token
    // On desktop, use token directly from daemon info
    const isChromeos = daemonInfo.host === '100.115.92.2'

    if (isChromeos) {
      this.daemonConnection = new DaemonConnection(
        daemonInfo.port,
        daemonInfo.host,
        createCredentialsGetter(this.channel),
        undefined, // legacyToken (not used for ChromeOS)
        daemonInfo.ioPort, // Separate high-throughput port for /io WebSocket
        daemonInfo.streamingPort, // Streaming batch write server (memory-efficient)
      )
    } else {
      // Desktop - use legacy token directly
      this.daemonConnection = new DaemonConnection(
        daemonInfo.port,
        daemonInfo.host,
        undefined,
        daemonInfo.token,
        daemonInfo.ioPort, // Separate high-throughput port (if available)
        daemonInfo.streamingPort, // Streaming batch write server (memory-efficient)
      )
    }
    try {
      await this.daemonConnection.connectWebSocket()
    } catch (error) {
      // If auth failed, signal host to retry connection
      if (error instanceof Error && error.message.includes('auth failed')) {
        console.log('[DaemonEngineManager] Auth failed, signaling host')
        this.channel.retryConnection()
      }
      throw error
    }
    console.log('[DaemonEngineManager] WebSocket connected')

    // Register disconnect/reconnect handlers
    this.daemonConnection.onDisconnect((reason) => {
      console.error('[DaemonEngineManager] IO WebSocket disconnected:', reason)
      this.handleIoDisconnect(reason)
    })
    this.daemonConnection.onReconnect(() => {
      console.log('[DaemonEngineManager] IO WebSocket reconnected')
      this.handleIoReconnect()
    })

    // 3. Set up storage root manager
    if (NULL_STORAGE) {
      console.warn('[DaemonEngineManager] NULL_STORAGE enabled - writes will be discarded!')
    }

    const srm = new StorageRootManager(
      (root) => new DaemonFileSystem(this.daemonConnection!, root.key, NULL_STORAGE),
    )

    // 4. Create session store — always delegate to host channel (per-profile KV via native host)
    this.sessionStore = new HostChannelSessionStore(this.channel)

    // Register download roots from daemon
    if (roots.length > 0) {
      for (const root of roots) {
        srm.addRoot({
          key: root.key,
          label: root.display_name,
          path: root.path,
        })
      }

      // Load saved default root from session store
      const savedDefaultBytes = await this.sessionStore.get(DEFAULT_ROOT_KEY_KEY)
      const defaultKey = savedDefaultBytes ? new TextDecoder().decode(savedDefaultBytes) : null
      const validDefault = defaultKey && roots.some((r) => r.key === defaultKey)

      if (validDefault) {
        srm.setDefaultRoot(defaultKey)
      } else if (roots.length > 0) {
        srm.setDefaultRoot(roots[0].key)
      }
      console.log('[DaemonEngineManager] Registered', roots.length, 'download roots')
    } else {
      console.warn('[DaemonEngineManager] No download roots configured!')
    }

    // 5. Create and init ConfigHub
    const configHub = new HostChannelConfigHub(this.channel)
    await configHub.init()
    this.configHub = configHub
    console.log('[DaemonEngineManager] ConfigHub initialized')

    // Set initial runtime values from daemon info
    configHub.setRuntime('daemonPort', daemonInfo.port)
    configHub.setRuntime('daemonHost', daemonInfo.host ?? '127.0.0.1')
    configHub.setRuntime('daemonConnected', true) // We just connected
    configHub.setRuntime('daemonVersion', daemonInfo.version?.toString() ?? null)
    configHub.setRuntime('platformType', isChromeos ? 'chromeos' : 'desktop')

    // Set storage roots in ConfigHub (mirrors what StorageRootManager has)
    const storageRootsForConfig: EngineStorageRoot[] = roots.map((r) => ({
      key: r.key,
      label: r.display_name,
      path: r.path,
    }))
    configHub.setRuntime('storageRoots', storageRootsForConfig)

    // 6. Create engine (suspended) with ConfigHub
    const delegateHasher = new WorkerHasher()
    const transferringHasher = new TransferringWorkerHasher()
    const hasher = new RoutingHasher(delegateHasher, transferringHasher)

    // Create socket factory, optionally wrapped with SOCKS5 proxy
    let socketFactory: ISocketFactory = new DaemonSocketFactory(this.daemonConnection)
    const proxyEnabled = configHub.proxyEnabled.get()
    const proxyHost = configHub.proxyHost.get()
    const proxyPort = configHub.proxyPort.get()

    if (proxyEnabled && proxyHost) {
      socketFactory = new Socks5SocketFactory(socketFactory, {
        host: proxyHost,
        port: proxyPort,
        username: configHub.proxyUsername.get() ?? undefined,
        password: configHub.proxyPassword.get() ?? undefined,
      })
      console.log(`[DaemonEngineManager] SOCKS5 proxy enabled: ${proxyHost}:${proxyPort}`)
    }

    this.engine = new BtEngine({
      socketFactory,
      storageRootManager: srm,
      sessionStore: this.sessionStore,
      hasher,
      port: configHub.listeningPortAuto.get() ? 0 : configHub.listeningPort.get(),
      startSuspended: true,
      getNetworkInterfaces: () => this.daemonConnection!.getNetworkInterfaces(),
      config: configHub,
      // Adaptive batching only supported by Android companion (ChromeOS)
      useAdaptiveBatching: isChromeos,
    })
    window.engine = this.engine // expose for debugging
    window.getBatchWriteHistogram = getBatchWriteHistogram // expose for benchmarking
    console.log('[DaemonEngineManager] Engine created (suspended)')

    // 7. Restore session
    const restored = await this.engine.restoreSession()
    console.log(`[DaemonEngineManager] Restored ${restored} torrents`)

    // 8. Resume engine
    // Guard: engine may have been destroyed during restoreSession() if daemon disconnected
    if (!this.engine) {
      throw new Error('Engine was destroyed during initialization (daemon disconnected)')
    }
    this.engine.resume()
    console.log('[DaemonEngineManager] Engine resumed')

    // 9. Set up background throttling prevention (UI-only, not engine)
    this.backgroundKeepAlive.setEnabled(configHub.preventBackgroundThrottling.get())
    configHub.preventBackgroundThrottling.subscribe((enabled) => {
      this.backgroundKeepAlive.setEnabled(enabled)
    })

    // 10. Set up beforeunload handler
    window.addEventListener('beforeunload', () => {
      this.shutdown()
    })

    // 11. Set up notification handling
    this.setupNotifications()

    // 12. Process any native events that arrived during initialization
    if (this.pendingNativeEvents.length > 0) {
      console.log(
        '[DaemonEngineManager] Processing',
        this.pendingNativeEvents.length,
        'queued events',
      )
      for (const { event, payload } of this.pendingNativeEvents) {
        await this.handleNativeEvent(event, payload)
        // Guard: engine may have been destroyed during event processing
        if (!this.engine) {
          throw new Error('Engine was destroyed during initialization (daemon disconnected)')
        }
      }
      this.pendingNativeEvents = []
    }

    return this.engine
  }

  /**
   * Clean shutdown - notify host that this UI is closing.
   */
  shutdown(): void {
    console.log('[DaemonEngineManager] Shutting down...')

    // Clean up notification interval
    if (this.notificationProgressInterval) {
      clearInterval(this.notificationProgressInterval)
      this.notificationProgressInterval = null
    }

    // Notify host
    this.channel.notifyClosing()

    // Clean up engine
    if (this.engine) {
      this.engine.destroy()
      this.engine = null
    }

    // Clean up configHub
    this.configHub = null

    // Clear any pending events
    this.pendingNativeEvents = []

    // Note: Don't close daemonConnection here. The engine.destroy() is async but
    // beforeunload can't wait for it, so closing the connection immediately would
    // cause tracker announce('stopped') to fail. The WebSocket will close
    // automatically when the page unloads.
    this.daemonConnection = null

    this.initPromise = null
  }

  /**
   * Reset engine state for reconnection.
   * Unlike shutdown(), this doesn't notify the host of UI closing.
   * Called when the daemon disconnects so we can reinitialize with fresh connection info.
   */
  reset(): void {
    console.log('[DaemonEngineManager] Resetting for reconnection...')

    // Clean up notification interval
    if (this.notificationProgressInterval) {
      clearInterval(this.notificationProgressInterval)
      this.notificationProgressInterval = null
    }

    // Close the daemon connection to stop reconnect attempts
    if (this.daemonConnection) {
      this.daemonConnection.close()
      this.daemonConnection = null
    }

    // Destroy engine (will persist session)
    if (this.engine) {
      this.engine.destroy()
      this.engine = null
    }

    // Clean up configHub
    this.configHub = null

    // Clear pending events and init state
    this.pendingNativeEvents = []
    this.initPromise = null
  }

  /**
   * Handle IO websocket disconnect.
   */
  private handleIoDisconnect(_reason: string): void {
    if (this.configHub) {
      ;(this.configHub as HostChannelConfigHub).setRuntime('daemonConnected', false)
    }

    if (!this.engine) return

    for (const torrent of this.engine.torrents) {
      if (torrent.userState === 'active' && !torrent.errorMessage) {
        torrent.errorMessage = 'IO connection lost'
      }
    }
  }

  /**
   * Handle IO websocket reconnect.
   */
  private handleIoReconnect(): void {
    if (this.configHub) {
      ;(this.configHub as HostChannelConfigHub).setRuntime('daemonConnected', true)
    }

    if (!this.engine) return

    for (const torrent of this.engine.torrents) {
      if (torrent.errorMessage === 'IO connection lost') {
        torrent.errorMessage = undefined
      }
    }
  }

  /**
   * Pick a download folder via native host.
   */
  async pickDownloadFolder(): Promise<StorageRoot | null> {
    const root = await this.channel.pickDownloadFolder()
    if (!root) return null

    const newRoot: EngineStorageRoot = {
      key: root.key,
      label: root.display_name,
      path: root.path,
    }

    if (this.engine) {
      this.engine.storageRootManager.addRoot(newRoot)
    }

    if (this.configHub) {
      const currentRoots = this.configHub.storageRoots.get()
      ;(this.configHub as HostChannelConfigHub).setRuntime('storageRoots', [
        ...currentRoots,
        newRoot,
      ])
    }

    return { key: root.key, label: root.display_name, path: root.path }
  }

  /**
   * Remove a download root.
   */
  async removeDownloadRoot(key: string): Promise<boolean> {
    try {
      await this.channel.removeDownloadRoot(key)
    } catch (e) {
      console.error('[DaemonEngineManager] Failed to remove root:', e)
      return false
    }

    if (this.engine) {
      this.engine.storageRootManager.removeRoot(key)

      const currentDefault = this.engine.storageRootManager.getDefaultRoot()
      if (!currentDefault) {
        const remaining = this.engine.storageRootManager.getRoots()
        if (remaining.length > 0) {
          this.engine.storageRootManager.setDefaultRoot(remaining[0].key)
          if (this.sessionStore) {
            await this.sessionStore.set(
              DEFAULT_ROOT_KEY_KEY,
              new TextEncoder().encode(remaining[0].key),
            )
          }
        } else if (this.sessionStore) {
          await this.sessionStore.delete(DEFAULT_ROOT_KEY_KEY)
        }
      }
    }

    if (this.configHub) {
      const currentRoots = this.configHub.storageRoots.get()
      const updatedRoots = currentRoots.filter((r) => r.key !== key)
      ;(this.configHub as HostChannelConfigHub).setRuntime('storageRoots', updatedRoots)
    }

    return true
  }

  async openFile(torrentHash: string, filePath: string): Promise<FileOperationResult> {
    if (!this.engine) return { ok: false, error: 'Engine not initialized' }

    const root = this.engine.storageRootManager.getRootForTorrent(torrentHash)
    if (!root) return { ok: false, error: 'No storage root for torrent' }

    try {
      await this.channel.openFile(root.key, filePath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  async revealInFolder(torrentHash: string, filePath: string): Promise<FileOperationResult> {
    if (!this.engine) return { ok: false, error: 'Engine not initialized' }

    const root = this.engine.storageRootManager.getRootForTorrent(torrentHash)
    if (!root) return { ok: false, error: 'No storage root for torrent' }

    try {
      await this.channel.revealInFolder(root.key, filePath)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  async openTorrentFolder(torrentHash: string): Promise<FileOperationResult> {
    if (!this.engine) return { ok: false, error: 'Engine not initialized' }

    const torrent = this.engine.torrents.find((t) => toHex(t.infoHash) === torrentHash)
    if (!torrent) return { ok: false, error: 'Torrent not found' }

    const root = this.engine.storageRootManager.getRootForTorrent(torrentHash)
    if (!root) return { ok: false, error: 'No storage root for torrent' }

    const path = torrent.name || torrentHash
    try {
      await this.channel.revealInFolder(root.key, path)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  getFilePath(torrentHash: string, filePath: string): string | null {
    if (!this.engine) return null

    const root = this.engine.storageRootManager.getRootForTorrent(torrentHash)
    if (!root) return null

    return `${root.path}/${filePath}`
  }

  async setDefaultRoot(key: string): Promise<void> {
    if (!this.engine) throw new Error('Engine not initialized')
    this.engine.storageRootManager.setDefaultRoot(key)
    if (this.sessionStore) {
      await this.sessionStore.set(DEFAULT_ROOT_KEY_KEY, new TextEncoder().encode(key))
    }
  }

  getRoots(): StorageRoot[] {
    if (!this.engine) return []
    return this.engine.storageRootManager.getRoots()
  }

  async getDefaultRootKey(): Promise<string | null> {
    if (!this.sessionStore) return null
    const bytes = await this.sessionStore.get(DEFAULT_ROOT_KEY_KEY)
    return bytes ? new TextDecoder().decode(bytes) : null
  }

  setLoggingConfig(config: EngineLoggingConfig): void {
    if (!this.engine) {
      console.warn('[DaemonEngineManager] Cannot set logging config: engine not initialized')
      return
    }
    this.engine.setLoggingConfig(config)
    console.log(`[DaemonEngineManager] Logging config updated: level=${config.level}`)
  }

  private setupNotifications(): void {
    if (!this.engine) return

    this.notificationBridge = createNotificationBridge(this.channel)

    this.engine.on('torrent-complete', (torrent: Torrent) => {
      this.notificationBridge!.onTorrentComplete(toHex(torrent.infoHash), torrent.name || 'Unknown')
    })

    this.notificationProgressInterval = setInterval(() => {
      this.sendProgressUpdate()
    }, 1000)

    this.sendProgressUpdate()
  }

  private sendProgressUpdate(): void {
    if (!this.engine || !this.notificationBridge) return

    const torrents = this.engine.torrents
    const activeTorrents = torrents.filter(
      (t) => t.userState === 'active' && !t.isComplete && t.hasMetadata,
    )
    const errorTorrents = torrents.filter((t) => t.errorMessage)
    const downloadSpeed = torrents.reduce((sum, t) => sum + (t.downloadSpeed || 0), 0)
    const uploadSpeed = torrents.reduce((sum, t) => sum + (t.uploadSpeed || 0), 0)
    const eta = this.calculateCombinedEta(activeTorrents)

    const stats: ProgressStats = {
      activeCount: activeTorrents.length,
      errorCount: errorTorrents.length,
      downloadSpeed,
      uploadSpeed,
      eta,
      singleTorrentName: activeTorrents.length === 1 ? activeTorrents[0].name : undefined,
    }

    this.notificationBridge.updateProgress(stats)
    this.backgroundKeepAlive.updateActiveDownloads(stats.activeCount)
  }

  private calculateCombinedEta(activeTorrents: Torrent[]): number | null {
    let maxEta: number | null = null

    for (const torrent of activeTorrents) {
      if (torrent.downloadSpeed > 0 && torrent.progress < 1) {
        const remainingBytes = this.calculateRemainingBytes(torrent)
        if (remainingBytes > 0) {
          const eta = remainingBytes / torrent.downloadSpeed
          if (maxEta === null || eta > maxEta) {
            maxEta = eta
          }
        }
      }
    }

    return maxEta
  }

  private calculateRemainingBytes(torrent: Torrent): number {
    if (torrent.contentStorage) {
      const files = torrent.files
      const totalSize = files.reduce((sum, f) => sum + f.length, 0)
      return totalSize * (1 - torrent.progress)
    }

    if (torrent.piecesCount > 0) {
      const remainingPieces = torrent.piecesCount - torrent.completedPiecesCount
      return remainingPieces * torrent.pieceLength
    }

    return 0
  }

  async handleNativeEvent(event: string, payload: unknown): Promise<void> {
    if (!this.engine) {
      console.log('[DaemonEngineManager] Engine not ready, queueing event:', event)
      this.pendingNativeEvents.push({ event, payload })
      return
    }

    if (event === 'TorrentAdded') {
      const p = payload as { name: string; infohash: string; contentsBase64: string }
      console.log('[DaemonEngineManager] Adding torrent:', p.name)
      try {
        const bytes = Uint8Array.from(atob(p.contentsBase64), (c) => c.charCodeAt(0))
        await this.engine.addTorrent(bytes)
        markDesktopActivated()
      } catch (e) {
        console.error('[DaemonEngineManager] Failed to add torrent:', e)
      }
    } else if (event === 'MagnetAdded') {
      const p = payload as { link: string }
      console.log('[DaemonEngineManager] Adding magnet:', p.link)
      try {
        await this.engine.addTorrent(p.link)
        markDesktopActivated()
      } catch (e) {
        console.error('[DaemonEngineManager] Failed to add magnet:', e)
      }
    }
  }
}

/**
 * Debug helper: Add Big Buck Bunny test torrent and start immediately.
 * Call from console: addTestTorrent()
 */
async function addTestTorrent(url?: string): Promise<Torrent | null> {
  const em = window.engineManager
  if (!em) {
    console.error('[addTestTorrent] engineManager not available on window')
    return null
  }

  let magnet =
    url ??
    'magnet:?xt=urn:btih:a4e71df0553e6c565df4958a817b1f1a780503da&dn=big_buck_bunny_720p_surround.mp4'
  magnet += '&x.pe=127.0.0.1:8998&x.pe=127.0.0.1:6082'

  const engine = await em.init()
  const result = await engine.addTorrent(magnet)
  if (result.torrent) {
    console.log('[addTestTorrent] Added:', result.torrent.name, toHex(result.torrent.infoHash))
  } else {
    console.log('[addTestTorrent] Torrent already exists or failed to add')
  }
  return result.torrent
}

async function addTestTorrent2(): Promise<Torrent | null> {
  const url =
    'magnet:?xt=urn:btih:68e52e19f423308ba4f330d5a9b7fb68cec36355&xt=urn:btmh:1220d501d9530fb0563cb8113adb85a69df2cf5997f59b1927d302fc807e407dc0ee&dn=remy%20reads%20a%20book.mp4'
  return addTestTorrent(url)
}

/**
 * Debug helper: Add n fake test torrents with sequential hashes.
 * Call from console: addTestTorrents(100)
 */
async function addTestTorrents(n: number): Promise<Torrent[]> {
  const em = window.engineManager
  if (!em) {
    console.error('[addTestTorrents] engineManager not available on window')
    return []
  }

  const engine = await em.init()
  const added: Torrent[] = []

  for (let i = 1; i <= n; i++) {
    const hexNum = i.toString(16).padStart(3, '0')
    const infoHash = i.toString(16).padStart(40, '0')
    const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=test%20torrent%20${hexNum}`

    const result = await engine.addTorrent(magnet, { userState: 'stopped' })
    if (result.torrent) {
      added.push(result.torrent)
    }
  }

  console.log(`[addTestTorrents] Added ${added.length}/${n} torrents`)
  return added
}

// @ts-expect-error -- exposing addTestTorrent for debugging
window.addTestTorrent = addTestTorrent
// @ts-expect-error -- exposing addTestTorrent2 for debugging
window.addTestTorrent2 = addTestTorrent2

// @ts-expect-error -- exposing addTestTorrents for debugging
window.addTestTorrents = addTestTorrents
