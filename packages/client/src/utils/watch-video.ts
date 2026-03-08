import type { Torrent, TorrentActivityState, TorrentUserState } from '@jstorrent/engine'

type PlaybackTorrent = Pick<
  Torrent,
  'isFileSkipped' | 'setFilePriorityAsync' | 'userStart' | 'userState' | 'activityState'
>

function shouldStartForPlayback(
  userState: TorrentUserState,
  activityState: TorrentActivityState,
): boolean {
  return userState !== 'active' || activityState === 'error'
}

/**
 * Watching a file should permanently unskip it and start the torrent if needed.
 */
export async function prepareTorrentForVideoPlayback(
  torrent: PlaybackTorrent,
  fileIndex: number,
): Promise<void> {
  if (torrent.isFileSkipped(fileIndex)) {
    await torrent.setFilePriorityAsync(fileIndex, 0)
  }

  if (shouldStartForPlayback(torrent.userState, torrent.activityState)) {
    await torrent.userStart()
  }
}
