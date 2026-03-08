import { BLOCK_SIZE, type ActivePiece } from './active-piece'
import { ActivePieceManager } from './active-piece-manager'
import { PieceAvailability } from './piece-availability'
import { EndgameManager } from './endgame-manager'
import { buildStreamingOverlayPlan, STREAM_NOW_PRIORITY } from './streaming-request-overlay'
import { EngineComponent, ILoggingEngine } from '../logging/logger'
import { BitField } from '../utils/bitfield'

/**
 * Represents a peer connection for piece requesting purposes.
 * This interface extracts only what PieceRequester needs from PeerConnection.
 */
export interface RequestablePeer {
  /** Unique identifier for this peer (may be undefined before handshake) */
  peerId?: Uint8Array
  remoteAddress?: string
  remotePort?: number

  /** Whether peer is choking us (can't request if true) */
  peerChoking: boolean

  /** Peer's bitfield (pieces they have) */
  bitfield: BitField | null

  /** Whether peer is a seed (has all pieces) */
  isSeed: boolean

  /** Adaptive pipeline depth for this peer */
  pipelineDepth: number

  /** Number of outstanding requests to this peer */
  requestsPending: number

  /** Recent measured download speed in bytes/sec. */
  downloadSpeed?: number

  /** Whether this peer is currently snubbed. */
  snubbed?: boolean

  /** Whether this peer is still probing throughput in slow-start. */
  inSlowStart?: boolean

  /** Record that a block was received (for adaptive pipeline) */
  recordBlockReceived(): void

  /** Send batched piece requests */
  sendRequests(requests: Array<{ index: number; begin: number; length: number }>): void
}

/**
 * Dependencies injected into PieceRequester.
 * Uses callbacks to avoid tight coupling with Torrent.
 */
export interface PieceRequesterDeps {
  // === State readers ===

  /** Total number of pieces in torrent */
  getPieceCount(): number

  /** Get length of a specific piece */
  getPieceLength(index: number): number

  /** Get piece priority array (0=skip, 1-7 priority) */
  getPiecePriority(): Uint8Array | null

  /** Get our bitfield (pieces we have) */
  getBitfield(): BitField | undefined

  /** Whether download is paused */
  isKillSwitchEnabled(): boolean

  /** Whether network is active */
  isNetworkActive(): boolean

  /** Whether verified-write backlog is currently applying backpressure. */
  isWriteQueueBackpressured(): boolean

  /** Whether we have metadata */
  hasMetadata(): boolean

  /** Number of connected peers */
  getConnectedPeerCount(): number

  /** Number of completed pieces */
  getCompletedPieceCount(): number

  /** First piece index we still need (optimization hint) */
  getFirstNeededPiece(): number

  // === Managers ===

  /** Get the active pieces manager (may be undefined before metadata) */
  getActivePieces(): ActivePieceManager | undefined

  /** Initialize active pieces manager (lazy init) */
  initActivePieces(): ActivePieceManager

  /** Get piece availability tracker */
  getAvailability(): PieceAvailability

  /** Get endgame manager */
  getEndgameManager(): EndgameManager

  // === Bandwidth ===

  /** Get configured max pipeline depth */
  getMaxPipelineDepth(): number

  /** Check if download rate limiting is enabled */
  isDownloadRateLimited(): boolean

  /** Get current download rate limit (bytes/sec) */
  getDownloadRateLimit(): number

  /** Try to consume bandwidth for a block. Returns false if rate limited. */
  tryConsumeDownloadBandwidth(bytes: number): boolean

  // === Callbacks ===

  /** Remove a piece from all peer indices (called when piece activated) */
  removePieceFromAllIndices(index: number): void

  /** Check if a piece should be included in peer indices */
  shouldAddToIndex(pieceIndex: number): boolean

  /** Schedule a retry when rate limited. Callback will be invoked after delay. */
  scheduleRateLimitRetry(delayMs: number, callback: () => void): boolean

