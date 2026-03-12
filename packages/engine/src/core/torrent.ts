import { DEFAULT_MAX_PIPELINE_DEPTH } from '../config/config-schema'
import { PeerConnection } from './peer-connection'
import { ActivePiece, BLOCK_SIZE } from './active-piece'
import type { ChunkedBuffer } from './chunked-buffer'
import { PeerCoordinator } from './peer-coordinator'
import { ActivePieceManager } from './active-piece-manager'
import { TorrentContentStorage } from './torrent-content-storage'
// HashMismatchError is checked by name (not instanceof) to support both
// daemon-file-handle and native-file-handle error classes
import { BitField } from '../utils/bitfield'
import { MessageType, WireMessage } from '../protocol/wire-protocol'
import { toHex, toString, compare } from '../utils/buffer'
import { InfoHashHex, infoHashFromBytes } from '../utils/infohash'
import { Bencode } from '../utils/bencode'
import { TrackerManager } from '../tracker/tracker-manager'
import { ISocketFactory } from '../interfaces/socket'
import { AnnounceStats, PeerInfo, TrackerStats } from '../interfaces/tracker'
import { TorrentFileInfo } from './torrent-file-info'
import { EngineComponent } from '../logging/logger'
import type { BtEngine } from './bt-engine'
import { TorrentUserState, TorrentActivityState, computeActivityState } from './torrent-state'
import {
  Swarm,
  SwarmStats,
  SwarmPeer,
  detectAddressFamily,
  peerKey,
  addressKey,
  PeerAddress,
} from './swarm'
import { ConnectionManager } from './connection-manager'
import type { EncryptionPolicy } from '../crypto'
import { randomBytes } from '../utils/hash'
import { ConnectionTimingTracker } from './connection-timing'
import { initializeTorrentStorage } from './torrent-initializer'
import { TorrentDiskQueue, PassthroughDiskQueue, DiskQueueSnapshot, IDiskQueue } from './disk-queue'
import { EndgameManager } from './endgame-manager'
import { PartsFile } from './parts-file'
import type { LookupResult } from '../dht'
import { CorruptionTracker, BanDecision } from './corruption-tracker'
import { TorrentPeerHandler, PeerHandlerCallbacks } from './torrent-peer-handler'
import {
  TorrentTickLoop,
  TickLoopCallbacks,
  TickStats,
  TickResult,
  CLEANUP_TICK_INTERVAL,
  BLOCK_REQUEST_TIMEOUT_MS,
} from './torrent-tick-loop'
import { MetadataFetcher } from './metadata-fetcher'
import { TorrentUploader } from './torrent-uploader'
import { FilePriorityManager, PieceClassification } from './file-priority-manager'
import { PieceAvailability } from './piece-availability'
import { TorrentPieceRequester, PieceRequesterDeps } from './piece-requester'
import {
  StreamingScheduler,
  type ActivePieceSnapshot,
  type StreamingDemandUrgency,
} from './streaming-scheduler'
import { WriteError, classifyError, getRetryDelay } from './write-error'
import { VerifyChunkResult } from '../interfaces/filesystem'
import type { VerifyChunksRequest, IFileSystem } from '../interfaces/filesystem'
import { WebSeedHttpClient } from '../webseed/web-seed-http-client'
import { WebSeedManager } from '../webseed/web-seed-manager'

/**
 * Maximum ratio of peer slots that incoming connections can occupy.
 * This prevents incoming connections from filling all slots, ensuring
 * we always have capacity to initiate outgoing connections to better peers.
 */
export const MAX_INCOMING_RATIO = 0.6

// Re-export tick loop constants for consumers
export { CLEANUP_TICK_INTERVAL, BLOCK_REQUEST_TIMEOUT_MS }
export type { TickStats }

// PieceClassification is imported from './file-priority-manager'
// Re-export for consumers
export type { PieceClassification } from './file-priority-manager'

/**
 * All persisted fields for a torrent.
 * Adding a new persisted field = add to this interface + add getter/setter in Torrent.
 */
export interface TorrentPersistedState {
  // === Origin (at least one set) ===
  magnetLink?: string // Original magnet URI
  torrentFileBase64?: string // Base64-encoded .torrent file

  // Info dict - for magnet, fetched from peers
  // For .torrent, can extract from torrentFile but cache here
  infoBuffer?: Uint8Array

  // === Timestamps ===
  addedAt: number
  completedAt?: number

  // === User Intent ===
  userState: TorrentUserState
  queuePosition?: number
  forceActive?: boolean // Bypasses queue limits when true

  // === Stats ===
  totalDownloaded: number
  totalUploaded: number

  // === Progress ===
  completedPieces: number[] // Indices of verified pieces

  // === File Priorities ===
  filePriorities?: number[] // Per-file priority: 0=normal, 1=skip
}

/**
 * Unified peer representation for UI display.
 * Can represent either a connected peer (with full PeerConnection) or a connecting peer.
 */
export interface DisplayPeer {
  /** Unique key: "ip:port" or "[ipv6]:port" */
  key: string
  /** Remote IP address */
  ip: string
  /** Remote port */
  port: number
  /** Connection state */
  state: 'connecting' | 'connected'
  /** Full connection (only for connected peers) */
  connection: PeerConnection | null
  /** Swarm peer data (available for both states) */
  swarmPeer: SwarmPeer | null
}

interface PieceFileSpan {
  fileIndex: number
  fileOffset: number
  length: number
  pieceOffset: number
  skipped: boolean
}

/**
 * Create default persisted state for new torrents.
 */
export function createDefaultPersistedState(): TorrentPersistedState {
  return {
    addedAt: Date.now(),
    userState: 'active',
    totalDownloaded: 0,
    totalUploaded: 0,
    completedPieces: [],
  }
}

export class Torrent extends EngineComponent {
  static logName = 'torrent'

  private btEngine: BtEngine
  private _swarm: Swarm // Single source of truth for peer state
  private _corruptionTracker: CorruptionTracker = new CorruptionTracker()
  private _connectionManager: ConnectionManager // Handles outgoing connection lifecycle
  private connectionTiming: ConnectionTimingTracker // Tracks connection timing for adaptive timeouts
  private _peerCoordinator: PeerCoordinator // Coordinates choke/unchoke and peer dropping decisions
  declare public infoHash: Uint8Array
  declare public peerId: Uint8Array
  public socketFactory: ISocketFactory
  public port: number
  private activePieces?: ActivePieceManager

  // Piece info (moved from PieceManager)
  public pieceHashes: Uint8Array[] = []
  public pieceLength: number = 0
  public lastPieceLength: number = 0
  public piecesCount: number = 0
  private _contentStorage?: TorrentContentStorage
  private _diskQueue: IDiskQueue

  /** Content storage for reading/writing piece data */
  get contentStorage(): TorrentContentStorage | undefined {
    return this._contentStorage
  }
  set contentStorage(storage: TorrentContentStorage | undefined) {
    this._contentStorage = storage
    // Update uploader with new storage
    this._uploader?.setContentStorage(storage ?? null)
  }
  private _endgameManager: EndgameManager = new EndgameManager()

  /** Tracks write retry attempts per piece index for transient errors */
  private _writeRetryCount: Map<number, number> = new Map()

  private _bitfield?: BitField
  /** Optimization: track the first piece index we still need (for sequential mode) */
  private _firstNeededPiece: number = 0
  public announce: string[] = []
  public trackerManager?: TrackerManager
  private _files: TorrentFileInfo[] = []
  public maxPeers: number = 20

  // === File Priority System ===
  // File priorities and piece classification are managed by FilePriorityManager
  /** Piece availability tracking for rarest-first selection */
  private _availability: PieceAvailability = new PieceAvailability()
  /** Pieces currently stored in .parts file (not in regular files) */
  private _partsFilePieces: Set<number> = new Set()
  /** .parts file manager for boundary pieces */
  private _partsFile?: PartsFile
  private maxUploadSlots: number = 4

  // Metadata fetcher (BEP 9)
  private _metadataFetcher!: MetadataFetcher

  // Uploader for rate-limited piece uploads
  private _uploader!: TorrentUploader

  // File priority manager
  private _filePriorityManager!: FilePriorityManager
  private _streamingScheduler: StreamingScheduler = new StreamingScheduler()
  private _streamingFileLocks: Map<string, number> = new Map()
  private _filePriorityUpdateLock: Promise<void> | null = null

  // Piece requester (handles piece selection and requesting)
  private _pieceRequester?: TorrentPieceRequester

  // Web-seed manager (BEP 19 url-list / magnet ws)
  private _webSeedManager?: WebSeedManager

  // Peer event handler (handles wire protocol events)
  private _peerHandler!: TorrentPeerHandler

  // Download rate limit retry scheduling
  private downloadRateLimitRetryScheduled = false

  // Round-robin index for fair peer request scheduling
  private _peerRequestRoundRobin = 0

  /**
   * The raw info dictionary buffer (verified via SHA1 against infoHash).
   * This is the bencoded "info" dictionary from the .torrent file.
   * Available for session persistence.
   */
  get metadataRaw(): Uint8Array | null {
    return this._metadataFetcher?.buffer ?? null
  }

  /** Expected total metadata size (from peers or .torrent file) */
  get metadataSize(): number | null {
    return this._metadataFetcher?.metadataSize ?? null
  }

  /** Whether we have verified complete metadata */
  get metadataComplete(): boolean {
    return this._metadataFetcher?.isComplete ?? false
  }

  // Cached parsed info dictionary (to avoid repeated bencode parsing)
  private _cachedInfoDict?: Record<string, unknown>

  /**
   * Precomputed identifier for MSE incoming connection routing.
   * This is SHA1('req2' + infoHash) per the MSE/PE specification.
   * Allows O(1) lookup to match incoming encrypted connections to this torrent.
   */
  private _mseIdentifier: Uint8Array | null = null

  get mseIdentifier(): Uint8Array | null {
    return this._mseIdentifier
  }

  setMseIdentifier(id: Uint8Array): void {
    this._mseIdentifier = id
  }

  /**
   * The parsed info dictionary (decoded from metadataRaw).
   * This is the official BitTorrent "info dict" containing name, piece hashes, files, etc.
   * Lazily parsed and cached to avoid repeated bencode decoding.
   */
  get infoDict(): Record<string, unknown> | undefined {
    if (this._cachedInfoDict) return this._cachedInfoDict

    const metadataRaw = this.metadataRaw
    if (metadataRaw) {
      try {
        this._cachedInfoDict = Bencode.decode(metadataRaw) as Record<string, unknown>
        return this._cachedInfoDict
      } catch {
        // Ignore decode errors
      }
    }
    return undefined
  }

  // Magnet display name (dn parameter) - fallback when info dict isn't available yet
  public _magnetDisplayName?: string

  /**
   * Peer hints from magnet link (x.pe parameter).
   * These are added to the swarm every time the torrent starts.
   */
  public magnetPeerHints: PeerAddress[] = []

  /**
   * Web seeds from magnet `ws` parameters.
   * Stored even before metadata is available so they can be activated later.
   */
  public magnetUrlSeeds: string[] = []

  /**
   * Web seeds from `.torrent` top-level `url-list`.
   * Only available when the torrent originated from a `.torrent` file.
   */
  public metadataUrlSeeds: string[] = []

  /**
   * All known web-seed URLs for this torrent, deduplicated with `.torrent`
   * metadata sources preferred before magnet hints.
   */
  get webSeedUrls(): string[] {
    const merged = new Set<string>()
    for (const url of this.metadataUrlSeeds) merged.add(url)
    for (const url of this.magnetUrlSeeds) merged.add(url)
    return Array.from(merged)
  }

  // === Centralized persisted state ===
  private _persisted: TorrentPersistedState = createDefaultPersistedState()

  // === Persisted state getters ===
  get totalDownloaded(): number {
    return this._persisted.totalDownloaded
  }
  set totalDownloaded(value: number) {
    this._persisted.totalDownloaded = value
  }

  get totalUploaded(): number {
    return this._persisted.totalUploaded
  }
  set totalUploaded(value: number) {
    this._persisted.totalUploaded = value
  }

  get userState(): TorrentUserState {
    return this._persisted.userState
  }
  set userState(value: TorrentUserState) {
    this._persisted.userState = value
  }

  get queuePosition(): number | undefined {
    return this._persisted.queuePosition
  }
  set queuePosition(value: number | undefined) {
    this._persisted.queuePosition = value
  }

  get forceActive(): boolean {
    return this._persisted.forceActive ?? false
  }
  set forceActive(value: boolean) {
    this._persisted.forceActive = value
  }

  get addedAt(): number {
    return this._persisted.addedAt
  }
  set addedAt(value: number) {
    this._persisted.addedAt = value
  }

  get completedAt(): number | undefined {
    return this._persisted.completedAt
  }
  set completedAt(value: number | undefined) {
    this._persisted.completedAt = value
  }

  get magnetLink(): string | undefined {
    return this._persisted.magnetLink
  }
  set magnetLink(value: string | undefined) {
    this._persisted.magnetLink = value
  }

  get torrentFileBase64(): string | undefined {
    return this._persisted.torrentFileBase64
  }
  set torrentFileBase64(value: string | undefined) {
    this._persisted.torrentFileBase64 = value
  }

  /**
   * Whether the torrent is currently checking data.
   */
  private _isChecking: boolean = false

  /**
   * Progress of data checking (0-1).
   */
  private _checkingProgress: number = 0

  /**
   * Whether this torrent needs a full data check before starting networking.
   * Set by verifyResumeData() when files don't match the persisted bitfield.
   */
  private _needsDataCheck: boolean = false

  /**
   * Current error message if any.
   */
  public errorMessage?: string

  /**
   * Get the disk queue for this torrent.
   * Used by TorrentContentStorage to queue disk operations.
   */
  get diskQueue(): IDiskQueue {
    return this._diskQueue
  }

  /**
   * Get disk queue snapshot for UI display.
   */
  getDiskQueueSnapshot(): DiskQueueSnapshot {
    return this._diskQueue.getSnapshot()
  }

  /**
   * Get tracker stats for UI display.
   */
  getTrackerStats(): TrackerStats[] {
    return this.trackerManager?.getTrackerStats() ?? []
  }

  /**
   * Whether network is currently active for this torrent.
   */
  private _networkActive: boolean = false

  /** Graceful stop: draining in-flight requests before stopping network */
  private _gracefulStopping = false
  private _gracefulStopTimer: ReturnType<typeof setTimeout> | null = null

  /** DHT lookup timer - periodically queries DHT for peers */
  private _dhtLookupTimer: ReturnType<typeof setTimeout> | null = null

  /** Tick loop for request scheduling and maintenance */
  private _tickLoop!: TorrentTickLoop

  public isPrivate: boolean = false
  public creationDate?: number
  public comment?: string
  public createdBy?: string

  // We need to re-implement EventEmitter methods if we don't extend it.
  // Or I can modify EngineComponent to extend EventEmitter.
  // Let's modify EngineComponent first.

  constructor(
    engine: BtEngine,
    infoHash: Uint8Array,
    peerId: Uint8Array,
    socketFactory: ISocketFactory,
    port: number,
    contentStorage?: TorrentContentStorage,
    announce: string[] = [],
    maxPeers: number = 20,
    maxUploadSlots: number = 4,
    encryptionPolicy: EncryptionPolicy = 'disabled',
    usePassthroughDiskQueue: boolean = false,
  ) {
    super(engine)
    this.btEngine = engine
    this.infoHash = infoHash
    this.peerId = peerId
    this.socketFactory = socketFactory
    this.port = port
    this.contentStorage = contentStorage
    this.announce = announce
    this.maxPeers = maxPeers
    this.maxUploadSlots = maxUploadSlots

    // Initialize disk queue:
    // - PassthroughDiskQueue for Android/QuickJS (batching happens in NativeBatchingDiskQueue)
    // - TorrentDiskQueue for extension/daemon (worker pool limits concurrent HTTP requests)
    this._diskQueue = usePassthroughDiskQueue ? new PassthroughDiskQueue() : new TorrentDiskQueue()

    this.instanceLogName = `t:${toHex(infoHash).slice(0, 6)}`

    // Initialize connection timing tracker for adaptive timeouts
    this.connectionTiming = new ConnectionTimingTracker()

    // Initialize swarm for unified peer tracking
    this._swarm = new Swarm(this.logger)

    // Initialize connection manager with config based on maxPeers
    this._connectionManager = new ConnectionManager(
      this._swarm,
      this.socketFactory,
      this.engineInstance,
      this.logger,
      {
        maxPeersPerTorrent: this.maxPeers,
        connectTimeout: 10000, // 10 second internal timeout
        encryptionPolicy, // MSE/PE encryption policy
      },
    )

    // Set MSE encryption context for the connection manager
    const hasher = this.btEngine.hasher
    this._connectionManager.setEncryptionContext({
      infoHash: this.infoHash,
      sha1Batch: hasher.sha1Batch
        ? (inputs, reason) => hasher.sha1Batch!(inputs, reason)
        : (inputs, reason) => Promise.all(inputs.map((i) => hasher.sha1(i, reason))),
      getRandomBytes: randomBytes,
    })

    // Register callback for when ConnectionManager establishes a connection
    this._connectionManager.setOnPeerConnected((key, peer) => {
      this.handleNewPeerConnection(key, peer)
    })

    // Initialize peer coordinator for BEP 3 choke algorithm
    this._peerCoordinator = new PeerCoordinator(
      { maxUploadSlots: this.maxUploadSlots },
      {}, // Use default download optimizer config
    )

    // Initialize metadata fetcher (BEP 9)
    this._metadataFetcher = new MetadataFetcher({
      engine: this.engineInstance,
      infoHash: this.infoHash,
      sha1: (data: Uint8Array) => this.btEngine.hasher.sha1(data, 'metadata-verify'),
    })
    this._metadataFetcher.on('metadata', (buffer) => {
      this._cachedInfoDict = undefined // Clear cache so infoDict getter re-parses
      this.emit('metadata', buffer)
    })

    // Initialize uploader for rate-limited piece uploads
    this._uploader = new TorrentUploader({
      engine: this.engineInstance,
      infoHash: this.infoHash,
      uploadBucket: this.btEngine.bandwidthTracker.uploadBucket,
      isPeerConnected: (peer) => this.connectedPeers.includes(peer),
      canServePiece: (index) => this.canServePiece(index),
      recordUpload: (bytes) => this.btEngine.bandwidthTracker.record('peer:payload', bytes, 'up'),
    })
    if (this.btEngine.config) {
      this._uploader.setSendBufferWatermark(this.btEngine.config.sendBufferWatermark.get())
    }
    this._uploader.setContentStorage(this.contentStorage ?? null)

    // Initialize file priority manager
    this._filePriorityManager = new FilePriorityManager({
      engine: this.engineInstance,
      infoHash: this.infoHash,
      getPiecesCount: () => this.piecesCount,
      getPieceLength: (index) => this.getPieceLength(index),
      getFiles: () => this.contentStorage?.filesList ?? [],
      hasMetadata: () => this.hasMetadata,
      isFileComplete: (fileIndex) => this.isFileComplete(fileIndex),
      getBitfield: () => this._bitfield,
      onPrioritiesChanged: (filePriorities, _classification) => {
        // Propagate file priorities to contentStorage for filtered writes
        this.contentStorage?.setFilePriorities(filePriorities)
      },
      onBlacklistPieces: (indices) => {
        // Clear blacklisted pieces from active pieces
        if (this.activePieces) {
          let cleared = 0
          for (const index of indices) {
            if (this.activePieces.has(index)) {
              this.activePieces.remove(index)
              cleared++
            }
          }
          if (cleared > 0) {
            this.logger.debug(`Cleared ${cleared} blacklisted active pieces`)
          }
        }
      },
    })

    // Initialize peer event handler
    this._peerHandler = new TorrentPeerHandler(
      this.engineInstance,
      this.createPeerHandlerCallbacks(),
    )

    // Initialize tick loop for maintenance and request scheduling
    this._tickLoop = new TorrentTickLoop(this.engineInstance, this.createTickLoopCallbacks())

    if (this.announce.length > 0) {
      this.initTrackerManager()
    }
  }

