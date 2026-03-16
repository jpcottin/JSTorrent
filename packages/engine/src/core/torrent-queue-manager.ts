/**
 * TorrentQueueManager
 *
 * Enforces active torrent limits and auto-promotes queued torrents.
 * Inspired by libtorrent's auto-management system.
 *
 * Key concepts:
 * - Torrents with userState='active' and forceActive=false are queue-managed
 * - forceActive=true bypasses queue limits (always runs)
 * - userState='stopped' is completely ignored by the queue
 * - Download queue uses static queue positions; seed queue uses round-robin rotation
 */

import { EngineComponent } from '../logging/logger'
import type { ConfigHub } from '../config/config-hub'
import type { Unsubscribe } from '../config/types'
import type { BtEngine } from './bt-engine'
import type { Torrent } from './torrent'

/** Hard cap on total active auto-managed torrents */
const ACTIVE_LIMIT = 500

/** Periodic re-evaluation interval in ticks (~5s at 100ms tick interval) */
const AUTO_MANAGE_INTERVAL_TICKS = 50

/** Minimum time a seed stays active before eligible for rotation */
const MIN_SEED_ACTIVE_MS = 5 * 60 * 1000

export class TorrentQueueManager extends EngineComponent {
  static logName = 'queue'

  private _dirty = false
  private _tickCount = 0
  private _configUnsubscribers: Unsubscribe[] = []
  /** Tracks when each seed was last activated (infoHashStr → epoch ms) */
  private _seedActivatedAt = new Map<string, number>()

  /** Ordered FIFO queue of torrents waiting to check (by queue position) */
  private _checkingQueue: Torrent[] = []
  /** Torrents currently running performDataCheck() */
  private _activelyChecking = new Set<Torrent>()
  /** Callbacks for requestCheckImmediate callers waiting for completion */
  private _checkCompletionCallbacks = new Map<Torrent, () => void>()

  constructor(
    private btEngine: BtEngine,
    private config: ConfigHub,
  ) {
    super(btEngine)

    // Subscribe to config changes
    this._configUnsubscribers.push(
      config.activeDownloads.subscribe(() => {
        this.logger.info(`activeDownloads changed to ${config.activeDownloads.get()}`)
        this.recalculate()
      }),
    )
    this._configUnsubscribers.push(
      config.activeSeeds.subscribe(() => {
        this.logger.info(`activeSeeds changed to ${config.activeSeeds.get()}`)
        this.recalculate()
      }),
    )
    this._configUnsubscribers.push(
      config.activeChecking.subscribe(() => {
        this.logger.info(`activeChecking changed to ${config.activeChecking.get()}`)
        this._drainCheckingQueue()
      }),
    )
  }

  /**
   * Mark queue as dirty — actual recalculation happens on next tick.
   */
  recalculate(): void {
    this._dirty = true
  }

  /**
   * Called from engine tick. Runs recalculation if dirty or at periodic interval.
   */
  tickCheck(): void {
    this._tickCount++
    if (this._dirty || this._tickCount >= AUTO_MANAGE_INTERVAL_TICKS) {
      this._dirty = false
      this._tickCount = 0
      this._doRecalculate()
    }
  }

  /**
   * Force an immediate recalculation (synchronous, no debounce).
   * Used in tests and for resume().
   */
  recalculateImmediate(): void {
    this._dirty = false
    this._tickCount = 0
    this._doRecalculate()
  }

  /**
   * Called when a new torrent is added to the engine.
   * Assigns a queue position and triggers recalculation.
   */
  onTorrentAdded(torrent: Torrent): void {
    if (torrent.queuePosition === undefined) {
      torrent.queuePosition = this._nextPosition()
    }
    this.recalculate()
  }

  /**
   * Called when a torrent is removed from the engine.
   * Closes position gap and triggers recalculation.
   */
  onTorrentRemoved(torrent: Torrent): void {
    const pos = torrent.queuePosition
    if (pos !== undefined) {
      // Shift all torrents above this position down by 1
      for (const t of this.btEngine.torrents) {
        if (t !== torrent && t.queuePosition !== undefined && t.queuePosition > pos) {
          t.queuePosition--
        }
      }
    }
    this._seedActivatedAt.delete(torrent.infoHashStr)
    this._checkingQueue = this._checkingQueue.filter((t) => t !== torrent)
    this._activelyChecking.delete(torrent)
    const cb = this._checkCompletionCallbacks.get(torrent)
    if (cb) {
      this._checkCompletionCallbacks.delete(torrent)
      cb()
    }
    this.recalculate()
  }