  /** Called when endgame state may have changed */
  onEndgameEvaluate(missingCount: number, activeCount: number, hasUnrequestedBlocks: boolean): void

  /** Get peer ID string for logging/tracking */
  getPeerId(peer: RequestablePeer): string
}

/**
 * Handles piece selection and requesting for a torrent.
 *
 * Extracted from Torrent class to reduce complexity and improve testability.
 * Uses dependency injection to avoid tight coupling with Torrent internals.
 *
 * The request algorithm has two phases:
 * 1. Request blocks from existing partial pieces (rarest-first with soft affinity)
 * 2. Activate new pieces when more work is needed (rarest-first selection)
 *
 * Key features:
 * - Rarest-first piece selection using libtorrent's priority formula
 * - Adaptive pipeline depth per-peer
 * - Soft affinity for peers with in-flight requests (reduces piece fragmentation)
 * - Endgame mode support (duplicate requests to finish faster)
 * - Download rate limiting integration
 * - Partial piece cap to prevent "active piece death spiral"
 */
export class TorrentPieceRequester extends EngineComponent {
  static logName = 'piece-requester'

  private deps: PieceRequesterDeps

  // Instrumentation for findNewPieceCandidates
  private _findCandidatesCallCount = 0
  private _findCandidatesLastLogTime = 0

  constructor(engine: ILoggingEngine, deps: PieceRequesterDeps) {
    super(engine)
    this.deps = deps
  }