  /**
   * Create callbacks for the tick loop.
   * This bridges the TorrentTickLoop back to Torrent methods.
   */
  private createTickLoopCallbacks(): TickLoopCallbacks {
    return {
      // State queries
      isNetworkActive: () => this._networkActive,
      isKillSwitchEnabled: () => this.isKillSwitchEnabled,
      isComplete: () => this.isComplete,
      getMaxPeers: () => this.maxPeers,
      getNumPeers: () => this.numPeers,
      getInfoHashStr: () => this.infoHashStr,

      // Peer access
      getConnectedPeers: () => this.connectedPeers,
      getPeers: () => this.peers,

      // Managers
      getSwarm: () => this._swarm,
      getPeerSelector: () => this._connectionManager.getPeerSelector(),
      getPeerCoordinator: () => this._peerCoordinator,
      getUploader: () => this._uploader,
      getActivePieces: () => this.activePieces,
      getDiskQueue: () => this._diskQueue,
      getWriteQueueStats: () => this.btEngine.getWriteQueueStats(),

      // Bandwidth
      isDownloadRateLimited: () => this.btEngine.bandwidthTracker.isDownloadRateLimited(),
      getCategoryRate: (direction, category) =>
        this.btEngine.bandwidthTracker.getCategoryRate(direction, category),
      getMaxPipelineDepth: () =>
        this.btEngine.config?.maxPipelineDepth.get() ?? DEFAULT_MAX_PIPELINE_DEPTH,

      // Actions
      applyStreamingPlan: () => this.syncStreamingScheduler(),
      requestPieces: (peer, now) => this.requestPieces(peer, now),
      requestConnections: (infoHashStr, count) =>
        this.btEngine.requestConnections(infoHashStr, count),
      fillSendBuffers: (peers) => this._uploader.fillSendBuffers(peers),

      // Event emission
      emitInvariantViolation: (data) => this.emit('test:invariant_violation', data),

      // Batch flush - uses socket factory's batchSend if available (native platforms)
      // Falls back to per-peer flush for sockets without ids (e.g., SOCKS5 wrapped sockets)
      batchFlushPeers: this.socketFactory.batchSend
        ? (peers) => {
            const sends: Array<{ socketId: number; data: Uint8Array }> = []
            for (const peer of peers) {
              const socketId = peer.getSocketId()
              if (socketId === undefined) {
                // Socket doesn't have an id (e.g., SOCKS5 proxy socket)
                // Fall back to per-peer flush
                peer.flush()
                continue
              }
              const data = peer.getQueuedData()
              if (data === null) continue
              sends.push({ socketId, data })
            }
            if (sends.length > 0) {
              this.socketFactory.batchSend!(sends)
            }
          }
        : undefined,
    }
  }

  /**
   * Create callbacks for the peer handler.
   * This bridges the TorrentPeerHandler back to Torrent methods.
   */
  private createPeerHandlerCallbacks(): PeerHandlerCallbacks {
    return {
      // State queries
      isPrivate: () => this.isPrivate,
      isPexEnabled: () => this.btEngine.config?.pexEnabled.get() ?? true,
      isComplete: () => this.isComplete,
      hasMetadata: () => this.hasMetadata,
      getPeerId: () => this.peerId,
      getPiecesCount: () => this.piecesCount,
      getMetadataSize: () => this.metadataSize,
      getAdvertisedBitfield: () => this.getAdvertisedBitfield() ?? null,

      // Managers
      getSwarm: () => this._swarm,
      getAvailability: () => this._availability,
      getMetadataFetcher: () => this._metadataFetcher,
      getActivePieces: () => this.activePieces,
      getUploader: () => this._uploader,
      getBandwidthTracker: () => this.btEngine.bandwidthTracker,

      // Callbacks
      onPeerRemoved: (peer) => this.removePeer(peer),
      onBytesDownloaded: (bytes) => {
        this.totalDownloaded += bytes
        this.emit('download', bytes)
      },
      onBytesUploaded: (bytes) => {
        this.totalUploaded += bytes
      },
      onBlock: (peer, msg) => this.handleBlock(peer, msg),
      onBlockZeroCopy: (peer, pieceIndex, blockOffset, buffer, dataOffset, dataLength) =>
        this.handleBlockZeroCopy(peer, pieceIndex, blockOffset, buffer, dataOffset, dataLength),
      onInterested: (peer) => this.handleInterested(peer),
      buildPeerPieceIndex: (peer) => this.buildPeerPieceIndex(peer),
      updateInterest: (peer) => this.updateInterest(peer),
      shouldAddToIndex: (pieceIndex) => this.shouldAddToIndex(pieceIndex),
      fillPeerSlots: () => this.fillPeerSlots(),
    }
  }

  /**
   * Start network activity for this torrent.
   * Single source of truth for activating networking (trackers, DHT, maintenance).
   * Idempotent - safe to call multiple times.
   */
  async start() {
    // Cancel graceful stop if being re-promoted to active
    if (this._gracefulStopping) {
      this._cancelGracefulStop()
    }

    // Idempotent - already active
    if (this._networkActive) return

    // Recheck in progress — the caller that initiated the check will activate
    // networking when it completes. Without this guard, the queue manager's
    // periodic re-evaluation sees !isActive and calls start() again, which
    // skips the (already-cleared) _needsDataCheck and sets _networkActive=true
    // while pieces are still being hashed.
    if (this._isChecking) return

    if (this.btEngine.isSuspended) {
      this.logger.debug('Engine suspended, not starting')
      return
    }

    if (this.userState !== 'active') {
      this.logger.debug('User state is not active, not starting')
      return
    }

    if (this.isKillSwitchEnabled) {
      this.logger.debug('Kill switch enabled, not starting')
      return
    }

    // Run initial data check if needed (e.g., files exist but no resume data,
    // or resume data doesn't match files on disk)
    if (this._needsDataCheck) {
      this._needsDataCheck = false
      this._isChecking = true // Show 'checking' activity state while queued
      const qm = (this.engine as BtEngine).queueManager
      if (qm) {
        this.logger.info('Queuing data check before starting')
        qm.requestCheck(this)
        return // Queue manager calls start() again after check completes
      }
      // No queue manager (tests, simple usage) — inline check
      this.logger.info('Running initial data check before starting')
      await this._doCheckPieces()
    }

    this.logger.debug('Starting network')
    this._networkActive = true
    if (this.webSeedUrls.length > 0) {
      this.ensureWebSeedManager().tick()
    }

    // Reset backoff state so we immediately try reconnecting to known peers
    this._swarm.resetBackoffState()

    // Start periodic maintenance (idempotent)
    // Note: Request processing is now handled by BtEngine.engineTick()
    this._tickLoop.startMaintenance()

    // Add magnet peer hints on every start
    if (this.magnetPeerHints.length > 0) {
      this.logger.info(`Adding ${this.magnetPeerHints.length} peer hints from magnet link`)
      this.addPeerHints(this.magnetPeerHints)
    }

    // Load cached peers from previous session (fast reconnection)
    try {
      const persistence = (this.engine as BtEngine).sessionPersistence
      if (persistence) {
        const cached = await persistence.loadPeers(toHex(this.infoHash))
        if (cached.length > 0) {
          const addresses: PeerAddress[] = cached.map((p) => ({
            ip: p.ip,
            port: p.port,
            family: detectAddressFamily(p.ip),
          }))
          const added = this._swarm.addPeers(addresses, 'cache')
          if (added > 0) {
            this.logger.info(`Loaded ${added} cached peers from previous session`)
          }
        }
      }
    } catch (e) {
      this.logger.warn(`Failed to load cached peers: ${e instanceof Error ? e.message : e}`)
    }

    // Start tracker announces
    if (this.trackerManager) {
      this.logger.info('Starting tracker announce')
      await this.trackerManager.announce('started')
    } else if (this.announce.length > 0) {
      // Initialize tracker manager if we have announces but no manager yet
      this.initTrackerManager()
    }

    // Start DHT peer discovery (if enabled and not private)
    if (!this.isPrivate) {
      this.startDHTLookup()
    }
  }

  async connectToPeer(peerInfo: PeerInfo) {
    if (this.isKillSwitchEnabled) return

    const key = peerKey(peerInfo.ip, peerInfo.port)

    // Check if already connected or connecting (swarm is source of truth)
    const existingPeer = this._swarm.getPeerByKey(key)
    if (existingPeer?.state === 'connected' || existingPeer?.state === 'connecting') return

    // Ensure peer exists in swarm before initiating connection
    // (connectToPeer may be called for peers not yet discovered via tracker)
    if (!existingPeer) {
      const family = detectAddressFamily(peerInfo.ip)
      this._swarm.addPeer({ ip: peerInfo.ip, port: peerInfo.port, family }, 'manual')
    }

    // Check global connection limit before attempting
    if (this.btEngine.numConnections >= this.btEngine.maxConnections) {
      this.logger.debug(
        `Skipping peer ${peerInfo.ip}, global limit reached (${this.btEngine.numConnections}/${this.btEngine.maxConnections})`,
      )
      return
    }

    // Delegate to ConnectionManager which handles:
    // - Swarm state tracking (markConnecting/markConnected/markFailed)
    // - MSE/PE encryption handshake (if enabled)
    // - PeerConnection creation
    // - Callback to handleNewPeerConnection for BT handshake
    const swarmPeer = this._swarm.getPeerByKey(key)
    if (swarmPeer) {
      await this._connectionManager.initiateConnection(swarmPeer)
    }
  }

  get infoHashStr(): InfoHashHex {
    return infoHashFromBytes(this.infoHash)
  }

  /** Get the storage root for this torrent */
  get storageRoot(): { key: string; label: string; path: string } | null {
    return this.btEngine.storageRootManager.getRootForTorrent(this.infoHashStr)
  }

  get bitfield(): BitField | undefined {
    return this._bitfield
  }

  /**
   * Initialize the bitfield with the given piece count.
   * Called when metadata is available and we know how many pieces there are.
   */
  initBitfield(pieceCount: number): void {
    this._bitfield = new BitField(pieceCount)
    this._firstNeededPiece = 0
  }

  /**
   * Initialize piece availability tracking.
   * Call after metadata is available (same time as initBitfield).
   */
  initPieceAvailability(pieceCount: number): void {
    this._availability.initialize(pieceCount)
  }

  get pieceAvailability(): Uint16Array | null {
    return this._availability.rawAvailability
  }

  /**
   * Number of connected seed peers.
   * Use this + pieceAvailability[i] for true availability of a piece.
   */
  get seedCount(): number {
    return this._availability.seedCount
  }

  // --- Piece Info Initialization ---

  /**
   * Initialize piece info from parsed torrent metadata.
   * Called when metadata becomes available.
   */
  initPieceInfo(pieceHashes: Uint8Array[], pieceLength: number, lastPieceLength: number): void {
    this.pieceHashes = pieceHashes
    this.pieceLength = pieceLength
    this.lastPieceLength = lastPieceLength
    this.piecesCount = pieceHashes.length
  }

  // --- Piece Metadata ---

  getPieceHash(index: number): Uint8Array | undefined {
    return this.pieceHashes[index]
  }

  getPieceLength(index: number): number {
    if (index === this.piecesCount - 1) {
      return this.lastPieceLength
    }
    return this.pieceLength
  }

  // --- Bitfield Helpers ---

  hasPiece(index: number): boolean {
    return this._bitfield?.get(index) ?? false
  }

  private updateFileProgressForVerifiedPiece(index: number): void {
    for (const file of this._files) {
      file.updateForPiece(index)
    }
    this.cleanupCompletedStreamingFileLocks()
  }

  markPieceVerified(index: number): void {
    this._bitfield?.set(index, true)

    // Phase 8: Remove piece from all peer indices (we have it now)
    this.removePieceFromAllIndices(index)

    // Advance firstNeededPiece if this was it (or earlier)
    if (index <= this._firstNeededPiece && this._bitfield) {
      // Scan forward to find next incomplete piece
      while (
        this._firstNeededPiece < this.piecesCount &&
        this._bitfield.get(this._firstNeededPiece)
      ) {
        this._firstNeededPiece++
      }
    }
  }

  getMissingPieces(): number[] {
    if (!this._bitfield) return []
    const missing: number[] = []
    for (let i = 0; i < this.piecesCount; i++) {
      if (this.shouldRequestPiece(i)) {
        missing.push(i)
      }
    }
    return missing
  }

  // --- Progress ---

  get completedPiecesCount(): number {
    return this._bitfield?.count() ?? 0
  }

  /**
   * Number of pieces we actually want (not blacklisted).
   */
  get wantedPiecesCount(): number {
    return this._filePriorityManager.getWantedPiecesCount()
  }

  /**
   * Number of wanted pieces we have (verified).
   * Counts pieces that are wanted or boundary and have bitfield=1.
   */
  get completedWantedPiecesCount(): number {
    return this._filePriorityManager.getCompletedWantedCount()
  }

  get isDownloadComplete(): boolean {
    if (this.piecesCount === 0) return false

    // If we have file priorities, check only wanted pieces
    if (this.pieceClassification.length > 0) {
      return this.completedWantedPiecesCount === this.wantedPiecesCount
    }

    // No file priorities - all pieces must be complete
    return this.completedPiecesCount === this.piecesCount
  }

  // --- Session Restore ---

  restoreBitfieldFromHex(hex: string): void {
    this._bitfield?.restoreFromHex(hex)
    this._recalculateFirstNeededPiece()
  }

  /** Recalculate _firstNeededPiece by scanning from 0. Call after bulk bitfield changes. */
  private _recalculateFirstNeededPiece(): void {
    this._firstNeededPiece = 0
    if (this._bitfield) {
      while (
        this._firstNeededPiece < this.piecesCount &&
        this._bitfield.get(this._firstNeededPiece)
      ) {
        this._firstNeededPiece++
      }
    }
  }

  get numPeers(): number {
    // Use swarm as single source of truth (Phase 3)
    return this._swarm.connectedCount
  }

  /**
   * Get all connected peer connections.
   * With Phase 3, swarm is single source of truth.
   */
  get peers(): PeerConnection[] {
    return this._swarm.getConnectedPeers()
  }

  /**
   * Alias for peers - used internally.
   */
  private get connectedPeers(): PeerConnection[] {
    return this.peers
  }

  /**
   * Get swarm statistics for debugging/UI.
   * Shows all known peers from all discovery sources.
   */
  get swarm(): SwarmStats {
    return this._swarm.getStats()
  }

  /**
   * Get the best peers for caching to disk (for fast reconnection next session).
   * Delegates to Swarm's selection logic.
   */
  getGoodPeersForCache(): Array<{ ip: string; port: number }> {
    return this._swarm.getGoodPeersForCache()
  }

  /**
   * Get all swarm peers (for detailed debugging).
   */
  get swarmPeers(): IterableIterator<import('./swarm').SwarmPeer> {
    return this._swarm.allPeers()
  }

  /**
   * Get all swarm peers as a stable array (for UI).
   * Returns cached array that only rebuilds when peers are added/removed.
   */
  get swarmPeersArray(): import('./swarm').SwarmPeer[] {
    return this._swarm.getAllPeersArray()
  }

  /**
   * Get connection timing statistics for debugging/UI.
   */
  getConnectionTimingStats(): import('./connection-timing').ConnectionTimingStats {
    return this.connectionTiming.getStats()
  }

  /**
   * Get peer coordinator state for debugging/UI.
   */
  getPeerCoordinatorState(): {
    protectedPeers: string[]
    optimisticPeer: string | null
    config: ReturnType<PeerCoordinator['getConfig']>
  } {
    const state = this._peerCoordinator.getUnchokeState()
    return {
      protectedPeers: Array.from(state.unchokedPeerIds),
      optimisticPeer: state.optimisticPeerId,
      config: this._peerCoordinator.getConfig(),
    }
  }

  /**
   * Get active pieces being downloaded.
   * Returns raw array for efficient RAF-driven UI updates.
   */
  getActivePieces(): ActivePiece[] {
    return this.activePieces?.activePieces ?? []
  }

  /**
   * Get the active piece manager for efficient state serialization.
   * Returns undefined if not downloading.
   */
  getActivePieceManager(): ActivePieceManager | undefined {
    return this.activePieces
  }

  get isComplete(): boolean {
    return this.isDownloadComplete
  }

  /**
   * Whether this torrent is in endgame mode.
   */
  get isEndgame(): boolean {
    return this._endgameManager.isEndgame
  }

  get files(): TorrentFileInfo[] {
    if (this._files.length > 0) return this._files

    if (this.contentStorage && this.hasMetadata) {
      const rawFiles = this.contentStorage.filesList
      this._files = rawFiles.map((f, i) => new TorrentFileInfo(f, this, i))
      return this._files
    }
    return []
  }

  // === File Priority System (delegated to FilePriorityManager) ===

  /**
   * Get file priorities array. Returns empty array if no files.
   */
  get filePriorities(): number[] {
    return this._filePriorityManager.filePriorities
  }

  /**
   * Get the piece classification array.
   */
  get pieceClassification(): PieceClassification[] {
    return this._filePriorityManager.pieceClassification
  }

  /**
   * Get per-piece priority (0=skip, 4=normal, 6=file-high, 7=streaming-now).
   */
  get piecePriority(): Uint8Array | null {
    return this._streamingScheduler.effectivePriority ?? this._filePriorityManager.piecePriority
  }

  /**
   * Get pieces currently stored in .parts file.
   */
  get partsFilePieces(): Set<number> {
    return this._partsFilePieces
  }

  /**
   * Get the PartsFile manager (if initialized).
   */
  get partsFile(): PartsFile | undefined {
    return this._partsFile
  }