  /**
   * Called when a torrent completes downloading (transitions to seeding).
   * Frees a download slot.
   */
  onTorrentCompleted(_torrent: Torrent): void {
    this.recalculate()
  }

  /**
   * Request a data check for a torrent. The check will be serialized
   * through the checking queue (only activeChecking torrents check concurrently).
   * The torrent's _isChecking should already be true before calling this.
   */
  requestCheck(torrent: Torrent): void {
    if (this._activelyChecking.has(torrent)) return
    if (this._checkingQueue.includes(torrent)) return

    // Clear the flag since the check is now being handled by the queue.
    // Without this, the _runCheck completion handler calling start() would
    // see _needsDataCheck=true and trigger a redundant second check.
    torrent.clearNeedsDataCheck()

    this._checkingQueue.push(torrent)
    this._checkingQueue.sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
    this._drainCheckingQueue()
  }

  /**
   * Request a data check and return a Promise that resolves when complete.
   * Used for manual recheck (recheckData) where the caller awaits completion.
   */
  requestCheckImmediate(torrent: Torrent): Promise<void> {
    return new Promise<void>((resolve) => {
      this._checkCompletionCallbacks.set(torrent, resolve)
      this.requestCheck(torrent)
    })
  }

  /** Whether a torrent is in the checking queue or actively checking */
  isCheckingOrQueued(torrent: Torrent): boolean {
    return this._activelyChecking.has(torrent) || this._checkingQueue.includes(torrent)
  }

  /**
   * Move a torrent to the top of the queue (position 0).
   */
  moveToTop(torrent: Torrent): void {
    const oldPos = torrent.queuePosition
    if (oldPos === undefined || oldPos === 0) return

    // Shift all torrents with position < oldPos up by 1
    for (const t of this.btEngine.torrents) {
      if (t !== torrent && t.queuePosition !== undefined && t.queuePosition < oldPos) {
        t.queuePosition++
      }
    }
    torrent.queuePosition = 0
    this.logger.info(`Moved ${torrent.name} to top of queue`)
    this.recalculate()
  }

  /**
   * Move a torrent to the bottom of the queue.
   */
  moveToBottom(torrent: Torrent): void {
    const oldPos = torrent.queuePosition
    if (oldPos === undefined) return

    const maxPos = this._maxPosition()
    if (oldPos === maxPos) return

    // Shift all torrents with position > oldPos down by 1
    for (const t of this.btEngine.torrents) {
      if (t !== torrent && t.queuePosition !== undefined && t.queuePosition > oldPos) {
        t.queuePosition--
      }
    }
    torrent.queuePosition = this._maxPosition() + 1
    this.logger.info(`Moved ${torrent.name} to bottom of queue`)
    this.recalculate()
  }

  /**
   * Force-start a torrent, bypassing queue limits.
   */
  forceStart(torrent: Torrent): void {
    torrent.forceActive = true
    torrent.userState = 'active'
    torrent.start()
    this.btEngine.sessionPersistence?.saveTorrentState(torrent)
    this.logger.info(`Force-started ${torrent.name}`)
  }

  /**
   * Assign initial queue positions to torrents that don't have them.
   * Used on upgrade path when existing torrents lack positions.
   */
  assignInitialPositions(torrents: Torrent[]): void {
    const unpositioned = torrents.filter((t) => t.queuePosition === undefined)
    if (unpositioned.length === 0) return

    // Sort by addedAt (oldest first)
    unpositioned.sort((a, b) => a.addedAt - b.addedAt)

    // Find next available position
    let nextPos = this._nextPosition()
    for (const t of unpositioned) {
      t.queuePosition = nextPos++
    }

    this.logger.info(`Assigned initial queue positions to ${unpositioned.length} torrents`)
  }

