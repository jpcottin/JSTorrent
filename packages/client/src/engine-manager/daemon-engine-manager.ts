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
  DaemonBackedEngine,
  DaemonControlStreamService,
  MinimalHttpClient,
  SocketHttpTransport,
  globalLogStore,
  LogStore,
  ISessionStore,
  Torrent,
  toHex,
  getBatchWriteHistogram,
  getCompanionWriteQueueStats,
  type ISocketFactory,
  type CredentialsGetter,
  type EngineLoggingConfig,
  type ConfigHub,
  type DaemonControlStreamConfig,
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
import type {
  InstalledPluginRecord,
  SearchPluginFetchInput,
  SearchPluginFetchPolicy,
  SearchPluginFetchResponse,
} from '../search/types'
import { ensurePluginFetchAllowed, SEARCH_PLUGIN_STORAGE_PREFIX } from '../search/plugin-utils'
import type { DaemonInfo, DownloadRoot } from '../types'
import type { IEngineManager, StorageRoot, FileOperationResult, LanShareResult } from './types'

// Toggle: true = WebRTC (no audio icon), false = Audio (shows audio icon)
// Recent chrome versions seem to throttle to ~1s with webrtc, but audio seems to
// be completely unthrottled.
const USE_WEBRTC_KEEP_ALIVE = false

// Toggle: true = writes are discarded (not sent to companion), for benchmarking I/O bottlenecks
const NULL_STORAGE = false

// Session store key for default root key
const LEGACY_DEFAULT_ROOT_KEY_KEY = 'settings:defaultRootKey'
const CHROMEOS_ANDROID_HOST = '100.115.92.2'
const CHROMEOS_WRITE_QUEUE_HIGH_WATER = 32 * 1024 * 1024
const CHROMEOS_WRITE_QUEUE_LOW_WATER = 16 * 1024 * 1024
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mkv': 'video/x-matroska',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
  '.ts': 'video/mp2t',
  '.m2ts': 'video/mp2t',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
}

