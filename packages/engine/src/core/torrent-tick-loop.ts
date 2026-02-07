import { PeerConnection } from './peer-connection'
import { BLOCK_SIZE } from './active-piece'
import { PeerSnapshot, ChokeDecision, DropDecision } from './peer-coordinator'
import { MessageType } from '../protocol/wire-protocol'
import { toHex } from '../utils/buffer'
import { peerKey } from './swarm'
import { EngineComponent, ILoggingEngine } from '../logging/logger'
import type { ActivePieceManager } from './active-piece-manager'
import type { PeerCoordinator } from './peer-coordinator'
import type { PeerSelector } from './peer-selector'
import type { Swarm } from './swarm'
import type { TorrentUploader } from './torrent-uploader'
import type { IDiskQueue } from './disk-queue'
import type { TrafficCategory } from './bandwidth-tracker'
import { getWriteStats, resetWriteStatsMax } from '../adapters/daemon/daemon-file-handle'

// === Constants ===

/**
 * Timeout for individual block requests.
 * Requests older than this are cancelled and the blocks become available
 * for reassignment to other peers.
 */
export const BLOCK_REQUEST_TIMEOUT_MS = 10_000 // 10 seconds

/**
 * Piece-level no-data timeout (libtorrent's piece_timeout).
 * If no data arrives for a piece for this long, snub all requesting peers.
 * More aggressive than per-request timeout — catches peers that accept
 * requests but don't send data.
 *
 * libtorrent reference: peer_connection.cpp piece_timeout check
 */
export const PIECE_NO_DATA_TIMEOUT_MS = 20_000 // 20 seconds

/**
 * How often to run piece health cleanup (every N ticks).
 * With 100ms tick interval, 5 = every 500ms.
 */
export const CLEANUP_TICK_INTERVAL = 5

/**
 * Adaptive maintenance intervals.
 * Starts frequent (500ms) for quick connection establishment,
 * then backs off to 5s steady-state.
 */
export const MAINTENANCE_INTERVALS = [500, 1000, 1000, 2000, 2000, 5000]

/**
 * Callback interface for TorrentTickLoop to communicate with Torrent.
 * This provides access to torrent state and methods needed by the tick loops.
 */
export interface TickLoopCallbacks {
  // State queries
  isNetworkActive(): boolean
  isKillSwitchEnabled(): boolean
  isComplete(): boolean
  getMaxPeers(): number
  getNumPeers(): number
  getInfoHashStr(): string

  // Peer access
  getConnectedPeers(): PeerConnection[]
  getPeers(): PeerConnection[]

  // Managers
  getSwarm(): Swarm
  getPeerSelector(): PeerSelector
  getPeerCoordinator(): PeerCoordinator
  getUploader(): TorrentUploader
  getActivePieces(): ActivePieceManager | undefined
  getDiskQueue(): IDiskQueue

  // Bandwidth
  isDownloadRateLimited(): boolean
  getCategoryRate(direction: 'down' | 'up', category: TrafficCategory): number
  getMaxPipelineDepth(): number

  // Actions
  requestPieces(peer: PeerConnection, now: number): void
  requestConnections(infoHashStr: string, count: number): void
  fillSendBuffers(peers: PeerConnection[]): void

  // Event emission
  emitInvariantViolation(data: {
    type: string
    context?: string
    total: number
    max: number
    peers: number
    connecting: number
    message: string
  }): void

  /**
   * Optional batch flush function for all peers in a single FFI call.
   * When provided, used instead of per-peer flush() calls.
   * On native (Android/iOS), this reduces FFI overhead significantly.
   */
  batchFlushPeers?(peers: PeerConnection[]): void
}

/**
 * Tick statistics for health monitoring (legacy, aggregated over window).
 */
export interface TickStats {
  tickCount: number
  tickTotalMs: number
  tickMaxMs: number
  activePieces: number
  connectedPeers: number
}

/**
 * Per-tick result snapshot returned from tick().
 * Contains current state - Kotlin aggregates as needed.
 */
export interface TickResult {
  // This tick's work
  blocksRecv: number
  blocksSent: number
  elapsedMs: number

  // Current state snapshot
  activePieces: number
  connectedPeers: number
  bufferedBytes: number // TCP buffers waiting to be processed

  // Pipeline state
  pipelineFilled: number // requests currently outstanding
  pipelineMax: number // max pipeline depth across peers
}

