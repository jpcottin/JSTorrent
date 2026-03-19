import { EventEmitter } from '../utils/event-emitter'
import { ISocketFactory } from '../interfaces/socket'
import { IFileSystem } from '../interfaces/filesystem'
import { randomBytes } from '../utils/hash'
import { fromString, concat, toHex, fromBase64 } from '../utils/buffer'
import { VERSION, versionToAzureusCode } from '../version'
import { TokenBucket } from '../utils/token-bucket'
import { DHTNode, saveDHTState, loadDHTState, hexToNodeId } from '../dht'
import {
  ILoggingEngine,
  Logger,
  EngineLoggingConfig,
  createFilter,
  randomClientId,
  withScopeAndFiltering,
  ShouldLogFn,
  ILoggableComponent,
  LogEntry,
  globalLogStore,
} from '../logging/logger'
import { PortMappingManager } from '../port-mapping'
import type { NetworkInterface, GatewayInfo } from '../interfaces/network'

import { ISessionStore } from '../interfaces/session-store'
import { IHasher, Sha1Reason } from '../interfaces/hasher'
import { SubtleCryptoHasher } from '../adapters/browser/subtle-crypto-hasher'
import { type EncryptionPolicy, MseSocket } from '../crypto'
import { toHex as toHexCrypto, computeReq2Hash } from '../crypto/key-derivation'
import { MemorySessionStore } from '../adapters/memory/memory-session-store'
import { StorageRootManager } from '../storage/storage-root-manager'
import type { StorageRoot } from '../storage/types'
import type { ConfigHub } from '../config/config-hub'
import { MemoryConfigHub } from '../config/memory-config-hub'
import type { ConfigType } from '../config/config-schema'
import { SessionPersistence } from './session-persistence'
import { ManifestWriter } from './manifest-writer'
import { Torrent } from './torrent'
import { PeerConnection } from './peer-connection'
import { TorrentUserState } from './torrent-state'
import { BandwidthTracker } from './bandwidth-tracker'
import { TorrentQueueManager } from './torrent-queue-manager'
import type { DiskWriteQueueStats } from './disk-queue'

// New imports for refactored code
import { parseTorrentInput } from './torrent-factory'
import { initializeTorrentMetadata } from './torrent-initializer'

// Maximum piece size supported by the io-daemon (must match DefaultBodyLimit in io-daemon)
export const MAX_PIECE_SIZE = 32 * 1024 * 1024 // 32MB

// UPnP status type
export type UPnPStatus = 'disabled' | 'discovering' | 'mapped' | 'unavailable' | 'failed'

/**
 * Engine-wide tick result aggregated across all torrents.
 * Returned from tick() for Kotlin to log/monitor.
 */
export interface EngineTickResult {
  // This tick's work (aggregated across torrents)
  blocksRecv: number
  blocksSent: number
  elapsedMs: number

  // Current state snapshot
  activePieces: number
  connectedPeers: number
  bufferedBytes: number

  // Pipeline state
  pipelineFilled: number
  pipelineMax: number

  // Backpressure queue depths (native only)
  pendingHashes: number
  pendingDiskWrites: number
}

export interface TorrentMemoryStats {
  infoHash: string
  name: string
  status: string
  progress: number
  downloadSpeed: number
  pieceLength: number
  isEndgame: boolean
  activePieces: {
    total: number
    partial: number
    fullyRequested: number
    fullyResponded: number
  }
  bufferedBytes: number
  bufferPool: {
    acquires: number
    reuses: number
    releases: number
    pooled: number
    bufferSize: number
    pooledBytes: number
    hitRate: number
  } | null
  peers: {
    connected: number
    connecting: number
    known: number
  }
}

export interface EngineMemoryStats {
  torrentCount: number
  activeDownloadingCount: number
  totalActivePieces: number
  totalBufferedBytes: number
  totalConnectedPeers: number
  totalKnownPeers: number
  dhtNodeCount: number | null
  torrents: TorrentMemoryStats[]
}

// === Unified Daemon Operation Queue Types ===

/**
 * Types of operations that consume daemon resources.
 * Currently only tcp_connect is used; kept as string literal type for future extensibility.
 */
export type DaemonOpType = 'tcp_connect'

/**
 * Filter out undefined values from an object.
 */
function filterUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>
}

export interface BtEngineOptions {
  downloadPath?: string
  socketFactory: ISocketFactory
  fileSystem?: IFileSystem
  storageRootManager?: StorageRootManager
  sessionStore?: ISessionStore
  hasher?: IHasher

  maxConnections?: number
  maxDownloadSpeed?: number
  maxUploadSpeed?: number
  peerId?: string // Optional custom peerId
  port?: number // Listening port to announce
  logging?: EngineLoggingConfig
  maxPeers?: number
  maxUploadSlots?: number
  onLog?: (entry: LogEntry) => void

  /**
   * Start the engine in suspended state (no network activity).
   * Use this when you need to restore session before starting networking.
   * Call resume() after setup/restore is complete.
   */
  startSuspended?: boolean

  /**
   * Maximum daemon operations per second (connections, announces).
   * Default: 20
   */
  daemonOpsPerSecond?: number

  /**
   * Burst capacity for daemon operations.
   * Default: 40 (2x rate)
   */
  daemonOpsBurst?: number

  /**
   * Function to get network interfaces.
   * Required for UPnP to determine local address for port mapping.
   */
  getNetworkInterfaces?: () => Promise<NetworkInterface[]>

  /**
   * Function to get the default gateway IP.
   * Required for NAT-PMP/PCP port mapping (unicast UDP to gateway:5351).
   */
  getDefaultGateway?: () => Promise<GatewayInfo | null>

  /**
   * MSE/PE encryption policy for peer connections.
   * - 'disabled': No encryption
   * - 'allow': Accept encryption if peer requests, but don't initiate
   * - 'prefer': Try encryption, fall back to plain
   * - 'required': Only accept encrypted connections
   * Default: 'disabled'
   */
  encryptionPolicy?: EncryptionPolicy

  /**
   * Enable DHT for trackerless peer discovery.
   * Default: true
   */
  dhtEnabled?: boolean

  /**
   * Skip DHT bootstrap (for testing only).
   * @internal
   */
  _skipDHTBootstrap?: boolean

  /**
   * Optional ConfigHub for reactive configuration.
   * When provided, settings are read from ConfigHub and subscriptions are
   * set up for automatic propagation. Individual options like maxConnections,
   * encryptionPolicy, etc. are ignored when config is provided.
   */
  config?: ConfigHub

  /**
   * When true, PeerConnection processes incoming data immediately instead of
   * waiting for the tick loop to call drainBuffer(). Useful for tests.
   * Default: false (production uses tick-aligned processing)
   */
  autoDrainBuffers?: boolean

  /**
   * Callback invoked at end of each engine tick.
   * Used by native adapters to flush batched writes in a single FFI call.
   * No-op on browser/extension.
   */
  onEndOfTick?: () => void

  /**
   * Optional callback returning current verified-write queue stats.
   * Used by native hosts to apply disk-backlog backpressure.
   */
  getWriteQueueStats?: () => DiskWriteQueueStats | undefined

  /**
   * High/low watermarks for verified-write queue backpressure.
   * When the queued verified-write bytes exceed the high watermark,
   * new requests are paused until the queue drains below the low watermark.
   */
  writeQueueBackpressureHighWater?: number
  writeQueueBackpressureLowWater?: number

  /**
   * Use passthrough disk queue (for Android/QuickJS).
   *
   * When true, disk writes execute immediately without JS-side queuing.
   * The actual batching happens in NativeBatchingDiskQueue which collects
   * writes during a tick and flushes them in a single FFI call.
   *
   * When false (default), uses TorrentDiskQueue with worker pool pattern
   * suitable for extension/daemon where each write is an HTTP request.
   */
  usePassthroughDiskQueue?: boolean

  /**
   * Enable adaptive batching for disk writes.
   * When true, multiple piece writes are batched together when queue has backlog.
   * Only supported by Android companion app (ChromeOS), not Rust io-daemon (desktop).
   */
  useAdaptiveBatching?: boolean

  /**
   * Tick loop ownership mode.
   * - 'js': JS owns the tick loop via setInterval (default, extension/browser)
   * - 'host': Host (Kotlin/Swift) drives the tick loop, calling tick() directly
   *
   * In 'host' mode, the host calls __jstorrent_engine_tick at regular intervals
   * and can measure timing precisely, including job pump time.
   */
  tickMode?: 'js' | 'host'
}

export class BtEngine extends EventEmitter implements ILoggingEngine, ILoggableComponent {
  public readonly storageRootManager: StorageRootManager
  public readonly socketFactory: ISocketFactory
  public readonly sessionPersistence: SessionPersistence
  public manifestWriter: ManifestWriter | null = null
  public readonly hasher: IHasher
  public readonly bandwidthTracker = new BandwidthTracker()
  public torrents: Torrent[] = []
  public port: number
  public peerId: Uint8Array

  /**
   * Get the current listening port.
   * This may differ from the initially configured port if port 0 (auto-assign) was used.
   */
  get listeningPort(): number {
    return this.port
  }

  public readonly clientId: string
  private logger: Logger
  private filterFn: ShouldLogFn
  private onLogCallback?: (entry: LogEntry) => void
  private onEndOfTickCallback?: () => void
  private getWriteQueueStatsCallback?: () => DiskWriteQueueStats | undefined
  public maxConnections: number
  public maxPeers: number
  public maxUploadSlots: number
  public encryptionPolicy: EncryptionPolicy
  public usePassthroughDiskQueue: boolean
  public useAdaptiveBatching: boolean

  /** Optional ConfigHub for reactive configuration (created internally if not provided) */
  public config?: ConfigHub

  /** Queue manager for torrent active limits */
  public queueManager?: TorrentQueueManager

  /** Cleanup functions for config subscriptions */
  private configUnsubscribers: Array<() => void> = []

  /**
   * Whether the engine is suspended (no network activity).
   * By default, engine starts active. Pass `startSuspended: true` to start suspended.
   */
  private _suspended: boolean = false