function concatChunks(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

function isRedirectStatus(statusCode: number): boolean {
  return (
    statusCode === 301 ||
    statusCode === 302 ||
    statusCode === 303 ||
    statusCode === 307 ||
    statusCode === 308
  )
}

function resolveRedirectUrl(currentUrl: string, locationHeader: string): string {
  return new URL(locationHeader, currentUrl).toString()
}

function isTauriContext(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

function guessMimeType(filePath: string): string | null {
  const lowerPath = filePath.toLowerCase()
  const lastDot = lowerPath.lastIndexOf('.')
  if (lastDot < 0) return null
  return MIME_TYPES_BY_EXTENSION[lowerPath.slice(lastDot)] ?? null
}

function mapDownloadRootsToEngineRoots(roots: DownloadRoot[]): EngineStorageRoot[] {
  return roots.map((root) => ({
    key: root.key,
    label: root.display_name,
    path: root.path,
  }))
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
  private daemonBackedEngine: DaemonBackedEngine | null = null
  private socketFactory: ISocketFactory | null = null
  private latestHostRoots: DownloadRoot[] = []
  private backgroundKeepAlive = USE_WEBRTC_KEEP_ALIVE
    ? new BackgroundWebRTCManager()
    : new BackgroundAudioManager()

  constructor(channel: HostChannel) {
    this.channel = channel
    this.latestHostRoots = channel.getState().roots ?? []

    this.channel.onStateChanged((state) => {
      this.latestHostRoots = state.roots ?? []

      if (state.status === 'connected') {
        void this.syncRootsFromHostState(state.roots)
      }
    })
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
    const liveRoots = this.channel.getState().roots
    const roots: DownloadRoot[] = liveRoots.length > 0 ? liveRoots : (daemonInfo.roots ?? [])
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
    console.log('[DaemonEngineManager] daemon capabilities:', daemonInfo.capabilities ?? null)
    console.log(
      '[DaemonEngineManager] profileId:',
      daemonInfo.profileId ?? 'none',
      'standalone:',
      this.isStandalone,
    )

    // 2. Create direct WebSocket connection to daemon
    // On ChromeOS, use credentials getter for fresh token
    // On desktop, use token directly from daemon info
    const isChromeos = this.channel.getState().platform === 'chromeos'

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
    const storageRootsForConfig = mapDownloadRootsToEngineRoots(roots)
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
    this.socketFactory = socketFactory

    this.engine = new BtEngine({
      socketFactory,
      storageRootManager: srm,
      sessionStore: this.sessionStore,
      hasher,
      port: configHub.listeningPortAuto.get() ? 0 : configHub.listeningPort.get(),
      startSuspended: true,
      getNetworkInterfaces: () => this.daemonConnection!.getNetworkInterfaces(),
      getDefaultGateway: () => this.daemonConnection!.getDefaultGateway(),
      config: configHub,
      // Adaptive batching only supported by Android companion (ChromeOS)
      useAdaptiveBatching: isChromeos,
      getWriteQueueStats: isChromeos ? () => getCompanionWriteQueueStats() : undefined,
      writeQueueBackpressureHighWater: isChromeos ? CHROMEOS_WRITE_QUEUE_HIGH_WATER : undefined,
      writeQueueBackpressureLowWater: isChromeos ? CHROMEOS_WRITE_QUEUE_LOW_WATER : undefined,
    })
    window.engine = this.engine // expose for debugging
    window.getBatchWriteHistogram = getBatchWriteHistogram // expose for benchmarking
    console.log('[DaemonEngineManager] Engine created (suspended)')

    await this.syncRootsFromHostState(roots)

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
    this.daemonBackedEngine?.closeControlStream()
    this.daemonBackedEngine = null
    this.socketFactory = null

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
    this.daemonBackedEngine?.closeControlStream()
    this.daemonBackedEngine = null
    this.socketFactory = null
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
          await this.persistDefaultRootKey(remaining[0].key)
        } else {
          await this.clearPersistedDefaultRootKey()
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

  async createLanShareUrl(torrentHash: string, filePath: string): Promise<LanShareResult> {
    if (!this.engine) return { ok: false, error: 'Engine not initialized' }

    const torrent = this.engine.torrents.find((t) => toHex(t.infoHash) === torrentHash)
    if (!torrent) return { ok: false, error: 'Torrent not found' }

    const fileIndex = torrent.files.findIndex((candidate) => candidate.path === filePath)
    if (fileIndex < 0) return { ok: false, error: 'File not found' }
    const file = torrent.files[fileIndex]
    if (!file) return { ok: false, error: 'File not found' }
    if (!file.isComplete) return { ok: false, error: 'File is not complete yet' }

    const root = this.engine.storageRootManager.getRootForTorrent(torrentHash)
    if (!root) return { ok: false, error: 'No storage root for torrent' }

    const mimeType = guessMimeType(file.path)
    try {
      let url: string | null
      const controlStreamService = await this.getDaemonControlStreamService()
      if (controlStreamService) {
        const streamToken = crypto.randomUUID().split('-').join('')
        const daemonInfo = this._daemonInfo
        if (!daemonInfo) {
          return { ok: false, error: 'Daemon not connected' }
        }
        const { mediaPort } = await controlStreamService.registerHttpStream({
          streamToken,
          torrentId: torrentHash,
          fileIndex,
          rootKey: root.key,
          path: file.path,
          fileSize: file.length,
          mimeType,
        })
        const lanAddress = await this.resolveLanAddress(daemonInfo)
        if (!lanAddress) {
          return { ok: false, error: 'No LAN IPv4 address available for sharing' }
        }
        url = `http://${lanAddress}:${mediaPort}/stream/${streamToken}`
      } else {
        url = await this.channel.createLanShareUrl(
          torrentHash,
          fileIndex,
          root.key,
          file.path,
          file.length,
          mimeType,
        )
      }
      if (!url) {
        return { ok: false, error: 'LAN sharing is not available on this host' }
      }
      return { ok: true, url, mimeType }
    } catch (e) {
      return { ok: false, error: String(e) }
    }
  }

  private async getDaemonControlStreamService(): Promise<DaemonControlStreamService | null> {
    const platform = this.channel.getState().platform
    if (platform !== 'chromeos' && platform !== 'desktop') {
      return null
    }
    const daemonInfo = this._daemonInfo
    if (!daemonInfo?.token) {
      return null
    }
    const host = daemonInfo.host ?? (platform === 'chromeos' ? CHROMEOS_ANDROID_HOST : '127.0.0.1')

    if (!this.engine) {
      return null
    }

    if (!this.daemonConnection) {
      return null
    }
    if (!this.daemonBackedEngine || this.daemonBackedEngine.engine !== this.engine) {
      this.daemonBackedEngine?.closeControlStream()
      this.daemonBackedEngine = new DaemonBackedEngine(this.engine, this.daemonConnection)
    }
    const controlStreamConfig: DaemonControlStreamConfig = {
      host,
      port: daemonInfo.ioPort ?? daemonInfo.port,
      token: daemonInfo.token,
      extensionId:
        typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : 'standalone',
      installId:
        (await this.channel.kvGet<string>('telemetryId', { keyPrefix: '' })) ?? 'stream-service',
    }
    return this.daemonBackedEngine.ensureControlStream(controlStreamConfig)
  }

  private async resolveLanAddress(daemonInfo: DaemonInfo): Promise<string | null> {
    const daemonHost = daemonInfo.host ?? '127.0.0.1'
    const tokenHeaders: HeadersInit | undefined =
      this.channel.getState().platform === 'desktop'
        ? { 'X-JST-Auth': daemonInfo.token }
        : undefined
    const [interfaces, gateway] = await Promise.all([
      fetch(`http://${daemonHost}:${daemonInfo.port}/network/interfaces`, {
        headers: tokenHeaders,
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error(`Failed to query network interfaces: ${response.status}`)
        }
        return (await response.json()) as Array<{
          name: string
          address: string
          prefixLength: number
        }>
      }),
      fetch(`http://${daemonHost}:${daemonInfo.port}/network/gateway`, {
        headers: tokenHeaders,
      })
        .then(async (response) => {
          if (!response.ok) {
            return null
          }
          return (await response.json()) as { ip: string; interfaceName?: string } | null
        })
        .catch(() => null),
    ])

    const candidates = interfaces.filter((iface) => {
      if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(iface.address)) return false
      if (iface.address.startsWith('127.')) return false
      if (iface.address.startsWith('169.254.')) return false
      if (iface.address.startsWith('100.115.')) return false
      return iface.address !== '0.0.0.0'
    })
    const isPrivateLan = (address: string): boolean => {
      if (address.startsWith('10.')) return true
      if (address.startsWith('192.168.')) return true
      const match = /^172\.(\d{1,3})\./.exec(address)
      if (!match) return false
      const octet = Number(match[1])
      return octet >= 16 && octet <= 31
    }

    if (gateway?.interfaceName) {
      const gatewayCandidates = candidates.filter((iface) => iface.name === gateway.interfaceName)
      const preferredGatewayCandidate = gatewayCandidates.find((iface) =>
        isPrivateLan(iface.address),
      )
      if (preferredGatewayCandidate) return preferredGatewayCandidate.address
      if (gatewayCandidates[0]) return gatewayCandidates[0].address
    }

    return (
      candidates.find((iface) => isPrivateLan(iface.address))?.address ??
      candidates[0]?.address ??
      null
    )
  }

  getFilePath(torrentHash: string, filePath: string): string | null {
    if (!this.engine) return null

    const root = this.engine.storageRootManager.getRootForTorrent(torrentHash)
    if (!root) return null

    return `${root.path}/${filePath}`
  }

  async setDefaultRoot(key: string): Promise<void> {
    if (!this.engine) throw new Error('Engine not initialized')
    await this.persistDefaultRootKey(key)
  }

  getRoots(): StorageRoot[] {
    if (this.engine) {
      const roots = this.engine.storageRootManager.getRoots()
      if (roots.length > 0) return roots
    }
    if (this.configHub) {
      return this.configHub.storageRoots.get()
    }
    return mapDownloadRootsToEngineRoots(this.latestHostRoots)
  }

  async getDefaultRootKey(): Promise<string | null> {
    const engineDefault = this.engine?.storageRootManager.getDefaultRoot()
    if (engineDefault) return engineDefault

    const configDefault = this.configHub?.defaultRootKey.get() ?? null
    if (configDefault) return configDefault

    return this.readLegacyDefaultRootKey()
  }

  setLoggingConfig(config: EngineLoggingConfig): void {
    if (!this.engine) {
      console.warn('[DaemonEngineManager] Cannot set logging config: engine not initialized')
      return
    }
    this.engine.setLoggingConfig(config)
    console.log(`[DaemonEngineManager] Logging config updated: level=${config.level}`)
  }

  async searchPluginFetch(
    input: SearchPluginFetchInput,
    policy?: SearchPluginFetchPolicy,
  ): Promise<SearchPluginFetchResponse> {
    await this.init()

    if (!this.socketFactory) {
      throw new Error('Socket factory not initialized')
    }

    ensurePluginFetchAllowed(input.url, policy)

    const method = input.method ?? 'GET'
    if (method !== 'GET' && method !== 'POST') {
      throw new Error(`Unsupported plugin fetch method: ${method}`)
    }

    let body: Uint8Array
    let statusCode: number
    let remoteAddress: string | undefined
    let finalUrl: string | undefined

    if (method === 'POST') {
      const client = new MinimalHttpClient(this.socketFactory, undefined, 'http-tracker')
      const response = await client.post(input.url, input.body ?? '', input.headers ?? {})
      body = response.body
      statusCode = response.statusCode
      remoteAddress = response.remoteAddress
      finalUrl = input.url
    } else {
      const transport = new SocketHttpTransport(this.socketFactory, undefined, 'http-tracker')
      let currentUrl = input.url
      let redirectsRemaining = 5

      while (true) {
        const response = await transport.request({
          method,
          url: currentUrl,
          headers: input.headers,
          keepAlive: false,
        })

        if (isRedirectStatus(response.head.statusCode)) {
          const location = response.head.headers.location
          response.body.cancel('Following redirect')
          if (!location) {
            throw new Error(
              `Redirect response missing Location header: HTTP ${response.head.statusCode}`,
            )
          }
          if (redirectsRemaining <= 0) {
            throw new Error(`Too many redirects while fetching ${input.url}`)
          }

          currentUrl = resolveRedirectUrl(currentUrl, location)
          ensurePluginFetchAllowed(currentUrl, policy)
          redirectsRemaining -= 1
          continue
        }

        const chunks: Uint8Array[] = []
        while (true) {
          const chunk = await response.body.read()
          if (chunk === null) break
          chunks.push(chunk)
        }
        body = concatChunks(chunks)
        statusCode = response.head.statusCode
        remoteAddress = response.remoteAddress
        finalUrl = currentUrl
        break
      }
    }

    return {
      bodyText: new TextDecoder().decode(body),
      bodyBytes: body,
      bytes: body.byteLength,
      statusCode,
      remoteAddress,
      finalUrl,
    }
  }

  async listInstalledSearchPlugins(): Promise<InstalledPluginRecord[]> {
    const keys = await this.channel.kvKeys('', { keyPrefix: SEARCH_PLUGIN_STORAGE_PREFIX })
    if (keys.length === 0) {
      return []
    }

    const values = await this.channel.kvGetMulti(keys, { keyPrefix: SEARCH_PLUGIN_STORAGE_PREFIX })
    return keys
      .map((key) => values[key] as InstalledPluginRecord | undefined)
      .filter((plugin): plugin is InstalledPluginRecord => Boolean(plugin?.pluginId))
      .sort((left, right) => left.manifest.name.localeCompare(right.manifest.name))
  }

  async saveInstalledSearchPlugin(plugin: InstalledPluginRecord): Promise<void> {
    await this.channel.kvSet(plugin.pluginId, plugin, { keyPrefix: SEARCH_PLUGIN_STORAGE_PREFIX })
  }

  async removeInstalledSearchPlugin(pluginId: string): Promise<void> {
    await this.channel.kvDelete(pluginId, { keyPrefix: SEARCH_PLUGIN_STORAGE_PREFIX })
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

  private async syncRootsFromHostState(roots: DownloadRoot[]): Promise<void> {
    if (this._daemonInfo) {
      this._daemonInfo = {
        ...this._daemonInfo,
        roots,
      }
    }

    const mappedRoots = mapDownloadRootsToEngineRoots(roots)

    if (this.configHub) {
      ;(this.configHub as HostChannelConfigHub).setRuntime('storageRoots', mappedRoots)
    }

    if (mappedRoots.length === 0) {
      await this.clearPersistedDefaultRootKey()
      return
    }

    const currentDefault = this.engine?.storageRootManager.getDefaultRoot() ?? null
    if (currentDefault && mappedRoots.some((root) => root.key === currentDefault)) {
      await this.persistDefaultRootKey(currentDefault)
      return
    }

    const configuredDefault = this.configHub?.defaultRootKey.get() ?? null
    if (configuredDefault && mappedRoots.some((root) => root.key === configuredDefault)) {
      await this.persistDefaultRootKey(configuredDefault)
      return
    }

    const legacyDefault = await this.readLegacyDefaultRootKey()
    if (legacyDefault && mappedRoots.some((root) => root.key === legacyDefault)) {
      await this.persistDefaultRootKey(legacyDefault)
      return
    }

    await this.persistDefaultRootKey(mappedRoots[0].key)
  }

  private async readLegacyDefaultRootKey(): Promise<string | null> {
    if (!this.sessionStore) return null
    const bytes = await this.sessionStore.get(LEGACY_DEFAULT_ROOT_KEY_KEY)
    return bytes ? new TextDecoder().decode(bytes) : null
  }

  private async writeLegacyDefaultRootKey(key: string): Promise<void> {
    if (!this.sessionStore) return
    await this.sessionStore.set(LEGACY_DEFAULT_ROOT_KEY_KEY, new TextEncoder().encode(key))
  }

  private async clearLegacyDefaultRootKey(): Promise<void> {
    if (!this.sessionStore) return
    await this.sessionStore.delete(LEGACY_DEFAULT_ROOT_KEY_KEY)
  }

  private async persistDefaultRootKey(key: string): Promise<void> {
    if (this.engine) {
      const hasRoot = this.engine.storageRootManager.getRoots().some((root) => root.key === key)
      if (hasRoot && this.engine.storageRootManager.getDefaultRoot() !== key) {
        this.engine.storageRootManager.setDefaultRoot(key)
      }
    }

    if (this.configHub?.defaultRootKey.get() !== key) {
      this.configHub?.set('defaultRootKey', key)
    }

    await this.writeLegacyDefaultRootKey(key)
  }

  private async clearPersistedDefaultRootKey(): Promise<void> {
    if (this.configHub?.defaultRootKey.get() != null) {
      this.configHub.set('defaultRootKey', null)
    }
    await this.clearLegacyDefaultRootKey()
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