/**
 * Handles periodic tick loops for torrent operations.
 *
 * This class manages two critical periodic tasks:
 *
 * 1. **Request Tick** (~100ms): Fills peer request pipelines, runs piece health cleanup
 * 2. **Maintenance** (adaptive 500ms→5s): Peer coordination, choke/unchoke, slot filling
 *
 * These are the "hot paths" of the torrent engine - understanding and optimizing
 * them is critical for download performance.
 *
 * Extracted from Torrent class for:
 * - Easier performance profiling and optimization
 * - Clearer separation of periodic vs event-driven logic
 * - Better testability of timing-sensitive code
 */
export class TorrentTickLoop extends EngineComponent {
  static logName = 'tick-loop'

  // === Request Tick State ===
  private _tickCount = 0
  private _tickTotalMs = 0
  private _tickMaxMs = 0
  private _lastTickLogTime = 0
  private _cleanupTickCounter = 0

  // === HAVE Batching (Phase 5) ===
  // Instead of broadcasting HAVE to all peers immediately when a piece completes,
  // we queue them here and flush at the end of the tick. This batches multiple
  // piece completions into a single pass over peers.
  private _pendingHaves: number[] = []

  // === Maintenance State ===
  private _maintenanceInterval: ReturnType<typeof setTimeout> | null = null
  private _maintenanceStep = 0
  private _maintCount = 0
  private _maintTotalMs = 0
  private _maintMaxMs = 0
  private _lastMaintLogTime = 0
  private _maintSnapshotMs = 0
  private _maintCoordinatorMs = 0
  private _maintApplyMs = 0
  private _lastBackpressureLogTime = 0

  constructor(
    engineInstance: ILoggingEngine,
    private callbacks: TickLoopCallbacks,
  ) {
    super(engineInstance)
  }

  /**
   * Flush all pending sends for the given peers.
   * Uses batch flush if available (single FFI call on native), otherwise per-peer flush.
   */
  private flushPeers(peers: PeerConnection[]): void {
    if (this.callbacks.batchFlushPeers) {
      this.callbacks.batchFlushPeers(peers)
    } else {
      for (const peer of peers) {
        peer.flush()
      }
    }
  }

  // ==========================================================================
  // HAVE Batching (Phase 5)
  // ==========================================================================

  /**
   * Queue a HAVE message to be broadcast to all peers at the end of the tick.
   *
   * Instead of iterating through all connected peers immediately when a piece
   * completes (which happens during GATHER phase), we batch the piece indices
   * and send them all at once during the OUTPUT phase.
   *
   * Benefits:
   * - Multiple pieces completing in one tick = single pass over peers
   * - All protocol sends batched together for efficient FFI
   * - Predictable timing (all HAVEs sent at end of tick)
   */
  queueHave(pieceIndex: number): void {
    this._pendingHaves.push(pieceIndex)
  }

  /**
   * Flush all pending HAVE messages to all connected peers.
   * Called at the end of the tick, before flushPeers().
   */
  private flushHaves(peers: PeerConnection[]): void {
    if (this._pendingHaves.length === 0) return

    let havesQueued = 0
    for (const peer of peers) {
      if (peer.handshakeReceived) {
        for (const pieceIndex of this._pendingHaves) {
          peer.sendHave(pieceIndex)
          havesQueued++
        }
      }
    }

    if (this._pendingHaves.length > 1 || havesQueued > 20) {
      this.logger.debug(
        `HAVE batch: ${this._pendingHaves.length} pieces to ${peers.length} peers (${havesQueued} messages)`,
      )
    }

    this._pendingHaves = []
  }

  // ==========================================================================
  // Request Tick (Game Loop)
  // ==========================================================================

  // Bottleneck instrumentation accumulators
  private _totalBufferedBytes = 0
  private _totalBlocksReceived = 0
  private _totalRequestsSent = 0
  private _totalPipelineSlots = 0
  private _totalPipelineFilled = 0
  private _phase1TotalMs = 0
  private _phase3TotalMs = 0
  private _phaseUploadTotalMs = 0
  private _phase4TotalMs = 0