  // === Port Mapping (UPnP / NAT-PMP / PCP) ===
  private portMappingManager?: PortMappingManager
  private _upnpStatus: UPnPStatus = 'disabled'
  private getNetworkInterfaces?: () => Promise<NetworkInterface[]>
  // @ts-expect-error Stored for Phase 5: NAT-PMP/PCP gateway detection
  private _getDefaultGateway?: () => Promise<GatewayInfo | null>

  // === Incoming Connection Tracking ===
  /** Whether we've ever received a successful incoming connection this session */
  private _hasReceivedIncomingConnection: boolean = false

  // === DHT ===
  private _dhtEnabled: boolean = true
  private _dhtNode?: DHTNode
  private _skipDHTBootstrap: boolean = false

  // === Tick-aligned processing ===
  /**
   * When true, PeerConnection processes incoming data immediately instead of
   * waiting for the tick loop to call drainBuffer(). Useful for tests.
   */
  public autoDrainBuffers: boolean = false

  // === Backpressure (Phase 2) ===
  /** High water mark for total buffered bytes across all peers - activate backpressure (16MB) */
  private static readonly BACKPRESSURE_HIGH_WATER = 16 * 1024 * 1024
  /** Low water mark for total buffered bytes - release backpressure (4MB, hysteresis) */
  private static readonly BACKPRESSURE_LOW_WATER = 4 * 1024 * 1024
  /** Whether backpressure is currently active (reads paused on native side) */
  private backpressureActive: boolean = false
  /** Whether verified-write backlog is currently applying backpressure. */
  private writeQueueBackpressureActive: boolean = false
  private readonly writeQueueBackpressureHighWater?: number
  private readonly writeQueueBackpressureLowWater?: number

  // === Incoming Connection Protection ===
  /** Timeout for incoming connections to complete BT handshake (ms) */
  private static readonly INCOMING_HANDSHAKE_TIMEOUT = 30_000
  /** Max pending (pre-handshake) incoming connections */
  private static readonly MAX_PENDING_INCOMING = 50
  /** Track pending incoming connections with their cleanup timers */
  private pendingIncoming = new Set<PeerConnection>()

  // === MSE Identifier Map for O(1) Incoming Connection Routing ===
  /**
   * Maps MSE connection identifiers to torrent infoHashes.
   * The identifier is SHA1('req2' + infoHash) per the MSE/PE spec.
   * Maintained incrementally as torrents are added/removed.
   * Used for O(1) lookup to route incoming encrypted connections.
   */
  private torrentByMseId = new Map<string, Uint8Array>()

  // === Unified Daemon Operation Queue ===

  /**
   * Pending operation counts per torrent.
   * Key: infoHashHex, Value: counts by operation type
   */
  /** Pending connection counts per torrent (infoHashHex → count) */
  private pendingOps = new Map<string, number>()

  /**
   * Round-robin index for fair queue draining.
   */
  private opDrainIndex = 0

  /**
   * Single rate limiter for all daemon operations.
   * Prevents overwhelming the daemon regardless of operation type.
   */
  private daemonRateLimiter: TokenBucket

  /**
   * Timeout handle for unified engine tick loop.
   * Combines connection slot allocation and per-torrent processing.
   * Uses setTimeout (not setInterval) for adaptive timing.
   */
  private engineTickTimeout: ReturnType<typeof setTimeout> | null = null

  // Adaptive tick timing constants (sync with EngineController.kt)
  private static readonly MIN_TICK_INTERVAL_MS = 1 // Minimum delay (near-continuous when busy)
  private static readonly IDLE_TICK_INTERVAL_MS = 20 // Delay when peers connected but idle
  private static readonly MAX_TICK_INTERVAL_MS = 100 // Delay when no peers but torrents active
  private static readonly DORMANT_TICK_INTERVAL_MS = 1000 // Delay when no active torrents (save CPU)

  /**
   * Tick loop ownership mode.
   * 'js' = JS owns via setInterval, 'host' = external caller drives tick()
   */
  private _tickMode: 'js' | 'host' = 'js'

  /**
   * True once destroy() has been called. Used to guard against
   * tick callbacks that fire during async destroy operations.
   */
  private _destroyed = false

  // ILoggableComponent implementation
  static logName = 'client'
  getLogName(): string {
    return BtEngine.logName
  }
  getStaticLogName(): string {
    return BtEngine.logName
  }
  get engineInstance(): ILoggingEngine {
    return this
  }

  constructor(options: BtEngineOptions) {
    super()
    this.socketFactory = options.socketFactory

    if (options.storageRootManager) {
      this.storageRootManager = options.storageRootManager
    } else if (options.fileSystem && options.downloadPath) {
      // Legacy support: wrap single filesystem in StorageRootManager
      this.storageRootManager = new StorageRootManager(() => options.fileSystem!)
      this.storageRootManager.addRoot({
        key: 'default',
        label: 'Default',
        path: options.downloadPath,
      })
      this.storageRootManager.setDefaultRoot('default')
    } else {
      throw new Error('BtEngine requires storageRootManager or fileSystem + downloadPath')
    }
    const sessionStore = options.sessionStore ?? new MemorySessionStore()
    this.sessionPersistence = new SessionPersistence(sessionStore, this)
    this.hasher = options.hasher ?? new SubtleCryptoHasher()
    this.port = options.port ?? 6881 // Use nullish coalescing to allow port 0

    this.clientId = randomClientId()
    this.onLogCallback = options.onLog
    this.onEndOfTickCallback = options.onEndOfTick
    this.getWriteQueueStatsCallback = options.getWriteQueueStats
    this.writeQueueBackpressureHighWater = options.writeQueueBackpressureHighWater
    this.writeQueueBackpressureLowWater = options.writeQueueBackpressureLowWater
    this.filterFn = createFilter(options.logging ?? { level: 'info' })
    this._suspended = options.startSuspended ?? false

    // Save network callbacks for port mapping
    this.getNetworkInterfaces = options.getNetworkInterfaces
    this._getDefaultGateway = options.getDefaultGateway

    // Create ConfigHub if not provided, mapping individual options as overrides
    if (options.config) {
      this.config = options.config
    } else {
      // Create default MemoryConfigHub with individual options as overrides
      const overrides = filterUndefined({
        maxGlobalPeers: options.maxConnections,
        maxPeersPerTorrent: options.maxPeers,
        maxUploadSlots: options.maxUploadSlots,
        encryptionPolicy: options.encryptionPolicy,
        dhtEnabled: options.dhtEnabled,
        daemonOpsPerSecond: options.daemonOpsPerSecond,
        daemonOpsBurst: options.daemonOpsBurst,
      }) as Partial<ConfigType>
      const internalConfig = new MemoryConfigHub(overrides)
      // MemoryConfigHub.init() is synchronous (loads from empty storage)
      void internalConfig.init()
      this.config = internalConfig
    }

    // Always read from ConfigHub
    this.maxConnections = this.config.maxGlobalPeers.get()
    this.maxPeers = this.config.maxPeersPerTorrent.get()
    this.maxUploadSlots = this.config.maxUploadSlots.get()
    this.encryptionPolicy = this.config.encryptionPolicy.get()
    this._dhtEnabled = this.config.dhtEnabled.get()
    this.usePassthroughDiskQueue = options.usePassthroughDiskQueue ?? false
    this.useAdaptiveBatching = options.useAdaptiveBatching ?? false
    this._tickMode = options.tickMode ?? 'js'

    // Set up bandwidth limits from config (0 = unlimited)
    const downloadLimit = this.config.downloadSpeedUnlimited.get()
      ? 0
      : this.config.downloadSpeedLimit.get()
    const uploadLimit = this.config.uploadSpeedUnlimited.get()
      ? 0
      : this.config.uploadSpeedLimit.get()
    this.bandwidthTracker.setDownloadLimit(downloadLimit)
    this.bandwidthTracker.setUploadLimit(uploadLimit)

    // Initialize daemon rate limiter from config
    const opsPerSec = this.config.daemonOpsPerSecond.get()
    const burst = this.config.daemonOpsBurst.get()
    this.daemonRateLimiter = new TokenBucket(opsPerSec, burst)

    // Wire up config subscriptions
    this.wireConfigSubscriptions()

    // Create queue manager for torrent active limits
    if (this.config) {
      this.queueManager = new TorrentQueueManager(this, this.config)
    }

    // Initialize manifest writer if setting is enabled
    if (this.config.downloadManifest.get()) {
      this.manifestWriter = new ManifestWriter(this)
    }
    this.config.downloadManifest.subscribe((enabled) => {
      if (enabled) {
        this.manifestWriter = new ManifestWriter(this)
      } else {
        this.manifestWriter?.dispose()
        this.manifestWriter = null
      }
    })

    this._skipDHTBootstrap = options._skipDHTBootstrap ?? false
    this.autoDrainBuffers = options.autoDrainBuffers ?? false

    // Initialize logger for BtEngine itself
    this.logger = this.scopedLoggerFor(this)

    if (options.peerId) {
      this.peerId = Buffer.from(options.peerId)
    } else {
      // Generate random peerId: -JS{version}- + 12 random bytes
      // Azureus-style: -XX####- where XX=client code, ####=version
      const prefix = `-JS${versionToAzureusCode(VERSION)}-`
      const random = randomBytes(12)
      this.peerId = concat([fromString(prefix), random])
    }

    this.startServer()
    this.startEngineTick()
  }

  scopedLoggerFor(component: ILoggableComponent): Logger {
    // Pass a wrapper that always calls current filterFn, enabling dynamic log level changes
    return withScopeAndFiltering(component, (level, ctx) => this.filterFn(level, ctx), {
      onLog: (entry) => {
        // Add to global store (once)
        globalLogStore.add(entry.level, entry.message, entry.args)
        // Also call user-provided callback if any
        this.onLogCallback?.(entry)
      },
    })
  }

  /**
   * Update logging configuration dynamically.
   * Takes effect immediately for all components.
   */
  setLoggingConfig(config: EngineLoggingConfig): void {
    this.filterFn = createFilter(config)
    this.logger.info('Logging config updated', { level: config.level })
  }

  getWriteQueueStats(): DiskWriteQueueStats | undefined {
    return this.getWriteQueueStatsCallback?.()
  }

