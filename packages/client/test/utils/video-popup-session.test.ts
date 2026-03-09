import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createRemoteByteRangeStreamingSession,
  createVideoPopupSessionHost,
} from '../../src/utils/video-popup-session'
import type {
  ByteRangeStreamingSession,
  PrebuiltKeyframeIndex,
  StreamingFilePieceSnapshot,
  StreamingVisualization,
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

function createDescriptor(sessionId: string): VideoPopupLaunchOptions {
  return {
    sessionId,
    fileName: 'movie.mkv',
    fileSize: 100,
  }
}

describe('video popup session transport', () => {
  beforeEach(() => {
    FakeBroadcastChannel.rooms.clear()
  })

  it('proxies reads and waits over the popup session channel', async () => {
    const session: ByteRangeStreamingSession & StreamingVisualization = {
      fileSize: 100,
      read: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
      waitForRange: vi.fn().mockResolvedValue(undefined),
      setHint: vi.fn(),
      clearHint: vi.fn(),
      close: vi.fn(),
      buildPrebuiltKeyframeIndex: vi.fn().mockResolvedValue(null),
    }

    const host = createVideoPopupSessionHost('session-rpc', session, createChannel)
    const remote = createRemoteByteRangeStreamingSession(createDescriptor('session-rpc'), {
      createChannel,
    })

    await remote.session.waitForRange(4, 8)
    const bytes = await remote.session.read(10, 4)

    expect(session.waitForRange).toHaveBeenCalledWith(4, 8, expect.any(AbortSignal))
    expect(session.read).toHaveBeenCalledWith(10, 4, expect.any(AbortSignal))
    expect([...bytes]).toEqual([1, 2, 3, 4])

    remote.dispose()
    host.dispose()
  })

  it('forwards byte-range hints and clears them', async () => {
    const session: ByteRangeStreamingSession & StreamingVisualization = {
      fileSize: 100,
      read: vi.fn().mockResolvedValue(new Uint8Array([1])),
      waitForRange: vi.fn().mockResolvedValue(undefined),
      setHint: vi.fn(),
      clearHint: vi.fn(),
      close: vi.fn(),
    }

    const host = createVideoPopupSessionHost('session-hints', session, createChannel)
    const remote = createRemoteByteRangeStreamingSession(createDescriptor('session-hints'), {
      createChannel,
    })

    remote.session.setHint('next', 32, 64, 'next')
    remote.session.clearHint('next')
    await Promise.resolve()

    expect(session.setHint).toHaveBeenCalledWith('next', 32, 64, 'next')
    expect(session.clearHint).toHaveBeenCalledWith('next')

    remote.dispose()
    host.dispose()
  })

  it('notifies the popup when the host session closes', async () => {
    const session: ByteRangeStreamingSession & StreamingVisualization = {
      fileSize: 100,
      read: vi.fn().mockResolvedValue(new Uint8Array([1])),
      waitForRange: vi.fn().mockResolvedValue(undefined),
      setHint: vi.fn(),
      clearHint: vi.fn(),
      close: vi.fn(),
    }

    const onSessionClosed = vi.fn()
    const host = createVideoPopupSessionHost('session-close', session, createChannel)
    createRemoteByteRangeStreamingSession(createDescriptor('session-close'), {
      createChannel,
      onSessionClosed,
    })

    host.dispose()
    await Promise.resolve()

    expect(session.close).toHaveBeenCalledTimes(1)
    expect(onSessionClosed).toHaveBeenCalledTimes(1)
  })

  it('proxies prebuilt keyframe index requests over the popup session channel', async () => {
    const index: PrebuiltKeyframeIndex = {
      durationSec: 12.5,
      keyframeTimestampsSec: [0, 4, 8, 12],
    }
    const session: ByteRangeStreamingSession & StreamingVisualization = {
      fileSize: 100,
      read: vi.fn().mockResolvedValue(new Uint8Array([1])),
      waitForRange: vi.fn().mockResolvedValue(undefined),
      setHint: vi.fn(),
      clearHint: vi.fn(),
      close: vi.fn(),
      buildPrebuiltKeyframeIndex: vi.fn().mockResolvedValue(index),
    }

    const host = createVideoPopupSessionHost('session-index', session, createChannel)
    const remote = createRemoteByteRangeStreamingSession(createDescriptor('session-index'), {
      createChannel,
    })

    await expect(remote.session.buildPrebuiltKeyframeIndex?.()).resolves.toEqual(index)
    expect(session.buildPrebuiltKeyframeIndex).toHaveBeenCalledTimes(1)

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
    const session: ByteRangeStreamingSession & StreamingVisualization = {
      fileSize: 100,
      read: vi.fn().mockResolvedValue(new Uint8Array([1])),
      waitForRange: vi.fn().mockResolvedValue(undefined),
      setHint: vi.fn(),
      clearHint: vi.fn(),
      close: vi.fn(),
      getPieceTimelineSnapshot: vi.fn().mockResolvedValue(snapshot),
    }

    const host = createVideoPopupSessionHost('session-piece-timeline', session, createChannel)
    const remote = createRemoteByteRangeStreamingSession(
      createDescriptor('session-piece-timeline'),
      { createChannel },
    )

    await expect(remote.session.getPieceTimelineSnapshot?.()).resolves.toEqual(snapshot)
    expect(session.getPieceTimelineSnapshot).toHaveBeenCalledTimes(1)

    remote.dispose()
    host.dispose()
  })

  it('propagates popup read aborts to the host-side session signal', async () => {
    let hostReadSignal: AbortSignal | undefined
    const session: ByteRangeStreamingSession & StreamingVisualization = {
      fileSize: 100,
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
      setHint: vi.fn(),
      clearHint: vi.fn(),
      close: vi.fn(),
    }

    const host = createVideoPopupSessionHost('session-abort-read', session, createChannel)
    const remote = createRemoteByteRangeStreamingSession(createDescriptor('session-abort-read'), {
      createChannel,
    })

    const controller = new AbortController()
    const readPromise = remote.session.read(0, 16, controller.signal)

    await Promise.resolve()
    controller.abort()

    await expect(readPromise).rejects.toMatchObject({ name: 'AbortError' })
    await Promise.resolve()
    expect(hostReadSignal?.aborted).toBe(true)

    remote.dispose()
    host.dispose()
  })

  it('closes the host session when the remote side disposes', async () => {
    const session: ByteRangeStreamingSession & StreamingVisualization = {
      fileSize: 100,
      read: vi.fn().mockResolvedValue(new Uint8Array([1])),
      waitForRange: vi.fn().mockResolvedValue(undefined),
      setHint: vi.fn(),
      clearHint: vi.fn(),
      close: vi.fn(),
    }

    const host = createVideoPopupSessionHost('session-dispose', session, createChannel)
    const remote = createRemoteByteRangeStreamingSession(createDescriptor('session-dispose'), {
      createChannel,
    })

    remote.dispose()
    await Promise.resolve()

    expect(session.close).toHaveBeenCalledTimes(1)

    host.dispose()
  })
})
