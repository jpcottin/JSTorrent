import { describe, expect, it, vi } from 'vitest'
import { prepareTorrentForVideoPlayback } from '../../src/utils/watch-video'

type PlaybackTorrent = Parameters<typeof prepareTorrentForVideoPlayback>[0]

function createTorrentMock(overrides?: {
  isFileComplete?: boolean
  isFileSkipped?: boolean
  userState?: 'active' | 'stopped' | 'queued'
  activityState?:
    | 'stopped'
    | 'checking'
    | 'downloading_metadata'
    | 'downloading'
    | 'seeding'
    | 'error'
    | 'queued'
    | 'done'
}) {
  const calls: string[] = []

  const torrent = {
    isFileComplete: vi.fn(() => overrides?.isFileComplete ?? false),
    isFileSkipped: vi.fn(() => overrides?.isFileSkipped ?? false),
    setFilePriorityAsync: vi.fn(async () => {
      calls.push('setFilePriorityAsync')
      return true
    }),
    userStart: vi.fn(async () => {
      calls.push('userStart')
    }),
    userState: overrides?.userState ?? 'active',
    activityState: overrides?.activityState ?? 'downloading',
  }

  return { torrent, calls }
}

describe('prepareTorrentForVideoPlayback', () => {
  it('permanently unskips the file before starting a stopped torrent', async () => {
    const { torrent, calls } = createTorrentMock({
      isFileComplete: false,
      isFileSkipped: true,
      userState: 'stopped',
      activityState: 'stopped',
    })

    await prepareTorrentForVideoPlayback(torrent as PlaybackTorrent, 7)

    expect(torrent.isFileSkipped).toHaveBeenCalledWith(7)
    expect(torrent.setFilePriorityAsync).toHaveBeenCalledWith(7, 0)
    expect(torrent.userStart).toHaveBeenCalledTimes(1)
    expect(calls).toEqual(['setFilePriorityAsync', 'userStart'])
  })

  it('restarts errored torrents even if they were already active', async () => {
    const { torrent } = createTorrentMock({
      isFileComplete: false,
      userState: 'active',
      activityState: 'error',
    })

    await prepareTorrentForVideoPlayback(torrent as PlaybackTorrent, 3)

    expect(torrent.setFilePriorityAsync).not.toHaveBeenCalled()
    expect(torrent.userStart).toHaveBeenCalledTimes(1)
  })

  it('leaves already playable torrents alone', async () => {
    const { torrent } = createTorrentMock({
      isFileComplete: false,
      userState: 'active',
      activityState: 'downloading',
    })

    await prepareTorrentForVideoPlayback(torrent as PlaybackTorrent, 1)

    expect(torrent.setFilePriorityAsync).not.toHaveBeenCalled()
    expect(torrent.userStart).not.toHaveBeenCalled()
  })

  it('does not start a stopped torrent when the watched file is already complete', async () => {
    const { torrent } = createTorrentMock({
      isFileComplete: true,
      userState: 'stopped',
      activityState: 'stopped',
    })

    await prepareTorrentForVideoPlayback(torrent as PlaybackTorrent, 4)

    expect(torrent.isFileComplete).toHaveBeenCalledWith(4)
    expect(torrent.userStart).not.toHaveBeenCalled()
  })
})
