import { PeerConnection } from './peer-connection'
import { EngineComponent, ILoggingEngine } from '../logging/logger'

/** Queued upload request */
interface QueuedUploadRequest {
  index: number
  begin: number
  length: number
}

/** Per-peer upload state */
interface PeerUploadState {
  requests: QueuedUploadRequest[]
  readingBytes: number
}

/** Token bucket interface for rate limiting */
interface UploadBucket {
  isLimited: boolean
  tryConsume(bytes: number): boolean
  msUntilAvailable(bytes: number): number
}

/** Content storage interface for reading piece data */
interface ContentReader {
  read(index: number, begin: number, length: number): Promise<Uint8Array>
}

/**
 * Handles uploading piece data to peers with rate limiting.
 *
 * Pull-based model: requests are queued per-peer and served during the
 * tick UPLOAD phase via fillSendBuffers(). Disk reads are issued only
 * while the peer's send buffer has room (watermark check).
 *
 * No backpressure choking — requests stay queued until the peer's
 * send buffer drains. Per-peer fairness via independent watermarks.
 */
export class TorrentUploader extends EngineComponent {
  static override logName = 'uploader'

  /** Max bytes in send buffer + in-flight reads before pausing uploads to a peer.
   *  Configurable at runtime via setSendBufferWatermark(). */
  private _sendBufferWatermark = 512 * 1024

  /** Max queued requests per peer before silently rejecting new ones */
  static MAX_REQUEST_QUEUE_PER_PEER = 500

  /** Per-peer upload state */
  private peerState = new Map<PeerConnection, PeerUploadState>()

  /** Upload rate limit bucket */
  private readonly uploadBucket: UploadBucket

  /** Content storage for reading piece data */
  private contentStorage: ContentReader | null = null

  // === Stats accumulators (reset via getAndResetStats()) ===
  private _readsIssued = 0
  private _readsCompleted = 0
  private _readsFailed = 0
  private _watermarkHits = 0
  private _rateLimitHits = 0
  private _bytesUploaded = 0
  private _peersServed = 0

  /** Callback to check if peer is still connected */
  private readonly isPeerConnected: (peer: PeerConnection) => boolean

  /** Callback to check if piece can be served */
  private readonly canServePiece: (index: number) => boolean

  /** Callback to record uploaded bytes for bandwidth tracking */
  private readonly recordUpload: (bytes: number) => void

  constructor(config: {
    engine: ILoggingEngine
    infoHash: Uint8Array
    uploadBucket: UploadBucket
    isPeerConnected: (peer: PeerConnection) => boolean
    canServePiece: (index: number) => boolean
    recordUpload: (bytes: number) => void
  }) {
    super(config.engine)
    this.infoHash = config.infoHash
    this.uploadBucket = config.uploadBucket
    this.isPeerConnected = config.isPeerConnected
    this.canServePiece = config.canServePiece
    this.recordUpload = config.recordUpload
  }

  /**
   * Set the content storage for reading piece data.
   * Must be called before requests can be processed.
   */
  setContentStorage(storage: ContentReader | null): void {
    this.contentStorage = storage
  }

  /** Update the send buffer watermark (bytes). Can be changed at runtime. */
  setSendBufferWatermark(bytes: number): void {
    this._sendBufferWatermark = bytes
  }

  /** Current send buffer watermark value (for stats/logging). */
  get sendBufferWatermark(): number {
    return this._sendBufferWatermark
  }

  /**
   * Queue an upload request from a peer.
   * Validates the request before queueing to the per-peer queue.
   * Does NOT trigger reads — reads happen in fillSendBuffers().
   *
   * @returns true if request was queued, false if rejected
   */
  queueRequest(peer: PeerConnection, index: number, begin: number, length: number): boolean {
    // Validate: we must not be choking this peer
    if (peer.amChoking) {
      this.logger.debug('Ignoring request from choked peer')
      return false
    }

    // Validate: we have this piece and it's serveable (not in .parts)
    if (!this.canServePiece(index)) {
      this.logger.debug(`Ignoring request for piece ${index} - not serveable`)
      return false
    }

    if (!this.contentStorage) {
      this.logger.debug('Ignoring request: no content storage')
      return false
    }

    // Get or create per-peer state
    let state = this.peerState.get(peer)
    if (!state) {
      state = { requests: [], readingBytes: 0 }
      this.peerState.set(peer, state)
    }

    // Per-peer queue limit
    if (state.requests.length >= TorrentUploader.MAX_REQUEST_QUEUE_PER_PEER) {
      return false
    }

    state.requests.push({ index, begin, length })
    return true
  }