  isWriteQueueBackpressured(): boolean {
    return this.writeQueueBackpressureActive
  }

  /**
   * Whether the engine is suspended (no network activity).
   */
  get isSuspended(): boolean {
    return this._suspended
  }

  /**
   * Suspend all network activity.
   * Torrents remain in their user state but stop all networking.
   * Use this during session restore or for "pause all" functionality.
   */
  suspend(): void {
    if (this._suspended) return

    this.logger.info('Suspending engine - stopping all network activity')
    this._suspended = true

    for (const torrent of this.torrents) {
      torrent.stopNetwork()
    }
  }

  /**
   * Resume network activity.
   * Torrents with userState 'active' will start networking.
   * Torrents with userState 'stopped' or 'queued' remain stopped.
   */
  resume(): void {
    if (!this._suspended) return

    this.logger.info('Resuming engine - starting active torrents')
    this._suspended = false

    if (this.queueManager) {
      this.queueManager.recalculateImmediate()
    } else {
      for (const torrent of this.torrents) {
        if (torrent.userState === 'active' || torrent.userState === 'awaitingFileSelection') {
          // start() is idempotent and handles all checks internally
          torrent.start()
        }
      }
    }

    // Apply initial config for subsystems that depend on non-suspended state
    this.applyInitialConfig()
  }

  /**
   * Apply initial configuration from ConfigHub.
   * Called once after engine resumes to start subsystems based on saved settings.
   * Subscriptions only fire on CHANGES, so initial values need explicit application.
   */
  private applyInitialConfig(): void {
    if (!this.config) return

    // Log initial rate limits for debugging
    const downloadUnlimited = this.config.downloadSpeedUnlimited.get()
    const uploadUnlimited = this.config.uploadSpeedUnlimited.get()
    const downloadLimit = downloadUnlimited ? 0 : this.config.downloadSpeedLimit.get()
    const uploadLimit = uploadUnlimited ? 0 : this.config.uploadSpeedLimit.get()
    this.logger.info(
      `Initial rate limits - download: ${downloadLimit === 0 ? 'unlimited' : downloadLimit + ' B/s'}, upload: ${uploadLimit === 0 ? 'unlimited' : uploadLimit + ' B/s'}`,
    )

    // Start DHT if enabled (constructor only reads the flag, doesn't start)
    if (this.config.dhtEnabled.get()) {
      this.logger.info('Starting DHT (from initial config)')
      this.enableDHT().catch((e) => this.logger.error('Failed to enable DHT on startup', e))
    }

    // Start UPnP if enabled (constructor doesn't read initial value)
    if (this.config.upnpEnabled.get()) {
      this.logger.info('Starting UPnP (from initial config)')
      this.enableUPnP().catch((e) => this.logger.error('Failed to enable UPnP on startup', e))
    }
  }

