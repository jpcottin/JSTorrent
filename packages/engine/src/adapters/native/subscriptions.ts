/**
 * UI Subscription Manager
 *
 * Push-only model where UI subscribes to data it needs.
 * Engine pushes all subscribed data in a single payload - no RPC calls for detail data.
 *
 * Benefits:
 * - Zero RPC queue pressure
 * - Batched updates in one JSON payload, one FFI crossing
 * - Natural backpressure (if JS slow, pushes less frequent)
 *
 * @see DESIGN-ui-subscriptions.md for architecture details
 */

import type { BtEngine } from '../../core/bt-engine'
import type { Torrent } from '../../core/torrent'
import { toHex } from '../../utils/buffer'
import type { InfoHashHex } from '../../utils/infohash'
import { generateMagnet } from '../../utils/magnet'
import './bindings.d.ts'

/**
 * Subscription types:
 *
 * 'torrents' (hash: '') - Torrent list summary:
 *   - torrents: TorrentSummary[] (name, progress %, speed, state)
 *
 * Per-torrent types (hash: infohash hex):
 *   'peers'    - Connected peers (address, client, up/down speed, flags)
 *   'files'    - File list with completion percentage
 *   'trackers' - Tracker status (url, announce result, peer count)
 *   'pieces'   - Piece map, recent changes, active download states
 *   'details'  - Extended torrent info (creation date, comment, etc.)
 */
export type SubscriptionType =
  | 'torrents'
  | 'torrent'
  | 'peers'
  | 'files'
  | 'trackers'
  | 'pieces'
  | 'details'

/** Hash value for torrent list subscription (empty = all torrents) */
export const TORRENTS_HASH = ''

// ============================================================
// Payload Types
// ============================================================

export interface TorrentSummary {
  infoHash: string
  name: string
  progress: number
  downloadSpeed: number
  uploadSpeed: number
  status: string // TorrentActivityState
  userState: string // TorrentUserState - user's intended state: 'active' | 'stopped' | 'queued' | 'awaitingFileSelection'
  numPeers: number
  swarmPeers: number
  skippedFilesCount: number
  hasMetadata: boolean
  uploaded: number
  addedAt: number
  eta: number | null
  errorMessage: string | undefined
  checkingProgress: number // 0-1, only meaningful when status='checking'
  queuePosition: number | undefined
  forceActive: boolean
  magnetSelectOnly: number[] | undefined
}

export interface PeerInfo {
  key: string
  ip: string
  port: number
  state: string
  kind: 'peer' | 'webseed'
  source: string
  downloadSpeed: number
  uploadSpeed: number
  downloaded: number
  uploaded: number
  requestsPending: number
  progress: number
  isEncrypted: boolean
  isIncoming: boolean
  clientName: string | null
  amInterested: boolean
  peerChoking: boolean
  peerInterested: boolean
  amChoking: boolean
  webSeedUrl: string | null
  webSeedRetryAt: number | null
}

export interface FileInfo {
  index: number
  path: string
  size: number
  downloaded: number
  progress: number
  priority: number
}

export interface FilesData {
  files: FileInfo[]
  rootKey: string | null
}

export interface TrackerInfo {
  url: string
  type: string
  status: string
  seeders: number | null
  leechers: number | null
  lastPeersReceived: number
  uniquePeersDiscovered: number
  lastError: string | null
  connectionFamily: string | undefined
}

export interface PiecesData {
  piecesTotal: number
  piecesCompleted: number
  pieceSize: number
  lastPieceSize: number
  bitfield: string // hex encoded
  recentChanges: number[] // piece indices completed since last push
  activePieceStates: string | undefined // hex-encoded binary
}

export interface TorrentDetails {
  infoHash: string
  addedAt: number
  completedAt: number | null
  totalSize: number
  pieceSize: number
  pieceCount: number
  magnetUrl: string
  rootKey: string | null
  comment: string | null
  createdBy: string | null
  creationDate: number | null
  isPrivate: boolean
}

/**
 * Combined payload sent on each push.
 * Only includes fields that are subscribed to.
 */
export interface StatePayload {
  // Included when subscribed to 'torrents' (hash: '')
  torrents?: TorrentSummary[]

  // Included when subscribed to 'torrent' (hash: specific infoHash)
  // Maps infoHash -> TorrentSummary for single-torrent subscriptions
  torrent?: Record<string, TorrentSummary>

  // Legacy piece changes (for backward compatibility during migration)
  pieceChanges?: Record<string, number[]>
  activePieceStates?: Record<string, string>