  /**
   * Initialize the PartsFile for boundary piece storage.
   * Called after storage is initialized.
   */
  async initPartsFile(): Promise<void> {
    if (!this.contentStorage) return

    const storageHandle = this.contentStorage.storage
    if (!storageHandle) {
      this.logger.warn('Cannot initialize PartsFile: no storage handle')
      return
    }

    this._partsFile = new PartsFile(
      this.engineInstance,
      storageHandle,
      this.infoHashStr,
      this.piecesCount,
      this.pieceLength,
    )
    await this._partsFile.load()

    // Sync partsFilePieces set with loaded data
    this._partsFilePieces = this._partsFile.pieces
    this.logger.debug(`PartsFile initialized with ${this._partsFilePieces.size} pieces`)

    if (this._partsFilePieces.size > 0) {
      const initialPartsCount = this._partsFilePieces.size
      const synced = await this.syncPartsPiecesToCurrentPriorities({ requireBitfield: false })
      if (synced.materialized > 0 || synced.exported > 0) {
        this.logger.info(`Synchronized ${initialPartsCount} .parts pieces during init`, synced)
      }
    }
  }

  /**
   * Check if a file is skipped.
   */
  isFileSkipped(fileIndex: number): boolean {
    return this._filePriorityManager.isFileSkipped(fileIndex)
  }

  /**
   * Check if a file is complete (all pieces touching it are verified).
   */
  isFileComplete(fileIndex: number): boolean {
    if (!this.hasMetadata || !this._bitfield) return false
    const file = this.contentStorage?.filesList[fileIndex]
    if (!file) return false

    const startPiece = Math.floor(file.offset / this.pieceLength)
    const endPiece = Math.floor((file.offset + file.length - 1) / this.pieceLength)

    for (let i = startPiece; i <= endPiece; i++) {
      if (!this._bitfield.get(i)) return false
    }
    return true
  }

  /**
   * Set file priority for a single file.
   * @param fileIndex - Index of the file
   * @param priority - 0 = normal, 1 = skip
   * @returns true if priority was changed, false if ignored (e.g., file already complete)
   */
  setFilePriority(fileIndex: number, priority: number): boolean {
    const wasSkipped = this._filePriorityManager.isFileSkipped(fileIndex)
    const changed = this._filePriorityManager.setFilePriority(fileIndex, priority)

    if (changed) {
      this.syncStreamingScheduler()

      // Persist state change
      ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)

      // If un-skipping, try to materialize any boundary pieces
      if (wasSkipped && priority === 0) {
        // Fire and forget - don't block the caller
        this.syncPartsPiecesToCurrentPriorities({
          targetFiles: new Set([fileIndex]),
        }).catch((e) => {
          this.logger.error('Error materializing pieces:', e)
        })
      }
    }

