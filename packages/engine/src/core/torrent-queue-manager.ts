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
 * - Single shared queue position space across downloads and seeds
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

export class TorrentQueueManager extends EngineComponent {
  static logName = 'queue'

  private _dirty = false
  private _tickCount = 0
  private _configUnsubscribers: Unsubscribe[] = []

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

    // Sort by queue position
    downloading.sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))
    seeding.sort((a, b) => (a.queuePosition ?? 0) - (b.queuePosition ?? 0))

    // Apply limits
    this._applyLimit(downloading, activeDownloads)
    this._applyLimit(seeding, activeSeeds)
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
}