  // Included based on per-torrent subscriptions
  peers?: Record<string, PeerInfo[]>
  files?: Record<string, FilesData>
  trackers?: Record<string, TrackerInfo[]>
  pieces?: Record<string, PiecesData>
  details?: Record<string, TorrentDetails>
}

// ============================================================
// SubscriptionManager
// ============================================================

/**
 * Manages UI subscriptions and pushes data to native layer.
 *
 * Single global subscriber model - one UI per engine.
 * Future remote UI would get its own manager instance.
 */
export class SubscriptionManager {
  private subs = new Map<string, Set<SubscriptionType>>() // hash -> types
  private paused = false
  private pushInterval = 500
  private loopTimeout: ReturnType<typeof setTimeout> | null = null
  private engine: BtEngine
  private onPush: (payload: string) => void
  private isReady: () => boolean

  // Track pending piece changes per torrent (cleared after each push)
  private pendingPieceChanges = new Map<string, Set<number>>()

  // Track piece listeners per torrent for cleanup
  private pieceListeners = new Map<string, (index: number) => void>()

  constructor(
    engine: BtEngine,
    onPush: (payload: string) => void,
    isReady: () => boolean = () => true,
  ) {
    this.engine = engine
    this.onPush = onPush
    this.isReady = isReady

    // Auto-cleanup when torrent removed
    engine.on('torrent-removed', (torrent) => {
      const hash = toHex(torrent.infoHash)
      if (this.subs.has(hash)) {
        console.log(
          `[subscriptions] Cleaning up subscriptions for removed torrent ${hash.slice(0, 8)}...`,
        )
        this.subs.delete(hash)
      }
      this.cleanupPieceTracking(torrent)
    })

    // Setup piece tracking for existing torrents
    for (const torrent of engine.torrents) {
      this.setupPieceTracking(torrent)
    }

    // Track new torrents
    engine.on('torrent', (torrent) => {
      this.setupPieceTracking(torrent)
    })
  }

  /**
   * Subscribe to data for a torrent (or 'torrents' for torrent list).
   *
   * For 'torrents' subscription, hash should be '' (empty string).
   * Restarts push loop immediately for fast first update.
   */
  subscribe(type: SubscriptionType, hash: string, intervalMs: number): void {
    let types = this.subs.get(hash)
    if (!types) {
      types = new Set()
      this.subs.set(hash, types)
    }
    types.add(type)
    this.pushInterval = intervalMs
    console.log(
      `[subscriptions] Subscribe: ${type} for ${hash === TORRENTS_HASH ? 'all' : hash.slice(0, 8)}... (interval=${intervalMs}ms)`,
    )
    this.restartLoop()
  }

  /**
   * Unsubscribe from specific data type.
   */
  unsubscribe(type: SubscriptionType, hash: string): void {
    const types = this.subs.get(hash)
    if (types) {
      types.delete(type)
      if (types.size === 0) {
        this.subs.delete(hash)
      }
      console.log(
        `[subscriptions] Unsubscribe: ${type} for ${hash === TORRENTS_HASH ? 'all' : hash.slice(0, 8)}...`,
      )
    }
  }

  /**
   * Unsubscribe all for a torrent (when navigating away from detail view).
   */
  unsubscribeAll(hash: string): void {
    if (this.subs.has(hash)) {
      console.log(
        `[subscriptions] Unsubscribe all for ${hash === TORRENTS_HASH ? 'all' : hash.slice(0, 8)}...`,
      )
      this.subs.delete(hash)
    }
  }