  /**
   * Process one tick for this torrent.
   * Called by BtEngine.engineTick() at 100ms intervals.
   *
   * Game loop pattern:
   * 1. GATHER - drain all input buffers (TCP data accumulated since last tick)
   * 2. PROCESS - protocol parsing, piece state updates, cleanup
   * 3. REQUEST - request pieces from eligible peers
   * 4. OUTPUT - flush all pending sends
   *
   * Returns snapshot of this tick's work and current state.
   */
  tick(): TickResult | null {
    if (!this.callbacks.isNetworkActive()) return null

    const startTime = Date.now()
    const connectedPeers = this.callbacks.getConnectedPeers()

    // Measure buffer state before drain (for bottleneck analysis)
    let bufferedBytesBefore = 0
    let requestsPendingBefore = 0
    let totalPipelineDepth = 0
    for (const peer of connectedPeers) {
      bufferedBytesBefore += peer.bufferedBytes
      requestsPendingBefore += peer.requestsPending
      totalPipelineDepth += peer.pipelineDepth
    }

    // === Phase 1: GATHER - drain all input buffers ===
    // Process all accumulated TCP data before any other work.
    // This moves processing from unpredictable callbacks to this controlled tick.
    const phase1Start = Date.now()
    for (const peer of connectedPeers) {
      peer.drainBuffer()
    }
    const phase1End = Date.now()
    this._phase1TotalMs += phase1End - phase1Start

    // Count blocks received this tick (measure post-drain state)
    let requestsPendingAfter = 0
    for (const peer of connectedPeers) {
      requestsPendingAfter += peer.requestsPending
    }
    const blocksReceived = requestsPendingBefore - requestsPendingAfter
    this._totalBlocksReceived += Math.max(0, blocksReceived)
    this._totalBufferedBytes += bufferedBytesBefore
    this._totalPipelineSlots += totalPipelineDepth
    this._totalPipelineFilled += requestsPendingBefore

    // === Phase 2: PROCESS - periodic cleanup of stuck pieces ===
    this._cleanupTickCounter++
    if (this._cleanupTickCounter >= CLEANUP_TICK_INTERVAL) {
      this._cleanupTickCounter = 0
      this.cleanupStuckPieces()
    }

    // === Phase 3: REQUEST - fill peer request pipelines ===
    const phase3Start = Date.now()
    let peersProcessed = 0
    let requestsSentThisTick = 0
    for (const peer of connectedPeers) {
      if (!peer.peerChoking && peer.requestsPending < peer.pipelineDepth) {
        const pendingBefore = peer.requestsPending
        this.callbacks.requestPieces(peer, startTime)
        requestsSentThisTick += peer.requestsPending - pendingBefore
        peersProcessed++
      }
    }
    const phase3End = Date.now()
    this._phase3TotalMs += phase3End - phase3Start
    this._totalRequestsSent += requestsSentThisTick

    // === Phase 3.5: UPLOAD - fill peer send buffers from queued upload requests ===
    const phaseUploadStart = Date.now()
    this.callbacks.fillSendBuffers(connectedPeers)
    this._phaseUploadTotalMs += Date.now() - phaseUploadStart

    // === Phase 4: OUTPUT - flush all queued sends ===
    // First, broadcast any pending HAVE messages (batched from piece completions during GATHER)
    const phase4Start = Date.now()
    this.flushHaves(connectedPeers)
    // Then batch all protocol messages into single FFI call (reduces overhead on Android)
    this.flushPeers(connectedPeers)
    const phase4End = Date.now()
    this._phase4TotalMs += phase4End - phase4Start

    const endTime = Date.now()
    const elapsed = endTime - startTime
    this._tickCount++
    this._tickTotalMs += elapsed
    if (elapsed > this._tickMaxMs) {
      this._tickMaxMs = elapsed
    }

    // Log tick stats every 5 seconds with bottleneck metrics
    if (endTime - this._lastTickLogTime >= 5000 && this._tickCount > 0) {
      const avgMs = (this._tickTotalMs / this._tickCount).toFixed(1)
      const activePieces = this.callbacks.getActivePieces()?.activeCount ?? 0
      const avgBufferedKB = (this._totalBufferedBytes / this._tickCount / 1024).toFixed(0)
      const avgBlocksRecv = (this._totalBlocksReceived / this._tickCount).toFixed(1)
      const avgReqSent = (this._totalRequestsSent / this._tickCount).toFixed(1)
      const pipelineUtil =
        this._totalPipelineSlots > 0
          ? ((this._totalPipelineFilled / this._totalPipelineSlots) * 100).toFixed(0)
          : '0'
      const avgPipelineDepth = (this._totalPipelineSlots / this._tickCount).toFixed(0)
      const avgPhase1 = (this._phase1TotalMs / this._tickCount).toFixed(1)
      const avgPhase3 = (this._phase3TotalMs / this._tickCount).toFixed(1)
      const avgPhaseUpload = (this._phaseUploadTotalMs / this._tickCount).toFixed(1)
      const avgPhase4 = (this._phase4TotalMs / this._tickCount).toFixed(1)

      this.logger.info(
        `Tick: ${this._tickCount} ticks, avg ${avgMs}ms (P1:${avgPhase1}/P3:${avgPhase3}/UP:${avgPhaseUpload}/P4:${avgPhase4}), ` +
          `max ${this._tickMaxMs}ms, ${activePieces} active, ${peersProcessed} peers | ` +
          `BUF:${avgBufferedKB}KB, BLOCKS:recv=${avgBlocksRecv}/sent=${avgReqSent}, ` +
          `PIPE:${pipelineUtil}% of ${avgPipelineDepth}`,
      )

      // Log upload stats if there was any upload activity
      const uploader = this.callbacks.getUploader()
      const uploadStats = uploader.getAndResetStats()
      if (uploadStats.readsIssued > 0 || uploader.queueLength > 0) {
        const uploadKB = (uploadStats.bytesUploaded / 1024).toFixed(0)
        this.logger.info(
          `Upload: ${uploadStats.readsIssued} reads issued, ${uploadStats.readsCompleted} completed` +
            (uploadStats.readsFailed > 0 ? `, ${uploadStats.readsFailed} failed` : '') +
            `, ${uploadKB}KB sent, ${uploadStats.peersServed} peers served` +
            `, wmHits=${uploadStats.watermarkHits}` +
            (uploadStats.rateLimitHits > 0 ? `, rlHits=${uploadStats.rateLimitHits}` : '') +
            ` | queue=${uploader.queueLength}, reading=${(uploader.totalReadingBytes / 1024).toFixed(0)}KB` +
            `, ${uploader.activePeerCount} active peers`,
        )
      }

      // Reset all counters
      this._tickCount = 0
      this._tickTotalMs = 0
      this._tickMaxMs = 0
      this._lastTickLogTime = endTime
      this._totalBufferedBytes = 0
      this._totalBlocksReceived = 0
      this._totalRequestsSent = 0
      this._totalPipelineSlots = 0
      this._totalPipelineFilled = 0
      this._phase1TotalMs = 0
      this._phase3TotalMs = 0
      this._phaseUploadTotalMs = 0
      this._phase4TotalMs = 0
    }

    // Measure post-tick state for result
    let bufferedBytesAfter = 0
    let pipelineFilledAfter = 0
    let pipelineMaxAfter = 0
    for (const peer of connectedPeers) {
      bufferedBytesAfter += peer.bufferedBytes
      pipelineFilledAfter += peer.requestsPending
      pipelineMaxAfter += peer.pipelineDepth
    }

    return {
      blocksRecv: Math.max(0, blocksReceived),
      blocksSent: requestsSentThisTick,
      elapsedMs: elapsed,
      activePieces: this.callbacks.getActivePieces()?.activeCount ?? 0,
      connectedPeers: connectedPeers.length,
      bufferedBytes: bufferedBytesAfter,
      pipelineFilled: pipelineFilledAfter,
      pipelineMax: pipelineMaxAfter,
    }
  }