  /**
   * Request pieces from a peer.
   *
   * Main entry point - fills the peer's pipeline with piece requests.
   * Called when:
   * - Peer unchokes us
   * - New pieces become available
   * - Rate limit retry fires
   * - Periodically from game loop
   *
   * @param peer - The peer to request from
   * @param now - Current timestamp for request tracking
   */
  request(peer: RequestablePeer, now: number): void {
    // Early exit conditions
    if (!this.deps.isNetworkActive()) return
    if (this.deps.isKillSwitchEnabled()) return
    if (this.deps.isWriteQueueBackpressured()) return
    if (peer.peerChoking) return
    if (!this.deps.hasMetadata()) return

    // Get or initialize active pieces manager
    let activePieces = this.deps.getActivePieces()
    if (!activePieces) {
      activePieces = this.deps.initActivePieces()
    }

    // Calculate effective pipeline limit
    const pipelineLimit = this.calculatePipelineLimit(peer)

    // Early exit if pipeline is already full
    if (peer.requestsPending >= pipelineLimit) return

    const peerId = this.deps.getPeerId(peer)
    const peerBitfield = peer.bitfield
    const endgameManager = this.deps.getEndgameManager()
    const isEndgame = endgameManager.isEndgame
    const maxDuplicateRequests = endgameManager.getConfig().maxDuplicateRequests
    const availability = this.deps.getAvailability()

    // Collect requests for batched sending (reduces FFI overhead)
    const pendingRequests: Array<{ index: number; begin: number; length: number }> = []

    // Helper to flush pending requests before early returns
    const flushPending = () => {
      if (pendingRequests.length > 0) {
        peer.sendRequests(pendingRequests)
        pendingRequests.length = 0
      }
    }

    const rawAvailability = availability.rawAvailability
    const piecePriority = this.deps.getPiecePriority()

    const queueStreamingBlocksFromPiece = (piece: ActivePiece, requestLimit: number): boolean => {
      if (peer.requestsPending >= requestLimit) return true
      if (!peer.isSeed && !peerBitfield?.get(piece.index)) return true
      if (!isEndgame && !piece.hasUnrequestedBlocks) return true

      const neededBlocks = isEndgame
        ? piece.getNeededBlocksEndgame(
            peerId,
            requestLimit - peer.requestsPending,
            maxDuplicateRequests,
          )
        : piece.getNeededBlocks(requestLimit - peer.requestsPending)

      for (const block of neededBlocks) {
        if (peer.requestsPending >= requestLimit) break
        if (
          this.deps.isDownloadRateLimited() &&
          !this.deps.tryConsumeDownloadBandwidth(block.length)
        ) {
          flushPending()
          this.deps.scheduleRateLimitRetry(block.length, () => {})
          return false
        }

        pendingRequests.push({ index: piece.index, begin: block.begin, length: block.length })
        peer.requestsPending++

        const blockIndex = Math.floor(block.begin / BLOCK_SIZE)
        piece.addRequest(blockIndex, peerId, now)

        if (!piece.hasUnrequestedBlocks) {
          activePieces.promoteToFullyRequested(piece.index)
        }
      }

      return true
    }

    const streamingOverlay = buildStreamingOverlayPlan({
      peer,
      peerId,
      activePieces,
      piecePriority,
      availability,
      bitfield: this.deps.getBitfield(),
      pieceCount: this.deps.getPieceCount(),
      firstNeededPiece: this.deps.getFirstNeededPiece(),
      pipelineLimit: pipelineLimit - peer.requestsPending,
    })

    if (streamingOverlay.reservedSlots > 0) {
      const overlayLimit = Math.min(
        pipelineLimit,
        peer.requestsPending + streamingOverlay.reservedSlots,
      )

      for (const piece of streamingOverlay.activePieces) {
        if (peer.requestsPending >= overlayLimit) break
        if (!queueStreamingBlocksFromPiece(piece, overlayLimit)) {
          return
        }
      }

      for (const pieceIndex of streamingOverlay.newPieceIndices) {
        if (peer.requestsPending >= overlayLimit) break

        const piece = activePieces.getOrCreate(pieceIndex)
        if (!piece) break
        this.deps.removePieceFromAllIndices(pieceIndex)

        if (!queueStreamingBlocksFromPiece(piece, overlayLimit)) {
          return
        }
      }
    }

    // PHASE 1: Request from existing partial pieces (rarest-first with soft affinity)
    // Two-pass soft affinity: prefer pieces where this peer already has in-flight requests.
    // This reduces piece fragmentation without hard-locking pieces to peers.
    // Like libtorrent's requested_from() — a sort preference, not a hard lock.

    if (rawAvailability && piecePriority) {
      const sortedPartials = activePieces.getPartialsRarestFirst(
        rawAvailability,
        availability.seedCount,
        piecePriority,
      )

      // Pass 1: Pieces where this peer already has in-flight requests (contiguity preference)
      for (const piece of sortedPartials) {
        if (peer.requestsPending >= pipelineLimit) {
          flushPending()
          return
        }

        if (piecePriority[piece.index] === STREAM_NOW_PRIORITY) continue
        if (!peer.isSeed && !peerBitfield?.get(piece.index)) continue
        if (!piece.hasRequestsFromPeer(peerId)) continue
        if (!isEndgame && !piece.hasUnrequestedBlocks) continue

        const neededBlocks = isEndgame
          ? piece.getNeededBlocksEndgame(
              peerId,
              pipelineLimit - peer.requestsPending,
              maxDuplicateRequests,
            )
          : piece.getNeededBlocks(pipelineLimit - peer.requestsPending)

        for (const block of neededBlocks) {
          if (peer.requestsPending >= pipelineLimit) {
            flushPending()
            return
          }

          if (
            this.deps.isDownloadRateLimited() &&
            !this.deps.tryConsumeDownloadBandwidth(block.length)
          ) {
            flushPending()
            this.deps.scheduleRateLimitRetry(block.length, () => {})
            return
          }

          pendingRequests.push({ index: piece.index, begin: block.begin, length: block.length })
          peer.requestsPending++

          const blockIndex = Math.floor(block.begin / BLOCK_SIZE)
          piece.addRequest(blockIndex, peerId, now)

          if (!piece.hasUnrequestedBlocks) {
            activePieces.promoteToFullyRequested(piece.index)
          }
        }
      }

      // Pass 2: Remaining pieces (no existing requests from this peer)
      for (const piece of sortedPartials) {
        if (peer.requestsPending >= pipelineLimit) {
          flushPending()
          return
        }

        if (piecePriority[piece.index] === STREAM_NOW_PRIORITY) continue
        if (!peer.isSeed && !peerBitfield?.get(piece.index)) continue
        if (piece.hasRequestsFromPeer(peerId)) continue // already handled in pass 1
        if (!isEndgame && !piece.hasUnrequestedBlocks) continue

        const neededBlocks = isEndgame
          ? piece.getNeededBlocksEndgame(
              peerId,
              pipelineLimit - peer.requestsPending,
              maxDuplicateRequests,
            )
          : piece.getNeededBlocks(pipelineLimit - peer.requestsPending)

        for (const block of neededBlocks) {
          if (peer.requestsPending >= pipelineLimit) {
            flushPending()
            return
          }

          if (
            this.deps.isDownloadRateLimited() &&
            !this.deps.tryConsumeDownloadBandwidth(block.length)
          ) {
            flushPending()
            this.deps.scheduleRateLimitRetry(block.length, () => {})
            return
          }

          pendingRequests.push({ index: piece.index, begin: block.begin, length: block.length })
          peer.requestsPending++

          const blockIndex = Math.floor(block.begin / BLOCK_SIZE)
          piece.addRequest(blockIndex, peerId, now)

          if (!piece.hasUnrequestedBlocks) {
            activePieces.promoteToFullyRequested(piece.index)
          }
        }
      }
    } else {
      // Fallback: iterate in arbitrary order if availability tracking not ready
      for (const piece of activePieces.partialValues()) {
        if (peer.requestsPending >= pipelineLimit) {
          flushPending()
          return
        }
        if (piecePriority?.[piece.index] === STREAM_NOW_PRIORITY) continue
        if (!peerBitfield?.get(piece.index)) continue
        if (!isEndgame && !piece.hasUnrequestedBlocks) continue

        const neededBlocks = isEndgame
          ? piece.getNeededBlocksEndgame(
              peerId,
              pipelineLimit - peer.requestsPending,
              maxDuplicateRequests,
            )
          : piece.getNeededBlocks(pipelineLimit - peer.requestsPending)

        for (const block of neededBlocks) {
          if (peer.requestsPending >= pipelineLimit) {
            flushPending()
            return
          }
          if (
            this.deps.isDownloadRateLimited() &&
            !this.deps.tryConsumeDownloadBandwidth(block.length)
          ) {
            flushPending()
            this.deps.scheduleRateLimitRetry(block.length, () => {})
            return
          }
          pendingRequests.push({ index: piece.index, begin: block.begin, length: block.length })
          peer.requestsPending++
          const blockIndex = Math.floor(block.begin / BLOCK_SIZE)
          piece.addRequest(blockIndex, peerId, now)

          if (!piece.hasUnrequestedBlocks) {
            activePieces.promoteToFullyRequested(piece.index)
          }
        }
      }
    }

    // PHASE 1b: In endgame mode, also request from fullyRequested pieces (duplicate requests)
    // These pieces have all blocks requested but not all received - we want to request
    // the same blocks from additional peers to finish faster.
    if (isEndgame && rawAvailability && piecePriority) {
      const sortedFullyRequested = activePieces.getFullyRequestedRarestFirst(
        rawAvailability,
        availability.seedCount,
        piecePriority,
      )

      for (const piece of sortedFullyRequested) {
        if (peer.requestsPending >= pipelineLimit) {
          flushPending()
          return
        }

        // Skip if peer doesn't have this piece
        if (!peer.isSeed && !peerBitfield?.get(piece.index)) continue

        // In endgame, we relax speed affinity - any peer can help finish
        // (speed affinity is mainly to prevent piece fragmentation during bulk download)

        // Get blocks this peer hasn't requested yet (for duplicate requests)
        const neededBlocks = piece.getNeededBlocksEndgame(
          peerId,
          pipelineLimit - peer.requestsPending,
          maxDuplicateRequests,
        )

        for (const block of neededBlocks) {
          if (peer.requestsPending >= pipelineLimit) {
            flushPending()
            return
          }

          // Rate limit check
          if (
            this.deps.isDownloadRateLimited() &&
            !this.deps.tryConsumeDownloadBandwidth(block.length)
          ) {
            flushPending()
            this.deps.scheduleRateLimitRetry(block.length, () => {})
            return
          }

          pendingRequests.push({ index: piece.index, begin: block.begin, length: block.length })
          peer.requestsPending++

          const blockIndex = Math.floor(block.begin / BLOCK_SIZE)
          piece.addRequest(blockIndex, peerId, now)
        }
      }
    }

    // PHASE 2: Activate new pieces (rarest-first selection)
    if (peer.requestsPending >= pipelineLimit) {
      flushPending()
      return
    }
    if (!peerBitfield || !this.deps.getBitfield() || !piecePriority || !rawAvailability) {
      flushPending()
      return
    }

    // Partial Cap: Don't start new pieces if we have too many partials
    const connectedPeerCount = this.deps.getConnectedPeerCount()
    if (activePieces.shouldPrioritizePartials(connectedPeerCount)) {
      flushPending()
      return
    }

    // Find candidate pieces sorted by rarity
    const candidates = this.findNewPieceCandidates(peer, pipelineLimit - peer.requestsPending)

    for (const pieceIndex of candidates) {
      if (peer.requestsPending >= pipelineLimit) break

      // Create new active piece
      const piece = activePieces.getOrCreate(pieceIndex)
      if (!piece) break // At capacity

      // Remove from peer indices since it's now active
      this.deps.removePieceFromAllIndices(pieceIndex)

      const neededBlocks = isEndgame
        ? piece.getNeededBlocksEndgame(
            peerId,
            pipelineLimit - peer.requestsPending,
            maxDuplicateRequests,
          )
        : piece.getNeededBlocks(pipelineLimit - peer.requestsPending)

      for (const block of neededBlocks) {
        if (peer.requestsPending >= pipelineLimit) break

        // Rate limit check
        if (
          this.deps.isDownloadRateLimited() &&
          !this.deps.tryConsumeDownloadBandwidth(block.length)
        ) {
          flushPending()
          this.deps.scheduleRateLimitRetry(block.length, () => {})
          return
        }

        pendingRequests.push({ index: pieceIndex, begin: block.begin, length: block.length })
        peer.requestsPending++

        const blockIndex = Math.floor(block.begin / BLOCK_SIZE)
        piece.addRequest(blockIndex, peerId, now)

        if (!piece.hasUnrequestedBlocks) {
          activePieces.promoteToFullyRequested(piece.index)
        }
      }
    }

    // Flush any remaining pending requests
    flushPending()

    // Check if we should enter/exit endgame mode
    const pieceCount = this.deps.getPieceCount()
    const completedCount = this.deps.getCompletedPieceCount()
    const missingCount = pieceCount - completedCount
    this.deps.onEndgameEvaluate(
      missingCount,
      activePieces.activeCount,
      activePieces.hasUnrequestedBlocks(),
    )
  }

