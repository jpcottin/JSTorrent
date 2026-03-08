import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteStreamingFileProvider,
  createVideoPopupSessionHost,
} from '../../src/utils/video-popup-session'
import {
  type PrebuiltKeyframeIndex,
  type StreamingFilePieceSnapshot,
  type StreamingFileProvider,
} from '@jstorrent/engine'
import type { VideoPopupLaunchOptions } from '../../src/host/types'

interface MessageListener {
  (event: MessageEvent<unknown>): void
}

class FakeBroadcastChannel {
  static rooms = new Map<string, Set<FakeBroadcastChannel>>()

  private listeners = new Set<MessageListener>()

  constructor(private name: string) {
    const room = FakeBroadcastChannel.rooms.get(name) ?? new Set<FakeBroadcastChannel>()
    room.add(this)
    FakeBroadcastChannel.rooms.set(name, room)
  }

  addEventListener(_type: 'message', listener: MessageListener): void {
    this.listeners.add(listener)
  }

  removeEventListener(_type: 'message', listener: MessageListener): void {
    this.listeners.delete(listener)
  }

  postMessage(message: unknown): void {
    const room = FakeBroadcastChannel.rooms.get(this.name) ?? new Set<FakeBroadcastChannel>()
    for (const peer of room) {
      if (peer === this) continue
      const event = { data: message } as MessageEvent<unknown>
      queueMicrotask(() => {
        for (const listener of peer.listeners) {
          listener(event)
        }
      })
    }
  }

  close(): void {
    const room = FakeBroadcastChannel.rooms.get(this.name)
    room?.delete(this)
    if (room && room.size === 0) {
      FakeBroadcastChannel.rooms.delete(this.name)
    }
    this.listeners.clear()
  }
}

function createChannel(name: string) {
  return new FakeBroadcastChannel(name)
}