  /**
   * Get current tick statistics for health monitoring.
   * Returns stats from the current logging window (resets every 5 seconds).
   */
  getTickStats(): TickStats {
    return {
      tickCount: this._tickCount,
      tickTotalMs: this._tickTotalMs,
      tickMaxMs: this._tickMaxMs,
      activePieces: this.callbacks.getActivePieces()?.activeCount ?? 0,
      connectedPeers: this.callbacks.getConnectedPeers().length,
    }
  }

  // ==========================================================================
  // Piece Health Management
  // ==========================================================================

  /**
   * Clean up stuck pieces: snub slow peers and timeout stale requests.
   *
   * Two-level timeout system (libtorrent alignment):
   * 1. Peer-level snubbing: If a peer hasn't sent data within their adaptive
   *    timeout (RTT-based), snub them (pipeline → 1).
   * 2. Per-request timeout: Individual requests exceeding the peer's timeout
   *    are cancelled and blocks freed for reassignment.
   *
   * Note: Pieces are never abandoned — libtorrent never abandons pieces with
   * received data. Failed peers are simply blocked from this piece, allowing
   * other peers to complete it.
   *
   * libtorrent reference: peer_connection.cpp:4565-4588
   */
  private cleanupStuckPieces(): void {
    const activePieces = this.callbacks.getActivePieces()
    if (!activePieces) return

    const now = Date.now()
    const connectedPeers = this.callbacks.getConnectedPeers()

    // --- Phase 1: Peer-level snub detection ---
    // Check each peer with outstanding requests for timeout
    let peersSnubbed = 0
    for (const peer of connectedPeers) {
      if (
        peer.requestsPending > 0 &&
        !peer.snubbed &&
        peer.lastReceiveTime > 0 &&
        now - peer.lastReceiveTime > peer.requestTimeout()
      ) {
        peer.snub()
        peersSnubbed++
        this.logger.debug(
          `Snubbed peer ${peer.remoteAddress}:${peer.remotePort} ` +
            `(no data for ${now - peer.lastReceiveTime}ms, timeout=${peer.requestTimeout()}ms)`,
        )
      }
    }

    // --- Phase 2: Per-request stale request cleanup ---
    // Build per-peer timeout lookup: peerId → timeout in ms
    const peerTimeoutMap = new Map<string, number>()
    for (const peer of connectedPeers) {
      const peerId = peer.peerId ? toHex(peer.peerId) : `${peer.remoteAddress}:${peer.remotePort}`
      peerTimeoutMap.set(peerId, peer.requestTimeout())
    }
    const getTimeout = (peerId: string): number =>
      peerTimeoutMap.get(peerId) ?? BLOCK_REQUEST_TIMEOUT_MS

    const piecesToDemote: number[] = []
    let staleRequestsCleared = 0
    let staleRequestsSkipped = 0

    // --- Phase 2 (free_blocks check): Only cancel stale requests that are blocking
    // piece completion. If a piece has free blocks (unrequested blocks), other peers
    // can pick those up instead — no need to cancel the stale request.
    //
    // Partial pieces always have freeBlocks > 0 (by definition), so stale requests
    // in partial pieces are never cancelled. The peer is already snubbed from the
    // Phase 1 check above, and other peers will grab the free blocks.
    //
    // FullyRequested pieces have freeBlocks === 0, so stale requests ARE cancelled
    // (one at a time: after cancelling one, freeBlocks becomes 1 and we stop).
    //
    // libtorrent reference: peer_connection.cpp — only steals blocks when no
    // free blocks remain on the piece.

    // Skip partial pieces — they always have free blocks, so no cancellation needed.
    // Peer snubbing (Phase 1 above) is sufficient for partial pieces.

    // Check fullyRequested pieces for stale requests with free_blocks gating
    for (const piece of activePieces.fullyRequestedValues()) {
      const staleRequests = piece.getStaleRequestsPerPeer(getTimeout, now)
      for (const { blockIndex, peerId } of staleRequests) {
        // free_blocks check: only cancel if this block is blocking piece completion
        if (piece.freeBlocks > 0) {
          staleRequestsSkipped++
          continue
        }

        // freeBlocks === 0: this stale request is blocking completion. Cancel it.
        const peer = this.findPeerById(peerId)
        if (peer) {
          const begin = blockIndex * BLOCK_SIZE
          const length = Math.min(BLOCK_SIZE, piece.length - begin)
          peer.sendCancel(piece.index, begin, length)
          peer.requestsPending = Math.max(0, peer.requestsPending - 1)
        }
        piece.cancelRequest(blockIndex, peerId)
        staleRequestsCleared++
        // After cancellation, freeBlocks is now > 0, so subsequent stale requests
        // for this piece will be skipped (other peers can grab the freed block).
      }

      // If piece now has unrequested blocks, demote back to partial
      if (piece.hasUnrequestedBlocks) {
        piecesToDemote.push(piece.index)
      }
    }

    // Demote full pieces back to partial if they have unrequested blocks
    for (const index of piecesToDemote) {
      activePieces.demoteToPartial(index)
    }

    // --- Phase 3: Piece-level no-data timeout ---
    // If no data arrives for a piece for PIECE_NO_DATA_TIMEOUT_MS, snub all
    // requesting peers. This is more aggressive than per-request timeout and
    // catches peers that accept requests but don't send data.
    let pieceTimeoutSnubs = 0
    for (const piece of activePieces.downloadingValues()) {
      if (piece.outstandingRequests > 0 && now - piece.lastActivity > PIECE_NO_DATA_TIMEOUT_MS) {
        const requestingPeers = piece.getRequestingPeers()
        for (const peerId of requestingPeers) {
          const peer = this.findPeerById(peerId)
          if (peer && !peer.snubbed) {
            peer.snub()
            pieceTimeoutSnubs++
            this.logger.debug(
              `Piece timeout snub: peer ${peer.remoteAddress}:${peer.remotePort} ` +
                `(piece ${piece.index} inactive for ${now - piece.lastActivity}ms)`,
            )
          }
        }
      }
    }

    // Log if we did any cleanup
    if (
      staleRequestsCleared > 0 ||
      staleRequestsSkipped > 0 ||
      piecesToDemote.length > 0 ||
      peersSnubbed > 0 ||
      pieceTimeoutSnubs > 0
    ) {
      this.logger.debug(
        `Piece health cleanup: ${staleRequestsCleared} stale cancelled, ` +
          `${staleRequestsSkipped} skipped (free blocks), ` +
          `${piecesToDemote.length} demoted to partial, ${peersSnubbed} peers snubbed` +
          (pieceTimeoutSnubs > 0 ? `, ${pieceTimeoutSnubs} piece-timeout snubs` : ''),
      )
    }
  }

