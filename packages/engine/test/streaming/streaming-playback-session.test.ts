import { describe, expect, it, vi } from 'vitest'
import { StreamingPlaybackSession } from '../../src/streaming/streaming-playback-session'
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
  it('keeps a stable token per hint id and clears it on demand', () => {
    const provider = createProvider()
    const session = new StreamingPlaybackSession(provider, {
      tokenPrefix: 'test-session',
      logPrefix: '[test-session]',
    })

    session.setHint('next', 0, 16384, 'next')
    session.setHint('next', 16384, 16384, 'next')
    session.clearHint('next')

    expect(provider.updateStreamingFileLock!).toHaveBeenCalledWith('test-session-file:0', true)
    expect(provider.updateStreamingDemand!).toHaveBeenCalledTimes(3)

    const [firstToken, firstPieces, firstUrgency] = provider.updateStreamingDemand!.mock.calls[0]
    const [secondToken, secondPieces, secondUrgency] =
      provider.updateStreamingDemand!.mock.calls[1]
    expect(firstToken).toMatch(/^test-session-hint:/)
    expect(secondToken).toBe(firstToken)
    expect(firstPieces).toEqual(new Set([0]))
    expect(secondPieces).toEqual(new Set([1]))
    expect(firstUrgency).toBe('next')
    expect(secondUrgency).toBe('next')
    expect(provider.updateStreamingDemand!.mock.calls[2]).toEqual([firstToken, null, 'now'])
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