  /**
   * Calculate effective pipeline limit for a peer.
   * Takes into account:
   * - Peer's adaptive pipeline depth
   * - Configured max pipeline depth
   * - Rate limit cap when bandwidth limiting is active
   */
  private calculatePipelineLimit(peer: RequestablePeer): number {
    let pipelineLimit = peer.pipelineDepth

    // Apply configurable pipeline depth cap
    pipelineLimit = Math.min(pipelineLimit, this.deps.getMaxPipelineDepth())

    // Cap pipeline depth when rate limited to prevent fast peers from monopolizing bandwidth
    if (this.deps.isDownloadRateLimited()) {
      const rateLimit = this.deps.getDownloadRateLimit()
      const blockSize = 16384 // 16KB standard block

      // Cap at ~1 second worth of bandwidth, minimum 1
      const rateLimitCap = Math.max(1, Math.floor(rateLimit / blockSize))
      pipelineLimit = Math.min(pipelineLimit, rateLimitCap)
    }

    return pipelineLimit
  }

  /**
   * Find new pieces to activate, sorted by rarity.
   *
   * Uses libtorrent's priority formula:
   * sortKey = availability × (PRIORITY_LEVELS - piecePriority) × PRIO_FACTOR
   *
   * Lower sort key = picked first (rarer + higher priority wins)
   *
   * @param peer - The peer to find pieces for
   * @param maxCount - Maximum number of candidates to return
   * @returns Array of piece indices sorted by rarity (rarest first)
   */
  private findNewPieceCandidates(peer: RequestablePeer, maxCount: number): number[] {
    const availability = this.deps.getAvailability()
    const availabilityArray = availability.rawAvailability
    const bitfield = this.deps.getBitfield()
    const piecePriority = this.deps.getPiecePriority()
    const activePieces = this.deps.getActivePieces()

    if (!bitfield || !piecePriority || !availabilityArray || !activePieces) {
      return []
    }

    const startTime = Date.now()
    const candidates: Array<{ index: number; sortKey: number }> = []
    const collectLimit = maxCount * 2
    let iterations = 0
    let usedIndex = false
    const seedCount = availability.seedCount
    const pieceCount = this.deps.getPieceCount()
    const firstNeededPiece = this.deps.getFirstNeededPiece()

    // Use per-peer index for non-seeds (O(pieces peer has) instead of O(all pieces))
    const peerId = this.deps.getPeerId(peer)
    const peerPieceSet = availability.getPeerPieceSet(peerId)

    if (!peer.isSeed && peerPieceSet && peerPieceSet.size > 0) {
      // Use the pre-computed index - only iterate pieces peer has that we need
      usedIndex = true
      for (const i of peerPieceSet) {
        iterations++
        if (candidates.length >= collectLimit) break

        if (bitfield.get(i)) continue
        if (activePieces.has(i)) continue

        const prio = piecePriority[i]
        if (prio === 0 || prio === STREAM_NOW_PRIORITY) continue

        const pieceAvail = availabilityArray[i] + seedCount
        const sortKey = pieceAvail * (8 - prio) * 3 // 8 = PRIORITY_LEVELS, 3 = PRIO_FACTOR

        candidates.push({ index: i, sortKey })
      }
    } else {
      // Seeds or no index: use original linear scan algorithm
      const peerBitfield = peer.bitfield
      for (let i = firstNeededPiece; i < pieceCount && candidates.length < collectLimit; i++) {
        iterations++

        // Skip if we have it
        if (bitfield.get(i)) continue

        // Skip if peer doesn't have it (seeds have everything)
        if (!peer.isSeed && !peerBitfield?.get(i)) continue

        // Skip if priority is 0 (skipped file)
        const prio = piecePriority[i]
        if (prio === 0 || prio === STREAM_NOW_PRIORITY) continue

        // Skip if already active (handled in phase 1)
        if (activePieces.has(i)) continue

        // Calculate sort key using libtorrent formula
        const pieceAvail = availabilityArray[i] + seedCount
        const sortKey = pieceAvail * (8 - prio) * 3

        candidates.push({ index: i, sortKey })
      }
    }

    // Sort by rarity (lower sortKey = rarer/higher priority = first)
    candidates.sort((a, b) => a.sortKey - b.sortKey)

    const elapsed = Date.now() - startTime

    // Log every 5 seconds
    this._findCandidatesCallCount++
    const now = Date.now()
    if (now - this._findCandidatesLastLogTime >= 5000) {
      this.logger.debug(
        `findNewPieceCandidates: ${iterations} iterations, ${candidates.length} found, ` +
          `${elapsed}ms, firstNeeded=${firstNeededPiece}, total=${pieceCount}, ` +
          `calls=${this._findCandidatesCallCount}, maxCount=${maxCount}, usedIndex=${usedIndex}`,
      )
      this._findCandidatesCallCount = 0
      this._findCandidatesLastLogTime = now
    }

    // Return just the indices
    return candidates.slice(0, maxCount).map((c) => c.index)
  }
}