  /**
   * Find a connected peer by their ID string.
   * Used by cleanupStuckPieces to send CANCEL messages.
   */
  private findPeerById(peerId: string): PeerConnection | undefined {
    for (const peer of this.callbacks.getConnectedPeers()) {
      const pId = peer.peerId ? toHex(peer.peerId) : `${peer.remoteAddress}:${peer.remotePort}`
      if (pId === peerId) {
        return peer
      }
    }
    return undefined
  }

  // ==========================================================================
  // Maintenance Loop
  // ==========================================================================

  /**
   * Start adaptive maintenance - runs frequently at first, then backs off.
   * Intervals: 500ms, 1s, 1s, 2s, 2s, then 5s steady-state
   */
  startMaintenance(): void {
    if (this._maintenanceInterval) return

    this._maintenanceStep = 0
    this.scheduleNextMaintenance()
  }

  /**
   * Schedule the next maintenance cycle with adaptive interval.
   */
  private scheduleNextMaintenance(): void {
    const delay =
      MAINTENANCE_INTERVALS[Math.min(this._maintenanceStep, MAINTENANCE_INTERVALS.length - 1)]

    this._maintenanceInterval = setTimeout(() => {
      this.runMaintenance()
      this._maintenanceStep++

      if (this.callbacks.isNetworkActive()) {
        this.scheduleNextMaintenance()
      }
    }, delay)
  }