describe('video popup session transport', () => {
  beforeEach(() => {
    FakeBroadcastChannel.rooms.clear()
  })

  it('maps file byte ranges to pieces locally in the popup provider', () => {
    const descriptor: VideoPopupLaunchOptions = {
      sessionId: 'session-math',
      fileName: 'movie.mkv',
      fileSize: 64_000,
      fileOffset: 32_768,
      pieceLength: 16_384,
    }

    const remote = createRemoteStreamingFileProvider(descriptor, { createChannel })
    expect(remote.provider.fileBytesToPieces(0, 1)).toEqual([2])
    expect(remote.provider.fileBytesToPieces(10_000, 20_000)).toEqual([2, 3])
    remote.dispose()
  })

  it('proxies reads and wait calls over the popup session channel', async () => {
    const provider: StreamingFileProvider = {
      fileSize: 100,
      fileBytesToPieces: (_offset, _length) => [0],
      setStreamingPieces: vi.fn(),
      updateStreamingFileLock: vi.fn(),
      updateStreamingDemand: vi.fn(),
      waitForPieces: vi.fn().mockResolvedValue(undefined),
      readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
      buildPrebuiltKeyframeIndex: vi.fn().mockResolvedValue(null),
    }

    const host = createVideoPopupSessionHost('session-rpc', provider, createChannel)
    const remote = createRemoteStreamingFileProvider(
      {
        sessionId: 'session-rpc',
        fileName: 'movie.mkv',
        fileSize: 100,
        fileOffset: 0,
        pieceLength: 16_384,
      },
      { createChannel },
    )

    remote.provider.setStreamingPieces(new Set([4, 5]))
    remote.provider.updateStreamingFileLock?.('stream-file', true)
    remote.provider.updateStreamingDemand?.('player', new Set([6, 7]), 'now')
    await Promise.resolve()
    await remote.provider.waitForPieces([4, 5])
    const bytes = await remote.provider.readFileBytes(10, 4)

    expect(provider.setStreamingPieces).toHaveBeenCalledWith(new Set([4, 5]))
    expect(provider.updateStreamingFileLock).toHaveBeenCalledWith('stream-file', true)
    expect(provider.updateStreamingDemand).toHaveBeenCalledWith('player', new Set([6, 7]), 'now')
    expect(provider.waitForPieces).toHaveBeenCalledWith([4, 5], expect.any(AbortSignal))
    expect(provider.readFileBytes).toHaveBeenCalledWith(10, 4)
    expect([...bytes]).toEqual([1, 2, 3, 4])

    remote.dispose()
    host.dispose()
  })

  it('notifies the popup when the host session closes', async () => {
    const provider: StreamingFileProvider = {
      fileSize: 100,
      fileBytesToPieces: (_offset, _length) => [0],
      setStreamingPieces: vi.fn(),
      updateStreamingFileLock: vi.fn(),
      updateStreamingDemand: vi.fn(),
      waitForPieces: vi.fn().mockResolvedValue(undefined),
      readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      buildPrebuiltKeyframeIndex: vi.fn().mockResolvedValue(null),
    }

    const onSessionClosed = vi.fn()
    const host = createVideoPopupSessionHost('session-close', provider, createChannel)
    createRemoteStreamingFileProvider(
      {
        sessionId: 'session-close',
        fileName: 'movie.mkv',
        fileSize: 100,
        fileOffset: 0,
        pieceLength: 16_384,
      },
      { createChannel, onSessionClosed },
    )

    host.dispose()
    await Promise.resolve()

    expect(onSessionClosed).toHaveBeenCalledTimes(1)
  })

  it('proxies prebuilt keyframe index requests over the popup session channel', async () => {
    const index: PrebuiltKeyframeIndex = {
      durationSec: 12.5,
      keyframeTimestampsSec: [0, 4, 8, 12],
    }
    const provider: StreamingFileProvider = {
      fileSize: 100,
      fileBytesToPieces: (_offset, _length) => [0],
      setStreamingPieces: vi.fn(),
      updateStreamingFileLock: vi.fn(),
      updateStreamingDemand: vi.fn(),
      waitForPieces: vi.fn().mockResolvedValue(undefined),
      readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      buildPrebuiltKeyframeIndex: vi.fn().mockResolvedValue(index),
    }

    const host = createVideoPopupSessionHost('session-index', provider, createChannel)
    const remote = createRemoteStreamingFileProvider(
      {
        sessionId: 'session-index',
        fileName: 'movie.mkv',
        fileSize: 100,
        fileOffset: 0,
        pieceLength: 16_384,
      },
      { createChannel },
    )

    await expect(remote.provider.buildPrebuiltKeyframeIndex?.()).resolves.toEqual(index)
    expect(provider.buildPrebuiltKeyframeIndex).toHaveBeenCalledTimes(1)

    remote.dispose()
    host.dispose()
  })

  it('proxies file piece timeline snapshots over the popup session channel', async () => {
    const snapshot: StreamingFilePieceSnapshot = {
      piecesTotal: 4,
      piecesCompleted: 2,
      bitfieldHex: 'a0',
      activePieces: [{ index: 2, state: 2 }],
    }
    const provider: StreamingFileProvider = {
      fileSize: 100,
      fileBytesToPieces: (_offset, _length) => [0],
      setStreamingPieces: vi.fn(),
      updateStreamingFileLock: vi.fn(),
      updateStreamingDemand: vi.fn(),
      waitForPieces: vi.fn().mockResolvedValue(undefined),
      readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      buildPrebuiltKeyframeIndex: vi.fn().mockResolvedValue(null),
      getPieceTimelineSnapshot: vi.fn().mockResolvedValue(snapshot),
    }

    const host = createVideoPopupSessionHost('session-piece-timeline', provider, createChannel)
    const remote = createRemoteStreamingFileProvider(
      {
        sessionId: 'session-piece-timeline',
        fileName: 'movie.mkv',
        fileSize: 100,
        fileOffset: 0,
        pieceLength: 16_384,
      },
      { createChannel },
    )

    await expect(remote.provider.getPieceTimelineSnapshot?.()).resolves.toEqual(snapshot)
    expect(provider.getPieceTimelineSnapshot).toHaveBeenCalledTimes(1)

    remote.dispose()
    host.dispose()
  })

  it('falls back to setStreamingPieces when host provider lacks tokenized demand API', async () => {
    const provider: StreamingFileProvider = {
      fileSize: 100,
      fileBytesToPieces: (_offset, _length) => [0],
      setStreamingPieces: vi.fn(),
      updateStreamingFileLock: vi.fn(),
      waitForPieces: vi.fn().mockResolvedValue(undefined),
      readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      buildPrebuiltKeyframeIndex: vi.fn().mockResolvedValue(null),
    }

    const host = createVideoPopupSessionHost('session-fallback', provider, createChannel)
    const remote = createRemoteStreamingFileProvider(
      {
        sessionId: 'session-fallback',
        fileName: 'movie.mkv',
        fileSize: 100,
        fileOffset: 0,
        pieceLength: 16_384,
      },
      { createChannel },
    )

    remote.provider.updateStreamingDemand?.('metadata', new Set([1]), 'metadata')
    await Promise.resolve()

    expect(provider.setStreamingPieces).toHaveBeenCalledWith(new Set([1]))

    remote.dispose()
    host.dispose()
  })

  it('propagates popup wait aborts to the host-side wait signal', async () => {
    let hostWaitSignal: AbortSignal | undefined
    const provider: StreamingFileProvider = {
      fileSize: 100,
      fileBytesToPieces: (_offset, _length) => [0],
      setStreamingPieces: vi.fn(),
      updateStreamingFileLock: vi.fn(),
      updateStreamingDemand: vi.fn(),
      waitForPieces: vi.fn(
        (_pieceIndices: number[], signal?: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            hostWaitSignal = signal
            signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'))
            })
          }),
      ),
      readFileBytes: vi.fn().mockResolvedValue(new Uint8Array([1])),
      buildPrebuiltKeyframeIndex: vi.fn().mockResolvedValue(null),
    }

    const host = createVideoPopupSessionHost('session-abort', provider, createChannel)
    const remote = createRemoteStreamingFileProvider(
      {
        sessionId: 'session-abort',
        fileName: 'movie.mkv',
        fileSize: 100,
        fileOffset: 0,
        pieceLength: 16_384,
      },
      { createChannel },
    )

    const controller = new AbortController()
    const waitPromise = remote.provider.waitForPieces([0], controller.signal)

    await Promise.resolve()
    controller.abort()

    await expect(waitPromise).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(hostWaitSignal?.aborted).toBe(true)

    remote.dispose()
    host.dispose()
  })
})