  /**
   * Pause all pushes (screen not visible).
   */
  pause(): void {
    console.log('[subscriptions] Paused')
    this.paused = true
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout)
      this.loopTimeout = null
    }
  }

  /**
   * Resume pushes (screen visible again).
   */
  resume(): void {
    console.log('[subscriptions] Resumed')
    this.paused = false
    this.restartLoop()
  }

  /**
   * Clear all subscriptions.
   */
  clear(): void {
    console.log('[subscriptions] Cleared all subscriptions')
    this.subs.clear()
    this.paused = false
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout)
      this.loopTimeout = null
    }
  }

  /**
   * Check if any subscriptions exist.
   */
  hasSubscriptions(): boolean {
    return this.subs.size > 0
  }

  /**
   * Get current subscription count (for debugging).
   */
  getSubscriptionCount(): number {
    return this.subs.size
  }

  /**
   * Cleanup resources when shutting down.
   */
  destroy(): void {
    this.clear()
    // Cleanup all piece listeners
    for (const torrent of this.engine.torrents) {
      this.cleanupPieceTracking(torrent)
    }
    this.pendingPieceChanges.clear()
    this.pieceListeners.clear()
  }

  // ============================================================
  // Push Loop
  // ============================================================

  private restartLoop(): void {
    if (this.loopTimeout) {
      clearTimeout(this.loopTimeout)
    }
    if (!this.paused) {
      this.loop() // Run immediately
    }
  }

  private loop(): void {
    if (this.paused) return

    // Don't push until engine is ready (session restored, torrents loaded)
    // This prevents pushing empty torrent list during engine startup
    if (!this.isReady()) {
      // Retry after a short delay
      this.loopTimeout = setTimeout(() => this.loop(), 50)
      return
    }

    try {
      const payload = this.buildPayload()
      this.onPush(JSON.stringify(payload))
    } catch (e) {
      console.error('[subscriptions] Error building payload:', e)
      __jstorrent_on_error(JSON.stringify({ error: String(e) }))
    }

    // setTimeout chain - next push after interval
    this.loopTimeout = setTimeout(() => this.loop(), this.pushInterval)
  }

  // ============================================================
  // Payload Building
  // ============================================================

  private buildPayload(): StatePayload {
    const payload: StatePayload = {}

    // Include torrent list only if subscribed to 'torrents'
    const torrentsSubs = this.subs.get(TORRENTS_HASH)
    if (torrentsSubs?.has('torrents')) {
      payload.torrents = this.buildTorrentSummaries()

      // Include piece changes and active states at global level (legacy)
      const pieceChanges = this.collectPieceChanges()
      if (Object.keys(pieceChanges).length > 0) {
        payload.pieceChanges = pieceChanges
      }

      const activePieceStates = this.collectActivePieceStates()
      if (activePieceStates && Object.keys(activePieceStates).length > 0) {
        payload.activePieceStates = activePieceStates
      }
    }

    // Add per-torrent subscribed data
    for (const [hash, types] of this.subs) {
      if (hash === TORRENTS_HASH) continue

      for (const type of types) {
        const data = this.getData(type, hash)
        if (data !== null) {
          switch (type) {
            case 'torrent':
              payload.torrent ??= {}
              payload.torrent[hash] = data as TorrentSummary
              break
            case 'peers':
              payload.peers ??= {}
              payload.peers[hash] = data as PeerInfo[]
              break
            case 'files':
              payload.files ??= {}
              payload.files[hash] = data as FilesData
              break
            case 'trackers':
              payload.trackers ??= {}
              payload.trackers[hash] = data as TrackerInfo[]
              break
            case 'pieces':
              payload.pieces ??= {}
              payload.pieces[hash] = data as PiecesData
              break
            case 'details':
              payload.details ??= {}
              payload.details[hash] = data as TorrentDetails
              break
          }
        }
      }
    }

    return payload
  }

  private getData(type: SubscriptionType, hash: string): unknown {
    const torrent = this.engine.getTorrent(hash)
    if (!torrent) return null

    switch (type) {
      case 'torrent':
        return this.buildTorrentSummary(torrent)
      case 'peers':
        return this.getPeersData(torrent)
      case 'files':
        return this.getFilesData(torrent)
      case 'trackers':
        return this.getTrackersData(torrent)
      case 'pieces':
        return this.getPiecesData(torrent, hash)
      case 'details':
        return this.getDetailsData(torrent)
      default:
        return null
    }
  }

  // ============================================================
  // Data Extraction Methods
  // ============================================================

  private buildTorrentSummaries(): TorrentSummary[] {
    return this.engine.torrents.map((t) => this.buildTorrentSummary(t))
  }

  private buildTorrentSummary(t: Torrent): TorrentSummary {
    return {
      infoHash: toHex(t.infoHash),
      name: t.name,
      progress: t.progress,
      downloadSpeed: t.downloadSpeed,
      uploadSpeed: t.uploadSpeed,
      status: t.activityState,
      userState: t.userState,
      numPeers: t.numPeers,
      swarmPeers: t.swarm.total,
      skippedFilesCount: t.filePriorities.filter((p) => p === 1).length,
      hasMetadata: t.hasMetadata,
      uploaded: t.totalUploaded,
      addedAt: t.addedAt,
      eta: t.eta,
      errorMessage: t.errorMessage,
      checkingProgress: t.checkingProgress,
      queuePosition: t.queuePosition,
      forceActive: t.forceActive,
      magnetSelectOnly: t.magnetSelectOnly,
    }
  }

  private getPeersData(torrent: Torrent): PeerInfo[] {
    const displayPeers = torrent.getDisplayPeers()
    return displayPeers.map((p) => ({
      key: p.key,
      ip: p.ip,
      port: p.port,
      state: p.state,
      kind: p.kind,
      source: p.source,
      downloadSpeed: p.downloadSpeed,
      uploadSpeed: p.uploadSpeed,
      downloaded: p.downloaded,
      uploaded: p.uploaded,
      requestsPending: p.requestsPending,
      progress: p.progress ?? 0,
      isEncrypted: p.isEncrypted,
      isIncoming: p.isIncoming,
      clientName: p.clientName,
      amInterested: p.amInterested,
      peerChoking: p.peerChoking,
      peerInterested: p.peerInterested,
      amChoking: p.amChoking,
      webSeedUrl: p.webSeedUrl,
      webSeedRetryAt: p.webSeedRetryAt,
    }))
  }

  private getFilesData(torrent: Torrent): FilesData {
    const hash = toHex(torrent.infoHash)
    const storageRoot = this.engine.storageRootManager.getRootForTorrent(hash)

    const files = torrent.files
      ? torrent.files.map((f, index) => ({
          index,
          path: f.path,
          size: f.length,
          downloaded: f.downloaded,
          progress: f.length > 0 ? f.downloaded / f.length : 0,
          priority: torrent.filePriorities[index] ?? 0,
        }))
      : []

    return {
      files,
      rootKey: storageRoot?.key ?? null,
    }
  }

  private getTrackersData(torrent: Torrent): TrackerInfo[] {
    const stats = torrent.getTrackerStats()
    return stats.map((t) => ({
      url: t.url,
      type: t.type,
      status: t.status,
      seeders: t.seeders,
      leechers: t.leechers,
      lastPeersReceived: t.lastPeersReceived,
      uniquePeersDiscovered: t.uniquePeersDiscovered,
      lastError: t.lastError,
      connectionFamily: t.connectionFamily,
    }))
  }

  private getPiecesData(torrent: Torrent, hash: string): PiecesData {
    // Get recent changes for this specific torrent
    const changes = this.pendingPieceChanges.get(hash)
    const recentChanges = changes ? Array.from(changes).sort((a, b) => a - b) : []
    changes?.clear()

    return {
      piecesTotal: torrent.piecesCount,
      piecesCompleted: torrent.completedPiecesCount,
      pieceSize: torrent.pieceLength,
      lastPieceSize: torrent.lastPieceLength,
      bitfield: torrent.bitfield?.toHex() ?? '',
      recentChanges,
      activePieceStates: this.packActivePieceStates(torrent),
    }
  }

  private getDetailsData(torrent: Torrent): TorrentDetails {
    const hash = toHex(torrent.infoHash)
    const magnetUrl =
      torrent.magnetLink ||
      generateMagnet({
        infoHash: hash as InfoHashHex,
        name: torrent.name,
        announce: torrent.announce,
      })

    const storageRoot = this.engine.storageRootManager.getRootForTorrent(hash)

    return {
      infoHash: hash,
      addedAt: torrent.addedAt,
      completedAt: torrent.completedAt ?? null,
      totalSize: this.getTorrentSize(torrent),
      pieceSize: torrent.pieceLength,
      pieceCount: torrent.piecesCount,
      magnetUrl,
      rootKey: storageRoot?.key ?? null,
      comment: torrent.comment ?? null,
      createdBy: torrent.createdBy ?? null,
      creationDate: torrent.creationDate ?? null,
      isPrivate: torrent.isPrivate,
    }
  }

  // ============================================================
  // Piece Tracking (for legacy global state push)
  // ============================================================

  private setupPieceTracking(torrent: Torrent): void {
    const infoHash = toHex(torrent.infoHash)
    if (this.pieceListeners.has(infoHash)) return

    const listener = (pieceIndex: number): void => {
      let changes = this.pendingPieceChanges.get(infoHash)
      if (!changes) {
        changes = new Set()
        this.pendingPieceChanges.set(infoHash, changes)
      }
      changes.add(pieceIndex)
    }

    torrent.on('piece', listener)
    this.pieceListeners.set(infoHash, listener)
  }

  private cleanupPieceTracking(torrent: Torrent): void {
    const infoHash = toHex(torrent.infoHash)
    const listener = this.pieceListeners.get(infoHash)
    if (listener) {
      torrent.off('piece', listener)
      this.pieceListeners.delete(infoHash)
    }
    this.pendingPieceChanges.delete(infoHash)
  }

  private collectPieceChanges(): Record<string, number[]> {
    const result: Record<string, number[]> = {}
    for (const [infoHash, changes] of this.pendingPieceChanges) {
      if (changes.size > 0) {
        result[infoHash] = Array.from(changes).sort((a, b) => a - b)
        changes.clear()
      }
    }
    return result
  }

  private collectActivePieceStates(): Record<string, string> | undefined {
    let result: Record<string, string> | undefined
    for (const t of this.engine.torrents) {
      const packed = this.packActivePieceStates(t)
      if (packed) {
        if (!result) result = {}
        result[toHex(t.infoHash)] = packed
      }
    }
    return result
  }

  /**
   * Pack active piece states into a compact binary format (hex-encoded).
   *
   * Format: [partialCount:u16][requestedCount:u16][respondedCount:u16][indices:u16[]]
   */
  private packActivePieceStates(torrent: Torrent): string | undefined {
    const manager = torrent.getActivePieceManager()
    if (!manager || manager.activeCount === 0) {
      return undefined
    }

    const partial = [...manager.partialKeys()]
    const requested = [...manager.fullyRequestedKeys()]
    const responded = [...manager.fullyRespondedKeys()]

    const totalCount = partial.length + requested.length + responded.length
    if (totalCount === 0) {
      return undefined
    }

    // 6 bytes header (3 x u16 counts) + 2 bytes per index
    const buf = new Uint8Array(6 + totalCount * 2)
    const view = new DataView(buf.buffer)

    // Write counts (u16 little-endian)
    view.setUint16(0, partial.length, true)
    view.setUint16(2, requested.length, true)
    view.setUint16(4, responded.length, true)

    // Write indices (u16 little-endian)
    let offset = 6
    for (const idx of partial) {
      view.setUint16(offset, idx, true)
      offset += 2
    }
    for (const idx of requested) {
      view.setUint16(offset, idx, true)
      offset += 2
    }
    for (const idx of responded) {
      view.setUint16(offset, idx, true)
      offset += 2
    }

    return toHex(buf)
  }

  // ============================================================
  // Utility
  // ============================================================

  private getTorrentSize(t: Torrent): number {
    if (t.piecesCount === 0) return 0
    return (t.piecesCount - 1) * t.pieceLength + t.lastPieceLength
  }
}