  /**
   * Stop periodic maintenance.
   */
  stopMaintenance(): void {
    if (this._maintenanceInterval) {
      clearTimeout(this._maintenanceInterval)
      this._maintenanceInterval = null
    }
    this._maintenanceStep = 0
  }

  /**
   * Run maintenance: peer coordination and slot filling.
   * Instrumented for performance monitoring - logs timing every 5s.
   */
  runMaintenance(): void {
    const maintStart = Date.now()

    // Always check invariants regardless of state
    this.checkSwarmInvariants()

    if (!this.callbacks.isNetworkActive()) return
    if (this.callbacks.isKillSwitchEnabled()) return

    const swarm = this.callbacks.getSwarm()
    const peerSelector = this.callbacks.getPeerSelector()
    const coordinator = this.callbacks.getPeerCoordinator()
    const peers = this.callbacks.getPeers()

    // === Phase 1: Build peer snapshots ===
    const snapshotStart = Date.now()
    const snapshots = this.buildPeerSnapshots(peers)
    const snapshotMs = Date.now() - snapshotStart
    this._maintSnapshotMs += snapshotMs

    // === Phase 2: Run peer coordinator (BEP 3 choke algorithm + download optimizer) ===
    const coordStart = Date.now()
    // Skip speed-based peer drops when we're heavily rate-limited
    const skipSpeedChecks = this.callbacks.isDownloadRateLimited()

    // Check candidates ONCE (fix: was calling getConnectablePeers twice)
    const connected = this.callbacks.getNumPeers()
    const connecting = swarm.connectingCount
    const maxPeers = this.callbacks.getMaxPeers()
    const slotsAvailable = maxPeers - connected - connecting
    const swarmSize = swarm.size

    // Get candidates once, reuse for both hasSwarmCandidates and candidateCount
    const candidates = slotsAvailable > 0 ? peerSelector.getConnectablePeers(slotsAvailable) : []
    const hasSwarmCandidates = candidates.length > 0

    const { unchoke, drop } = coordinator.evaluate(snapshots, hasSwarmCandidates, {
      skipSpeedChecks,
    })
    const coordMs = Date.now() - coordStart
    this._maintCoordinatorMs += coordMs

    // === Phase 3: Apply decisions ===
    const applyStart = Date.now()
    for (const decision of unchoke) {
      this.applyUnchokeDecision(peers, decision)
    }

    // Apply drop decisions (only when downloading - don't drop peers for slow download when seeding)
    if (!this.callbacks.isComplete()) {
      for (const decision of drop) {
        this.applyDropDecision(peers, decision)
      }
    }
    const applyMs = Date.now() - applyStart
    this._maintApplyMs += applyMs

    // Flush all queued sends (CHOKE/UNCHOKE messages from above)
    this.flushPeers(peers)

    // === Phase 4: Request connection slots from engine ===
    if (this.callbacks.isComplete()) {
      this.logMaintenanceStats(maintStart, swarm)
      return // Don't seek peers when complete
    }

    if (slotsAvailable <= 0) {
      this.logger.debug(
        `Maintenance: no slots (connected=${connected}, connecting=${connecting}, max=${maxPeers})`,
      )
      this.logMaintenanceStats(maintStart, swarm)
      return
    }

    const candidateCount = candidates.length
    if (candidateCount === 0) {
      this.logger.warn(
        `Maintenance: 0 candidates! swarm=${swarmSize}, connected=${connected}, connecting=${connecting}`,
      )
      this.logMaintenanceStats(maintStart, swarm)
      return
    }

    // Request slots from engine (will be granted fairly via round-robin)
    const slotsToRequest = Math.min(slotsAvailable, candidateCount)
    this.callbacks.requestConnections(this.callbacks.getInfoHashStr(), slotsToRequest)

    this.logger.info(
      `Maintenance: swarm=${swarmSize}, connected=${connected}, connecting=${connecting}, ` +
        `requested ${slotsToRequest} slots (${candidateCount} candidates)`,
    )

    // Log backpressure stats periodically (every 5s in steady state)
    this.logBackpressureStats()
    this.logMaintenanceStats(maintStart, swarm)
  }