  /**
   * Cleanup config subscriptions.
   */
  destroy(): void {
    for (const unsub of this._configUnsubscribers) {
      unsub()
    }
    this._configUnsubscribers = []
    this._seedActivatedAt.clear()
    this._checkingQueue = []
    this._activelyChecking.clear()
    this._checkCompletionCallbacks.clear()
  }

  // ===========================================================================
  // Private
  // ===========================================================================

  private _doRecalculate(): void {
    if (this.btEngine.isSuspended) return

    const torrents = this.btEngine.torrents

    // Assign initial positions for any unpositioned torrents (upgrade path)
    this.assignInitialPositions(torrents)

    const activeDownloads = this.config.activeDownloads.get()
    const activeSeeds = this.config.activeSeeds.get()

    // Partition torrents
    const downloading: Torrent[] = []
    const seeding: Torrent[] = []

    for (const t of torrents) {
      // Skip stopped torrents
      if (t.userState === 'stopped') continue

      // awaitingFileSelection: start networking (for metadata) but don't count against limits
      if (t.userState === 'awaitingFileSelection') {
        if (!t.isActive) {
          t.start()
        }
        continue
      }

      // Skip torrents that are checking or queued for check — they don't
      // count against download/seed limits
      if (this._activelyChecking.has(t) || this._checkingQueue.includes(t)) continue

      // Skip force-active torrents — they always stay running
      if (t.forceActive) {
        if (t.userState !== 'active') {
          t.userState = 'active'
        }
        if (!t.isActive) {
          t.start()
        }
        continue
      }

      // Skip errored torrents — network is stopped, don't count against limits
      if (t.errorMessage) continue

      // Classify by progress
      if (t.progress >= 1) {
        seeding.push(t)
      } else {
        downloading.push(t)
      }
    }

    // Downloads: position-based ordering
    downloading.sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
    this._applyLimit(downloading, activeDownloads)

    // Seeds: round-robin rotation with anti-oscillation
    this._applySeedRotation(seeding, activeSeeds)
  }

  private _applyLimit(torrents: Torrent[], limit: number): void {
    const effectiveLimit = Math.min(limit, ACTIVE_LIMIT)

    for (let i = 0; i < torrents.length; i++) {
      const t = torrents[i]
      if (i < effectiveLimit) {
        // Should be active
        if (t.userState !== 'active') {
          this.logger.info(
            `${t.name}: queued → active (position ${t.queuePosition}, limit ${effectiveLimit})`,
          )
          t.userState = 'active'
          t.start() // start() cancels any graceful stop
          this.btEngine.sessionPersistence?.saveTorrentState(t)
        } else if (t.isGracefulStopping) {
          // Was being demoted, but now back within limit — cancel graceful stop
          t.start()
        } else if (!t.isActive && !this.btEngine.isSuspended) {
          // userState is active but network isn't running
          t.start()
        }
      } else {
        // Should be queued — use graceful stop to allow in-flight requests to drain
        if (t.userState !== 'queued' && !t.isGracefulStopping) {
          this.logger.info(
            `${t.name}: active → queued (position ${t.queuePosition}, limit ${effectiveLimit})`,
          )
          t.gracefulStop()
        }
      }
    }
  }

