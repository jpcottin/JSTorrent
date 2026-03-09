import { describe, expect, it, vi } from 'vitest'
import { StreamingPlaybackSession } from '../../src/streaming/streaming-playback-session'
import { StreamingContainerFormats, StreamingPlaybackModes } from '../../src'
import type { StreamingFileProvider } from '../../src/streaming/streaming-file-provider'

function createProvider(): StreamingFileProvider {
  const updateStreamingFileLock = vi.fn()
  const updateStreamingDemand = vi.fn()

  return {
    fileSize: 65536,
    fileBytesToPieces: vi.fn((offset: number, length: number) => {
      const first = Math.floor(offset / 16384)
      const last = Math.floor((offset + length - 1) / 16384)
      const pieces: number[] = []
      for (let i = first; i <= last; i++) {
        pieces.push(i)
      }
      return pieces
    }),
    setStreamingPieces: vi.fn(),
    updateStreamingFileLock,
    updateStreamingDemand,
    waitForPieces: vi.fn().mockResolvedValue(undefined),
    readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
  }
}

describe('StreamingPlaybackSession', () => {
  it('prepares and caches playback metadata through the player-controller surface', async () => {
    const provider = createProvider()
    provider.getPlaybackCapabilities = vi.fn().mockResolvedValue({
      supportedModes: [StreamingPlaybackModes.Hls],
      preferredMode: StreamingPlaybackModes.Hls,
      containerFormat: StreamingContainerFormats.Matroska,
      canPrepareMetadata: false,
    })
    const session = new StreamingPlaybackSession(provider, {
      tokenPrefix: 'test-session',
      logPrefix: '[test-session]',
    })

    await expect(session.getPlaybackCapabilities()).resolves.toEqual({
      supportedModes: [StreamingPlaybackModes.Hls],
      preferredMode: StreamingPlaybackModes.Hls,
      containerFormat: StreamingContainerFormats.Matroska,
      canPrepareMetadata: false,
    })
    await expect(session.getPlaybackOptions()).resolves.toEqual([
      { mode: StreamingPlaybackModes.Hls },
    ])
    await expect(session.getPreparedPlaybackMetadata()).resolves.toBeNull()
    await expect(session.preparePlaybackMetadata()).resolves.toEqual({
      capabilities: {
        supportedModes: [StreamingPlaybackModes.Hls],
        preferredMode: StreamingPlaybackModes.Hls,
        containerFormat: StreamingContainerFormats.Matroska,
        canPrepareMetadata: false,
      },
    })
    await expect(session.getPreparedPlaybackMetadata()).resolves.toEqual({
      capabilities: {
        supportedModes: [StreamingPlaybackModes.Hls],
        preferredMode: StreamingPlaybackModes.Hls,
        containerFormat: StreamingContainerFormats.Matroska,
        canPrepareMetadata: false,
      },
    })
    await expect(session.preparePlaybackMetadata()).resolves.toEqual({
      capabilities: {
        supportedModes: [StreamingPlaybackModes.Hls],
        preferredMode: StreamingPlaybackModes.Hls,
        containerFormat: StreamingContainerFormats.Matroska,
        canPrepareMetadata: false,
      },
    })
    expect(provider.getPlaybackCapabilities).toHaveBeenCalledTimes(1)
  })

  it('waitForRange maps bytes to pieces and forwards abortable waits', async () => {
    let waitSignal: AbortSignal | undefined
    const provider = createProvider()
    provider.waitForPieces = vi.fn(
      (_pieces: number[], signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          waitSignal = signal
          signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )

    const session = new StreamingPlaybackSession(provider)
    const controller = new AbortController()
    const promise = session.waitForRange(0, 20000, controller.signal)

    expect(provider.waitForPieces).toHaveBeenCalledWith([0, 1], expect.any(AbortSignal))

    controller.abort()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(waitSignal?.aborted).toBe(true)
  })
})
