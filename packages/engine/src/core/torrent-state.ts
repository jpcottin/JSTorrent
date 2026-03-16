/**
 * User's intent for the torrent - persisted to session store.
 */
export type TorrentUserState = 'active' | 'stopped' | 'queued' | 'awaitingFileSelection'

/**
 * What the torrent is actually doing right now.
 * Derived from userState + engine state + torrent progress.
 * NOT persisted - computed on the fly.
 */
export type TorrentActivityState =
  | 'stopped' // No network activity
  | 'checking' // Verifying existing data on disk
  | 'downloading_metadata' // Fetching .torrent info from peers
  | 'downloading' // Actively downloading pieces
  | 'seeding' // Complete, uploading to peers
  | 'error' // Something went wrong
  | 'queued' // Waiting for active slot
  | 'awaitingFileSelection' // Metadata ready, waiting for user to pick files
  | 'noFilesChosen' // All files set to skip
  | 'done' // Complete, not in an active seed slot

/**
 * Compute activity state from torrent properties.
 */
export function computeActivityState(
  userState: TorrentUserState,
  engineSuspended: boolean,
  hasMetadata: boolean,
  isChecking: boolean,
  progress: number,
  hasError: boolean,
  noFilesWanted?: boolean,
): TorrentActivityState {
  // Engine suspended = everything stopped
  if (engineSuspended) return 'stopped'

  // Checking data (takes priority over stopped state)
  if (isChecking) return 'checking'

  // User stopped = stopped, queued = queued
  if (userState === 'stopped') return 'stopped'
  if (userState === 'queued') return progress >= 1 ? 'done' : 'queued'

  // Awaiting file selection: fetching metadata or waiting for user to pick files
  if (userState === 'awaitingFileSelection') {
    return hasMetadata ? 'awaitingFileSelection' : 'downloading_metadata'
  }

  // Error state
  if (hasError) return 'error'

  // No metadata yet
  if (!hasMetadata) return 'downloading_metadata'

  // All files skipped
  if (noFilesWanted) return 'noFilesChosen'

  // Complete
  if (progress >= 1) return 'seeding'

  // Downloading
  return 'downloading'
}