    return changed
  }

  /**
   * Set file priority and wait for any required .parts export/materialization.
   * Use this when callers need the on-disk file to be ready before proceeding.
   */
  async setFilePriorityAsync(fileIndex: number, priority: number): Promise<boolean> {
    return this.withFilePriorityUpdateLock(async () => {
      const wasSkipped = this._filePriorityManager.isFileSkipped(fileIndex)
      const changed = this._filePriorityManager.setFilePriority(fileIndex, priority)

      if (!changed) return false

      this.syncStreamingScheduler()
      ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)

      if (wasSkipped && priority === 0) {
        await this.syncPartsPiecesToCurrentPriorities({
          targetFiles: new Set([fileIndex]),
        })
      }

      return true
    })
  }

  /**
   * Set priorities for multiple files at once.
   * @param priorities - Map of fileIndex -> priority
   * @returns Number of files whose priority was changed
   */
  setFilePriorities(priorities: Map<number, number>): number {
    // Check for any files that will be un-skipped
    const oldPriorities = [...this.filePriorities]
    const changed = this._filePriorityManager.setFilePriorities(priorities)

    if (changed > 0) {
      this.syncStreamingScheduler()
      ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)

      // Check if any files were un-skipped
      const anyUnskipped = this._filePriorityManager.checkForUnskipped(
        oldPriorities,
        this.filePriorities,
      )
      if (anyUnskipped) {
        const targetFiles = this.getNewlyUnskippedFiles(oldPriorities, this.filePriorities)
        this.syncPartsPiecesToCurrentPriorities({ targetFiles }).catch((e) => {
          this.logger.error('Error materializing pieces:', e)
        })
      }
    }

    return changed
  }

  /**
   * Set multiple file priorities and wait for any required .parts export/materialization.
   */
  async setFilePrioritiesAsync(priorities: Map<number, number>): Promise<number> {
    return this.withFilePriorityUpdateLock(async () => {
      const oldPriorities = [...this.filePriorities]
      const changed = this._filePriorityManager.setFilePriorities(priorities)

      if (changed === 0) return 0

      this.syncStreamingScheduler()
      ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)

      const anyUnskipped = this._filePriorityManager.checkForUnskipped(
        oldPriorities,
        this.filePriorities,
      )
      if (anyUnskipped) {
        const targetFiles = this.getNewlyUnskippedFiles(oldPriorities, this.filePriorities)
        await this.syncPartsPiecesToCurrentPriorities({ targetFiles })
      }

      return changed
    })
  }

  /**
   * Initialize file priorities array (called when metadata becomes available).
   */
  initFilePriorities(): void {
    this._filePriorityManager.setStandardPieceLength(this.pieceLength)
    this._filePriorityManager.initFilePriorities()
    this.syncStreamingScheduler()
  }

  /**
   * Restore file priorities from persisted state.
   * Bypasses validation since we're restoring saved state.
   * Called during session restore after metadata is available.
   */
  restoreFilePriorities(priorities: number[]): void {
    this._filePriorityManager.setStandardPieceLength(this.pieceLength)
    this._filePriorityManager.restoreFilePriorities(priorities)
    this.syncStreamingScheduler()
  }

  // === Streaming API ===

  /**
   * Convert a file-relative byte range to piece indices.
   * Pure math — no I/O.
   */
  fileBytesToPieces(fileIndex: number, offset: number, length: number): number[] {
    if (!this.contentStorage) {
      throw new Error('Content storage not initialized')
    }
    return this.contentStorage.fileBytesToPieces(fileIndex, offset, length)
  }

  /**
   * Read arbitrary bytes from a file.
   * Caller must ensure required pieces are verified.
   *
   * Boundary pieces may still live in `.parts` while their wanted spans are being
   * exported or materialized. In that case the sparse on-disk file can contain
   * holes/zeroes, so reads must splice those segments directly from `.parts`.
   */
  async readFileBytes(fileIndex: number, offset: number, length: number): Promise<Uint8Array> {
    if (!this.contentStorage) {
      throw new Error('Content storage not initialized')
    }
    const pieceIndices = this.contentStorage.fileBytesToPieces(fileIndex, offset, length)
    const needsPartsOverlay = pieceIndices.some((pieceIndex) =>
      this._partsFilePieces.has(pieceIndex),
    )
    if (!needsPartsOverlay) {
      return this.contentStorage.readFileBytes(fileIndex, offset, length)
    }

    const result = new Uint8Array(length)
    const file = this.contentStorage.filesList[fileIndex]
    if (!file) {
      throw new Error(`Invalid file index: ${fileIndex}`)
    }

    let remaining = length
    let outputOffset = 0
    let currentTorrentOffset = file.offset + offset

    while (remaining > 0) {
      const pieceIndex = Math.floor(currentTorrentOffset / this.pieceLength)
      const pieceStart = pieceIndex * this.pieceLength
      const pieceOffset = currentTorrentOffset - pieceStart
      const bytesToCopy = Math.min(remaining, this.getPieceLength(pieceIndex) - pieceOffset)

      if (this._partsFilePieces.has(pieceIndex)) {
        const pieceData = this._partsFile?.getPiece(pieceIndex)
        if (!pieceData) {
          throw new Error(`Piece ${pieceIndex} marked in .parts but data is unavailable`)
        }
        if (pieceOffset + bytesToCopy > pieceData.length) {
          throw new Error(
            `Piece ${pieceIndex} .parts data truncated: need ${pieceOffset + bytesToCopy}, have ${pieceData.length}`,
          )
        }
        result.set(pieceData.subarray(pieceOffset, pieceOffset + bytesToCopy), outputOffset)
      } else {
        const bytes = await this.contentStorage.read(pieceIndex, pieceOffset, bytesToCopy)
        result.set(bytes, outputOffset)
      }

      remaining -= bytesToCopy
      outputOffset += bytesToCopy
      currentTorrentOffset += bytesToCopy
    }

    return result
  }

  /**
   * Wait for specific pieces to be verified.
   * Resolves immediately if all pieces are already available.
   * Supports cancellation via AbortSignal.
   */
  waitForPieces(pieceIndices: number[], signal?: AbortSignal): Promise<void> {
    // Check if all pieces are already available
    const missing = pieceIndices.filter((i) => !this.hasPiece(i))
    if (missing.length === 0) return Promise.resolve()

    return new Promise<void>((resolve, reject) => {
      const needed = new Set(missing)

      const onPiece = (index: number) => {
        needed.delete(index)
        if (needed.size === 0) {
          cleanup()
          resolve()
        }
      }

      const onAbort = () => {
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }

      const cleanup = () => {
        this.off('piece', onPiece)
        signal?.removeEventListener('abort', onAbort)
      }

      this.on('piece', onPiece)
      signal?.addEventListener('abort', onAbort)

      // Handle already-aborted signal
      if (signal?.aborted) {
        cleanup()
        reject(new DOMException('Aborted', 'AbortError'))
      }
    })
  }

  /**
   * Set which pieces should be downloaded with high priority for streaming.
   * Pass null to clear streaming priorities.
   */
  setStreamingPieces(pieces: Set<number> | null): void {
    this._streamingScheduler.setLegacyPieces(pieces)
    this.syncStreamingScheduler()
  }

  /**
   * Update a named streaming demand window.
   * Multiple windows can coexist and are merged by the streaming scheduler.
   */
  updateStreamingDemand(
    token: string,
    pieces: Set<number> | null,
    urgency: StreamingDemandUrgency = 'now',
  ): void {
    const changed = this._streamingScheduler.updateDemand(token, pieces, urgency)
    if (changed) {
      this.syncStreamingScheduler()
    }
  }

  /**
   * Temporarily lock scheduling to a streamed file without mutating persisted user priorities.
   */
  updateStreamingFileLock(token: string, fileIndex: number | null): void {
    const previous = this._streamingFileLocks.get(token)
    const nextFileIndex =
      fileIndex !== null && !this.files[fileIndex]?.isComplete ? fileIndex : null

    if (nextFileIndex === null) {
      if (previous === undefined) return
      this._streamingFileLocks.delete(token)
      this._streamingScheduler.updateDemand(`file-lock:${token}`, null, 'file')
    } else {
      if (previous === nextFileIndex) return
      this._streamingFileLocks.set(token, nextFileIndex)

      const file = this.files[nextFileIndex]
      const pieces =
        file && file.length > 0
          ? new Set(this.fileBytesToPieces(nextFileIndex, 0, file.length))
          : new Set<number>()
      this._streamingScheduler.updateDemand(`file-lock:${token}`, pieces, 'file')
    }

    this.syncStreamingFileLocks()
    this.syncStreamingScheduler()
  }

  private cleanupCompletedStreamingFileLocks(): void {
    if (this._streamingFileLocks.size === 0) return

    let changed = false
    for (const [token, fileIndex] of this._streamingFileLocks.entries()) {
      if (!this.files[fileIndex]?.isComplete) continue
      this._streamingFileLocks.delete(token)
      this._streamingScheduler.updateDemand(`file-lock:${token}`, null, 'file')
      changed = true
    }

    if (!changed) return
    this.syncStreamingFileLocks()
    this.syncStreamingScheduler()
  }

  private syncStreamingFileLocks(): void {
    const lockedFiles =
      this._streamingFileLocks.size > 0 ? new Set(this._streamingFileLocks.values()) : null
    this._filePriorityManager.setStreamingFileLocks(lockedFiles)
  }

  private syncStreamingScheduler(): void {
    if (!this.hasMetadata || this.piecesCount === 0) return

    const { previousSuppressedPieces, plan } = this._streamingScheduler.buildPlan({
      piecesCount: this.piecesCount,
      basePiecePriority: this._filePriorityManager.piecePriority,
      activePieces: this.getStreamingActivePieceSnapshots(),
    })

    this.applyStreamingSuppressionDiff(previousSuppressedPieces, plan.suppressedPieces)
    this.dropStreamingSuppressedPieces(plan.dropPieceIndices)
  }

  private getStreamingActivePieceSnapshots(): ActivePieceSnapshot[] {
    if (!this.activePieces) return []

    const snapshots: ActivePieceSnapshot[] = []

    for (const piece of this.activePieces.partialValues()) {
      snapshots.push({
        index: piece.index,
        state: 'partial',
        blocksReceived: piece.blocksReceived,
        blocksNeeded: piece.blocksNeeded,
        outstandingRequests: piece.outstandingRequests,
        requests: piece.getRequestEntries(),
      })
    }

    for (const piece of this.activePieces.fullyRequestedValues()) {
      snapshots.push({
        index: piece.index,
        state: 'fullyRequested',
        blocksReceived: piece.blocksReceived,
        blocksNeeded: piece.blocksNeeded,
        outstandingRequests: piece.outstandingRequests,
        requests: piece.getRequestEntries(),
      })
    }

    for (const piece of this.activePieces.fullyRespondedValues()) {
      snapshots.push({
        index: piece.index,
        state: 'fullyResponded',
        blocksReceived: piece.blocksReceived,
        blocksNeeded: piece.blocksNeeded,
        outstandingRequests: piece.outstandingRequests,
        requests: [],
      })
    }

    return snapshots
  }

  private applyStreamingSuppressionDiff(
    previousSuppressedPieces: Set<number>,
    nextSuppressedPieces: Set<number>,
  ): void {
    for (const pieceIndex of nextSuppressedPieces) {
      if (previousSuppressedPieces.has(pieceIndex)) continue
      this.removePieceFromAllIndices(pieceIndex)
    }

    for (const pieceIndex of previousSuppressedPieces) {
      if (nextSuppressedPieces.has(pieceIndex)) continue
      this.reindexPieceForConnectedPeers(pieceIndex)
    }
  }

  private dropStreamingSuppressedPieces(pieceIndices: number[]): void {
    if (!this.activePieces || pieceIndices.length === 0) return

    for (const pieceIndex of pieceIndices) {
      const piece = this.activePieces.get(pieceIndex)
      if (!piece) continue

      for (const request of piece.getRequestEntries()) {
        const peer = this.findConnectedPeerById(request.peerId)
        const begin = request.blockIndex * BLOCK_SIZE
        const length = Math.min(BLOCK_SIZE, piece.length - begin)
        if (peer) {
          peer.sendCancel(pieceIndex, begin, length)
          peer.requestsPending = Math.max(0, peer.requestsPending - 1)
        }
        piece.cancelRequest(request.blockIndex, request.peerId)
      }

      this.activePieces.remove(pieceIndex)
    }
  }

  private reindexPieceForConnectedPeers(pieceIndex: number): void {
    if (!this.shouldAddToIndex(pieceIndex)) return

    for (const peer of this.connectedPeers) {
      if (peer.isSeed || !peer.bitfield?.get(pieceIndex)) continue
      const peerId = peer.peerId ? toHex(peer.peerId) : `${peer.remoteAddress}:${peer.remotePort}`
      this._availability.addPieceToIndex(peerId, pieceIndex)
    }
  }

  private findConnectedPeerById(peerId: string): PeerConnection | undefined {
    for (const peer of this.connectedPeers) {
      const currentPeerId = peer.peerId
        ? toHex(peer.peerId)
        : `${peer.remoteAddress}:${peer.remotePort}`
      if (currentPeerId === peerId) {
        return peer
      }
    }
    return undefined
  }

  /**
   * Materialize a boundary piece from .parts to regular files.
   * Called when all files touched by a boundary piece become non-skipped.
   *
   * @returns true if successfully materialized, false otherwise
   */
  private async materializePiece(pieceIndex: number): Promise<boolean> {
    if (!this._partsFile || !this.contentStorage) return false

    const pieceData = this._partsFile.getPiece(pieceIndex)
    if (!pieceData) {
      this.logger.warn(`Cannot materialize piece ${pieceIndex}: not in .parts`)
      return false
    }

    try {
      // Drain disk queue before modifying files
      await this._diskQueue.drain()

      // Write to regular files
      await this.contentStorage.writePiece(pieceIndex, pieceData)

      // Remove from .parts file
      await this._partsFile.removePieceAndFlush(pieceIndex)

      // Update tracking
      this._partsFilePieces.delete(pieceIndex)

      // Resume disk queue
      this._diskQueue.resume()

      this.logger.debug(`Materialized piece ${pieceIndex} from .parts to regular files`)

      // Update cached downloaded bytes on file objects
      this.updateFileProgressForVerifiedPiece(pieceIndex)

      // Now we can advertise this piece - send HAVE to all peers
      for (const p of this.connectedPeers) {
        if (p.handshakeReceived) {
          p.sendHave(pieceIndex)
        }
      }

      return true
    } catch (e) {
      this._diskQueue.resume()
      this.logger.error(`Failed to materialize piece ${pieceIndex}:`, e)
      return false
    }
  }

  /**
   * Export wanted file spans for a boundary piece while keeping the full piece in .parts.
   */
  private async exportPieceWantedSpans(pieceIndex: number): Promise<boolean> {
    if (!this._partsFile || !this.contentStorage) return false

    const pieceData = this._partsFile.getPiece(pieceIndex)
    if (!pieceData) {
      this.logger.warn(`Cannot export piece ${pieceIndex}: not in .parts`)
      return false
    }

    try {
      await this._diskQueue.drain()
      await this.contentStorage.writePieceFilteredByPriority(pieceIndex, pieceData)
      this._diskQueue.resume()

      this.logger.debug(`Exported wanted spans for piece ${pieceIndex} from .parts`)

      this.updateFileProgressForVerifiedPiece(pieceIndex)

      return true
    } catch (e) {
      this._diskQueue.resume()
      this.logger.error(`Failed to export wanted spans for piece ${pieceIndex}:`, e)
      return false
    }
  }

  /**
   * Check if a piece can be materialized (all files it touches are non-skipped).
   */
  private canMaterializePiece(
    pieceIndex: number,
    options?: { requireBitfield?: boolean },
  ): boolean {
    // Must be a verified piece currently in .parts
    if (!this._partsFilePieces.has(pieceIndex)) return false
    if (options?.requireBitfield !== false && !this._bitfield?.get(pieceIndex)) return false

    // The new classification should be 'wanted' (all files non-skipped)
    return this.pieceClassification[pieceIndex] === 'wanted'
  }

  private getPieceFileSpans(pieceIndex: number): PieceFileSpan[] {
    if (!this.contentStorage) return []

    const pieceStart = pieceIndex * this.pieceLength
    const pieceEnd = pieceStart + this.getPieceLength(pieceIndex)
    const spans: PieceFileSpan[] = []
    const files = this.contentStorage.filesList

    for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
      const file = files[fileIndex]
      const overlapStart = Math.max(pieceStart, file.offset)
      const overlapEnd = Math.min(pieceEnd, file.offset + file.length)
      if (overlapStart >= overlapEnd) continue

      spans.push({
        fileIndex,
        fileOffset: overlapStart - file.offset,
        length: overlapEnd - overlapStart,
        pieceOffset: overlapStart - pieceStart,
        skipped: this.isFileSkipped(fileIndex),
      })
    }

    return spans
  }

  private async withFilePriorityUpdateLock<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this._filePriorityUpdateLock
    let release: (() => void) | undefined
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    this._filePriorityUpdateLock = current

    if (previous) {
      await previous
    }

    try {
      return await fn()
    } finally {
      release?.()
      if (this._filePriorityUpdateLock === current) {
        this._filePriorityUpdateLock = null
      }
    }
  }

  private getNewlyUnskippedFiles(oldPriorities: number[], newPriorities: number[]): Set<number> {
    const unskipped = new Set<number>()
    const count = Math.min(oldPriorities.length, newPriorities.length)
    for (let i = 0; i < count; i++) {
      if (oldPriorities[i] === 1 && newPriorities[i] === 0) {
        unskipped.add(i)
      }
    }
    return unskipped
  }

  private pieceTouchesAnyFiles(pieceIndex: number, targetFiles: Set<number>): boolean {
    if (targetFiles.size === 0) return false
    return this.getPieceFileSpans(pieceIndex).some((span) => targetFiles.has(span.fileIndex))
  }

  private async syncPartsPiecesToCurrentPriorities(options?: {
    requireBitfield?: boolean
    targetFiles?: Set<number>
  }): Promise<{ exported: number; materialized: number }> {
    if (!this._partsFile || this._partsFilePieces.size === 0) {
      return { exported: 0, materialized: 0 }
    }

    const targetFiles = options?.targetFiles
    const toExport: number[] = []
    const toMaterialize: number[] = []

    for (const pieceIndex of this._partsFilePieces) {
      if (options?.requireBitfield !== false && !this._bitfield?.get(pieceIndex)) continue
      if (targetFiles && !this.pieceTouchesAnyFiles(pieceIndex, targetFiles)) continue

      const classification = this.pieceClassification[pieceIndex]
      if (classification === 'wanted') {
        toMaterialize.push(pieceIndex)
      } else if (classification === 'boundary') {
        toExport.push(pieceIndex)
      }
    }

    let exported = 0
    for (const pieceIndex of toExport) {
      if (await this.exportPieceWantedSpans(pieceIndex)) {
        exported++
      }
    }

    let materialized = 0
    for (const pieceIndex of toMaterialize) {
      if (await this.materializePiece(pieceIndex)) {
        materialized++
      }
    }

    if (materialized > 0) {
      ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)
    }

    return { exported, materialized }
  }

  /**
   * Attempt to materialize any boundary pieces that can now be written to regular files.
   * Called after file priorities change (un-skip).
   */
  async materializeEligiblePieces(options?: { requireBitfield?: boolean }): Promise<number> {
    if (!this._partsFile || this._partsFilePieces.size === 0) return 0

    const toMaterialize: number[] = []
    for (const pieceIndex of this._partsFilePieces) {
      if (this.canMaterializePiece(pieceIndex, options)) {
        toMaterialize.push(pieceIndex)
      }
    }

    if (toMaterialize.length === 0) return 0

    this.logger.info(`Materializing ${toMaterialize.length} pieces from .parts`)

    let materialized = 0
    for (const pieceIndex of toMaterialize) {
      if (await this.materializePiece(pieceIndex)) {
        materialized++
      }
    }

    if (materialized > 0) {
      // Persist state change
      ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)
    }

    return materialized
  }

  /**
   * Check if a piece should be requested based on priority.
   */
  shouldRequestPiece(index: number): boolean {
    return this._filePriorityManager.shouldRequestPiece(index, this._bitfield)
  }

  /**
   * Get the advertised bitfield (for sending to peers).
   * This excludes boundary pieces that are stored in .parts file.
   * We don't advertise pieces we can't actually serve from regular files.
   */
  getAdvertisedBitfield(): BitField | undefined {
    if (!this._bitfield) return undefined

    // If no pieces in .parts, return the regular bitfield
    if (this._partsFilePieces.size === 0) {
      return this._bitfield
    }

    // Clone the bitfield and clear boundary pieces
    const advertised = this._bitfield.clone()
    for (const pieceIndex of this._partsFilePieces) {
      advertised.set(pieceIndex, false)
    }
    return advertised
  }

  /**
   * Check if a piece can be served to peers (in regular files, not .parts).
   */
  canServePiece(index: number): boolean {
    if (!this._bitfield?.get(index)) return false
    return !this._partsFilePieces.has(index)
  }

  get progress(): number {
    if (this.piecesCount === 0) return 0

    // If we have file priorities, calculate progress based on wanted pieces
    if (this.pieceClassification.length > 0) {
      const wanted = this.wantedPiecesCount
      if (wanted === 0) return 1 // All files skipped = 100% (nothing to do)
      return this.completedWantedPiecesCount / wanted
    }

    return this.completedPiecesCount / this.piecesCount
  }

  /**
   * Progress of data checking operation (0-1).
   * Only meaningful when activityState is 'checking'.
   */
  get checkingProgress(): number {
    return this._checkingProgress
  }

  get name(): string {
    // Try to get from info dict (cached, avoids repeated parsing)
    const info = this.infoDict
    if (info?.name) {
      return toString(info.name as Uint8Array)
    }

    // Fallback to magnet display name
    if (this._magnetDisplayName) return this._magnetDisplayName

    // Final fallback to truncated infohash
    return `Torrent-${this.infoHashStr.substring(0, 8)}...`
  }

  get downloadSpeed(): number {
    return this.connectedPeers.reduce((acc, peer) => acc + peer.downloadSpeed, 0)
  }

  get uploadSpeed(): number {
    return this.connectedPeers.reduce((acc, peer) => acc + peer.uploadSpeed, 0)
  }

  /**
   * Estimated time to completion in seconds.
   * Returns null if:
   * - No metadata yet (don't know total size)
   * - Download complete
   * - Download speed is zero
   */
  get eta(): number | null {
    if (!this.hasMetadata) return null
    if (this.progress >= 1) return null
    const speed = this.downloadSpeed
    if (speed <= 0) return null

    // Calculate remaining bytes using the same logic as getAnnounceStats
    const totalSize =
      this.piecesCount > 0 ? (this.piecesCount - 1) * this.pieceLength + this.lastPieceLength : 0

    let bytesDownloaded = 0
    if (this._bitfield) {
      for (let i = 0; i < this.piecesCount; i++) {
        if (this._bitfield.get(i)) {
          bytesDownloaded += this.getPieceLength(i)
        }
      }
    }

    const remaining = totalSize - bytesDownloaded
    if (remaining <= 0) return null

    return Math.ceil(remaining / speed)
  }

  /**
   * Get the current activity state (derived, not persisted).
   */
  get activityState(): TorrentActivityState {
    return computeActivityState(
      this.userState,
      (this.engine as BtEngine).isSuspended,
      this.hasMetadata,
      this._isChecking,
      this.progress,
      !!this.errorMessage,
    )
  }

  /**
   * Returns true if network activity should be blocked.
   * Check this at the top of network-related functions.
   */
  get isKillSwitchEnabled(): boolean {
    return (
      this.userState === 'stopped' ||
      this.userState === 'queued' ||
      !!this.errorMessage ||
      (this.engine as BtEngine).isSuspended
    )
  }

  /**
   * Whether this torrent is actively networking.
   * Used by BtEngine connection queue to check if slots should be granted.
   */
  get isActive(): boolean {
    return this._networkActive && !this.isKillSwitchEnabled
  }

  /**
   * Whether this torrent is gracefully stopping (draining in-flight requests).
   * During graceful stop, network stays active but no new pieces are requested.
   */
  get isGracefulStopping(): boolean {
    return this._gracefulStopping
  }

  /**
   * Whether this torrent has metadata (piece info, files, etc).
   */
  get hasMetadata(): boolean {
    return this.piecesCount > 0
  }

  /**
   * Get stats for tracker announce (uploaded, downloaded, left).
   * Used by TrackerManager to include accurate stats in announces.
   */
  getAnnounceStats(): AnnounceStats {
    // If no metadata yet (magnet before metadata fetched), left is unknown
    if (!this.hasMetadata) {
      return {
        uploaded: this.totalUploaded,
        downloaded: this.totalDownloaded,
        left: null,
      }
    }

    // Calculate total size: (piecesCount - 1) * pieceLength + lastPieceLength
    const totalSize =
      this.piecesCount > 0 ? (this.piecesCount - 1) * this.pieceLength + this.lastPieceLength : 0

    // Calculate bytes downloaded by summing completed piece sizes
    let bytesDownloaded = 0
    if (this._bitfield) {
      for (let i = 0; i < this.piecesCount; i++) {
        if (this._bitfield.get(i)) {
          bytesDownloaded += this.getPieceLength(i)
        }
      }
    }

    return {
      uploaded: this.totalUploaded,
      downloaded: this.totalDownloaded,
      left: totalSize - bytesDownloaded,
    }
  }

  /**
   * Connect to one peer from the swarm.
   * Called by BtEngine when granting a connection slot.
   * @returns true if a connection was initiated, false if no candidates available
   */
  connectOnePeer(): boolean {
    // Don't initiate outgoing connections when seeding - accept incoming only
    if (this.isDownloadComplete) {
      this.logger.debug(`connectOnePeer: blocked by isDownloadComplete`)
      return false
    }
    if (!this._networkActive) {
      this.logger.debug(`connectOnePeer: blocked by !_networkActive`)
      return false
    }
    if (this._gracefulStopping) {
      return false
    }
    if (this.isKillSwitchEnabled) {
      this.logger.debug(`connectOnePeer: blocked by isKillSwitchEnabled`)
      return false
    }

    // Check we still have room
    const connected = this.numPeers
    const connecting = this._swarm.connectingCount
    if (connected + connecting >= this.maxPeers) {
      this.logger.debug(
        `connectOnePeer: blocked by maxPeers (${connected}+${connecting}>=${this.maxPeers})`,
      )
      return false
    }

    // Get best candidate right now
    const swarmSize = this._swarm.size
    const candidates = this._connectionManager.getPeerSelector().getConnectablePeers(1)
    if (candidates.length === 0) {
      this.logger.warn(
        `connectOnePeer: no candidates! swarm=${swarmSize}, connected=${connected}, connecting=${connecting}`,
      )
      return false
    }

    const peer = candidates[0]
    this.logger.info(`connectOnePeer: connecting to ${peer.ip}:${peer.port}`)
    this.connectToPeer({ ip: peer.ip, port: peer.port })
    return true
  }

  /**
   * Use a granted connection slot to connect one peer.
   * Called by BtEngine when granting a slot from the rate-limited queue.
   * @returns true if a connection was initiated, false if none available
   */
  useConnectionSlot(): boolean {
    if (!this._networkActive || this._gracefulStopping) return false
    return this.connectOnePeer()
  }

  /**
   * Try to initialize storage for this torrent.
   * Used for recovery when storage becomes available after initial failure.
   * @throws MissingStorageRootError if storage is still unavailable
   */
  async tryInitializeStorage(): Promise<void> {
    if (this.contentStorage) {
      return // Already initialized
    }
    if (!this.hasMetadata || !this.metadataRaw) {
      throw new Error('Cannot initialize storage without metadata')
    }
    await initializeTorrentStorage(this.engine as BtEngine, this, this.metadataRaw)
  }

  /**
   * User action: Start the torrent.
   * Changes userState to 'active' and starts networking if engine allows.
   * If storage was missing, attempts to initialize it first.
   */
  async userStart(): Promise<void> {
    this.logger.info('User starting torrent')

    // If storage is missing but we have metadata, try to initialize storage
    if (!this.contentStorage && this.hasMetadata) {
      try {
        await this.tryInitializeStorage()
      } catch (e) {
        // Use name check instead of instanceof (instanceof fails across module boundaries)
        if (e instanceof Error && e.name === 'MissingStorageRootError') {
          this.errorMessage = `Download location unavailable. Storage root not found.`
          this.logger.warn('Cannot start - storage still unavailable')
          return // Stay in error state, don't change userState
        }
        throw e
      }
    }

    this.userState = 'active'
    this.forceActive = false // User start enters queue-managed mode
    this.errorMessage = undefined

    const btEngine = this.engine as BtEngine
    if (btEngine.queueManager) {
      // Queue manager decides whether to start or queue
      btEngine.queueManager.recalculate()
    } else {
      // start() checks isSuspended internally
      await this.start()
    }

    // Persist state change (userState + bitfield)
    btEngine.sessionPersistence?.saveTorrentState(this)
  }

  /**
   * User action: Stop the torrent.
   * Changes userState to 'stopped' and stops all networking.
   */
  userStop(): void {
    this.logger.info('User stopping torrent')
    this.userState = 'stopped'
    this.forceActive = false
    this.stopNetwork()

    // Persist state change (userState + bitfield)
    const btEngine = this.engine as BtEngine
    btEngine.sessionPersistence?.saveTorrentState(this)
    btEngine.emit('torrent-stopped', this)

    // Notify queue manager to promote next queued torrent
    btEngine.queueManager?.recalculate()
  }

  /**
   * Stop network activity for this torrent.
   * Single source of truth for deactivating networking (trackers, DHT, maintenance).
   * Idempotent - safe to call multiple times.
   * Note: This pauses networking; use the async stop() method to fully destroy the torrent.
   */
  stopNetwork(): void {
    // Cancel graceful stop if in progress (force immediate)
    if (this._gracefulStopping) {
      this._gracefulStopping = false
      if (this._gracefulStopTimer) {
        clearTimeout(this._gracefulStopTimer)
        this._gracefulStopTimer = null
      }
    }

    const wasActive = this._networkActive

    // Save cached peers before we close connections and mutate swarm state.
    // Fire-and-forget: the critical save path is flushPendingSaves() on shutdown.
    if (wasActive) {
      const persistence = (this.engine as BtEngine).sessionPersistence
      if (persistence) {
        const peers = this._swarm.getGoodPeersForCache()
        if (peers.length > 0) {
          persistence.savePeers(toHex(this.infoHash), peers).catch((e) => {
            this.logger.warn(`Failed to save cached peers: ${e instanceof Error ? e.message : e}`)
          })
        }
      }
    }

    // Cancel pending connection requests from the global queue
    this.btEngine.cancelConnectionRequests(this.infoHashStr)

    // Cancel in-flight connection attempts (clears timers, marks peers as failed in swarm)
    this._connectionManager.cancelAllPendingConnections()

    // Mark ALL connecting peers as failed (handles peers from both ConnectionManager and connectToPeer)
    // Copy keys first since markConnectFailed modifies connectingKeys
    const connectingKeys = [...this._swarm.getConnectingKeys()]
    for (const key of connectingKeys) {
      this._swarm.markConnectFailed(key, 'stopped')
    }

    // Always close peers, even if already suspended (handles race conditions)
    for (const peer of this.connectedPeers) {
      peer.close()
    }

    if (!wasActive) return

    this.logger.debug('Suspending network')
    this._networkActive = false
    this._webSeedManager?.stop()

    // Stop periodic maintenance
    // Note: Request processing is now handled by BtEngine.engineTick()
    this._tickLoop.stopMaintenance()

    // Stop DHT lookup timer
    this.stopDHTLookup()

    // Send stopped announce to trackers
    if (this.trackerManager) {
      this.trackerManager.announce('stopped').catch((err) => {
        this.logger.warn(`Failed to send stopped announce: ${err}`)
      })
    }

    // Clear active pieces - release buffered data and pending requests
    this._streamingScheduler.clear()
    this.activePieces?.destroy()
    this.activePieces = undefined

    // Clear pending disk writes - prevents stale writes from accumulating
    this._diskQueue.clearPending()

    // Reset endgame state
    this._endgameManager.reset()

    // Reset peer coordinator so next start gets fresh isFirstEvaluation
    this._peerCoordinator.reset()
  }

  /**
   * Gracefully stop this torrent: stop requesting new pieces but allow in-flight
   * requests to complete before stopping the network. Used by the queue manager
   * when deactivating torrents to avoid abruptly disconnecting peers mid-transfer.
   *
   * During graceful stop:
   * - No new piece requests are made (Phase 3 of tick is skipped)
   * - No new peer connections are initiated
   * - Existing connections continue receiving data
   * - Upload responses continue being served
   *
   * After all in-flight requests drain (or timeout), calls stopNetwork()
   * and sets userState to 'queued'.
   */
  gracefulStop(timeoutMs = 10000): void {
    if (this._gracefulStopping) return

    if (!this._networkActive) {
      // Not active — just set queued directly
      this.userState = 'queued'
      const btEngine = this.engine as BtEngine
      btEngine.sessionPersistence?.saveTorrentState(this)
      return
    }

    this.logger.info(`Graceful stop initiated (timeout: ${timeoutMs}ms)`)
    this._gracefulStopping = true

    // Cancel pending connection requests (no new outgoing connections)
    this.btEngine.cancelConnectionRequests(this.infoHashStr)
    this._connectionManager.cancelAllPendingConnections()

    // Check if already drained
    const totalPending = this.connectedPeers.reduce((sum, p) => sum + p.requestsPending, 0)
    if (totalPending === 0) {
      this._completeGracefulStop()
      return
    }

    // Set timeout to force-complete
    this._gracefulStopTimer = setTimeout(() => {
      if (!this._gracefulStopping) return
      this.logger.info('Graceful stop timeout reached, forcing stop')
      this._completeGracefulStop()
    }, timeoutMs)
  }

  private _cancelGracefulStop(): void {
    if (!this._gracefulStopping) return
    this.logger.info('Graceful stop cancelled')
    this._gracefulStopping = false
    if (this._gracefulStopTimer) {
      clearTimeout(this._gracefulStopTimer)
      this._gracefulStopTimer = null
    }
  }

  private _completeGracefulStop(): void {
    this.logger.info('Graceful stop complete — all in-flight requests drained')
    if (this._gracefulStopTimer) {
      clearTimeout(this._gracefulStopTimer)
      this._gracefulStopTimer = null
    }
    this._gracefulStopping = false
    this.userState = 'queued'
    this.stopNetwork()
    const btEngine = this.engine as BtEngine
    btEngine.sessionPersistence?.saveTorrentState(this)
  }

  private _checkGracefulStopComplete(): void {
    const totalPending = this.connectedPeers.reduce((sum, p) => sum + p.requestsPending, 0)
    if (totalPending === 0) {
      this._completeGracefulStop()
    }
  }

  /**
   * Get current tick statistics for health monitoring.
   * Returns stats from the current logging window (resets every 5 seconds).
   */
  getTickStats(): TickStats {
    return this._tickLoop.getTickStats()
  }

  /**
   * Process one tick for this torrent.
   * Called by BtEngine.engineTick() at 100ms intervals.
   * Processes all accumulated data, runs cleanup, and fills request pipelines.
   * Returns snapshot of this tick's work and current state.
   */
  tick(): TickResult | null {
    const result = this._tickLoop.tick()
    if (this.webSeedUrls.length > 0) {
      this.ensureWebSeedManager().tick()
    }
    if (this._gracefulStopping) {
      this._checkGracefulStopComplete()
    }
    return result
  }

  // ==========================================================================
  // DHT Peer Discovery
  // ==========================================================================

  /**
   * Start periodic DHT lookups for peer discovery.
   * Runs immediately, then every 5 minutes.
   */
  private startDHTLookup(): void {
    if (this._dhtLookupTimer) return
    if (!this.btEngine.dhtEnabled || !this.btEngine.dhtNode) return

    // Run immediately - lookup handles sparse routing table gracefully
    this.requestDHTPeers()

    // Schedule periodic lookups (every 5 minutes)
    const scheduleLookup = () => {
      this._dhtLookupTimer = setTimeout(
        () => {
          this.requestDHTPeers()
          if (this._networkActive && !this.isPrivate) {
            scheduleLookup()
          }
        },
        5 * 60 * 1000,
      )
    }
    scheduleLookup()
  }

  /**
   * Stop DHT lookup timer.
   */
  private stopDHTLookup(): void {
    if (this._dhtLookupTimer) {
      clearTimeout(this._dhtLookupTimer)
      this._dhtLookupTimer = null
    }
  }

  /**
   * Called by the engine when DHT becomes ready (bootstrap complete).
   * Triggers an immediate lookup now that the routing table is populated.
   */
  onDHTReady(): void {
    if (!this._networkActive) return
    if (this.isPrivate) return
    // Start periodic lookups if not already started
    this.startDHTLookup()
    // Lookup again now that routing table is populated
    this.requestDHTPeers()
  }

  /**
   * Request peers from DHT via iterative lookup.
   * Adds discovered peers to the swarm.
   */
  private async requestDHTPeers(): Promise<void> {
    const dhtNode = this.btEngine.dhtNode
    if (!dhtNode) return
    if (!this._networkActive) return

    try {
      this.logger.debug('DHT: Starting peer lookup')
      const result: LookupResult = await dhtNode.lookup(this.infoHash)

      if (result.peers.length > 0) {
        this.logger.info(`DHT: Found ${result.peers.length} peers`)

        // Add peers to swarm
        const peerAddresses = result.peers.map((p) => ({
          ip: p.host,
          port: p.port,
          family: detectAddressFamily(p.host),
        }))
        const swarmSizeBefore = this._swarm.size
        const added = this._swarm.addPeers(peerAddresses, 'dht')
        this.logger.info(
          `DHT: swarm before=${swarmSizeBefore}, added=${added}, swarm after=${this._swarm.size}`,
        )
        if (added > 0) {
          dhtNode.recordPeersDiscovered(added)
          this.logger.info(`DHT: Added ${added} new peers to swarm, calling fillPeerSlots`)
          this.fillPeerSlots()
        }
      } else {
        this.logger.debug(`DHT: No peers found, got ${result.closestNodes.length} closer nodes`)
      }

      // Announce ourselves to the nodes that gave us tokens
      if (result.tokens.size > 0 && this.port > 0) {
        const announceResult = await dhtNode.announce(this.infoHash, this.port, result.tokens)
        this.logger.debug(
          `DHT: Announced to ${announceResult.successCount}/${announceResult.totalCount} nodes`,
        )
      }
    } catch (err) {
      this.logger.warn(`DHT: Lookup failed: ${err}`)
    }
  }

  /**
   * Assert connection limit immediately after state changes.
   * Delegates to the tick loop for implementation.
   */
  private assertConnectionLimit(context: string): void {
    this._tickLoop.assertConnectionLimit(context)
  }

  /**
   * Initialize the tracker manager.
   */
  private initTrackerManager(): void {
    if (this.trackerManager) return

    const tiers = [this.announce]
    this.trackerManager = new TrackerManager(
      this.engineInstance,
      tiers,
      this.infoHash,
      this.peerId,
      this.socketFactory,
      (this.engine as BtEngine).bandwidthTracker,
    )

    // Set the stats getter so trackers can include accurate uploaded/downloaded/left values
    this.trackerManager.setStatsGetter(() => this.getAnnounceStats())

    this.trackerManager.on('peersDiscovered', (peers: PeerInfo[]) => {
      // Add peers to swarm for unified tracking
      const peerAddresses = peers.map((p) => ({
        ip: p.ip,
        port: p.port,
        family: detectAddressFamily(p.ip),
      }))
      const added = this._swarm.addPeers(peerAddresses, 'tracker')
      if (added > 0) {
        this.logger.debug(`Added ${added} tracker peers to swarm (total: ${this._swarm.size})`)
      }

      // Fill peer slots (existing behavior)
      this.fillPeerSlots()
    })

    this.trackerManager.on('warning', (msg) => {
      this.logger.warn(`Tracker warning: ${msg}`)
    })

    this.trackerManager.on('error', (err) => {
      this.logger.error(`Tracker error: ${err.message}`)
    })
  }

  /**
   * Get information about all connected peers.
   *
   * Choking/Interest fields follow BitTorrent wire protocol semantics:
   * - peerChoking: Peer is choking us (we cannot download from them)
   * - peerInterested: Peer wants to download from us
   * - amChoking: We are choking peer (blocking their downloads)
   * - amInterested: We want to download from peer
   */
  getPeerInfo() {
    return this.connectedPeers.map((peer) => ({
      ip: peer.remoteAddress,
      port: peer.remotePort,
      client: peer.peerId ? toString(peer.peerId) : 'unknown',
      peerId: peer.peerId ? toHex(peer.peerId) : null,
      downloaded: peer.downloaded,
      uploaded: peer.uploaded,
      downloadSpeed: peer.downloadSpeed,
      uploadSpeed: peer.uploadSpeed,
      percent: peer.bitfield && this.piecesCount > 0 ? peer.bitfield.count() / this.piecesCount : 0,
      peerChoking: peer.peerChoking,
      peerInterested: peer.peerInterested,
      amChoking: peer.amChoking,
      amInterested: peer.amInterested,
      piecesHave: peer.bitfield?.count() ?? 0,
      connectionType: peer.isIncoming ? ('incoming' as const) : ('outgoing' as const),
    }))
  }

  /**
   * Get all peers for UI display, including those currently connecting.
   * Returns unified DisplayPeer objects that work for both states.
   */
  getDisplayPeers(): DisplayPeer[] {
    const result: DisplayPeer[] = []

    // Add connected peers
    for (const conn of this._swarm.getConnectedPeers()) {
      const key = peerKey(conn.remoteAddress ?? '', conn.remotePort ?? 0)
      const swarmPeer = this._swarm.getPeerByKey(key) ?? null
      result.push({
        key,
        ip: conn.remoteAddress ?? '',
        port: conn.remotePort ?? 0,
        state: 'connected',
        connection: conn,
        swarmPeer,
      })
    }

    // Add connecting peers
    for (const key of this._swarm.getConnectingKeys()) {
      const swarmPeer = this._swarm.getPeerByKey(key)
      if (swarmPeer) {
        result.push({
          key,
          ip: swarmPeer.ip,
          port: swarmPeer.port,
          state: 'connecting',
          connection: null,
          swarmPeer,
        })
      }
    }

    return result
  }

  disconnectPeer(ip: string, port: number) {
    const peer = this.connectedPeers.find((p) => p.remoteAddress === ip && p.remotePort === port)
    if (peer) {
      peer.close()
    }
  }

  setMaxPeers(max: number) {
    this.maxPeers = max
    // Sync with ConnectionManager
    this._connectionManager.updateConfig({ maxPeersPerTorrent: max })
  }

  setMaxUploadSlots(max: number) {
    this.maxUploadSlots = max
    this._peerCoordinator.updateUnchokeConfig({ maxUploadSlots: max })

    // Force prompt re-evaluation so slot reductions choke peers immediately.
    this._peerCoordinator.reset()
    this._tickLoop.runMaintenance()
  }

  setSendBufferWatermark(bytes: number) {
    this._uploader.setSendBufferWatermark(bytes)
  }

  /**
   * Set encryption policy at runtime.
   * Takes effect for new connections only.
   */
  setEncryptionPolicy(policy: EncryptionPolicy): void {
    this._connectionManager.setEncryptionPolicy(policy)
  }

  /**
   * Handle a new peer connection from ConnectionManager.
   * This is called after MSE handshake (if enabled) completes.
   */
  private handleNewPeerConnection(_key: string, peer: PeerConnection) {
    // Set up the peer with event listeners etc
    this.addPeer(peer)

    // Initiate BitTorrent handshake
    peer.sendHandshake(this.infoHash, this.peerId)
  }

  addPeer(peer: PeerConnection) {
    // Reject peers when kill switch is enabled (stopped, queued, error, or engine suspended)
    if (this.isKillSwitchEnabled || this._gracefulStopping) {
      this.logger.debug('Rejecting peer - kill switch enabled or graceful stopping')
      peer.close()
      return
    }

    // Validate address info exists - required for proper swarm tracking
    if (!peer.remoteAddress || !peer.remotePort) {
      this.logger.warn('addPeer called without address info - cannot track in swarm')
    }

    // Check for duplicate connection (race condition: incoming + outgoing to same peer)
    // Use swarm as single source of truth
    if (peer.remoteAddress && peer.remotePort) {
      const key = peerKey(peer.remoteAddress, peer.remotePort)
      const swarmPeer = this._swarm.getPeerByKey(key)
      if (swarmPeer?.state === 'connected') {
        this.logger.debug(`Rejecting duplicate connection to ${key} - already connected in swarm`)
        peer.close()
        return
      }
    }

    // Check incoming connection limit - reserve slots for outgoing connections
    // This prevents incoming connections from filling all slots during sleep/wake bursts
    if (peer.isIncoming) {
      const incomingCount = this.peers.filter((p) => p.isIncoming).length
      const maxIncoming = Math.floor(this.maxPeers * MAX_INCOMING_RATIO)
      if (incomingCount >= maxIncoming) {
        this.logger.info(
          `Rejecting incoming peer, incoming limit reached (${incomingCount}/${maxIncoming})`,
        )
        peer.close()
        if (peer.remoteAddress && peer.remotePort) {
          this._swarm.rejectIncoming(
            peer.remoteAddress,
            peer.remotePort,
            detectAddressFamily(peer.remoteAddress),
            'incoming_limit_reached',
          )
        }
        return
      }
    }

    // Check total connections including connecting (accounts for incoming during outgoing attempts)
    // If peer is already in connecting state (outgoing connection), it's already counted
    // so we use > instead of >= to avoid double-counting
    const key =
      peer.remoteAddress && peer.remotePort ? peerKey(peer.remoteAddress, peer.remotePort) : null
    const existingSwarmPeer = key ? this._swarm.getPeerByKey(key) : null
    const peerAlreadyCounted = existingSwarmPeer?.state === 'connecting'
    const total = this.numPeers + this._swarm.connectingCount
    const effectiveTotal = peerAlreadyCounted ? total : total + 1

    if (effectiveTotal > this.maxPeers) {
      this.logger.info(`Rejecting peer, max reached (${effectiveTotal}/${this.maxPeers})`)
      peer.close()
      if (existingSwarmPeer) {
        // Outgoing connection we initiated - mark as failed
        this._swarm.markConnectFailed(key!, 'max_peers_reached')
      } else if (peer.remoteAddress && peer.remotePort) {
        // Incoming connection - track the rejection
        this._swarm.rejectIncoming(
          peer.remoteAddress,
          peer.remotePort,
          detectAddressFamily(peer.remoteAddress),
          'max_peers_reached',
        )
      }
      return
    }
    // Note: global limit for incoming is handled by BtEngine via connection queue

    // Update swarm state FIRST - swarm is single source of truth (Phase 3)
    if (peer.remoteAddress && peer.remotePort) {
      const key = peerKey(peer.remoteAddress, peer.remotePort)
      if (this._swarm.hasPeer(key)) {
        // Outgoing connection we initiated
        this._swarm.markConnected(key, peer)
      } else {
        // Incoming connection - add to swarm
        this._swarm.addIncomingConnection(
          peer.remoteAddress,
          peer.remotePort,
          detectAddressFamily(peer.remoteAddress),
          peer,
        )
      }
    }

    this.assertConnectionLimit('addPeer')
    if (this.hasMetadata) {
      peer.bitfield = new BitField(this.piecesCount)
      // Phase 4: Set piece length for isFast calculation
      peer.setPieceLength(this.pieceLength)
    }
    this._peerHandler.setupListeners(peer)
  }

  private removePeer(peer: PeerConnection) {
    // Handle availability cleanup
    const peerId = peer.peerId ? toHex(peer.peerId) : `${peer.remoteAddress}:${peer.remotePort}`
    this._availability.onPeerDisconnected(peerId, peer.bitfield, peer.isSeed)
    if (peer.isSeed) {
      this.logger.debug(`Seed disconnected (seedCount: ${this._availability.seedCount})`)
    }

    // Clear any queued uploads for this peer
    const removedUploads = this._uploader.removeQueuedUploads(peer)
    if (removedUploads > 0) {
      this.logger.debug(`Cleared ${removedUploads} queued uploads for disconnected peer`)
    }

    // Clean up any pending metadata fetch from this peer
    this._metadataFetcher.onPeerDisconnected(peer)

    // Update swarm state - swarm is single source of truth (Phase 3)
    if (peer.remoteAddress && peer.remotePort) {
      const key = peerKey(peer.remoteAddress, peer.remotePort)
      this._swarm.markDisconnected(key)
      // Notify peer coordinator of disconnect
      this._peerCoordinator.peerDisconnected(key)
      this.logger.debug(`Removing peer ${key}, peers remaining: ${this.numPeers}`)
    } else {
      // Address info missing - this is a bug, but log it to help debug
      this.logger.warn('removePeer called without address info - swarm state may be inconsistent', {
        peerId: peer.peerId ? toHex(peer.peerId) : 'unknown',
      })
    }

    // THE KEY FIX: Clear requests for this peer so blocks can be re-requested
    // Unlike the old approach (clearing all requests for affected pieces),
    // this surgically removes only the requests from the disconnected peer
    // Note: peerId already computed at top of function for Phase 8 index cleanup
    const cleared = this.activePieces?.clearRequestsForPeer(peerId) || 0
    if (cleared > 0) {
      this.logger.debug(`Peer ${peerId} disconnected, cleared ${cleared} pending requests`)
    }

    // Request pipeline refilled by requestTick() game loop
    // Vacated peer slot will be filled by next maintenance interval (~5s)
  }

  /**
   * Iterate connected peers starting from round-robin index.
   * Advances the index for next call to ensure fair bandwidth distribution.
   */
  private *iteratePeersRoundRobin(): Generator<PeerConnection> {
    const peers = this.connectedPeers
    if (peers.length === 0) return
    const startIndex = this._peerRequestRoundRobin % peers.length
    for (let i = 0; i < peers.length; i++) {
      yield peers[(startIndex + i) % peers.length]
    }
    this._peerRequestRoundRobin = (startIndex + 1) % peers.length
  }

  /**
   * Schedule retry when download rate limit blocks requests.
   * Uses round-robin to be fair across peers when resuming.
   */
  private scheduleDownloadRateLimitRetry(blockSize: number): void {
    if (this.downloadRateLimitRetryScheduled) return

    const downloadBucket = this.btEngine.bandwidthTracker.downloadBucket
    const delayMs = downloadBucket.msUntilAvailable(blockSize)
    this.downloadRateLimitRetryScheduled = true
    setTimeout(
      () => {
        this.downloadRateLimitRetryScheduled = false
        const now = Date.now()
        // Use round-robin for fair bandwidth distribution across peers
        for (const peer of this.iteratePeersRoundRobin()) {
          if (!peer.peerChoking) {
            this.requestPieces(peer, now)
          }
        }
      },
      Math.max(delayMs, 10),
    )
  }

  /**
   * Fill peer slots from the swarm.
   * Delegates to runMaintenance() for single codepath.
   */
  private fillPeerSlots(): void {
    this._tickLoop.runMaintenance()
  }

  private handleInterested(peer: PeerConnection) {
    peer.peerInterested = true
    // Try quick unchoke if slots available (otherwise algorithm handles on next maintenance)
    this.tryQuickUnchoke(peer)
  }

  /**
   * Quick unchoke for new peers when slots are available.
   * Provides immediate reciprocity without waiting for maintenance cycle.
   * The regular unchoke algorithm may adjust later if needed.
   */
  private tryQuickUnchoke(peer: PeerConnection): void {
    if (!this._networkActive) return
    if (!peer.amChoking) return // Already unchoked

    // Only consider peers where there's mutual potential benefit
    // - Peer is interested in us (they want to download)
    // - OR we're interested in them (we want reciprocity)
    if (!peer.peerInterested && !peer.amInterested) return

    // Count currently unchoked interested peers
    const unchokedCount = this.peers.filter((p) => !p.amChoking && p.peerInterested).length
    const maxSlots = this._peerCoordinator.getConfig().unchoke.maxUploadSlots

    if (unchokedCount < maxSlots) {
      peer.amChoking = false
      peer.sendMessage(MessageType.UNCHOKE)
      this.logger.debug(
        `Quick unchoke for ${peerKey(peer.remoteAddress!, peer.remotePort!)} ` +
          `(${unchokedCount + 1}/${maxSlots} slots)`,
      )
    }

    // Request pipeline filled by requestTick() game loop
  }

  // === Phase 8: Peer Piece Index Management ===

  /**
   * Build the peer piece index for a newly connected peer.
   * Called when bitfield is received or when a HAVE_ALL peer gets metadata.
   *
   * The index contains pieces that:
   * 1. Peer has (from their bitfield)
   * 2. We don't have (not in our bitfield)
   * 3. We need (priority > 0)
   * 4. Aren't currently active
   *
   * libtorrent reference: This is implicit in their piece-centric design.
   */
  private buildPeerPieceIndex(peer: PeerConnection): void {
    if (!this._bitfield || !peer.bitfield || peer.isSeed) {
      return // Seeds don't use per-peer index (they have everything)
    }

    const peerId = peer.peerId ? toHex(peer.peerId) : `${peer.remoteAddress}:${peer.remotePort}`
    const count = this._availability.buildPeerIndex(peerId, peer.bitfield, this.piecesCount, (i) =>
      this.shouldAddToIndex(i),
    )
    this.logger.debug(`Built peer piece index for ${peerId}: ${count} pieces`)
  }

  /**
   * Check if a piece should be added to peer indices.
   * Returns true if we need this piece and it's not active.
   */
  private shouldAddToIndex(pieceIndex: number): boolean {
    // Skip if we have it
    if (this._bitfield?.get(pieceIndex)) return false

    // Skip if streaming scheduler has explicitly suppressed this piece
    if (this._streamingScheduler.isPieceSuppressed(pieceIndex)) return false

    // Skip if priority is 0 (skipped file)
    if (this.piecePriority && this.piecePriority[pieceIndex] === 0) return false

    // Skip if already active
    if (this.activePieces?.has(pieceIndex)) return false

    return true
  }

  /**
   * Remove a piece from all peer indices.
   * Called when we complete a piece or activate it for download.
   */
  private removePieceFromAllIndices(pieceIndex: number): void {
    this._availability.removePieceFromAllIndices(pieceIndex)
  }

  private updateInterest(peer: PeerConnection) {
    if (!peer.bitfield) return

    // Calculate if peer has any piece we want and don't have
    let interested = false
    if (!this.isComplete && this.bitfield) {
      for (let i = 0; i < this.bitfield.size; i++) {
        // Use shouldRequestPiece which checks both bitfield and classification
        if (this.shouldRequestPiece(i) && peer.bitfield.get(i)) {
          interested = true
          break
        }
      }
    }

    // Send INTERESTED if newly interested
    if (interested && !peer.amInterested) {
      this.logger.debug('Sending INTERESTED')
      peer.sendMessage(MessageType.INTERESTED)
      peer.amInterested = true
      // Try to get reciprocity by unchoking them if we have slots
      this.tryQuickUnchoke(peer)
    }

    // Send NOT_INTERESTED if no longer interested
    if (!interested && peer.amInterested) {
      this.logger.debug('Sending NOT_INTERESTED')
      peer.sendMessage(MessageType.NOT_INTERESTED)
      peer.amInterested = false
    }

    // Request pipeline filled by requestTick() game loop
  }

  /**
   * Request pieces from a peer. Delegates to TorrentPieceRequester.
   */
  private requestPieces(peer: PeerConnection, now: number) {
    // Don't request new pieces during graceful stop — let in-flight requests drain
    if (this._gracefulStopping) return

    // Lazy init piece requester
    if (!this._pieceRequester) {
      this._pieceRequester = this.createPieceRequester()
    }
    this._pieceRequester.request(peer, now)
  }

  private initActivePieceManager(): ActivePieceManager {
    if (this.activePieces) {
      return this.activePieces
    }

    this.activePieces = new ActivePieceManager(
      this.engineInstance,
      (index) => this.getPieceLength(index),
      {
        platformType: this.btEngine.config?.platformType.get(),
        standardPieceLength: this.pieceLength,
      },
    )
    return this.activePieces
  }

  private createWebSeedHttpClient(): WebSeedHttpClient {
    return new WebSeedHttpClient(this.socketFactory, this.logger)
  }

  private ensureWebSeedManager(): WebSeedManager {
    if (this._webSeedManager) {
      return this._webSeedManager
    }

    this._webSeedManager = new WebSeedManager(
      this.engineInstance,
      this.createWebSeedHttpClient(),
      {
        isNetworkActive: () => this._networkActive,
        isComplete: () => this.isComplete,
        hasMetadata: () => this.hasMetadata,
        getWebSeedUrls: () => this.webSeedUrls,
        getFiles: () => this.contentStorage?.filesList ?? [],
        isMultiFileTorrent: () => Array.isArray(this.infoDict?.files),
        getPieceCount: () => this.piecesCount,
        getFirstNeededPiece: () => this._firstNeededPiece,
        getPieceLength: (index) => this.getPieceLength(index),
        getPieceOffset: (index) => index * this.pieceLength,
        shouldRequestPiece: (index) => this.shouldRequestPiece(index),
        hasPiece: (index) => this.hasPiece(index),
        getActivePieces: () => this.activePieces,
        initActivePieces: () => this.initActivePieceManager(),
        removePieceFromAllIndices: (index) => this.removePieceFromAllIndices(index),
        reindexPieceForConnectedPeers: (index) => this.reindexPieceForConnectedPeers(index),
        onReceivedBlockFromSource: (sourceId, pieceIndex, blockOffset, data) =>
          this.handleBlockFromSource(sourceId, pieceIndex, blockOffset, data),
      },
    )

    return this._webSeedManager
  }

  /**
   * Create the piece requester with all necessary dependencies.
   */
  private createPieceRequester(): TorrentPieceRequester {
    const deps: PieceRequesterDeps = {
      // State readers
      getPieceCount: () => this.piecesCount,
      getPieceLength: (index) => this.getPieceLength(index),
      getPiecePriority: () => this.piecePriority,
      getBitfield: () => this._bitfield,
      isKillSwitchEnabled: () => this.isKillSwitchEnabled,
      isNetworkActive: () => this._networkActive,
      isWriteQueueBackpressured: () => this.btEngine.isWriteQueueBackpressured(),
      hasMetadata: () => this.hasMetadata,
      getConnectedPeerCount: () => this.connectedPeers.length,
      getCompletedPieceCount: () => this.completedPiecesCount,
      getFirstNeededPiece: () => this._firstNeededPiece,
      getStreamingSelectionHint: () => this._streamingScheduler.selectionHint,

      // Managers
      getActivePieces: () => this.activePieces,
      initActivePieces: () => this.initActivePieceManager(),
      getAvailability: () => this._availability,
      getEndgameManager: () => this._endgameManager,

      // Bandwidth
      getMaxPipelineDepth: () =>
        this.btEngine.config?.maxPipelineDepth.get() ?? DEFAULT_MAX_PIPELINE_DEPTH,
      isDownloadRateLimited: () => this.btEngine.bandwidthTracker.downloadBucket.isLimited,
      getDownloadRateLimit: () => this.btEngine.bandwidthTracker.downloadBucket.refillRate,
      tryConsumeDownloadBandwidth: (bytes) =>
        this.btEngine.bandwidthTracker.downloadBucket.tryConsume(bytes),

      // Callbacks
      removePieceFromAllIndices: (index) => this.removePieceFromAllIndices(index),
      shouldAddToIndex: (pieceIndex) => this.shouldAddToIndex(pieceIndex),
      scheduleRateLimitRetry: (delayMs, _callback) => {
        this.scheduleDownloadRateLimitRetry(delayMs)
        return true
      },
      onEndgameEvaluate: (missingCount, activeCount, hasUnrequestedBlocks) => {
        const decision = this._endgameManager.evaluate(
          missingCount,
          activeCount,
          hasUnrequestedBlocks,
        )
        if (decision) {
          this.logger.info(`Endgame: ${decision.type}`)
        }
      },
      getPeerId: (peer) =>
        peer.peerId ? toHex(peer.peerId) : `${peer.remoteAddress}:${peer.remotePort}`,
    }

    return new TorrentPieceRequester(this.engineInstance, deps)
  }

  /**
   * Handle a received block from the wire protocol PIECE message.
   *
   * BitTorrent terminology:
   * - Piece: A fixed-size segment of the torrent (e.g., 256KB) with a SHA1 hash
   * - Block: A smaller chunk (typically 16KB) transferred in a single PIECE message
   *
   * This method buffers blocks in memory until the piece is complete,
   * then verifies the hash and writes the complete piece to storage.
   */
  private handleBlock(peer: PeerConnection, msg: WireMessage): void {
    if (msg.index === undefined || msg.begin === undefined || !msg.block) {
      return
    }

    if (peer.requestsPending > 0) peer.requestsPending--

    const block = msg.block
    this.handleBlockCommon(peer, msg.index, msg.begin, block.length, (piece, blockIndex, peerId) =>
      piece.addBlock(blockIndex, block, peerId),
    )
  }

  /**
   * Zero-copy block handler for PIECE messages.
   * Called from processBuffer() fast path to copy block data directly from
   * ChunkedBuffer to piece buffer, eliminating 3 intermediate allocations.
   */
  private handleBlockZeroCopy(
    peer: PeerConnection,
    pieceIndex: number,
    blockOffset: number,
    buffer: ChunkedBuffer,
    dataOffset: number,
    dataLength: number,
  ): void {
    // Note: requestsPending is already decremented in processBuffer fast path
    this.handleBlockCommon(peer, pieceIndex, blockOffset, dataLength, (piece, blockIndex, peerId) =>
      piece.addBlockFromChunked(blockIndex, buffer, dataOffset, dataLength, peerId),
    )
  }

  /**
   * Common block handling logic shared by handleBlock and handleBlockZeroCopy.
   * The addBlockFn parameter allows different block storage strategies.
   */
  private handleBlockCommon(
    peer: PeerConnection,
    pieceIndex: number,
    blockOffset: number,
    dataLength: number,
    addBlockFn: (piece: ActivePiece, blockIndex: number, peerId: string) => boolean,
  ): void {
    // Track block receipt for adaptive pipeline depth adjustment
    peer.recordBlockReceived()

    // Initialize activePieces if needed (lazy init after metadata is available)
    if (!this.activePieces && this.hasMetadata) {
      this.initActivePieceManager()
    }

    if (!this.activePieces) {
      this.logger.warn(
        `Received block ${pieceIndex}:${blockOffset} but activePieces not initialized (metadata not yet received?)`,
      )
      return
    }

    // Early exit if we already have this piece (prevents creating active pieces for complete pieces)
    if (this._bitfield?.get(pieceIndex)) {
      this.logger.debug(`Ignoring block ${pieceIndex}:${blockOffset} - piece already complete`)
      return
    }

    // Inbound blocks must match existing active/requested state.
    // Do not create new active pieces from unsolicited or canceled traffic.
    const piece = this.activePieces.get(pieceIndex)
    if (!piece && this._streamingScheduler.isPieceSuppressed(pieceIndex)) {
      this.logger.debug(`Ignoring late block ${pieceIndex}:${blockOffset} for suppressed piece`)
      return
    }
    if (!piece) {
      this.logger.debug(
        `Ignoring unsolicited block ${pieceIndex}:${blockOffset} - piece not active`,
      )
      return
    }

    // Get peer ID for tracking
    const peerId = peer.peerId ? toHex(peer.peerId) : 'unknown'
    const blockIndex = Math.floor(blockOffset / BLOCK_SIZE)

    if (!piece.hasRequestForBlockFromPeer(blockIndex, peerId)) {
      this.logger.debug(
        `Ignoring unsolicited block ${pieceIndex}:${blockOffset} from ${peerId} - request not active`,
      )
      return
    }

    // Record RTT sample BEFORE addBlockFn (which clears the request entry)
    const requestTimestamp = piece.getRequestTimestamp(blockIndex, peerId)
    if (requestTimestamp !== undefined) {
      const rtt = Date.now() - requestTimestamp
      peer.recordRttSample(rtt)
    }

    const cancels = this._endgameManager.getCancels(piece, blockIndex, peerId)

    // Add block to piece using the provided function
    const isNew = addBlockFn(piece, blockIndex, peerId)
    if (!isNew) {
      this.logger.debug(`Duplicate block ${pieceIndex}:${blockOffset}`)
    } else {
      // Record payload bytes (piece data only, not protocol overhead)
      ;(this.engine as BtEngine).bandwidthTracker.record('peer:payload', dataLength, 'down')
    }

    // Cancel any duplicate requests still outstanding for this block.
    // This applies to both global endgame and urgent streaming-now pieces.
    if (isNew) {
      for (const cancel of cancels) {
        // Find peer by ID and send cancel
        for (const p of this.connectedPeers) {
          const pId = p.peerId ? toHex(p.peerId) : `${p.remoteAddress}:${p.remotePort}`
          if (pId === cancel.peerId) {
            p.sendCancel(cancel.index, cancel.begin, cancel.length)
            this.logger.debug(`Endgame: sent CANCEL to ${pId} for ${cancel.index}:${cancel.begin}`)
            break
          }
        }
      }
    }

    // Finalize if piece is complete
    if (piece.haveAllBlocks) {
      // Promote to pending state - no longer counts against partial cap
      // This allows new pieces to start downloading while this one awaits verification
      this.activePieces.promoteToFullyResponded(pieceIndex)
      // Fire-and-forget the async finalization
      this.finalizePiece(pieceIndex, piece).catch((err) => {
        this.logger.error(`Error finalizing piece ${pieceIndex}:`, err)
      })
    }
  }

  private handleBlockFromSource(
    sourceId: string,
    pieceIndex: number,
    blockOffset: number,
    data: Uint8Array,
  ): boolean {
    if (!this.activePieces && this.hasMetadata) {
      this.initActivePieceManager()
    }

    if (!this.activePieces) {
      this.logger.warn(
        `Received web-seed block ${pieceIndex}:${blockOffset} but activePieces not initialized`,
      )
      return false
    }

    if (this._bitfield?.get(pieceIndex)) {
      this.logger.debug(`Ignoring web-seed block ${pieceIndex}:${blockOffset} - piece complete`)
      return false
    }

    const piece = this.activePieces.get(pieceIndex)
    if (!piece) {
      this.logger.debug(
        `Ignoring web-seed block ${pieceIndex}:${blockOffset} - piece not active`,
      )
      return false
    }

    const blockIndex = Math.floor(blockOffset / BLOCK_SIZE)
    if (!piece.hasRequestForBlockFromSource(blockIndex, sourceId)) {
      this.logger.debug(
        `Ignoring unsolicited web-seed block ${pieceIndex}:${blockOffset} from ${sourceId}`,
      )
      return false
    }

    const isNew = piece.addBlock(blockIndex, data, sourceId)
    if (!isNew) {
      this.logger.debug(`Duplicate web-seed block ${pieceIndex}:${blockOffset}`)
      return false
    }

    this.totalDownloaded += data.length
    this.emit('download', data.length)

    if (piece.haveAllBlocks) {
      this.activePieces.promoteToFullyResponded(pieceIndex)
      this.finalizePiece(pieceIndex, piece).catch((err) => {
        this.logger.error(`Error finalizing web-seed piece ${pieceIndex}:`, err)
      })
    }

    return true
  }

  /**
   * Finalize a complete piece: verify hash and write to storage.
   * Uses verified write when available (io-daemon) for atomic hash verification.
   */
  private async finalizePiece(index: number, piece: ActivePiece): Promise<void> {
    // IMPORTANT: Capture contributors NOW before any async operations.
    // stopNetwork() can be called while we're awaiting disk writes (e.g., if another
    // piece fails), which calls activePieces.destroy() and clears all piece data
    // including blockSenders. Without this, handleHashMismatch would see empty contributors.
    const contributors = Array.from(piece.getContributingPeers())

    // Assemble the complete piece
    const pieceData = piece.assemble()
    const expectedHash = this.getPieceHash(index)

    // Check piece classification to determine storage destination
    const classification = this.pieceClassification[index]
    const isBoundaryPiece = classification === 'boundary'

    if (isBoundaryPiece && this._partsFile) {
      // Boundary piece: verify hash then store in .parts file
      // Use sha1TransferThen callback pattern for type-safe buffer handling after transfer
      const result = await this.verifyAndWriteBoundaryPiece(
        index,
        pieceData,
        expectedHash,
        contributors,
      )
      if (!result.success) {
        return // Hash mismatch or write error already handled
      }

      // Mark as verified in internal bitfield
      this.markPieceVerified(index)
      this.activePieces?.removeFullyResponded(index)

      // Track disk write throughput
      ;(this.engine as BtEngine).bandwidthTracker.record('disk', result.bytesWritten, 'down')

      // Update cached downloaded bytes on file objects
      this.updateFileProgressForVerifiedPiece(index)

      // Note: Do NOT send HAVE for boundary pieces (they're in .parts, not serveable)
      // Progress still counts toward completion
    } else {
      // Wanted piece (or no classification): write to regular files
      if (this.contentStorage) {
        try {
          const usedVerifiedWrite = await this.contentStorage.writePieceVerified(
            index,
            pieceData,
            expectedHash,
          )

          if (!usedVerifiedWrite && expectedHash) {
            // Verified write not available - verify hash in TypeScript
            const actualHash = await this.btEngine.hasher.sha1(pieceData, 'piece-verify')
            if (compare(actualHash, expectedHash) !== 0) {
              this.handleHashMismatch(index, contributors)
              return
            }
          }
        } catch (e) {
          // Classify the error for proper handling
          const writeError = e instanceof WriteError ? e : classifyError(e, `piece ${index}`)

          // Hash mismatch: re-request from different peers (handled separately)
          if (writeError.isHashMismatch || (e instanceof Error && e.name === 'HashMismatchError')) {
            this._writeRetryCount.delete(index) // Clear retry count on hash mismatch
            this.handleHashMismatch(index, contributors)
            return
          }

          // Disk queue cleared: torrent was stopped, this is expected
          const errorMsg = e instanceof Error ? e.message : String(e)
          if (errorMsg.includes('Disk queue cleared')) {
            this.logger.debug(`Write cancelled (torrent stopped):`, errorMsg)
            return
          }

          // Fatal errors: stop immediately, user intervention required
          if (writeError.isFatal) {
            this._writeRetryCount.delete(index)
            this.logger.error(
              `Fatal write error (${writeError.errorType}) - stopping torrent:`,
              errorMsg,
            )
            this.errorMessage = `Write failed: ${errorMsg}`
            this.stopNetwork()
            this.activePieces?.removeFullyResponded(index)
            ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)
            return
          }

          // Retryable errors: check retry count and maybe retry
          if (writeError.isRetryable) {
            const retryCount = this._writeRetryCount.get(index) ?? 0
            const delay = getRetryDelay(writeError.errorType, retryCount)

            if (delay !== undefined) {
              // Schedule retry with backoff
              this._writeRetryCount.set(index, retryCount + 1)
              this.logger.warn(
                `Transient write error (${writeError.errorType}), retry ${retryCount + 1} in ${delay}ms:`,
                errorMsg,
              )

              // Re-queue the piece for another attempt after delay
              // The piece data is still in the active piece, so we can retry
              setTimeout(() => {
                if (!this._networkActive) return // Torrent was stopped
                // Re-invoke handlePieceData to retry the write
                // The piece is still marked as fully responded, so we just need to retry the write
                this.retryPieceWrite(index, pieceData, expectedHash)
              }, delay)
              return
            }

            // Max retries exceeded
            this._writeRetryCount.delete(index)
            this.logger.error(
              `Write failed after ${retryCount} retries (${writeError.errorType}) - stopping torrent:`,
              errorMsg,
            )
            this.errorMessage = `Write failed after retries: ${errorMsg}`
            this.stopNetwork()
            this.activePieces?.removeFullyResponded(index)
            ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)
            return
          }

          // Unknown error type: treat as fatal to be safe
          this._writeRetryCount.delete(index)
          this.logger.error(`Write error - stopping torrent:`, errorMsg)
          this.errorMessage = `Write failed: ${errorMsg}`
          this.stopNetwork()
          this.activePieces?.removeFullyResponded(index)
          ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)
          return
        }
      } else if (expectedHash) {
        // No storage but have hash - verify anyway (shouldn't happen in practice)
        const actualHash = await this.btEngine.hasher.sha1(pieceData, 'piece-verify')
        if (compare(actualHash, expectedHash) !== 0) {
          this.handleHashMismatch(index, contributors)
          return
        }
      }

      // Mark as verified
      this.markPieceVerified(index)
      this.activePieces?.removeFullyResponded(index)

      // Track disk write throughput
      ;(this.engine as BtEngine).bandwidthTracker.record('disk', pieceData.length, 'down')

      // Update cached downloaded bytes on file objects
      this.updateFileProgressForVerifiedPiece(index)

      // Queue HAVE for batch broadcast at end of tick (Phase 5 optimization)
      // Instead of iterating all peers here, we batch HAVEs and send them
      // together in the OUTPUT phase of the tick loop.
      this._tickLoop.queueHave(index)
    }

    const progressPct =
      this.piecesCount > 0 ? ((this.completedPiecesCount / this.piecesCount) * 100).toFixed(1) : '0'

    this.logger.debug(
      `Piece ${index} verified [${this.completedPiecesCount}/${this.piecesCount}] ${progressPct}%`,
    )

    this.emit('piece', index)

    // Check completion first so completedAt is set before persisting
    const hadCompletedAt = !!this.completedAt
    this.checkCompletion()

    const btEngine = this.engine as BtEngine
    if (!hadCompletedAt && this.completedAt) {
      // Torrent just completed - save immediately
      btEngine.sessionPersistence?.saveTorrentState(this)
    } else {
      // Schedule throttled persistence for piece completions
      // (avoids excessive storage writes during fast downloads)
      btEngine.sessionPersistence?.schedulePiecePersistence(this)
    }
  }

  /**
   * Verify hash and write a boundary piece to .parts file.
   * Uses sha1TransferThen callback pattern for type-safe buffer handling -
   * the original pieceData is not accessible inside the callback, preventing
   * accidental use of the detached buffer after transfer.
   *
   * @returns success=true with bytesWritten, or success=false if hash mismatch or error
   */
  private async verifyAndWriteBoundaryPiece(
    index: number,
    pieceData: Uint8Array,
    expectedHash: Uint8Array | undefined,
    contributors: string[],
  ): Promise<{ success: true; bytesWritten: number } | { success: false }> {
    // Helper to write piece data to .parts and content storage
    const writePiece = async (data: Uint8Array): Promise<void> => {
      await this._diskQueue.drain()
      await this._partsFile!.addPieceAndFlush(index, data)
      this._diskQueue.resume()
      this._partsFilePieces.add(index)
      if (this.contentStorage) {
        await this.contentStorage.writePieceFilteredByPriority(index, data)
      }
      this.logger.debug(
        `Boundary piece ${index} stored in .parts file (wanted portions written to files)`,
      )
    }

    try {
      if (expectedHash && this.btEngine.hasher.sha1TransferThen) {
        // Use callback pattern: pieceData is not accessible inside the callback,
        // preventing accidental use of detached buffer after transfer
        const bytesWritten = await this.btEngine.hasher.sha1TransferThen(
          pieceData,
          async (hash, validData) => {
            if (compare(hash, expectedHash) !== 0) {
              return null // Signal hash mismatch
            }
            await writePiece(validData)
            return validData.length
          },
          'piece-verify',
        )
        if (bytesWritten === null) {
          this.handleHashMismatch(index, contributors)
          return { success: false }
        }
        return { success: true, bytesWritten }
      } else {
        // Fallback: regular sha1 (no buffer transfer, pieceData stays valid)
        if (expectedHash) {
          const actualHash = await this.btEngine.hasher.sha1(pieceData, 'piece-verify')
          if (compare(actualHash, expectedHash) !== 0) {
            this.handleHashMismatch(index, contributors)
            return { success: false }
          }
        }
        await writePiece(pieceData)
        return { success: true, bytesWritten: pieceData.length }
      }
    } catch (e) {
      this._diskQueue.resume()
      const errorMsg = e instanceof Error ? e.message : String(e)
      this.logger.error(`Failed to write boundary piece to .parts:`, errorMsg)
      this.errorMessage = `Write failed: ${errorMsg}`
      this.stopNetwork()
      this.activePieces?.removeFullyResponded(index)
      ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)
      return { success: false }
    }
  }

  /**
   * Retry writing a piece after a transient error.
   * This is called from the retry timer in finalizePiece's error handler.
   */
  private async retryPieceWrite(
    index: number,
    pieceData: Uint8Array,
    expectedHash: Uint8Array | undefined,
  ): Promise<void> {
    if (!this.contentStorage) {
      this.logger.error(`Cannot retry piece ${index} write: no content storage`)
      return
    }

    try {
      const usedVerifiedWrite = await this.contentStorage.writePieceVerified(
        index,
        pieceData,
        expectedHash,
      )

      if (!usedVerifiedWrite && expectedHash) {
        // Verified write not available - verify hash in TypeScript
        const actualHash = await this.btEngine.hasher.sha1(pieceData, 'piece-verify')
        if (compare(actualHash, expectedHash) !== 0) {
          // Hash mismatch during retry - this shouldn't happen since we already
          // verified the data, but handle it anyway
          this.logger.error(`Hash mismatch during retry of piece ${index}`)
          this._writeRetryCount.delete(index)
          this.activePieces?.removeFullyResponded(index)
          return
        }
      }

      // Success! Clear retry count and complete the piece
      this._writeRetryCount.delete(index)

      // Mark as verified
      this.markPieceVerified(index)
      this.activePieces?.removeFullyResponded(index)

      // Track disk write throughput
      ;(this.engine as BtEngine).bandwidthTracker.record('disk', pieceData.length, 'down')

      // Update cached downloaded bytes on file objects
      this.updateFileProgressForVerifiedPiece(index)

      // Queue HAVE for batch broadcast
      this._tickLoop.queueHave(index)

      const progressPct =
        this.piecesCount > 0
          ? ((this.completedPiecesCount / this.piecesCount) * 100).toFixed(1)
          : '0'

      this.logger.debug(
        `Piece ${index} verified after retry [${this.completedPiecesCount}/${this.piecesCount}] ${progressPct}%`,
      )

      this.emit('piece', index)

      // Check completion
      const hadCompletedAt = !!this.completedAt
      this.checkCompletion()

      const btEngine = this.engine as BtEngine
      if (!hadCompletedAt && this.completedAt) {
        btEngine.sessionPersistence?.saveTorrentState(this)
      } else {
        btEngine.sessionPersistence?.schedulePiecePersistence(this)
      }
    } catch (e) {
      // Rethrow to let the same error handling logic in finalizePiece apply
      // But since we're in a setTimeout, we need to handle it inline
      const writeError = e instanceof WriteError ? e : classifyError(e, `piece ${index}`)
      const errorMsg = e instanceof Error ? e.message : String(e)

      // Fatal errors: stop immediately
      if (writeError.isFatal) {
        this._writeRetryCount.delete(index)
        this.logger.error(
          `Fatal write error during retry (${writeError.errorType}) - stopping torrent:`,
          errorMsg,
        )
        this.errorMessage = `Write failed: ${errorMsg}`
        this.stopNetwork()
        this.activePieces?.removeFullyResponded(index)
        ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)
        return
      }

      // Retryable errors: check retry count
      if (writeError.isRetryable) {
        const retryCount = this._writeRetryCount.get(index) ?? 0
        const delay = getRetryDelay(writeError.errorType, retryCount)

        if (delay !== undefined) {
          this._writeRetryCount.set(index, retryCount + 1)
          this.logger.warn(
            `Transient write error during retry (${writeError.errorType}), retry ${retryCount + 1} in ${delay}ms:`,
            errorMsg,
          )

          setTimeout(() => {
            if (!this._networkActive) return
            this.retryPieceWrite(index, pieceData, expectedHash)
          }, delay)
          return
        }

        // Max retries exceeded
        this._writeRetryCount.delete(index)
        this.logger.error(
          `Write failed after ${retryCount} retries during retry (${writeError.errorType}) - stopping torrent:`,
          errorMsg,
        )
        this.errorMessage = `Write failed after retries: ${errorMsg}`
        this.stopNetwork()
        this.activePieces?.removeFullyResponded(index)
        ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)
        return
      }

      // Unknown error: treat as fatal
      this._writeRetryCount.delete(index)
      this.logger.error(`Write error during retry - stopping torrent:`, errorMsg)
      this.errorMessage = `Write failed: ${errorMsg}`
      this.stopNetwork()
      this.activePieces?.removeFullyResponded(index)
      ;(this.engine as BtEngine).sessionPersistence?.saveTorrentState(this)
    }
  }

  /**
   * Handle hash mismatch for a piece - log, track contributors, and potentially ban.
   *
   * Uses a Bayesian-inspired corruption tracker to decide when to ban:
   * - Sole contributor to a failed piece = immediate ban (proof of guilt)
   * - Multiple failures with same peer as common denominator = likely ban
   * - Swarm health affects threshold (sparse swarm = more cautious)
   *
   * @param contributors - Pre-captured list of peer IDs that contributed blocks.
   *   Must be captured at the start of finalizePiece before any async operations,
   *   because stopNetwork() can clear piece data while finalization is in progress.
   */
  private handleHashMismatch(index: number, contributors: string[]): void {
    this.logger.warn(`Piece ${index} failed hash check. Contributors: ${contributors.join(', ')}`)

    // Get swarm health for threshold adjustment
    const swarmHealth = {
      connected: this._swarm.connectedCount,
      total: this._swarm.size,
    }

    // Record failure and get ban recommendations
    const banDecisions = this._corruptionTracker.recordHashFailure(index, contributors, swarmHealth)

    // Execute bans
    for (const decision of banDecisions) {
      this.banPeerByPeerId(decision)
    }

    // Discard the failed piece data (piece is in pending state after all blocks received)
    this.activePieces?.removeFullyResponded(index)
  }

  /**
   * Ban a peer by their peer ID (from corruption tracker decision).
   * Looks up all swarm entries for this peer ID and bans them.
   */
  private banPeerByPeerId(decision: BanDecision): void {
    const swarmPeers = this._swarm.getPeersByPeerId(decision.peerId)

    if (swarmPeers.length === 0) {
      this.logger.warn(
        `Cannot ban peer ${decision.peerId}: not found in swarm (may have disconnected)`,
      )
      return
    }

    for (const peer of swarmPeers) {
      const key = addressKey(peer)
      this._swarm.ban(key, decision.reason)
      this.logger.info(`Banned ${key} (${peer.clientName ?? 'unknown client'}): ${decision.reason}`)
    }

    // Remove from corruption tracker (no need to track banned peers)
    this._corruptionTracker.removePeer(decision.peerId)
  }

  private async verifyPiece(index: number): Promise<boolean> {
    if (!this.hasMetadata || !this.contentStorage) return false
    const expectedHash = this.getPieceHash(index)
    if (!expectedHash) {
      // If no hashes provided (e.g. Phase 1), assume valid
      return true
    }

    // Read full piece from disk
    const pieceLength = this.getPieceLength(index)
    const data = await this.contentStorage.read(index, 0, pieceLength)

    // Calculate SHA1
    const hash = await this.btEngine.hasher.sha1(data, 'piece-upload-verify')

    // Compare
    return compare(hash, expectedHash) === 0
  }
  /**
   * Destroy the torrent - full teardown before removal.
   * Closes all connections, destroys managers, clears swarm.
   * Use stopNetwork() for temporary pause that preserves state.
   */
  async destroy(options?: { skipAnnounce?: boolean }) {
    const t0 = Date.now()
    this.logger.info(`Destroying (skipAnnounce=${options?.skipAnnounce ?? false})`)

    // Save cached peers before any cleanup mutates swarm state.
    // Must happen while _networkActive is still true and swarm data is intact.
    if (this._networkActive) {
      const persistence = (this.engine as BtEngine).sessionPersistence
      if (persistence) {
        const peers = this._swarm.getGoodPeersForCache()
        if (peers.length > 0) {
          persistence.savePeers(toHex(this.infoHash), peers).catch((e) => {
            this.logger.warn(`Failed to save cached peers: ${e instanceof Error ? e.message : e}`)
          })
        }
      }
    }

    // Cancel graceful stop if in progress
    if (this._gracefulStopping) {
      this._gracefulStopping = false
      if (this._gracefulStopTimer) {
        clearTimeout(this._gracefulStopTimer)
        this._gracefulStopTimer = null
      }
    }

    // CRITICAL: Disable network activity FIRST to prevent new connections.
    // When we close peers below, the 'close' event triggers removePeer() which
    // calls fillPeerSlots() -> runMaintenance() -> requestConnections().
    // Without this flag, we'd create 45+ new connection promises while stopping.
    this._networkActive = false

    // Stop periodic maintenance (request processing is handled by BtEngine.engineTick())
    this._tickLoop.stopMaintenance()
    this.logger.info(`stopMaintenance done at ${Date.now() - t0}ms`)

    // Cancel any pending connection attempts
    this._connectionManager.destroy()
    this.logger.info(`connectionManager.destroy done at ${Date.now() - t0}ms`)

    // Cleanup active pieces manager
    this._streamingScheduler.clear()
    this.activePieces?.destroy()
    this.logger.info(`activePieces.destroy done at ${Date.now() - t0}ms`)

    this.logger.info(`about to check trackerManager (exists=${!!this.trackerManager})`)
    if (this.trackerManager) {
      if (!options?.skipAnnounce) {
        try {
          const t1 = Date.now()
          this.logger.info('starting tracker announce...')
          await this.trackerManager.announce('stopped')
          this.logger.info(`Tracker announce took ${Date.now() - t1}ms`)
        } catch (err) {
          // Announce may fail if IO is disconnected during shutdown - that's ok
          this.logger.warn(
            `Failed to announce stopped: ${err instanceof Error ? err.message : err}`,
          )
        }
      } else {
        this.logger.info('skipping tracker announce (skipAnnounce=true)')
      }
      this.logger.info('calling trackerManager.destroy()...')
      this.trackerManager.destroy()
      this.logger.info(`trackerManager.destroy done at ${Date.now() - t0}ms`)
    } else {
      this.logger.info('no trackerManager to destroy')
    }
    // Close all connected peers (swarm will be updated via markDisconnected)
    const numPeers = this.connectedPeers.length
    this.connectedPeers.forEach((peer) => peer.close())
    this.logger.info(`Closed ${numPeers} peers`)

    // Clear swarm state
    this._swarm.clear()

    if (this.contentStorage) {
      const t2 = Date.now()
      await this.contentStorage.close()
      this.logger.info(`contentStorage.close took ${Date.now() - t2}ms`)
    }
    this.logger.info(`destroy() complete, total ${Date.now() - t0}ms`)
  }

  /**
   * Reset torrent state (progress, stats, file priorities) without clearing metadata.
   * This is used for "Reset State" which clears download progress but preserves the
   * infodict for magnet torrents so metadata doesn't need to be re-fetched.
   */
  resetState(): void {
    this.logger.info('Resetting torrent state')

    // Reset bitfield (progress) to empty
    if (this.hasMetadata && this.piecesCount > 0) {
      this._bitfield = new BitField(this.piecesCount)
      this._firstNeededPiece = 0
    }

    // Reset stats
    this._persisted.totalDownloaded = 0
    this._persisted.totalUploaded = 0

    // Reset file priorities to all normal (0)
    this._filePriorityManager.setStandardPieceLength(this.pieceLength)
    this._filePriorityManager.initFilePriorities()

    // Clear cached file info so it's recomputed with fresh values
    this._files = []

    // Clear partsFilePieces tracking
    this._partsFilePieces.clear()

    this.logger.info('Torrent state reset complete')
  }

  /**
   * Whether this torrent needs a full data check before starting.
   */
  get needsDataCheck(): boolean {
    return this._needsDataCheck
  }

  clearNeedsDataCheck(): void {
    this._needsDataCheck = false
  }

  /**
   * Fast resume verification: check file existence/sizes without hashing.
   * Sets _needsDataCheck = true if a full hash recheck is needed.
   *
   * Uses listTree() for a single RPC call instead of per-file exists()/stat().
   *
   * Mirrors libtorrent's verify_resume_data():
   * - If bitfield is non-empty (session restored): verify files haven't been deleted
   * - If bitfield is empty (no resume data): check if files exist from a previous download
   */
  async verifyResumeData(): Promise<void> {
    if (!this.contentStorage || !this.hasMetadata) return

    const fs = this.contentStorage.storage.getFileSystem()
    const files = this.contentStorage.filesList
    if (files.length === 0) return

    // Determine the common root directory from file paths.
    // Multi-file torrents: paths are "TorrentName/file.txt" → root is "TorrentName"
    // Single-file torrents: path is "filename.ext" → no directory
    const firstSlash = files[0].path.indexOf('/')
    const rootDir = firstSlash >= 0 ? files[0].path.substring(0, firstSlash) : ''

    // Build a map of existing files on disk.
    // For multi-file torrents, use a single listTree call instead of per-file RPCs.
    // For single-file torrents, fall back to stat (only 1 file, no benefit from listTree).
    const diskFiles = new Map<string, number>()
    if (rootDir) {
      try {
        const entries = await fs.listTree(rootDir)
        for (const entry of entries) {
          diskFiles.set(rootDir + '/' + entry.path, entry.size)
        }
      } catch {
        // listTree failed (e.g., root dir doesn't exist) — no files on disk
      }
    } else {
      for (const file of files) {
        try {
          const stat = await fs.stat(file.path)
          diskFiles.set(file.path, stat.size)
        } catch {
          // File doesn't exist or not accessible
        }
      }
    }

    const hasPieces = this._bitfield != null && this._bitfield.count() > 0

    if (hasPieces) {
      // Session restored with bitfield — verify files haven't been deleted/corrupted
      if (this.progress >= 1) {
        // Seed: all wanted files must exist with correct sizes
        for (let i = 0; i < files.length; i++) {
          if (this._filePriorityManager.filePriorities[i] === 1) continue // skipped
          const diskSize = diskFiles.get(files[i].path)
          if (diskSize === undefined) {
            this.logger.info(
              `Resume data check: file "${files[i].path}" not found on disk, need recheck`,
            )
            this._needsDataCheck = true
            return
          }
          if (diskSize < files[i].length) {
            this.logger.info(
              `Resume data check: file "${files[i].path}" size mismatch (${diskSize} < ${files[i].length}), need recheck`,
            )
            this._needsDataCheck = true
            return
          }
        }
        this.logger.debug('Resume data check: all files verified, trusting bitfield')
      } else {
        // Partial download: at least one wanted file should exist
        let anyExist = false
        for (let i = 0; i < files.length; i++) {
          if (this._filePriorityManager.filePriorities[i] === 1) continue
          if (diskFiles.has(files[i].path)) {
            anyExist = true
            break
          }
        }
        if (!anyExist) {
          this.logger.info('Resume data check: no wanted files found on disk, need recheck')
          this._needsDataCheck = true
        } else {
          this.logger.debug('Resume data check: files present, trusting bitfield')
        }
      }
    } else {
      // No resume data — check if files exist from a previous download
      for (const file of files) {
        if (diskFiles.has(file.path)) {
          this.logger.info(`No resume data but file "${file.path}" exists on disk, need recheck`)
          this._needsDataCheck = true
          return
        }
      }
    }
  }

  /**
   * Core piece-by-piece hash verification. Resets bitfield and verifies every piece
   * from disk. Used by both recheckData() (manual) and start() (auto on resume).
   *
   * Uses listTree() to pre-determine which files exist, skipping pieces that only
   * span missing files to avoid unnecessary disk I/O.
   */
  private async _doCheckPieces(): Promise<void> {
    this._isChecking = true
    this._checkingProgress = 0

    // Reset bitfield to 0% (create fresh bitfield)
    this._bitfield = new BitField(this.piecesCount)
    this._firstNeededPiece = 0

    // Clear cached file info so it's recomputed with fresh downloaded values
    this._files = []

    // Clear partsFilePieces tracking - will be rebuilt during recheck
    this._partsFilePieces.clear()

    // Reload .parts file to get current state
    if (this._partsFile) {
      await this._partsFile.load()
    }

    // Close file handles so they're reopened fresh during verification.
    // This detects deleted files - on Linux, deleted files with open handles
    // remain readable until handles are closed.
    if (this.contentStorage) {
      await this.contentStorage.close()
    }

    // Build per-piece skip map using listTree to avoid unnecessary disk I/O.
    // A piece can be skipped if all files it spans are missing and it's not in .parts.
    // For multi-file torrents, use a single listTree call; for single-file, use exists.
    const pieceHasFile = new Uint8Array(this.piecesCount) // 0 = no existing files
    if (this.contentStorage) {
      const fs = this.contentStorage.storage.getFileSystem()
      const files = this.contentStorage.filesList
      if (files.length > 0) {
        const firstSlash = files[0].path.indexOf('/')
        const rootDir = firstSlash >= 0 ? files[0].path.substring(0, firstSlash) : ''
        try {
          const existingFiles = new Set<string>()
          if (rootDir) {
            const entries = await fs.listTree(rootDir)
            for (const entry of entries) {
              existingFiles.add(rootDir + '/' + entry.path)
            }
          } else {
            for (const file of files) {
              try {
                if (await fs.exists(file.path)) {
                  existingFiles.add(file.path)
                }
              } catch {
                // File not accessible
              }
            }
          }
          // Mark pieces that have at least one existing file
          for (const file of files) {
            if (!existingFiles.has(file.path)) continue
            const startPiece = Math.floor(file.offset / this.pieceLength)
            const endPiece = Math.floor((file.offset + file.length - 1) / this.pieceLength)
            for (let p = startPiece; p <= endPiece; p++) {
              pieceHasFile[p] = 1
            }
          }
        } catch {
          // listTree/exists failed — conservatively mark all pieces as having files
          pieceHasFile.fill(1)
        }
      }
    }

    const hasPartsData = this._partsFile && this._partsFile.pieces.size > 0

    try {
      // If no files exist and no .parts data, skip piece loop entirely
      if (pieceHasFile.indexOf(1) === -1 && !hasPartsData) {
        this.logger.info('Data check: no files on disk and no .parts data, skipping verification')
      } else {
        // Phase 1: Verify .parts boundary pieces individually (data is in memory)
        for (let i = 0; i < this.piecesCount; i++) {
          const isBoundary = this.pieceClassification[i] === 'boundary'
          const inParts = isBoundary && this._partsFile?.hasPiece(i)
          if (!inParts) continue
          try {
            const isValid = await this.verifyPieceFromParts(i)
            if (isValid) {
              this._partsFilePieces.add(i)
              this.markPieceVerified(i)
              this.updateFileProgressForVerifiedPiece(i)
            }
          } catch (err) {
            this.logger.debug(`Piece ${i} .parts read error during recheck:`, { err })
          }
        }

        // Phase 2: Batch verify regular pieces using verifyChunks
        await this._batchVerifyPieces(pieceHasFile)
      }
    } finally {
      // Always clear checking state
      this._isChecking = false
      this._checkingProgress = 0
    }

    this.logger.info(
      `Data check complete for ${this.infoHashStr}: ${this._bitfield?.count() ?? 0}/${this.piecesCount} pieces valid (${this._partsFilePieces.size} in .parts)`,
    )

    // Persist the verified bitfield
    this.btEngine.sessionPersistence.schedulePiecePersistence(this)
  }

  /**
   * Batch verify regular (non-.parts) pieces using verifyChunks().
   * Falls back to per-piece verifyPiece() if the backend doesn't support it.
   */
  private async _batchVerifyPieces(pieceHasFile: Uint8Array): Promise<void> {
    if (!this.contentStorage) return

    const fs = this.contentStorage.storage.getFileSystem()
    const files = this.contentStorage.filesList
    if (files.length === 0) return

    // Build list of regular pieces that need verification from disk files.
    // Exclude pieces already verified from .parts and pieces with no files.
    const piecesToVerify: number[] = []
    for (let i = 0; i < this.piecesCount; i++) {
      if (this.hasPiece(i)) continue // already verified (e.g. from .parts)
      if (!pieceHasFile[i]) continue // no files on disk for this piece
      piecesToVerify.push(i)
    }

    if (piecesToVerify.length === 0) {
      this._checkingProgress = 1
      return
    }

    // Try batch verification first, fall back to per-piece on error
    try {
      await this._verifyChunksBatched(fs, files, piecesToVerify)
    } catch (err) {
      this.logger.info('verifyChunks not supported, falling back to per-piece verification', {
        err,
      })
      await this._verifyPieceByPiece(piecesToVerify)
    }
  }

  /**
   * Use verifyChunks() to verify pieces in batches. Sends file layout + hashes
   * to the backend which reads and hashes locally — no piece data crosses the boundary.
   */
  private async _verifyChunksBatched(
    fs: IFileSystem,
    files: { path: string; length: number; offset: number }[],
    piecesToVerify: number[],
  ): Promise<void> {
    const MAX_BATCH_BYTES = 64 * 1024 * 1024 // 64 MB
    const BATCH_SIZE = Math.max(1, Math.floor(MAX_BATCH_BYTES / this.pieceLength))

    // Build the concatenated hashes for ALL pieces (verifyChunks operates on
    // the virtual concatenated file stream, indexed by chunk position)
    const allHashes = new Uint8Array(this.piecesCount * 20)
    for (let i = 0; i < this.piecesCount; i++) {
      const hash = this.getPieceHash(i)
      if (hash) allHashes.set(hash, i * 20)
    }

    // File layout for verifyChunks: path + length (offset is implicit from order)
    const fileLayout = files.map((f) => ({ path: f.path, length: f.length }))

    // Process in contiguous ranges to minimize verifyChunks calls.
    // Group piecesToVerify into contiguous runs, then batch those.
    let verified = 0
    const totalToVerify = piecesToVerify.length

    // Process in batches of BATCH_SIZE pieces
    for (let batchStart = 0; batchStart < totalToVerify; batchStart += BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + BATCH_SIZE, totalToVerify)
      const batchPieces = piecesToVerify.slice(batchStart, batchEnd)

      // Find the range of chunk indices this batch spans
      const startChunk = batchPieces[0]
      const endChunk = batchPieces[batchPieces.length - 1]
      const chunkCount = endChunk - startChunk + 1

      // Slice hashes to only include this batch — backends expect hashes
      // indexed 0-based within the batch, not the full piece hash array
      const batchHashes = allHashes.slice(startChunk * 20, (startChunk + chunkCount) * 20)

      const request: VerifyChunksRequest = {
        files: fileLayout,
        chunkSize: this.pieceLength,
        hashes: batchHashes,
        startChunk,
        chunkCount,
      }

      const results = await fs.verifyChunks(request)

      // Validate result — empty result means backend error (e.g. unknown rootKey, exception)
      if (results.length === 0) {
        throw new Error(
          `verifyChunks returned empty result (expected ${chunkCount} results for batch startChunk=${startChunk})`,
        )
      }

      // Map results back to piece indices
      for (const pieceIndex of batchPieces) {
        const resultIndex = pieceIndex - startChunk
        if (resultIndex < results.length && results[resultIndex] === VerifyChunkResult.MATCH) {
          this.markPieceVerified(pieceIndex)
          this.updateFileProgressForVerifiedPiece(pieceIndex)
        }
      }

      verified += batchPieces.length
      this._checkingProgress = verified / totalToVerify
    }
  }

  /**
   * Fallback: verify pieces one at a time when verifyChunks is not available.
   */
  private async _verifyPieceByPiece(piecesToVerify: number[]): Promise<void> {
    for (let i = 0; i < piecesToVerify.length; i++) {
      const pieceIndex = piecesToVerify[i]
      try {
        const isValid = await this.verifyPiece(pieceIndex)
        if (isValid) {
          this.markPieceVerified(pieceIndex)
          this.updateFileProgressForVerifiedPiece(pieceIndex)
        }
      } catch (err) {
        this.logger.debug(`Piece ${pieceIndex} read error during recheck:`, { err })
      }
      this._checkingProgress = (i + 1) / piecesToVerify.length
    }
  }

  /**
   * Run piece hash verification. Called by the queue manager's checking scheduler.
   * Do not call directly — use the queue manager to serialize checks.
   */
  async performDataCheck(): Promise<void> {
    await this._doCheckPieces()
  }

  async recheckData() {
    // Prevent re-entry if already checking
    if (this._isChecking) {
      this.logger.warn('Recheck already in progress, ignoring')
      return
    }

    this.logger.info(`Rechecking data for ${this.infoHashStr}`)

    if (!this.hasMetadata) return

    // Suspend networking during check (non-destructive, unlike stop())
    const wasNetworkActive = this._networkActive
    if (wasNetworkActive) {
      this.stopNetwork()
    }

    this._isChecking = true // Show 'checking' activity state while queued
    const qm = (this.engine as BtEngine).queueManager
    if (qm) {
      await qm.requestCheckImmediate(this)
    } else {
      await this._doCheckPieces()
    }

    // Note: Don't call checkCompletion() here - recheck shouldn't trigger
    // "download complete" notifications, it's just verifying existing data

    // Resume networking if it was active before recheck
    if (wasNetworkActive) {
      this.start()
    }
  }

  /**
   * Verify a piece from the .parts file.
   */
  private async verifyPieceFromParts(index: number): Promise<boolean> {
    if (!this._partsFile) return false

    const data = this._partsFile.getPiece(index)
    if (!data) return false

    let pieceData = data
    const spans = this.getPieceFileSpans(index)
    const hasWantedSpans = spans.some((span) => !span.skipped)
    if (hasWantedSpans) {
      if (!this.contentStorage) return false

      const assembled = new Uint8Array(this.getPieceLength(index))
      for (const span of spans) {
        if (span.skipped) {
          assembled.set(
            data.subarray(span.pieceOffset, span.pieceOffset + span.length),
            span.pieceOffset,
          )
        } else {
          const fileData = await this.contentStorage.readFileBytes(
            span.fileIndex,
            span.fileOffset,
            span.length,
          )
          assembled.set(fileData, span.pieceOffset)
        }
      }
      pieceData = assembled
    }

    const expectedHash = this.getPieceHash(index)
    if (!expectedHash) {
      // If no hashes provided, assume valid
      return true
    }

    // Calculate SHA1
    const hash = await this.btEngine.hasher.sha1(pieceData, 'piece-upload-verify')

    // Compare
    return compare(hash, expectedHash) === 0
  }

  private checkCompletion() {
    if (this.isDownloadComplete) {
      // Clear ALL active pieces - downloading is done, release memory
      this._streamingScheduler.clear()
      this.activePieces?.destroy()
      this.activePieces = undefined

      // Reset endgame state
      this._endgameManager.reset()

      // Only emit completion events once (completedAt guards against duplicates)
      if (!this.completedAt) {
        this.completedAt = Date.now()
        this.logger.info('Download complete!')
        this.emit('done')
        this.emit('complete')
        // Tell all peers we're no longer interested and that we're now a seeder
        this.notifyPeersWeAreSeeding()

        // Prune swarm to release memory - keep only connected peers for seeding
        // This is especially important on mobile where memory is constrained
        this._swarm.pruneForSeeding()
      }
    }
  }

  public recheckPeers() {
    this.logger.debug('Rechecking all peers')
    for (const peer of this.connectedPeers) {
      // Phase 4: Set piece length for isFast calculation
      if (this.pieceLength > 0) {
        peer.setPieceLength(this.pieceLength)
      }

      // Handle deferred have_all - peer sent HAVE_ALL before we had metadata
      if (peer.deferredHaveAll && this.piecesCount > 0) {
        this.logger.debug('Processing deferred have_all for peer')
        peer.deferredHaveAll = false
        peer.bitfield = BitField.createFull(this.piecesCount)
        peer.haveCount = this.piecesCount
        peer.isSeed = true

        // Seeds are tracked separately - don't add to per-piece availability
        this._availability.onDeferredHaveAll()
        this.logger.debug(`Deferred seed processed (seedCount: ${this._availability.seedCount})`)
      }

      this.updateInterest(peer)
    }
  }

  /**
   * Notify all connected peers that we've become a seeder.
   * - Disconnect any seeder peers (seeder-to-seeder connections have no utility)
   * - Re-send extension handshake with upload_only: 1 (BEP 21)
   * - Send NOT_INTERESTED to all peers
   */
  private notifyPeersWeAreSeeding() {
    this.logger.debug('Notifying peers we are now seeding')

    // Disconnect seeder-to-seeder connections (no utility)
    // Includes peers who sent upload_only (they won't request from us either)
    // Copy array since we're modifying during iteration
    const uploadOnlyPeers = this.connectedPeers.filter((p) => p.isSeed || p.peerUploadOnly)
    for (const peer of uploadOnlyPeers) {
      const reason = peer.isSeed ? 'seeder' : 'upload_only'
      this.logger.info(
        `Disconnecting ${reason} (we completed): ${peer.remoteAddress}:${peer.remotePort}`,
      )
      peer.close()
    }

    // Notify remaining peers (leechers who might want data from us)
    for (const peer of this.connectedPeers) {
      // Re-send extension handshake with upload_only: 1 (BEP 10 allows multiple handshakes)
      if (peer.peerExtensions) {
        peer.sendExtendedHandshake({
          uploadOnly: true,
          metadataSize: this.metadataSize ?? undefined,
        })
      }

      // Send NOT_INTERESTED if we were interested
      if (peer.amInterested) {
        peer.sendMessage(MessageType.NOT_INTERESTED)
        peer.amInterested = false
      }
    }
  }

  // Called by BtEngine when metadata is provided initially (e.g. .torrent file or restored from session)
  public setMetadata(infoBuffer: Uint8Array) {
    this._metadataFetcher.setMetadata(infoBuffer)
    this._cachedInfoDict = undefined // Clear cache so infoDict getter re-parses
  }

  // === Persistence API ===

  /**
   * Get all persisted state for this torrent.
   * Used by SessionPersistence to save torrent state.
   */
  getPersistedState(): TorrentPersistedState {
    return {
      ...this._persisted,
      // Always sync bitfield → completedPieces
      completedPieces: this._bitfield?.getSetIndices() ?? [],
      // Always sync metadataRaw → infoBuffer
      infoBuffer: this.metadataRaw ?? undefined,
      // Always sync filePriorities
      filePriorities: this.filePriorities.length > 0 ? [...this.filePriorities] : undefined,
    }
  }

  /**
   * Restore persisted state for this torrent.
   * Used by SessionPersistence to restore torrent state.
   */
  restorePersistedState(state: TorrentPersistedState): void {
    this._persisted = { ...state }

    // Restore bitfield from completedPieces
    if (state.completedPieces.length && this._bitfield) {
      for (const i of state.completedPieces) {
        this._bitfield.set(i, true)
      }
    }

    // Restore metadata
    if (state.infoBuffer) {
      this._metadataFetcher.setMetadata(state.infoBuffer)
      this._cachedInfoDict = undefined // Clear cache so infoDict getter re-parses
    }

    // Restore file priorities (will be applied when initFilePriorities is called)
    // Note: pieceClassification will be recomputed after metadata is initialized
    // This is handled by calling restoreFilePriorities after metadata initialization
  }

  // === Initialization helpers ===

  /**
   * Initialize torrent from a magnet link.
   */
  initFromMagnet(magnetLink: string): void {
    this._persisted.magnetLink = magnetLink
  }

  /**
   * Initialize torrent from a .torrent file.
   */
  initFromTorrentFile(torrentFileBase64: string): void {
    this._persisted.torrentFileBase64 = torrentFileBase64
  }

  /**
   * Manually add a peer and attempt to connect immediately.
   * Useful for debugging.
   *
   * @param address - Peer address in format 'ip:port' (e.g., '127.0.0.1:8998' or '[::1]:8998')
   */
  manuallyAddPeer(address: string): void {
    // Parse address - handle IPv6 with brackets: [ip]:port
    let ip: string
    let port: number

    if (address.startsWith('[')) {
      // IPv6 format: [ip]:port
      const closeBracket = address.indexOf(']')
      if (closeBracket === -1 || address[closeBracket + 1] !== ':') {
        this.logger.error(`Invalid IPv6 address format: ${address} (expected [ip]:port)`)
        return
      }
      ip = address.slice(1, closeBracket)
      port = parseInt(address.slice(closeBracket + 2), 10)
    } else {
      // IPv4 format: ip:port
      const lastColon = address.lastIndexOf(':')
      if (lastColon === -1) {
        this.logger.error(`Invalid address format: ${address} (expected ip:port)`)
        return
      }
      ip = address.slice(0, lastColon)
      port = parseInt(address.slice(lastColon + 1), 10)
    }

    if (isNaN(port) || port < 1 || port > 65535) {
      this.logger.error(`Invalid port in address: ${address}`)
      return
    }

    this.logger.info(`Manually adding peer: ${ip}:${port}`)

    // Add to swarm with 'manual' source
    const family = detectAddressFamily(ip)
    this._swarm.addPeers([{ ip, port, family }], 'manual')

    // Attempt to connect immediately
    this.connectToPeer({ ip, port })
  }

  /**
   * Add peer hints from magnet link (x.pe parameter) to the swarm.
   * These are typically peers that have the torrent and can help with bootstrapping.
   *
   * @param hints - Array of PeerAddress objects (already parsed with family)
   */
  addPeerHints(hints: PeerAddress[]): void {
    if (hints.length === 0) return

    const added = this._swarm.addPeers(hints, 'magnet_hint')
    if (added > 0) {
      this.logger.info(`Added ${added} magnet peer hints to swarm`)
    }

    // Trigger peer slot filling to connect to hints immediately
    this.fillPeerSlots()
  }
}