  /**
   * Build peer snapshots for the coordinator algorithms.
   */
  private buildPeerSnapshots(peers: PeerConnection[]): PeerSnapshot[] {
    const now = Date.now()
    return peers.map((peer) => ({
      id: peerKey(peer.remoteAddress!, peer.remotePort!),
      peerInterested: peer.peerInterested,
      peerChoking: peer.peerChoking,
      amChoking: peer.amChoking,
      downloadRate: peer.downloadSpeed,
      connectedAt: peer.connectedAt,
      lastDataReceived: peer.downloadSpeedCalculator.lastActivity || now,
      isIncoming: peer.isIncoming,
      totalBytesReceived: peer.downloadSpeedCalculator.totalBytes,
    }))
  }

  /**
   * Apply an unchoke decision to a peer.
   */
  private applyUnchokeDecision(peers: PeerConnection[], decision: ChokeDecision): void {
    const peer = peers.find((p) => peerKey(p.remoteAddress!, p.remotePort!) === decision.peerId)
    if (!peer) return

    if (decision.action === 'unchoke') {
      if (peer.amChoking) {
        peer.amChoking = false
        peer.sendMessage(MessageType.UNCHOKE)
        this.logger.debug(`Unchoked ${decision.peerId} (${decision.reason})`)
      }
    } else {
      this.chokePeer(peer)
      this.logger.debug(`Choked ${decision.peerId} (${decision.reason})`)
    }
  }

  /**
   * Apply a drop decision to a peer.
   */
  private applyDropDecision(peers: PeerConnection[], decision: DropDecision): void {
    const peer = peers.find((p) => peerKey(p.remoteAddress!, p.remotePort!) === decision.peerId)
    if (!peer) return

    this.logger.info(`Dropping slow peer ${decision.peerId}: ${decision.reason}`)
    peer.close()
  }

  /**
   * Choke a peer and clear their upload queue.
   */
  private chokePeer(peer: PeerConnection): void {
    if (peer.amChoking) return

    peer.amChoking = true
    peer.sendMessage(MessageType.CHOKE)

    // Clear queued uploads for this peer
    const removed = this.callbacks.getUploader().removeQueuedUploads(peer)
    if (removed > 0) {
      this.logger.debug(`Cleared ${removed} queued uploads for choked peer`)
    }
  }

  /**
   * Log maintenance performance stats every 5 seconds.
   */
  private logMaintenanceStats(maintStart: number, swarm: Swarm): void {
    const elapsed = Date.now() - maintStart
    this._maintCount++
    this._maintTotalMs += elapsed
    if (elapsed > this._maintMaxMs) {
      this._maintMaxMs = elapsed
    }

    const now = Date.now()
    if (now - this._lastMaintLogTime >= 5000 && this._maintCount > 0) {
      const avgMs = (this._maintTotalMs / this._maintCount).toFixed(1)
      const avgSnapshotMs = (this._maintSnapshotMs / this._maintCount).toFixed(1)
      const avgCoordMs = (this._maintCoordinatorMs / this._maintCount).toFixed(1)
      const avgApplyMs = (this._maintApplyMs / this._maintCount).toFixed(1)

      this.logger.info(
        `Maintenance: ${this._maintCount} runs, avg ${avgMs}ms (snapshot=${avgSnapshotMs}ms, ` +
          `coord=${avgCoordMs}ms, apply=${avgApplyMs}ms), max ${this._maintMaxMs}ms, ` +
          `swarm=${swarm.size}, peers=${this.callbacks.getNumPeers()}`,
      )

      // Reset counters
      this._maintCount = 0
      this._maintTotalMs = 0
      this._maintMaxMs = 0
      this._maintSnapshotMs = 0
      this._maintCoordinatorMs = 0
      this._maintApplyMs = 0
      this._lastMaintLogTime = now
    }
  }

