/**
 * Notification Bridge for UI Thread.
 * Sends notification events to the host via HostChannel.
 */

import type { HostChannel } from '../host/host-channel'
import type { ProgressStats } from '../host/types'

export type { ProgressStats } from '../host/types'

class NotificationBridge {
  private throttleTimer: ReturnType<typeof setTimeout> | null = null
  private pendingStats: ProgressStats | null = null

  constructor(private channel: HostChannel) {
    this.setupVisibilityTracking()
  }

  private setupVisibilityTracking(): void {
    // Send initial state
    this.sendVisibility(document.visibilityState === 'visible')

    // Track changes
    document.addEventListener('visibilitychange', () => {
      this.sendVisibility(document.visibilityState === 'visible')
    })
  }

  private sendVisibility(visible: boolean): void {
    this.channel.notify({ type: 'visibility', visible })
  }

  /**
   * Call this from the engine's progress event handler.
   * Throttles updates to avoid spamming the SW.
   */
  updateProgress(stats: ProgressStats): void {
    this.pendingStats = stats

    // Throttle to every 2 seconds
    if (this.throttleTimer === null) {
      this.sendProgressUpdate()
      this.throttleTimer = setTimeout(() => {
        this.throttleTimer = null
        if (this.pendingStats) {
          this.sendProgressUpdate()
        }
      }, 2000)
    }
  }

  private sendProgressUpdate(): void {
    if (!this.pendingStats) return

    this.channel.notify({ type: 'stats', stats: this.pendingStats })
  }

  onTorrentComplete(infoHash: string, name: string): void {
    this.channel.notify({ type: 'torrent-complete', infoHash, name })
  }

  onTorrentError(infoHash: string, name: string, error: string): void {
    this.channel.notify({ type: 'torrent-error', infoHash, name, error })
  }

  onDuplicateTorrent(name: string): void {
    this.channel.notify({ type: 'duplicate-torrent', name })
  }
}

/** Create a NotificationBridge backed by the given HostChannel. */
export function createNotificationBridge(channel: HostChannel): NotificationBridge {
  return new NotificationBridge(channel)
}

export { NotificationBridge }