  private startServer() {
    try {
      const server = this.socketFactory.createTcpServer()
      if (server && typeof server.listen === 'function') {
        server.listen(this.port, () => {
          // Get the actual bound port (important when port was 0 for auto-assign)
          const addr = server.address()
          if (addr && typeof addr === 'object' && 'port' in addr) {
            this.port = addr.port
          }
          this.logger.info(`BtEngine listening on port ${this.port}`)
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        server.on('connection', (socket: any) => {
          this.handleIncomingConnection(socket)
        })
      }
    } catch (err) {
      // not implemented yet
      this.logger.info('Failed to start server:', { error: err })
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async handleIncomingConnection(nativeSocket: any) {
    const rawSocket = this.socketFactory.wrapTcpSocket(nativeSocket)

    // Check global connection limit for incoming connections
    if (this.numConnections >= this.maxConnections) {
      this.logger.debug(
        `Rejecting incoming connection: global limit reached (${this.numConnections}/${this.maxConnections})`,
      )
      rawSocket.close()
      return
    }

    // Validate remote address info - required for peer tracking
    if (!rawSocket.remoteAddress || !rawSocket.remotePort) {
      this.logger.error(
        `Incoming connection missing remote address info (remoteAddress=${rawSocket.remoteAddress}, remotePort=${rawSocket.remotePort}). ` +
          `Socket wrapper must implement remoteAddress/remotePort getters.`,
      )
      rawSocket.close()
      return
    }

    // Handle MSE/PE encryption for incoming connections
    let socket = rawSocket
    const shouldHandleMse = this.encryptionPolicy !== 'disabled'

    if (shouldHandleMse && this.torrents.length > 0) {
      const mseSocket = new MseSocket(rawSocket, {
        policy: this.encryptionPolicy,
        // Identify which torrent this connection is for; return null if inactive.
        identifyTorrent: (connectionIdHex) => {
          const infoHash = this.torrentByMseId.get(connectionIdHex)
          if (!infoHash) return null
          const torrent = this.getTorrent(toHex(infoHash))
          return torrent?.isActive ? infoHash : null
        },
        sha1Batch: (inputs, reason) => this.sha1Batch(inputs, reason),
        getRandomBytes: randomBytes,
      })

      try {
        await mseSocket.acceptConnection()
        socket = mseSocket
        this.logger.debug(`Incoming MSE handshake complete (encrypted: ${mseSocket.isEncrypted})`)
      } catch (err) {
        // MSE failed
        if (this.encryptionPolicy === 'required') {
          this.logger.debug(`Incoming connection rejected: encryption required but MSE failed`)
          rawSocket.close()
          return
        }
        // 'allow' or 'prefer': fall back to plain socket
        this.logger.debug(`Incoming MSE failed, using plain: ${err}`)
      }
    }

    // Check pending connection limit to prevent resource exhaustion from zombie connections
    if (this.pendingIncoming.size >= BtEngine.MAX_PENDING_INCOMING) {
      this.logger.debug(
        `Rejecting incoming connection: pending limit reached (${this.pendingIncoming.size}/${BtEngine.MAX_PENDING_INCOMING})`,
      )
      rawSocket.close()
      return
    }

    const peer = new PeerConnection(this, socket, {
      remoteAddress: socket.remoteAddress!,
      remotePort: socket.remotePort!,
    })

    // Track this pending connection
    this.pendingIncoming.add(peer)

    // Set up handshake timeout - close connection if no valid handshake received
    const handshakeTimeout = setTimeout(() => {
      if (this.pendingIncoming.has(peer)) {
        this.logger.debug(
          `Incoming connection from ${peer.remoteAddress}:${peer.remotePort} timed out waiting for handshake`,
        )
        this.pendingIncoming.delete(peer)
        peer.close()
      }
    }, BtEngine.INCOMING_HANDSHAKE_TIMEOUT)

    // Clean up on connection close (before handshake)
    peer.on('close', () => {
      if (this.pendingIncoming.has(peer)) {
        clearTimeout(handshakeTimeout)
        this.pendingIncoming.delete(peer)
      }
    })

    peer.on('handshake', (infoHash, _peerId, _extensions) => {
      // Handshake received - clear timeout and remove from pending
      clearTimeout(handshakeTimeout)
      this.pendingIncoming.delete(peer)

      const infoHashStr = toHex(infoHash)
      const torrent = this.getTorrent(infoHashStr)
      if (torrent) {
        this.logger.debug(`Incoming connection for torrent ${infoHashStr}`)
        // Send our handshake back FIRST
        peer.sendHandshake(torrent.infoHash, torrent.peerId)
        peer.isIncoming = true
        torrent.addPeer(peer)
        // Track that we've received at least one incoming connection
        if (!this._hasReceivedIncomingConnection) {
          this._hasReceivedIncomingConnection = true
          this.logger.info(
            'First incoming connection received - port forwarding appears to be working',
          )
        }
      } else {
        const knownHashes = this.torrents.map((t) => toHex(t.infoHash))
        this.logger.warn(
          `Incoming connection for unknown torrent ${infoHashStr}. ` +
            `Known torrents (${this.torrents.length}): ${knownHashes.join(', ') || 'none'}`,
        )
        peer.close()
      }
    })
  }

  async addTorrent(
    magnetOrBuffer: string | Uint8Array,
    options: {
      storageKey?: string
      /** Whether this torrent is being restored from session, reset, or added by user action. Default: 'user' */
      source?: 'user' | 'restore' | 'reset'
      userState?: TorrentUserState
    } = {},
  ): Promise<{ torrent: Torrent | null; isDuplicate: boolean }> {
    // Parse the input (magnet link or torrent file)
    const input = await parseTorrentInput(magnetOrBuffer, this.hasher)

    // Check for existing torrent
    const existing = this.getTorrent(input.infoHashStr)
    if (existing) {
      return { torrent: existing, isDuplicate: true }
    }

    // Register storage root for this torrent if provided
    if (options.storageKey) {
      this.storageRootManager.setRootForTorrent(input.infoHashStr, options.storageKey)
    }

    // Create the torrent instance
    const torrent = new Torrent(
      this,
      input.infoHash,
      this.peerId,
      this.socketFactory,
      this.port,
      undefined, // contentStorage - initialized later with metadata
      input.announce,
      this.maxPeers,
      this.maxUploadSlots,
      this.encryptionPolicy,
      this.usePassthroughDiskQueue,
    )

    // Store magnet display name for fallback naming
    if (input.magnetDisplayName) {
      torrent._magnetDisplayName = input.magnetDisplayName
    }

    // Store magnet peer hints for use on every start
    if (input.magnetPeerHints && input.magnetPeerHints.length > 0) {
      torrent.magnetPeerHints = input.magnetPeerHints
    }

    if (input.magnetUrlSeeds && input.magnetUrlSeeds.length > 0) {
      torrent.magnetUrlSeeds = [...input.magnetUrlSeeds]
    }

    if (input.magnetSelectOnly !== undefined) {
      torrent.magnetSelectOnly = input.magnetSelectOnly
    }

    // Store origin info for persistence
    if (input.magnetLink) {
      torrent.initFromMagnet(input.magnetLink)
    } else if (input.torrentFileBase64) {
      torrent.initFromTorrentFile(input.torrentFileBase64)
    }

    // Set initial user state
    torrent.userState = options.userState ?? 'active'

    // Precompute MSE identifier for incoming connection routing.
    // This is SHA1('req2' + infoHash) - only needs infoHash so we do it early.
    const mseId = await computeReq2Hash(torrent.infoHash, (data) =>
      this.hasher.sha1(data, 'mse-req2'),
    )
    torrent.setMseIdentifier(mseId)
    this.torrentByMseId.set(toHexCrypto(mseId), torrent.infoHash)

    // Initialize metadata if we have it (torrent file case)
    if (input.infoBuffer && input.parsedTorrent) {
      try {
        await initializeTorrentMetadata(this, torrent, input.infoBuffer, input.parsedTorrent)
        // Write download manifest now that metadata is available
        await this.manifestWriter?.writeNow(torrent)
      } catch (e) {
        // Handle missing storage gracefully - torrent will be in error state but still visible
        if (e instanceof Error && e.name === 'MissingStorageRootError') {
          torrent.errorMessage = `Download location unavailable. Storage root not found.`
          this.logger.warn(`Torrent ${input.infoHashStr} initialized with missing storage`)
        } else {
          throw e
        }
      }
    }

    // Set up metadata event handler for magnet links
    torrent.on('metadata', async (infoBuffer) => {
      try {
        await initializeTorrentMetadata(this, torrent, infoBuffer, undefined, {
          magnetSelectOnly: torrent.magnetSelectOnly,
        })

        // Save infodict for future restores
        await this.sessionPersistence.saveInfoDict(input.infoHashStr, infoBuffer)

        // Write download manifest now that metadata is available
        await this.manifestWriter?.writeNow(torrent)

        // If data check is needed (files exist from a previous download) and
        // torrent is already active, run the check now before proceeding
        if (torrent.needsDataCheck && torrent.isActive) {
          await torrent.recheckData()
          torrent.clearNeedsDataCheck()
        }

        torrent.recheckPeers()
        torrent.emit('test:ready')
      } catch (err) {
        this.emit('error', err)
      }
    })

    // Register torrent
    this.torrents.push(torrent)
    this.emit('torrent', torrent)

    // Set up event forwarding
    torrent.on('complete', () => {
      this.emit('torrent-complete', torrent)
      this.queueManager?.onTorrentCompleted(torrent)
      void this.manifestWriter?.writeNow(torrent)
    })

    torrent.on('error', (err) => {
      this.emit('error', err)
    })

    // Save torrent file for file-source torrents (write once)
    if (options.source !== 'restore' && options.source !== 'reset' && input.torrentFileBuffer) {
      await this.sessionPersistence.saveTorrentFile(input.infoHashStr, input.torrentFileBuffer)
    }

    // Persist torrent list and initial state BEFORE starting - must happen before
    // any async work that could yield control (e.g., torrent.start()), otherwise a
    // quick pause could interrupt before the list is saved
    if (options.source !== 'restore' && options.source !== 'reset') {
      await this.sessionPersistence.saveTorrentList()
      await this.sessionPersistence.saveTorrentState(torrent)
    }

    // Start if engine not suspended AND user wants it active
    if (!this._suspended) {
      if (torrent.userState === 'awaitingFileSelection') {
        // Start networking immediately for metadata exchange — not subject to queue limits
        await torrent.start()
      } else if (torrent.userState === 'active') {
        if (this.queueManager && options.source !== 'restore') {
          this.queueManager.onTorrentAdded(torrent)
        } else if (!this.queueManager) {
          await torrent.start()
        }
        // For restore: queue manager handles batch recalculation after all torrents are restored
      }
    }

    return { torrent, isDuplicate: false }
  }

  async removeTorrent(torrent: Torrent) {
    // Immediately stop network activity (synchronous) so the torrent can't
    // continue downloading while we do async cleanup below.
    torrent.stopNetwork()

    // Notify queue manager before removal (while torrent is still in the list)
    this.queueManager?.onTorrentRemoved(torrent)

    const index = this.torrents.indexOf(torrent)
    if (index !== -1) {
      this.torrents.splice(index, 1)
      const infoHash = toHex(torrent.infoHash)

      // Remove from MSE identifier map
      if (torrent.mseIdentifier) {
        this.torrentByMseId.delete(toHexCrypto(torrent.mseIdentifier))
      }

      // Remove persisted data
      await this.sessionPersistence.removeTorrentData(infoHash)
      await this.sessionPersistence.saveTorrentList()
      await this.manifestWriter?.deleteManifest(torrent)
      await torrent.destroy({ skipAnnounce: true })

      this.emit('torrent-removed', torrent)
    }
  }

  async removeTorrentByHash(infoHash: string) {
    const torrent = this.getTorrent(infoHash)
    if (torrent) {
      await this.removeTorrent(torrent)
    }
  }

  /**
   * Remove a torrent and delete all associated data files from disk.
   * This includes: downloaded content files, .parts file, and session data.
   * Returns a list of any errors encountered during file deletion.
   */
  async removeTorrentWithData(torrent: Torrent): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = []
    const infoHash = toHex(torrent.infoHash)

    // 1. Immediately stop all network activity (synchronous) before any async work.
    // This prevents the torrent from continuing to download/connect while we
    // close file handles and delete files, which can be slow on Android/SAF.
    torrent.stopNetwork()

    // 2. Close file handles and fully destroy torrent state
    if (torrent.contentStorage) {
      await torrent.contentStorage.close()
    }
    await torrent.destroy({ skipAnnounce: true })

    // 3. Get filesystem for this torrent (may throw if no storage root)
    let fs: IFileSystem | null = null
    try {
      fs = this.storageRootManager.getFileSystemForTorrent(infoHash)
    } catch {
      // No storage root - skip file deletion (torrent may never have had files)
    }

    // 4. Delete content files using batchDelete (bottom-up)
    if (torrent.contentStorage && fs) {
      const files = torrent.contentStorage.filesList
      if (files.length > 0) {
        const firstSlash = files[0].path.indexOf('/')
        const isMultiFile = firstSlash >= 0
        const torrentRootDir = isMultiFile ? files[0].path.substring(0, firstSlash) : ''

        // Early bail: check if torrent content exists on disk
        let rootExists = true
        try {
          rootExists = isMultiFile
            ? await fs.exists(torrentRootDir)
            : await fs.exists(files[0].path)
        } catch {
          // If exists() throws, proceed anyway — batchDelete handles missing entries
        }

        if (rootExists) {
          if (isMultiFile) {
            // Group files by parent directory (relative to storage root)
            const dirToEntries = new Map<string, string[]>()
            for (const file of files) {
              const lastSlash = file.path.lastIndexOf('/')
              const dir = file.path.substring(0, lastSlash)
              const name = file.path.substring(lastSlash + 1)
              const entries = dirToEntries.get(dir)
              if (entries) {
                entries.push(name)
              } else {
                dirToEntries.set(dir, [name])
              }
            }

            // Sort directory groups deepest-first
            const sortedDirs = [...dirToEntries.keys()].sort(
              (a, b) => b.split('/').length - a.split('/').length,
            )

            // Delete files bottom-up, adding empty subdirectory names to parent batches
            const deletedSubdirs = new Map<string, string[]>()
            for (const dir of sortedDirs) {
              const entries = dirToEntries.get(dir)!
              // Include any subdirectories that were emptied at a deeper level
              const subdirEntries = deletedSubdirs.get(dir)
              if (subdirEntries) {
                entries.push(...subdirEntries)
              }
              try {
                const failed = await fs.batchDelete(dir, entries)
                for (const name of failed) {
                  errors.push(`${dir}/${name}: failed to delete`)
                }
                // Track successfully deleted entries so parent knows this subdir is empty
                const allSucceeded = failed.length === 0
                if (allSucceeded) {
                  const parentSlash = dir.lastIndexOf('/')
                  if (parentSlash >= 0) {
                    const parentDir = dir.substring(0, parentSlash)
                    const subdirName = dir.substring(parentSlash + 1)
                    const parentSubdirs = deletedSubdirs.get(parentDir)
                    if (parentSubdirs) {
                      parentSubdirs.push(subdirName)
                    } else {
                      deletedSubdirs.set(parentDir, [subdirName])
                    }
                  }
                }
              } catch (e) {
                errors.push(`${dir}: ${e instanceof Error ? e.message : String(e)}`)
              }
            }

            // Delete the torrent root directory itself
            try {
              // Include any subdirectories emptied directly under the root
              const rootSubdirs = deletedSubdirs.get(torrentRootDir)
              if (rootSubdirs) {
                const failed = await fs.batchDelete(torrentRootDir, rootSubdirs)
                for (const name of failed) {
                  errors.push(`${torrentRootDir}/${name}: failed to delete`)
                }
              }
              await fs.delete(torrentRootDir)
            } catch (e) {
              errors.push(`${torrentRootDir}: ${e instanceof Error ? e.message : String(e)}`)
            }
          } else {
            // Single-file torrent: just delete the one file
            try {
              await fs.delete(files[0].path)
            } catch (e) {
              errors.push(`${files[0].path}: ${e instanceof Error ? e.message : String(e)}`)
            }
          }
        }
      }
    }

    // 5. Delete .parts file (no exists check, catch errors)
    if (fs) {
      const partsPath = `${infoHash}.parts`
      try {
        await fs.delete(partsPath)
      } catch {
        // Ignore — .parts file may not exist
      }
    }

    // 6. Remove from engine (clears session data)
    await this.removeTorrent(torrent)

    return { success: errors.length === 0, errors }
  }

  /**
   * Delete specific files from disk for a torrent without removing the torrent itself.
   * Closes file handles first, deletes the files, and if all files are deleted,
   * also deletes the .parts file and the torrent root directory.
   */
  async deleteFileData(
    torrent: Torrent,
    fileIndices: number[],
  ): Promise<{ success: boolean; errors: string[] }> {
    const errors: string[] = []
    const infoHash = toHex(torrent.infoHash)

    if (!torrent.contentStorage) {
      return { success: false, errors: ['No content storage'] }
    }

    let fs: IFileSystem | null = null
    try {
      fs = this.storageRootManager.getFileSystemForTorrent(infoHash)
    } catch {
      return { success: false, errors: ['No storage root'] }
    }

    const allFiles = torrent.contentStorage.filesList
    const filesToDelete = fileIndices
      .map((i) => allFiles[i])
      .filter((f): f is (typeof allFiles)[number] => f !== undefined)

    if (filesToDelete.length === 0) {
      return { success: true, errors: [] }
    }

    // Close file handles for the files we're about to delete
    await torrent.contentStorage.closeFileHandles(filesToDelete.map((f) => f.path))

    const isMultiFile = allFiles[0].path.indexOf('/') >= 0
    const deletingAll = filesToDelete.length === allFiles.length

    // Group files by parent directory for batchDelete
    const dirToEntries = new Map<string, string[]>()
    for (const file of filesToDelete) {
      const lastSlash = file.path.lastIndexOf('/')
      if (lastSlash >= 0) {
        const dir = file.path.substring(0, lastSlash)
        const name = file.path.substring(lastSlash + 1)
        const entries = dirToEntries.get(dir)
        if (entries) entries.push(name)
        else dirToEntries.set(dir, [name])
      } else {
        // Single-file torrent or root-level file
        try {
          await fs.delete(file.path)
        } catch (e) {
          errors.push(`${file.path}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    // Delete grouped files bottom-up
    const sortedDirs = [...dirToEntries.keys()].sort(
      (a, b) => b.split('/').length - a.split('/').length,
    )

    const deletedSubdirs = new Map<string, string[]>()
    for (const dir of sortedDirs) {
      const entries = dirToEntries.get(dir)!
      const subdirEntries = deletedSubdirs.get(dir)
      if (subdirEntries) entries.push(...subdirEntries)
      try {
        const failed = await fs.batchDelete(dir, entries)
        for (const name of failed) {
          errors.push(`${dir}/${name}: failed to delete`)
        }
        if (failed.length === 0) {
          const parentSlash = dir.lastIndexOf('/')
          if (parentSlash >= 0) {
            const parentDir = dir.substring(0, parentSlash)
            const subdirName = dir.substring(parentSlash + 1)
            const parentSubdirs = deletedSubdirs.get(parentDir)
            if (parentSubdirs) parentSubdirs.push(subdirName)
            else deletedSubdirs.set(parentDir, [subdirName])
          }
        }
      } catch (e) {
        errors.push(`${dir}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }

    // If deleting all files, also clean up .parts file and torrent root directory
    if (deletingAll) {
      // Delete .parts file
      try {
        await fs.delete(`${infoHash}.parts`)
      } catch {
        // Ignore — .parts file may not exist
      }

      // Delete torrent root directory (multi-file only)
      if (isMultiFile) {
        const torrentRootDir = allFiles[0].path.substring(0, allFiles[0].path.indexOf('/'))
        try {
          const rootSubdirs = deletedSubdirs.get(torrentRootDir)
          if (rootSubdirs) {
            const failed = await fs.batchDelete(torrentRootDir, rootSubdirs)
            for (const name of failed) {
              errors.push(`${torrentRootDir}/${name}: failed to delete`)
            }
          }
          await fs.delete(torrentRootDir)
        } catch (e) {
          errors.push(`${torrentRootDir}: ${e instanceof Error ? e.message : String(e)}`)
        }
      }
    }

    // Re-verify so piece states and file progress reflect the deleted data
    await torrent.recheckData()

    return { success: errors.length === 0, errors }
  }

  /**
   * Batch SHA1 computation for MSE handshake.
   * Uses hasher.sha1Batch if available, otherwise falls back to sequential calls.
   */
  private sha1Batch(inputs: Uint8Array[], reason?: Sha1Reason): Promise<Uint8Array[]> {
    if (this.hasher.sha1Batch) {
      return this.hasher.sha1Batch(inputs, reason)
    }
    // Fallback: parallel individual calls
    return Promise.all(inputs.map((input) => this.hasher.sha1(input, reason)))
  }

  /**
   * Reset a torrent's state (progress, stats, file priorities) without removing it.
   * For magnet torrents, this preserves the infodict so metadata doesn't need to be re-fetched.
   * The torrent will be stopped after reset and needs to be started manually.
   *
   * This works by removing and re-adding the torrent from its original source (magnet or file),
   * which ensures trackers and other metadata are properly restored.
   */
  async resetTorrent(torrent: Torrent): Promise<void> {
    const index = this.torrents.indexOf(torrent)
    if (index === -1) return

    const infoHash = toHex(torrent.infoHash)
    const storageKey = this.storageRootManager.getRootForTorrent(infoHash)?.key

    // Get original source for re-adding
    const magnetLink = torrent.magnetLink
    const torrentFileBase64 = torrent.torrentFileBase64

    // Stop the torrent
    await torrent.destroy({ skipAnnounce: true })

    // Remove from engine array (but keep in persisted list)
    this.torrents.splice(index, 1)

    // Reset persisted state (clears progress, keeps source files + list entry)
    await this.sessionPersistence.resetState(infoHash)

    // Re-add from original source
    const source = magnetLink || (torrentFileBase64 ? fromBase64(torrentFileBase64) : null)
    if (!source) {
      throw new Error('Cannot reset: no source available')
    }

    const result = await this.addTorrent(source, {
      storageKey,
      source: 'reset', // Skip saving source files and list (already saved)
      userState: 'stopped',
    })

    // For magnet torrents, restore infodict if available
    if (result.torrent && !result.torrent.hasMetadata && magnetLink) {
      const infoDict = await this.sessionPersistence.loadInfoDict(infoHash)
      if (infoDict) {
        await initializeTorrentMetadata(this, result.torrent, infoDict)
      }
    }

    // Note: addTorrent() emits 'torrent' event, which updates UI with fresh torrent
  }

  getTorrent(infoHash: string): Torrent | undefined {
    return this.torrents.find((t) => toHex(t.infoHash) === infoHash)
  }

  // ===========================================================================
  // Queue Management
  // ===========================================================================

  queueMoveToTop(torrent: Torrent): void {
    this.queueManager?.moveToTop(torrent)
  }

  queueMoveToBottom(torrent: Torrent): void {
    this.queueManager?.moveToBottom(torrent)
  }

  queueForceStart(torrent: Torrent): void {
    this.queueManager?.forceStart(torrent)
  }

  async destroy() {
    this.logger.info('Destroying engine')
    this._destroyed = true

    // Clean up config subscriptions
    for (const unsubscribe of this.configUnsubscribers) {
      unsubscribe()
    }
    this.configUnsubscribers = []

    // Close pending incoming connections (pre-handshake)
    for (const peer of this.pendingIncoming) {
      peer.close()
    }
    this.pendingIncoming.clear()

    // Notify ConfigHub that engine is stopping (clears pending restart-required changes)
    if (this.config && 'setEngineRunning' in this.config) {
      ;(this.config as { setEngineRunning: (running: boolean) => void }).setEngineRunning(false)
    }

    // Stop engine tick loop
    this.stopEngineTick()

    // Clear pending operations
    this.pendingOps.clear()

    // Clean up UPnP mappings
    await this.disableUPnP()

    // Stop DHT (saves state)
    await this.disableDHT()

    // Flush any pending persistence saves
    await this.sessionPersistence.flushPendingSaves()
    await this.manifestWriter?.flushPendingSaves()

    // Destroy all torrents
    await Promise.all(this.torrents.map((t) => t.destroy()))
    this.torrents = []

    // Close server?
    // We don't have a reference to server instance returned by createTcpServer unless we stored it.
    // startServer() didn't store it.
    // But we should probably store it.
    // For now, just clearing torrents satisfies the test.
  }

  /**
   * Restore torrents from session storage.
   * Call this after engine is initialized.
   */
  async restoreSession(): Promise<number> {
    this.logger.info('Restoring session...')
    const count = await this.sessionPersistence.restoreSession()
    this.logger.info(`Restored ${count} torrents`)
    return count
  }

  get numConnections(): number {
    return this.torrents.reduce((acc, t) => acc + t.numPeers, 0)
  }

  /**
   * Get aggregated engine statistics for health monitoring.
   * Combines tick stats from all active torrents.
   */
  getEngineStats(): {
    tickCount: number
    tickTotalMs: number
    tickMaxMs: number
    tickAvgMs: number
    activePieces: number
    connectedPeers: number
    activeTorrents: number
  } {
    let tickCount = 0
    let tickTotalMs = 0
    let tickMaxMs = 0
    let activePieces = 0
    let connectedPeers = 0
    let activeTorrents = 0

    for (const torrent of this.torrents) {
      const stats = torrent.getTickStats()
      tickCount += stats.tickCount
      tickTotalMs += stats.tickTotalMs
      if (stats.tickMaxMs > tickMaxMs) {
        tickMaxMs = stats.tickMaxMs
      }
      activePieces += stats.activePieces
      connectedPeers += stats.connectedPeers
      if (stats.connectedPeers > 0) {
        activeTorrents++
      }
    }

    return {
      tickCount,
      tickTotalMs,
      tickMaxMs,
      tickAvgMs: tickCount > 0 ? tickTotalMs / tickCount : 0,
      activePieces,
      connectedPeers,
      activeTorrents,
    }
  }

  getMemoryStats(): EngineMemoryStats {
    const torrents = this.torrents.map((torrent) => {
      const activePieces = torrent.getActivePieceManager()
      const bufferPool = activePieces?.bufferPoolStats ?? null
      const swarm = torrent.swarm
      const hitRate =
        bufferPool && bufferPool.acquires > 0 ? bufferPool.reuses / bufferPool.acquires : 0

      return {
        infoHash: toHex(torrent.infoHash),
        name: torrent.name,
        status: torrent.activityState,
        progress: torrent.progress,
        downloadSpeed: torrent.downloadSpeed,
        pieceLength: torrent.pieceLength,
        isEndgame: torrent.isEndgame,
        activePieces: {
          total: activePieces?.activeCount ?? 0,
          partial: activePieces?.partialCount ?? 0,
          fullyRequested: activePieces?.fullyRequestedCount ?? 0,
          fullyResponded: activePieces?.fullyRespondedCount ?? 0,
        },
        bufferedBytes: activePieces?.totalBufferedBytes ?? 0,
        bufferPool: bufferPool
          ? {
              acquires: bufferPool.acquires,
              reuses: bufferPool.reuses,
              releases: bufferPool.releases,
              pooled: bufferPool.pooled,
              bufferSize: bufferPool.bufferSize,
              pooledBytes: bufferPool.pooledBytes,
              hitRate,
            }
          : null,
        peers: {
          connected: torrent.numPeers,
          connecting: swarm.byState.connecting,
          known: swarm.total,
        },
      }
    })

    return {
      torrentCount: this.torrents.length,
      activeDownloadingCount: torrents.filter((torrent) =>
        ['downloading', 'downloading_metadata', 'checking'].includes(torrent.status),
      ).length,
      totalActivePieces: torrents.reduce((sum, torrent) => sum + torrent.activePieces.total, 0),
      totalBufferedBytes: torrents.reduce((sum, torrent) => sum + torrent.bufferedBytes, 0),
      totalConnectedPeers: torrents.reduce((sum, torrent) => sum + torrent.peers.connected, 0),
      totalKnownPeers: torrents.reduce((sum, torrent) => sum + torrent.peers.known, 0),
      dhtNodeCount: this.dhtNode?.getStats().nodeCount ?? null,
      torrents,
    }
  }

  // === ConfigHub Subscription Wiring ===

  /**
   * Wire up ConfigHub subscriptions for reactive configuration.
   * Called once during construction when config is provided.
   */
  private wireConfigSubscriptions(): void {
    if (!this.config) return

    // Capture config for use in callbacks (TypeScript can't track narrowing into closures)
    const config = this.config

    // Rate Limits - subscribe to both boolean flags and values
    // Download speed
    this.configUnsubscribers.push(
      config.downloadSpeedUnlimited.subscribe((unlimited) => {
        const limit = unlimited ? 0 : config.downloadSpeedLimit.get()
        this.bandwidthTracker.setDownloadLimit(limit)
        this.logger.info(
          `Download speed limit updated: ${limit === 0 ? 'unlimited' : limit + ' B/s'}`,
        )
      }),
    )

    this.configUnsubscribers.push(
      config.downloadSpeedLimit.subscribe((value) => {
        // Only apply if not unlimited
        if (!config.downloadSpeedUnlimited.get()) {
          this.bandwidthTracker.setDownloadLimit(value)
          this.logger.info(`Download speed limit updated: ${value} B/s`)
        }
      }),
    )

    // Upload speed
    this.configUnsubscribers.push(
      config.uploadSpeedUnlimited.subscribe((unlimited) => {
        const limit = unlimited ? 0 : config.uploadSpeedLimit.get()
        this.bandwidthTracker.setUploadLimit(limit)
        this.logger.info(
          `Upload speed limit updated: ${limit === 0 ? 'unlimited' : limit + ' B/s'}`,
        )
      }),
    )

    this.configUnsubscribers.push(
      config.uploadSpeedLimit.subscribe((value) => {
        // Only apply if not unlimited
        if (!config.uploadSpeedUnlimited.get()) {
          this.bandwidthTracker.setUploadLimit(value)
          this.logger.info(`Upload speed limit updated: ${value} B/s`)
        }
      }),
    )

    // Connection Limits - inline the logic from the removed setConnectionLimits method
    this.configUnsubscribers.push(
      this.config.maxPeersPerTorrent.subscribe((maxPeers) => {
        this.maxPeers = maxPeers
        for (const torrent of this.torrents) {
          torrent.setMaxPeers(maxPeers)
        }
        this.logger.info(`Max peers per torrent updated: ${maxPeers}`)
      }),
    )

    this.configUnsubscribers.push(
      this.config.maxGlobalPeers.subscribe((maxGlobal) => {
        this.maxConnections = maxGlobal
        this.logger.info(`Max global peers updated: ${maxGlobal}`)
      }),
    )

    this.configUnsubscribers.push(
      this.config.maxUploadSlots.subscribe((maxSlots) => {
        this.maxUploadSlots = maxSlots
        for (const torrent of this.torrents) {
          torrent.setMaxUploadSlots(maxSlots)
        }
        this.logger.info(`Max upload slots updated: ${maxSlots}`)
      }),
    )

    this.configUnsubscribers.push(
      this.config.activePieceMemoryLimitMiB.subscribe((limitMiB) => {
        for (const torrent of this.torrents) {
          torrent.setActivePieceMemoryLimitMiB(limitMiB)
        }
        this.logger.info(
          `Active piece memory limit updated: ${
            limitMiB === 0 ? 'platform default' : `${limitMiB} MiB`
          }`,
        )
      }),
    )

    // Send buffer watermark
    this.configUnsubscribers.push(
      this.config.sendBufferWatermark.subscribe((watermark) => {
        for (const torrent of this.torrents) {
          torrent.setSendBufferWatermark(watermark)
        }
        this.logger.info(`Send buffer watermark updated: ${(watermark / 1024).toFixed(0)}KB`)
      }),
    )

    // Encryption Policy - inline the logic from the removed setEncryptionPolicy method
    this.configUnsubscribers.push(
      this.config.encryptionPolicy.subscribe((policy) => {
        this.encryptionPolicy = policy
        for (const torrent of this.torrents) {
          torrent.setEncryptionPolicy(policy)
        }
        this.logger.info(`Encryption policy updated: ${policy}`)
      }),
    )

    // DHT - call private methods directly (the public setDHTEnabled was removed)
    this.configUnsubscribers.push(
      this.config.dhtEnabled.subscribe((enabled) => {
        if (enabled) {
          this.enableDHT()
        } else {
          this.disableDHT()
        }
      }),
    )

    // UPnP - call private methods directly (the public setUPnPEnabled was removed)
    this.configUnsubscribers.push(
      this.config.upnpEnabled.subscribe((enabled) => {
        if (enabled) {
          this.enableUPnP()
        } else {
          this.disableUPnP()
        }
      }),
    )

    // Daemon Rate Limit - inline the logic from the removed setDaemonRateLimit method
    this.configUnsubscribers.push(
      this.config.daemonOpsPerSecond.subscribe((opsPerSec) => {
        const burst = this.config!.daemonOpsBurst.get()
        this.daemonRateLimiter.setLimit(opsPerSec, burst / Math.max(1, opsPerSec))
        this.logger.info(`Daemon rate limit updated: ${opsPerSec} ops/s, burst ${burst}`)
      }),
    )

    this.configUnsubscribers.push(
      this.config.daemonOpsBurst.subscribe((burst) => {
        const opsPerSec = this.config!.daemonOpsPerSecond.get()
        this.daemonRateLimiter.setLimit(opsPerSec, burst / Math.max(1, opsPerSec))
        this.logger.info(`Daemon rate limit updated: ${opsPerSec} ops/s, burst ${burst}`)
      }),
    )

    // Storage Roots
    this.configUnsubscribers.push(
      this.config.storageRoots.subscribe((roots) => {
        this.syncStorageRoots(roots)
      }),
    )

    this.configUnsubscribers.push(
      this.config.defaultRootKey.subscribe((key) => {
        if (key && this.storageRootManager.getRoots().some((r) => r.key === key)) {
          this.storageRootManager.setDefaultRoot(key)
          this.logger.info(`Default storage root updated: ${key}`)
        }
      }),
    )
  }

  /**
   * Sync storage roots from ConfigHub to StorageRootManager.
   * Adds new roots, removes missing roots, preserves torrent mappings.
   */
  private syncStorageRoots(configRoots: StorageRoot[]): void {
    const currentRoots = this.storageRootManager.getRoots()
    const currentKeys = new Set(currentRoots.map((r) => r.key))
    const newKeys = new Set(configRoots.map((r) => r.key))

    // Add new roots
    for (const root of configRoots) {
      if (!currentKeys.has(root.key)) {
        this.storageRootManager.addRoot(root)
        this.logger.info(`Storage root added: ${root.label} (${root.key})`)
      }
    }

    // Remove old roots
    for (const root of currentRoots) {
      if (!newKeys.has(root.key)) {
        this.storageRootManager.removeRoot(root.key)
        this.logger.info(`Storage root removed: ${root.label} (${root.key})`)
      }
    }
  }

  // === Unified Daemon Operation Queue Methods ===

  /**
   * Request daemon operation slots for a torrent.
   * @param infoHashHex - Torrent identifier
   * @param type - Type of operation
   * @param count - Number of slots requested
   */
  requestDaemonOps(infoHashHex: string, _type: DaemonOpType, count: number): void {
    if (count <= 0) return
    const current = this.pendingOps.get(infoHashHex) ?? 0
    this.pendingOps.set(infoHashHex, current + count)
    this.logger.debug(
      `[OpQueue] ${infoHashHex.slice(0, 8)} +${count} (pending: ${current + count})`,
    )
  }

  /**
   * Cancel all pending operations for a torrent.
   * Called when torrent is stopped or removed.
   * @param infoHashHex - Torrent identifier
   */
  cancelDaemonOps(infoHashHex: string): void {
    const pending = this.pendingOps.get(infoHashHex)
    if (pending && pending > 0) {
      this.pendingOps.delete(infoHashHex)
      this.logger.debug(`[OpQueue] ${infoHashHex.slice(0, 8)} cancelled ${pending} pending ops`)
    }
  }

  /**
   * Cancel pending operations of a specific type for a torrent.
   * @param infoHashHex - Torrent identifier
   * @param _type - Type of operation to cancel (currently only tcp_connect)
   */
  cancelDaemonOpsByType(infoHashHex: string, _type: DaemonOpType): void {
    // With single type, this is equivalent to cancelDaemonOps
    this.cancelDaemonOps(infoHashHex)
  }

  // === Legacy Connection Queue API (wrapper around unified queue) ===

  /**
   * Request connection slots for a torrent.
   * @deprecated Use requestDaemonOps(hash, 'tcp_connect', count) instead.
   */
  requestConnections(infoHashHex: string, count: number): void {
    this.requestDaemonOps(infoHashHex, 'tcp_connect', count)
  }

  /**
   * Cancel all pending connection requests for a torrent.
   * @deprecated Use cancelDaemonOps() instead.
   */
  cancelConnectionRequests(infoHashHex: string): void {
    this.cancelDaemonOps(infoHashHex)
  }

  // ==========================================================================
  // ENGINE TICK LOOP
  //
  // SYNC WITH: android/quickjs-engine/.../EngineController.kt (startHostDrivenTick)
  //
  // Both implementations use adaptive timing with similar parameters:
  //
  // - Extension (JS-driven, here): setTimeout with calculateTickDelay()
  //   - MIN_TICK_INTERVAL_MS (1ms) when work pending (bufferedBytes > 0 or activePieces > 0)
  //   - IDLE_TICK_INTERVAL_MS (20ms) when peers connected but idle
  //   - MAX_TICK_INTERVAL_MS (100ms) when active torrents but no peers
  //   - DORMANT_TICK_INTERVAL_MS (1000ms) when no active torrents (save CPU)
  //
  // - Android (host-driven, EngineController.kt): postDelayed with delay hints from JS
  //   - MIN_TICK_INTERVAL_MS (1ms) when work pending
  //   - IDLE_DELAY_MS (20ms) when idle
  //   - Proportional delay when hasher backed up (pendingHashes * 0.4, max 100ms)
  //   - (TODO: Android should also add dormant mode for parity)
  //
  // Both call the same doTick()/tick() which delegates to TorrentTickLoop:
  // 1. GATHER - drain TCP buffers from all peers
  // 2. PROCESS - piece health cleanup (timeout stale requests)
  // 3. REQUEST - fill peer request pipelines
  // 4. OUTPUT - flush all pending sends
  //
  // If you change timing or tick behavior here, consider whether
  // EngineController.kt needs the same change for Android parity.
  // ==========================================================================

  /**
   * Start the unified engine tick loop with adaptive timing.
   * Uses setTimeout (not setInterval) to adjust delay based on workload:
   * - MIN_TICK_INTERVAL_MS (1ms) when work is pending (near-continuous)
   * - IDLE_TICK_INTERVAL_MS (20ms) when idle
   * - MAX_TICK_INTERVAL_MS (100ms) under backpressure
   *
   * Only starts if tickMode is 'js'. In 'host' mode, host calls tick() directly.
   */
  private startEngineTick(): void {
    if (this.engineTickTimeout) return
    if (this._tickMode === 'host') {
      this.logger.info('Tick mode: host-driven (JS timeout disabled)')
      return
    }

    const scheduleNextTick = (delayMs: number): void => {
      if (this._tickMode !== 'js') return

      this.engineTickTimeout = setTimeout(() => {
        const result = this.doTick()
        const nextDelay = this.calculateTickDelay(result)
        scheduleNextTick(nextDelay)
      }, delayMs)
    }

    // Start with minimum delay
    scheduleNextTick(BtEngine.MIN_TICK_INTERVAL_MS)
    this.logger.info(
      `Tick mode: js-driven adaptive (${BtEngine.MIN_TICK_INTERVAL_MS}-${BtEngine.MAX_TICK_INTERVAL_MS}ms)`,
    )
  }

  /**
   * Calculate delay until next tick based on current state.
   * Returns shorter delays when there's work to do, longer when idle.
   *
   * Timing hierarchy:
   * - 1ms: buffered data or active pieces (work pending)
   * - 20ms: peers connected but no immediate work
   * - 100ms: active torrents but no peers yet
   * - 1000ms: no active torrents (dormant - save CPU)
   */
  private calculateTickDelay(result: EngineTickResult): number {
    // If there's buffered data or active pieces, tick quickly
    if (result.bufferedBytes > 0 || result.activePieces > 0) {
      return BtEngine.MIN_TICK_INTERVAL_MS
    }

    // If we have connected peers but no active work, use idle interval
    if (result.connectedPeers > 0) {
      return BtEngine.IDLE_TICK_INTERVAL_MS
    }

    // Check if any torrents are active or if there are pending connection ops
    const hasActiveTorrents = this.torrents.some((t) => t.isActive)
    const hasPendingOps = this.pendingOps.size > 0

    if (hasActiveTorrents || hasPendingOps) {
      // Active torrents but no peers yet - use max interval
      return BtEngine.MAX_TICK_INTERVAL_MS
    }

    // No active torrents, no pending work - use dormant interval (save CPU)
    return BtEngine.DORMANT_TICK_INTERVAL_MS
  }

  /**
   * Stop the unified engine tick loop.
   */
  private stopEngineTick(): void {
    if (this.engineTickTimeout) {
      clearTimeout(this.engineTickTimeout)
      this.engineTickTimeout = null
    }
  }

  /**
   * Set tick loop mode at runtime.
   * - 'js': Engine manages its own tick via setInterval
   * - 'host': External caller (Kotlin/Swift) drives tick() directly
   *
   * When switching to 'host' mode, stops the JS interval.
   * When switching to 'js' mode, starts the JS interval.
   */
  setTickMode(mode: 'js' | 'host'): void {
    if (mode === this._tickMode) return

    this._tickMode = mode
    if (mode === 'host') {
      this.stopEngineTick()
      this.logger.info('Tick mode changed to: host-driven')
    } else {
      this.startEngineTick()
      this.logger.info('Tick mode changed to: js-driven')
    }
  }

  /**
   * Get current tick mode.
   */
  get tickMode(): 'js' | 'host' {
    return this._tickMode
  }

  /**
   * Execute one tick. Called by host in 'host' mode, or by setInterval in 'js' mode.
   * Returns aggregated tick result for instrumentation.
   */
  tick(): EngineTickResult {
    return this.doTick()
  }

  /**
   * Internal tick implementation.
   * Unified engine tick: combines connection slot allocation with per-torrent processing.
   * Called at 100ms intervals for predictable timing across all torrents.
   * Returns aggregated result across all torrents.
   */
  private doTick(): EngineTickResult {
    // Guard against tick callbacks firing during async destroy
    if (this._destroyed) {
      return {
        blocksRecv: 0,
        blocksSent: 0,
        elapsedMs: 0,
        activePieces: 0,
        connectedPeers: 0,
        bufferedBytes: 0,
        pipelineFilled: 0,
        pipelineMax: 0,
        pendingHashes: 0,
        pendingDiskWrites: 0,
      }
    }

    const startTime = Date.now()

    // Phase 3+4: Flush accumulated callbacks from native I/O threads.
    // This drains all pending data in a single FFI call per type, reducing boundary crossings
    // from 60+ per tick to 1-2. Only available on native (Android) - no-op on extension.
    this.socketFactory.flushCallbacks?.()

    // 0. Check backpressure before processing (Phase 2)
    this.checkBackpressure()

    // 1. Connection slot allocation (existing drainOpQueue logic)
    this.drainOpQueue()

    // 2. Torrent data processing - tick all network-active torrents
    // Aggregate results across all torrents
    let blocksRecv = 0
    let blocksSent = 0
    let activePieces = 0
    let connectedPeers = 0
    let bufferedBytes = 0
    let pipelineFilled = 0
    let pipelineMax = 0

    for (const torrent of this.torrents) {
      if (torrent.isActive) {
        const result = torrent.tick()
        if (result) {
          blocksRecv += result.blocksRecv
          blocksSent += result.blocksSent
          activePieces += result.activePieces
          connectedPeers += result.connectedPeers
          bufferedBytes += result.bufferedBytes
          pipelineFilled += result.pipelineFilled
          pipelineMax += result.pipelineMax
        }
      }
    }

    // 3. Queue management - check if recalculation needed
    this.queueManager?.tickCheck()

    // 4. End of tick - flush batched operations (e.g., verified writes on native)
    this.onEndOfTickCallback?.()

    const elapsedMs = Date.now() - startTime

    // Return aggregated result - pendingHashes/pendingDiskWrites filled by controller
    return {
      blocksRecv,
      blocksSent,
      elapsedMs,
      activePieces,
      connectedPeers,
      bufferedBytes,
      pipelineFilled,
      pipelineMax,
      pendingHashes: 0, // Filled by native controller
      pendingDiskWrites: 0, // Filled by native controller
    }
  }

  /**
   * Get total buffered bytes across all peer connections.
   * Used for backpressure detection - when too much data is buffered,
   * native reads are paused to prevent unbounded memory growth.
   */
  private getTotalBufferedBytes(): number {
    if (this._destroyed) return 0
    let total = 0
    for (const torrent of this.torrents) {
      // Guard: peers may be undefined if torrent is being destroyed
      const peers = torrent.peers
      if (!peers) continue
      for (const peer of peers) {
        total += peer.bufferedBytes
      }
    }
    return total
  }

  /**
   * Check if backpressure should be activated or released.
   * Uses hysteresis to prevent thrashing:
   * - Activate when buffered > HIGH_WATER (16MB)
   * - Release when buffered < LOW_WATER (4MB)
   */
  private checkBackpressure(): void {
    const buffered = this.getTotalBufferedBytes()
    const writeQueueStats = this.getWriteQueueStatsCallback?.()
    const writeQueueBytes = writeQueueStats?.totalBytes ?? 0
    const writeQueueHigh = this.writeQueueBackpressureHighWater
    const writeQueueLow = this.writeQueueBackpressureLowWater ?? writeQueueHigh

    if (
      writeQueueHigh !== undefined &&
      writeQueueLow !== undefined &&
      !this.writeQueueBackpressureActive &&
      writeQueueBytes > writeQueueHigh
    ) {
      this.writeQueueBackpressureActive = true
      this.logger.warn(
        `Write queue backpressure ON: ${(writeQueueBytes / 1024 / 1024).toFixed(1)}MB queued ` +
          `(${writeQueueStats?.pendingWrites ?? 0} pending, ${writeQueueStats?.inFlightWrites ?? 0} in-flight)`,
      )
    } else if (
      this.writeQueueBackpressureActive &&
      (writeQueueHigh === undefined ||
        writeQueueLow === undefined ||
        writeQueueBytes < writeQueueLow)
    ) {
      this.writeQueueBackpressureActive = false
      this.logger.info(
        `Write queue backpressure OFF: ${(writeQueueBytes / 1024 / 1024).toFixed(1)}MB queued`,
      )
    }

    const shouldPauseReads =
      buffered > BtEngine.BACKPRESSURE_HIGH_WATER || this.writeQueueBackpressureActive
    const shouldResumeReads =
      buffered < BtEngine.BACKPRESSURE_LOW_WATER && !this.writeQueueBackpressureActive

    if (!this.backpressureActive && shouldPauseReads) {
      this.backpressureActive = true
      this.socketFactory.setBackpressure?.(true)
      const reasons: string[] = []
      if (buffered > BtEngine.BACKPRESSURE_HIGH_WATER) {
        reasons.push(`${(buffered / 1024 / 1024).toFixed(1)}MB peer buffered`)
      }
      if (this.writeQueueBackpressureActive) {
        reasons.push(`${(writeQueueBytes / 1024 / 1024).toFixed(1)}MB write queued`)
      }
      this.logger.warn(`Backpressure ON: ${reasons.join(', ')}`)
    } else if (this.backpressureActive && shouldResumeReads) {
      this.backpressureActive = false
      this.socketFactory.setBackpressure?.(false)
      this.logger.info(
        `Backpressure OFF: ${(buffered / 1024 / 1024).toFixed(1)}MB peer buffered, ` +
          `${(writeQueueBytes / 1024 / 1024).toFixed(1)}MB write queued`,
      )
    }
  }

  /**
   * Drain operation queue with round-robin fairness.
   * Grants one connection slot per call, rate limited.
   */
  private drainOpQueue(): void {
    // Early exit if no pending ops (avoid any allocations)
    if (this.pendingOps.size === 0) return

    // Check global connection limit
    if (this.numConnections >= this.maxConnections) return

    // Check rate limit
    if (!this.daemonRateLimiter.tryConsume(1)) return

    // Get hashes for round-robin iteration
    const hashes = Array.from(this.pendingOps.keys())
    const numTorrents = hashes.length

    // Round-robin: try each torrent starting from last position
    for (let i = 0; i < numTorrents; i++) {
      const idx = (this.opDrainIndex + i) % numTorrents
      const hash = hashes[idx]
      const pending = this.pendingOps.get(hash)

      if (!pending || pending <= 0) {
        this.pendingOps.delete(hash)
        continue
      }

      const torrent = this.getTorrent(hash)
      if (!torrent || !torrent.isActive) {
        this.pendingOps.delete(hash)
        continue
      }

      // Grant slot - torrent tries to connect one peer
      if (torrent.useConnectionSlot()) {
        // Decrement pending count
        const newPending = pending - 1
        if (newPending <= 0) {
          this.pendingOps.delete(hash)
        } else {
          this.pendingOps.set(hash, newPending)
        }

        // Advance round-robin for next call
        this.opDrainIndex = (idx + 1) % numTorrents
        return
      } else {
        // Torrent couldn't use slot, clear its pending ops
        this.pendingOps.delete(hash)
      }
    }
  }

  /**
   * Get operation queue stats for debugging.
   */
  /**
   * Get connection queue stats for debugging.
   */
  getConnectionQueueStats(): {
    pendingByTorrent: Record<string, number>
    totalPending: number
    rateLimiterAvailable: number
  } {
    const pendingByTorrent: Record<string, number> = {}
    let totalPending = 0

    for (const [hash, count] of this.pendingOps) {
      pendingByTorrent[hash.slice(0, 8)] = count
      totalPending += count
    }

    return {
      pendingByTorrent,
      totalPending,
      rateLimiterAvailable: this.daemonRateLimiter.available,
    }
  }

  // === UPnP Methods ===

  /**
   * Get the current UPnP status.
   */
  get upnpStatus(): UPnPStatus {
    return this._upnpStatus
  }

  private setUpnpStatus(status: UPnPStatus): void {
    if (this._upnpStatus === status) return
    this._upnpStatus = status
    this.emit('upnpStatusChanged', status)
  }

  /**
   * Whether we've ever received a successful incoming connection this session.
   * Useful for verifying port forwarding is working.
   */
  get hasReceivedIncomingConnection(): boolean {
    return this._hasReceivedIncomingConnection
  }

  /**
   * Get the external IP address discovered via UPnP.
   * Returns null if UPnP is not enabled or discovery failed.
   */
  get upnpExternalIP(): string | null {
    return this.portMappingManager?.externalIP ?? null
  }

  private async enableUPnP(): Promise<void> {
    if (this._upnpStatus !== 'disabled') {
      // Already enabled or in progress
      return
    }

    if (!this.getNetworkInterfaces) {
      this.logger.warn('UPnP: Cannot enable - no getNetworkInterfaces function provided')
      this.setUpnpStatus('failed')
      return
    }

    this.setUpnpStatus('discovering')
    this.logger.info('UPnP: Discovering gateway...')

    this.portMappingManager = new PortMappingManager(
      this.socketFactory,
      this.getNetworkInterfaces,
      this.logger,
    )

    const discovered = await this.portMappingManager.discover()
    if (!discovered) {
      this.setUpnpStatus('unavailable')
      this.logger.info('UPnP: No gateway found')
      return
    }

    const tcpMapped = await this.portMappingManager.addMapping(this.port, 'TCP')
    const udpMapped = await this.portMappingManager.addMapping(this.port + 1, 'UDP') // For DHT

    if (tcpMapped) {
      this.setUpnpStatus('mapped')
      this.logger.info(
        `UPnP: Mapped TCP port ${this.port}${udpMapped ? ` and UDP port ${this.port + 1}` : ''}, external IP: ${this.portMappingManager.externalIP}`,
      )
    } else {
      this.setUpnpStatus('failed')
      this.logger.warn(`UPnP: Failed to map port ${this.port}`)
    }
  }

  private async disableUPnP(): Promise<void> {
    if (this._upnpStatus === 'disabled') {
      return
    }

    if (this.portMappingManager) {
      await this.portMappingManager.cleanup()
      this.portMappingManager = undefined
    }

    this.setUpnpStatus('disabled')
    this.logger.info('UPnP: Disabled')
  }

  // === DHT Methods ===

  /**
   * Get whether DHT is enabled.
   */
  get dhtEnabled(): boolean {
    return this._dhtEnabled
  }

  /**
   * Get the DHT node instance (if enabled and started).
   */
  get dhtNode(): DHTNode | undefined {
    return this._dhtNode
  }

  /**
   * Start the DHT node.
   * Loads persisted state (node ID, routing table) if available.
   */
  private async enableDHT(): Promise<void> {
    if (this._dhtNode) {
      // Already enabled
      return
    }

    this.logger.info('DHT: Starting...')
    this._dhtEnabled = true

    // Try to load persisted state
    const sessionStore = this.sessionPersistence.store
    const persistedState = await loadDHTState(sessionStore)

    // Create DHT node with persisted node ID or generate new one
    const nodeId = persistedState ? hexToNodeId(persistedState.nodeId) : undefined

    // Create a scoped logger for DHT
    const dhtLoggable = {
      getLogName: () => 'dht',
      getStaticLogName: () => 'dht',
      engineInstance: this as ILoggingEngine,
    }
    const dhtLogger = this.scopedLoggerFor(dhtLoggable)

    // Retry logic for port binding failures (e.g., after quick reconnect)
    const maxRetries = 5
    const delays = [1000, 2000, 3000, 4000, 5000]

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      this._dhtNode = new DHTNode({
        nodeId,
        socketFactory: this.socketFactory,
        krpcOptions: { bindPort: this.port === 0 ? 0 : this.port + 1 }, // DHT uses port+1 or auto-assign if engine port is 0
        logger: dhtLogger,
        bandwidthTracker: this.bandwidthTracker,
      })

      try {
        await this._dhtNode.start()
        break // Success
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        const isBindingError = errMsg.includes('status 1')

        if (isBindingError && attempt < maxRetries - 1) {
          this.logger.warn(`DHT: Port binding failed, retrying in ${delays[attempt]}ms...`)
          this._dhtNode = undefined
          await new Promise((r) => setTimeout(r, delays[attempt]))
          continue
        }
        // Final failure - cleanup and throw
        this.logger.error(`DHT: Failed to start: ${errMsg}`)
        this._dhtNode = undefined
        this._dhtEnabled = false
        throw err
      }
    }

    // TypeScript can't infer that the loop either succeeds or throws
    const dhtNode = this._dhtNode!

    // Restore routing table from persisted state
    if (persistedState && persistedState.nodes.length > 0) {
      this.logger.info(`DHT: Restoring ${persistedState.nodes.length} nodes from session`)
      for (const node of persistedState.nodes) {
        dhtNode.addNode({
          id: hexToNodeId(node.id),
          host: node.host,
          port: node.port,
          lastSeen: node.lastSeen,
        })
      }
    }

    // Bootstrap if routing table is empty or small (skip for tests)
    if (!this._skipDHTBootstrap && dhtNode.getNodeCount() < 10) {
      this.logger.info('DHT: Bootstrapping...')
      const stats = await dhtNode.bootstrap()
      this.logger.info(`DHT: Bootstrap complete - ${stats.routingTableSize} nodes in routing table`)
    }

    this.logger.info(`DHT: Started with node ID ${dhtNode.nodeIdHex}`)

    // Notify all active torrents that DHT is ready
    // This handles the race condition where torrents start before DHT
    for (const torrent of this.torrents) {
      torrent.onDHTReady()
    }
  }

  /**
   * Stop the DHT node and save state for persistence.
   */
  private async disableDHT(): Promise<void> {
    if (!this._dhtNode) {
      this._dhtEnabled = false
      return
    }

    this.logger.info('DHT: Stopping...')

    // Save state before stopping
    const sessionStore = this.sessionPersistence.store
    const state = this._dhtNode.getState()
    await saveDHTState(sessionStore, state)
    this.logger.info(`DHT: Saved ${state.nodes.length} nodes to session`)

    this._dhtNode.stop()
    this._dhtNode = undefined
    this._dhtEnabled = false
    this.logger.info('DHT: Stopped')
  }

  /**
   * Save DHT state (called periodically or before shutdown).
   */
  async saveDHTState(): Promise<void> {
    if (!this._dhtNode) return

    const sessionStore = this.sessionPersistence.store
    const state = this._dhtNode.getState()
    await saveDHTState(sessionStore, state)
  }
}