  /**
   * Fill peer send buffers from queued upload requests.
   * Called during tick UPLOAD phase. Issues async disk reads
   * gated by per-peer send buffer watermark and global rate limit.
   */
  fillSendBuffers(peers: PeerConnection[]): void {
    if (!this.contentStorage) return

    const storage = this.contentStorage

    for (const peer of peers) {
      const state = this.peerState.get(peer)
      if (!state) continue

      // Choked peers: discard their queued requests
      if (peer.amChoking) {
        this.peerState.delete(peer)
        continue
      }

      let peerIssued = false
      while (state.requests.length > 0) {
        // Watermark check: send buffer + in-flight reads
        if (peer.sendBufferBytes + state.readingBytes >= this._sendBufferWatermark) {
          this._watermarkHits++
          break
        }

        const req = state.requests[0]

        // Global rate limit check
        if (this.uploadBucket.isLimited && !this.uploadBucket.tryConsume(req.length)) {
          this._rateLimitHits++
          return // Rate-limited globally — stop all peers
        }

        state.requests.shift()
        state.readingBytes += req.length
        this._readsIssued++
        peerIssued = true

        // Fire-and-forget async read
        storage.read(req.index, req.begin, req.length).then(
          (block) => {
            state.readingBytes -= req.length
            this._readsCompleted++
            // Final check: peer still connected and unchoked
            if (!this.isPeerConnected(peer)) return
            if (peer.amChoking) return
            peer.sendPiece(req.index, req.begin, block)
            this.recordUpload(block.length)
            this._bytesUploaded += block.length
          },
          (err) => {
            state.readingBytes -= req.length
            this._readsFailed++
            this.logger.error(
              `Error reading for upload: ${err instanceof Error ? err.message : String(err)}`,
              { err },
            )
          },
        )
      }
      if (peerIssued) this._peersServed++

      // Clean up empty state
      if (state.requests.length === 0 && state.readingBytes === 0) {
        this.peerState.delete(peer)
      }
    }
  }

  /**
   * Remove all queued uploads for a peer (e.g., when they disconnect or are choked).
   * @returns number of requests removed
   */
  removeQueuedUploads(peer: PeerConnection): number {
    const state = this.peerState.get(peer)
    if (!state) return 0
    const removed = state.requests.length
    state.requests = []
    // Keep entry if readingBytes > 0 (in-flight reads still need to decrement)
    if (state.readingBytes === 0) {
      this.peerState.delete(peer)
    }
    return removed
  }

  /**
   * Get the total queue length across all peers (for debugging/stats).
   */
  get queueLength(): number {
    let total = 0
    for (const state of this.peerState.values()) {
      total += state.requests.length
    }
    return total
  }

  /** Get total bytes currently being read from disk (in-flight reads). */
  get totalReadingBytes(): number {
    let total = 0
    for (const state of this.peerState.values()) {
      total += state.readingBytes
    }
    return total
  }

  /** Get number of peers with queued or in-flight uploads. */
  get activePeerCount(): number {
    return this.peerState.size
  }

  /**
   * Get accumulated upload stats and reset counters.
   * Called by tick loop for periodic logging.
   */
  getAndResetStats() {
    const stats = {
      readsIssued: this._readsIssued,
      readsCompleted: this._readsCompleted,
      readsFailed: this._readsFailed,
      watermarkHits: this._watermarkHits,
      rateLimitHits: this._rateLimitHits,
      bytesUploaded: this._bytesUploaded,
      peersServed: this._peersServed,
    }
    this._readsIssued = 0
    this._readsCompleted = 0
    this._readsFailed = 0
    this._watermarkHits = 0
    this._rateLimitHits = 0
    this._bytesUploaded = 0
    this._peersServed = 0
    return stats
  }
}