// ============================================================
// Global Function Bindings (for Kotlin to call)
// ============================================================

let subscriptionManager: SubscriptionManager | null = null

/**
 * Initialize the subscription manager.
 * Called from bundle-entry.ts during engine initialization.
 *
 * @param isReady - Callback that returns true when engine is fully ready (session restored).
 *                  Subscriptions won't push data until this returns true.
 */
export function initSubscriptionManager(
  engine: BtEngine,
  onPush: (payload: string) => void,
  isReady: () => boolean = () => true,
): SubscriptionManager {
  if (subscriptionManager) {
    console.warn('[subscriptions] Subscription manager already initialized')
    return subscriptionManager
  }
  subscriptionManager = new SubscriptionManager(engine, onPush, isReady)
  return subscriptionManager
}

/**
 * Get the subscription manager instance (for testing/debugging).
 */
export function getSubscriptionManager(): SubscriptionManager | null {
  return subscriptionManager
}

/**
 * Setup global function bindings for Kotlin to call.
 * Must be called after subscription manager is initialized.
 */
export function setupSubscriptionBindings(manager: SubscriptionManager): void {
  // Subscribe to data
  ;(globalThis as Record<string, unknown>).__jstorrent_subscribe = (
    type: string,
    hash: string,
    intervalMs: number,
  ): void => {
    manager.subscribe(type as SubscriptionType, hash, intervalMs)
  }

  // Unsubscribe from specific type
  ;(globalThis as Record<string, unknown>).__jstorrent_unsubscribe = (
    type: string,
    hash: string,
  ): void => {
    manager.unsubscribe(type as SubscriptionType, hash)
  }

  // Unsubscribe all for a hash
  ;(globalThis as Record<string, unknown>).__jstorrent_unsubscribe_all = (hash: string): void => {
    manager.unsubscribeAll(hash)
  }

  // Pause all pushes
  ;(globalThis as Record<string, unknown>).__jstorrent_pause_subscriptions = (): void => {
    manager.pause()
  }

  // Resume pushes
  ;(globalThis as Record<string, unknown>).__jstorrent_resume_subscriptions = (): void => {
    manager.resume()
  }
}
