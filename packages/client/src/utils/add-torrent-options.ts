import type { ConfigHub } from '@jstorrent/engine'

/**
 * Returns addTorrent options for user-initiated adds.
 *
 * All user-initiated addTorrent call sites should use this so the
 * "show file selection" preference is respected consistently.
 * Dev helpers and session restore paths should NOT use this.
 */
export function getUserAddTorrentOptions(configHub: ConfigHub): {
  userState?: 'active' | 'stopped' | 'awaitingFileSelection'
} {
  return configHub.showFileSelection.get() ? { userState: 'awaitingFileSelection' } : {}
}
