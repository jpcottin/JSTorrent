import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteByteRangeStreamingSession,
  createVideoPopupSessionHost,
} from '../../src/utils/video-popup-session'
import type {
  ByteRangeStreamingSession,
  DirectBytePlaybackOption,
  PreparedPlaybackMetadata,
  StreamingContainerFormat,
  StreamingPlaybackCapabilities,
  StreamingPlaybackOption,
  StreamingPlaybackHandle,
  StreamingPlaybackMode,
  StreamingPlayerController,
  StreamingFilePieceSnapshot,
  StreamingVisualization,
} from '@jstorrent/engine'
import type { VideoPopupLaunchOptions } from '../../src/host/types'

const HLS_MODE: StreamingPlaybackMode = 'hls'
const MATROSKA_CONTAINER: StreamingContainerFormat = 'matroska'

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

function createDescriptor(sessionId: string): VideoPopupLaunchOptions {
  return {
    sessionId,
    fileName: 'movie.mkv',
    fileSize: 100,
  }
}

function createPlaybackHandle(
  overrides: Partial<ByteRangeStreamingSession> = {},
  controller: StreamingPlayerController = {},
  diagnostics: StreamingVisualization = {},
): StreamingPlaybackHandle {
  const bytes: ByteRangeStreamingSession = {
    fileSize: 100,
    read: vi.fn().mockResolvedValue(new Uint8Array([1])),
    waitForRange: vi.fn().mockResolvedValue(undefined),
    close: vi.fn(),
    ...overrides,
  }

  return {
    bytes,
    controller,
    diagnostics,
  }
}

describe('video popup session transport', () => {
  beforeEach(() => {
    FakeBroadcastChannel.rooms.clear()
  })

  it('proxies reads and waits over the popup session channel', async () => {
    const playback = createPlaybackHandle(
      {
        read: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
        waitForRange: vi.fn().mockResolvedValue(undefined),
      },
      {
        preparePlaybackMetadata: vi.fn().mockResolvedValue(null),
      },
    )

    const host = createVideoPopupSessionHost('session-rpc', playback, createChannel)
    const remote = createRemoteByteRangeStreamingSession(createDescriptor('session-rpc'), {
      createChannel,
    })

    await remote.playback.bytes.waitForRange(4, 8)
    const bytes = await remote.playback.bytes.read(10, 4)

    expect(playback.bytes.waitForRange).toHaveBeenCalledWith(4, 8, expect.any(AbortSignal))
    expect(playback.bytes.read).toHaveBeenCalledWith(10, 4, expect.any(AbortSignal))
    expect([...bytes]).toEqual([1, 2, 3, 4])

    remote.dispose()
    host.dispose()
  })

  it('notifies the popup when the host session closes', async () => {
    const playback = createPlaybackHandle()

    const onSessionClosed = vi.fn()
    const host = createVideoPopupSessionHost('session-close', playback, createChannel)
    createRemoteByteRangeStreamingSession(createDescriptor('session-close'), {
      createChannel,
      onSessionClosed,
    })

    host.dispose()
    await Promise.resolve()

    expect(playback.bytes.close).toHaveBeenCalledTimes(1)
    expect(onSessionClosed).toHaveBeenCalledTimes(1)
  })

  it('proxies prepared playback metadata requests over the popup session channel', async () => {
    const capabilities: StreamingPlaybackCapabilities = {
      supportedModes: [HLS_MODE],
      preferredMode: HLS_MODE,
      containerFormat: MATROSKA_CONTAINER,
      canPrepareMetadata: false,
    }
    const preparedMetadata: PreparedPlaybackMetadata = {
      capabilities,
    }
    const playbackOptions: StreamingPlaybackOption[] = [
      {
        mode: 'direct-bytes',
        url: 'http://127.0.0.1:4321/stream/token',
        mimeType: 'video/mp4',
      } satisfies DirectBytePlaybackOption,
      { mode: HLS_MODE },
    ]
    const controller = {
      getPlaybackCapabilities: vi.fn().mockResolvedValue(capabilities),
      getPlaybackOptions: vi.fn().mockResolvedValue(playbackOptions),
      preparePlaybackMetadata: vi.fn().mockResolvedValue(preparedMetadata),
      getPreparedPlaybackMetadata: vi.fn().mockResolvedValue(preparedMetadata),
    }
    const playback = createPlaybackHandle({}, controller)

    const host = createVideoPopupSessionHost('session-index', playback, createChannel)
    const remote = createRemoteByteRangeStreamingSession(createDescriptor('session-index'), {
      createChannel,
    })

    await expect(remote.playback.controller?.getPlaybackCapabilities?.()).resolves.toEqual(
      capabilities,
    )
    await expect(remote.playback.controller?.getPlaybackOptions?.()).resolves.toEqual(
      playbackOptions,
    )
    await expect(remote.playback.controller?.preparePlaybackMetadata?.()).resolves.toEqual(
      preparedMetadata,
    )
    await expect(remote.playback.controller?.getPreparedPlaybackMetadata?.()).resolves.toEqual(
      preparedMetadata,
    )
    expect(controller.getPlaybackCapabilities).toHaveBeenCalledTimes(1)
    expect(controller.getPlaybackOptions).toHaveBeenCalledTimes(1)
    expect(controller.preparePlaybackMetadata).toHaveBeenCalledTimes(1)
    expect(controller.getPreparedPlaybackMetadata).toHaveBeenCalledTimes(1)

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
    const diagnostics = {
      getPieceTimelineSnapshot: vi.fn().mockResolvedValue(snapshot),
    }
    const playback = createPlaybackHandle({}, {}, diagnostics)

    const host = createVideoPopupSessionHost('session-piece-timeline', playback, createChannel)
    const remote = createRemoteByteRangeStreamingSession(
      createDescriptor('session-piece-timeline'),
      { createChannel },
    )

    await expect(remote.playback.diagnostics?.getPieceTimelineSnapshot?.()).resolves.toEqual(
      snapshot,
    )
    expect(diagnostics.getPieceTimelineSnapshot).toHaveBeenCalledTimes(1)

    remote.dispose()
    host.dispose()
  })

  it('propagates popup read aborts to the host-side session signal', async () => {
    let hostReadSignal: AbortSignal | undefined
    const playback = createPlaybackHandle({
      read: vi.fn(
        (_offset: number, _length: number, signal?: AbortSignal) =>
          new Promise<Uint8Array>((_resolve, reject) => {
            hostReadSignal = signal
            signal?.addEventListener('abort', () => {
              reject(new DOMException('Aborted', 'AbortError'))
            })
          }),
      ),
      waitForRange: vi.fn().mockResolvedValue(undefined),
    })

    const host = createVideoPopupSessionHost('session-abort-read', playback, createChannel)
    const remote = createRemoteByteRangeStreamingSession(createDescriptor('session-abort-read'), {
      createChannel,
    })

    const controller = new AbortController()
    const readPromise = remote.playback.bytes.read(0, 16, controller.signal)

    await Promise.resolve()
    controller.abort()

    await expect(readPromise).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(hostReadSignal?.aborted).toBe(true)

    remote.dispose()
    host.dispose()
  })

  it('closes the host session when the remote side disposes', async () => {
    const playback = createPlaybackHandle()

    const host = createVideoPopupSessionHost('session-dispose', playback, createChannel)
    const remote = createRemoteByteRangeStreamingSession(createDescriptor('session-dispose'), {
      createChannel,
    })

    remote.dispose()
    await Promise.resolve()

    expect(playback.bytes.close).toHaveBeenCalledTimes(1)

    host.dispose()
  })
})