  /**
   * Log backpressure-related stats for debugging download performance.
   * Logs: active pieces, buffered bytes, outstanding requests.
   */
  private logBackpressureStats(): void {
    const now = Date.now()
    if (now - this._lastBackpressureLogTime < 5000) return
    this._lastBackpressureLogTime = now

    const activePieces = this.callbacks.getActivePieces()
    if (!activePieces) return

    const activeCount = activePieces.activeCount
    const partialCount = activePieces.partialCount
    const fullyRequestedCount = activePieces.fullyRequestedCount
    const fullyRespondedCount = activePieces.fullyRespondedCount
    const bufferedBytes = activePieces.totalBufferedBytes
    const bufferedMB = (bufferedBytes / (1024 * 1024)).toFixed(2)

    // Get peer count and pipeline stats
    const swarm = this.callbacks.getSwarm()
    const connectedPeers = swarm.getConnectedPeers()
    const maxPartials = activePieces.getMaxPartials(connectedPeers.length)
    const pipelineLimit = this.callbacks.getMaxPipelineDepth()

    // Sum outstanding requests and pipeline depth across all peers
    let totalRequests = 0
    let totalPipelineDepth = 0
    for (const peer of connectedPeers) {
      totalRequests += peer.requestsPending
      totalPipelineDepth += peer.pipelineDepth
    }

    // Get disk queue stats
    const diskSnapshot = this.callbacks.getDiskQueue().getSnapshot()
    const diskPending = diskSnapshot.pending.length
    const diskRunning = diskSnapshot.running.length

    // Get disk write rate
    const diskRate = this.callbacks.getCategoryRate('down', 'disk')
    const diskRateMB = (diskRate / (1024 * 1024)).toFixed(1)

    // Get WebSocket write stats (in-flight writes awaiting ACK)
    const writeStats = getWriteStats()

    this.logger.info(
      `Backpressure: ${activeCount} active (${partialCount}/${maxPartials} partial, ${fullyRequestedCount} fullyReq, ${fullyRespondedCount} awaiting write), ` +
        `${bufferedMB}MB buffered, PIPE:${totalRequests}/${totalPipelineDepth} (limit=${pipelineLimit}), ` +
        `disk: ${diskPending}/${diskRunning} queue, ${diskRateMB}MB/s, ` +
        `WS-writes: ${writeStats.inFlight} in-flight (max=${writeStats.maxInFlight}, sent=${writeStats.totalSent}, acked=${writeStats.totalAcked})`,
    )

    // Reset max for next period
    resetWriteStatsMax()
  }

  // ==========================================================================
  // Invariant Checking
  // ==========================================================================

  /**
   * Validate connection state invariants.
   * Swarm is single source of truth for connection state.
   */
  private checkSwarmInvariants(): void {
    const swarm = this.callbacks.getSwarm()
    const swarmStats = swarm.getStats()
    const numPeers = this.callbacks.getNumPeers()
    const maxPeers = this.callbacks.getMaxPeers()

    // Total active connections should not exceed maxPeers (with headroom for in-flight)
    const total = numPeers + swarmStats.byState.connecting
    const maxWithHeadroom = maxPeers + 10 // Allow headroom for in-flight connections
    if (total > maxWithHeadroom) {
      const msg = `total connections (${total}) > maxPeers+headroom (${maxWithHeadroom})`
      this.logger.error(`INVARIANT VIOLATION: ${msg}`)
      this.callbacks.emitInvariantViolation({
        type: 'limit_exceeded',
        total,
        max: maxWithHeadroom,
        peers: numPeers,
        connecting: swarmStats.byState.connecting,
        message: msg,
      })
    }
  }

  /**
   * Assert connection limit immediately after state changes.
   * Allows headroom for in-flight connections.
   */
  assertConnectionLimit(context: string): void {
    const swarm = this.callbacks.getSwarm()
    const numPeers = this.callbacks.getNumPeers()
    const maxPeers = this.callbacks.getMaxPeers()
    const connecting = swarm.connectingCount
    const total = numPeers + connecting
    const maxWithHeadroom = maxPeers + 10
    if (total > maxWithHeadroom) {
      const msg = `${numPeers} peers + ${connecting} connecting = ${total} > ${maxWithHeadroom} max`
      this.logger.error(`LIMIT EXCEEDED [${context}]: ${msg}`)
      this.callbacks.emitInvariantViolation({
        type: 'limit_exceeded',
        context,
        total,
        max: maxWithHeadroom,
        peers: numPeers,
        connecting,
        message: msg,
      })
    }
  }
}
