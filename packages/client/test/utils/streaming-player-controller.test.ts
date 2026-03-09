import { describe, expect, it, vi } from 'vitest'
import { createStreamingPlayerController } from '../../src/utils/streaming-player-controller'
import type {
  DirectBytePlaybackOption,
  StreamingPlaybackOption,
  StreamingPlayerController,
} from '@jstorrent/engine'

describe('createStreamingPlayerController', () => {
  it('prepends a cached direct-byte option ahead of base playback options', async () => {
    const baseOptions: StreamingPlaybackOption[] = [{ mode: 'hls' }]
    const baseController: StreamingPlayerController = {
      getPlaybackOptions: vi.fn().mockResolvedValue(baseOptions),
    }
    const directByteOption: DirectBytePlaybackOption = {
      mode: 'direct-bytes',
      url: 'http://127.0.0.1:9999/stream/token',
      mimeType: 'video/mp4',
    }
    const getDirectByteOption = vi.fn().mockResolvedValue(directByteOption)

    const controller = createStreamingPlayerController({
      base: baseController,
      getDirectByteOption,
    })

    await expect(controller?.getPlaybackOptions?.()).resolves.toEqual([
      directByteOption,
      { mode: 'hls' },
    ])
    await expect(controller?.getPlaybackOptions?.()).resolves.toEqual([
      directByteOption,
      { mode: 'hls' },
    ])

    expect(getDirectByteOption).toHaveBeenCalledTimes(1)
    expect(baseController.getPlaybackOptions).toHaveBeenCalledTimes(2)
  })
})