  /**
   * Round-robin seed rotation with anti-oscillation.
   * Seeds that have been active < MIN_SEED_ACTIVE_MS are protected from demotion.
   * Among candidates, least-recently-activated seeds get priority (fair rotation).
   */
  private _applySeedRotation(seeds: Torrent[], limit: number): void {
    const effectiveLimit = Math.min(limit, ACTIVE_LIMIT)
    const now = Date.now()

    // Partition into currently active vs idle (queued)
    const active: Torrent[] = []
    const idle: Torrent[] = []
    for (const t of seeds) {
      if (t.userState !== 'queued' && !t.isGracefulStopping) {
        active.push(t)
      } else {
        idle.push(t)
      }
    }

    // Protected: active seeds within the anti-oscillation window
    const protectedSeeds: Torrent[] = []
    const unprotected: Torrent[] = []
    for (const t of active) {
      const activatedAt = this._seedActivatedAt.get(t.infoHashStr) ?? 0
      if (now - activatedAt < MIN_SEED_ACTIVE_MS) {
        protectedSeeds.push(t)
      } else {
        unprotected.push(t)
      }
    }

    // If protected seeds already fill all slots, demote the rest
    if (protectedSeeds.length >= effectiveLimit) {
      for (const t of unprotected) this._demoteSeed(t)
      for (const t of idle) this._demoteSeed(t)
      return
    }

    const remainingSlots = effectiveLimit - protectedSeeds.length

    // Candidates: unprotected active + idle, sorted by activatedAt ascending
    // (least recently activated first = fairest rotation)
    const candidates = [...unprotected, ...idle]
    candidates.sort((a, b) => {
      const aTime = this._seedActivatedAt.get(a.infoHashStr) ?? 0
      const bTime = this._seedActivatedAt.get(b.infoHashStr) ?? 0
      return aTime - bTime
    })

    for (let i = 0; i < candidates.length; i++) {
      if (i < remainingSlots) {
        this._activateSeed(candidates[i], now)
      } else {
        this._demoteSeed(candidates[i])
      }
    }
  }

  private _activateSeed(t: Torrent, now: number): void {
    if (t.userState !== 'active') {
      this.logger.info(`${t.name}: seed promoted (rotation)`)
      t.userState = 'active'
      t.start()
      this._seedActivatedAt.set(t.infoHashStr, now)
      this.btEngine.sessionPersistence?.saveTorrentState(t)
    } else if (t.isGracefulStopping) {
      t.start()
    } else if (!t.isActive && !this.btEngine.isSuspended) {
      t.start()
    }
    // Ensure activatedAt is set (for seeds active from session restore)
    if (!this._seedActivatedAt.has(t.infoHashStr)) {
      this._seedActivatedAt.set(t.infoHashStr, now)
    }
  }

  private _demoteSeed(t: Torrent): void {
    if (t.userState !== 'queued' && !t.isGracefulStopping) {
      this.logger.info(`${t.name}: seed demoted (rotation)`)
      t.gracefulStop()
    }
  }

  private _nextPosition(): number {
    let max = -1
    for (const t of this.btEngine.torrents) {
      if (t.queuePosition !== undefined && t.queuePosition > max) {
        max = t.queuePosition
      }
    }
    return max + 1
  }

  private _maxPosition(): number {
    let max = -1
    for (const t of this.btEngine.torrents) {
      if (t.queuePosition !== undefined && t.queuePosition > max) {
        max = t.queuePosition
      }
    }
    return max
  }

  // ===========================================================================
  // Checking queue
  // ===========================================================================

  private _drainCheckingQueue(): void {
    const limit = this.config.activeChecking.get()

    while (this._activelyChecking.size < limit && this._checkingQueue.length > 0) {
      const torrent = this._checkingQueue.shift()!
      this._activelyChecking.add(torrent)
      this._runCheck(torrent)
    }
  }

  private _runCheck(torrent: Torrent): void {
    torrent
      .performDataCheck()
      .then(() => {
        this._activelyChecking.delete(torrent)

        // Resolve any immediate callback (recheckData callers)
        const cb = this._checkCompletionCallbacks.get(torrent)
        if (cb) {
          this._checkCompletionCallbacks.delete(torrent)
          cb()
        }

        // Start networking if the torrent should be active.
        // _needsDataCheck is already false and _isChecking is cleared by _doCheckPieces(),
        // so start() will proceed past the check guards to activate networking.
        if (
          (torrent.userState === 'active' || torrent.userState === 'awaitingFileSelection') &&
          !this.btEngine.isSuspended
        ) {
          torrent.start()
        }

        // Drain next queued check
        this._drainCheckingQueue()

        // Recalculate — the torrent may now need a download/seed slot
        this.recalculate()
      })
      .catch((err) => {
        this.logger.error(`Data check failed for ${torrent.name}:`, { err })
        this._activelyChecking.delete(torrent)

        const cb = this._checkCompletionCallbacks.get(torrent)
        if (cb) {
          this._checkCompletionCallbacks.delete(torrent)
          cb()
        }

        this._drainCheckingQueue()
      })
  }
}
