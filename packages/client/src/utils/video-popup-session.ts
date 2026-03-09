import type {
  ByteRangeStreamingSession,
  PreparedPlaybackMetadata,
  StreamingPlaybackCapabilities,
  StreamingPlaybackHandle,
  StreamingPlaybackOption,
  StreamingPlayerController,
  StreamingFilePieceSnapshot,
  StreamingVisualization,
} from '@jstorrent/engine'
import type { VideoPopupLaunchOptions } from '../host/types'

type ChannelMessageEvent = MessageEvent<unknown>

interface ChannelLike {
  postMessage(message: unknown): void
  close(): void
  addEventListener(type: 'message', listener: (event: ChannelMessageEvent) => void): void
  removeEventListener(type: 'message', listener: (event: ChannelMessageEvent) => void): void
}

type ChannelFactory = (name: string) => ChannelLike

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

interface HostPendingCall {
  controller: AbortController
}

type HostMessage =
  | {
      type: 'call'
      id: string
      method:
        | 'read'
        | 'waitForRange'
        | 'getPlaybackCapabilities'
        | 'getPlaybackOptions'
        | 'preparePlaybackMetadata'
        | 'getPreparedPlaybackMetadata'
        | 'getPieceTimelineSnapshot'
      args: unknown[]
    }
  | { type: 'abort'; id: string }
  | { type: 'close' }

type PopupMessage =
  | { type: 'result'; id: string; value: unknown }
  | { type: 'error'; id: string; message: string }
  | { type: 'closing' }

export interface VideoPopupSessionHost {
  dispose(): void
}

export interface RemoteByteRangeStreamingSessionHandle {
  playback: StreamingPlaybackHandle
  dispose(): void
}

export interface RemoteByteRangeStreamingSessionOptions {
  onSessionClosed?: () => void
  createChannel?: ChannelFactory
}

const CHANNEL_PREFIX = 'jstorrent-video-popup:'

function createDefaultChannel(name: string): ChannelLike {
  return new BroadcastChannel(name)
}

function createRequestId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `video-popup-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getChannelName(sessionId: string): string {
  return CHANNEL_PREFIX + sessionId
}

function makeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

export function createVideoPopupSessionHost(
  sessionId: string,
  playback: StreamingPlaybackHandle,
  createChannel: ChannelFactory = createDefaultChannel,
): VideoPopupSessionHost {
  const channel = createChannel(getChannelName(sessionId))
  const pendingCalls = new Map<string, HostPendingCall>()
  let disposed = false

  const cleanupPendingCall = (id: string) => {
    pendingCalls.delete(id)
  }

  const reply = (message: PopupMessage) => {
    if (!disposed) {
      channel.postMessage(message)
    }
  }

  const onMessage = (event: ChannelMessageEvent) => {
    if (disposed) return
    const message = event.data as HostMessage
    if (!message || typeof message !== 'object' || !('type' in message)) return

    if (message.type === 'abort') {
      pendingCalls.get(message.id)?.controller.abort()
      cleanupPendingCall(message.id)
      return
    }

    if (message.type === 'close') {
      dispose()
      return
    }

    if (message.type !== 'call') return

    if (message.method === 'getPlaybackCapabilities') {
      Promise.resolve(
        playback.controller?.getPlaybackCapabilities
          ? playback.controller.getPlaybackCapabilities()
          : null,
      )
        .then((capabilities) => {
          reply({ type: 'result', id: message.id, value: capabilities ?? null })
        })
        .catch((error) => {
          reply({ type: 'error', id: message.id, message: makeError(error).message })
        })
      return
    }

    if (message.method === 'getPlaybackOptions') {
      Promise.resolve(
        playback.controller?.getPlaybackOptions ? playback.controller.getPlaybackOptions() : null,
      )
        .then((playbackOptions) => {
          reply({ type: 'result', id: message.id, value: playbackOptions ?? null })
        })
        .catch((error) => {
          reply({ type: 'error', id: message.id, message: makeError(error).message })
        })
      return
    }

    if (message.method === 'preparePlaybackMetadata') {
      Promise.resolve(
        playback.controller?.preparePlaybackMetadata
          ? playback.controller.preparePlaybackMetadata()
          : null,
      )
        .then((index) => {
          reply({ type: 'result', id: message.id, value: index ?? null })
        })
        .catch((error) => {
          reply({ type: 'error', id: message.id, message: makeError(error).message })
        })
      return
    }

    if (message.method === 'getPreparedPlaybackMetadata') {
      Promise.resolve(
        playback.controller?.getPreparedPlaybackMetadata
          ? playback.controller.getPreparedPlaybackMetadata()
          : null,
      )
        .then((metadata) => {
          reply({ type: 'result', id: message.id, value: metadata ?? null })
        })
        .catch((error) => {
          reply({ type: 'error', id: message.id, message: makeError(error).message })
        })
      return
    }

    if (message.method === 'getPieceTimelineSnapshot') {
      Promise.resolve(
        playback.diagnostics?.getPieceTimelineSnapshot
          ? playback.diagnostics.getPieceTimelineSnapshot()
          : null,
      )
        .then((snapshot) => {
          reply({ type: 'result', id: message.id, value: snapshot ?? null })
        })
        .catch((error) => {
          reply({ type: 'error', id: message.id, message: makeError(error).message })
        })
      return
    }

    const controller = new AbortController()
    pendingCalls.set(message.id, { controller })

    const promise =
      message.method === 'read'
        ? playback.bytes.read(...(message.args as [number, number]), controller.signal)
        : playback.bytes.waitForRange(...(message.args as [number, number]), controller.signal)

    promise
      .then((value) => {
        cleanupPendingCall(message.id)
        reply({ type: 'result', id: message.id, value: value ?? null })
      })
      .catch((error) => {
        cleanupPendingCall(message.id)
        reply({ type: 'error', id: message.id, message: makeError(error).message })
      })
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    for (const pending of pendingCalls.values()) {
      pending.controller.abort()
    }
    pendingCalls.clear()
    playback.bytes.close()
    channel.postMessage({ type: 'closing' } satisfies PopupMessage)
    channel.removeEventListener('message', onMessage)
    channel.close()
  }

  channel.addEventListener('message', onMessage)

  return { dispose }
}

export function createRemoteByteRangeStreamingSession(
  descriptor: VideoPopupLaunchOptions,
  options: RemoteByteRangeStreamingSessionOptions = {},
): RemoteByteRangeStreamingSessionHandle {
  const createChannel = options.createChannel ?? createDefaultChannel
  const channel = createChannel(getChannelName(descriptor.sessionId))
  const pendingCalls = new Map<string, PendingCall>()
  let disposed = false

  const rejectAll = (error: Error) => {
    for (const pending of pendingCalls.values()) {
      pending.reject(error)
    }
    pendingCalls.clear()
  }

  const onMessage = (event: ChannelMessageEvent) => {
    const message = event.data as PopupMessage
    if (!message || typeof message !== 'object' || !('type' in message)) return

    if (message.type === 'closing') {
      const error = new Error('Video popup session closed')
      rejectAll(error)
      dispose(false)
      options.onSessionClosed?.()
      return
    }

    if (message.type !== 'result' && message.type !== 'error') return
    const pending = pendingCalls.get(message.id)
    if (!pending) return
    pendingCalls.delete(message.id)

    if (message.type === 'result') {
      pending.resolve(message.value)
    } else {
      pending.reject(new Error(message.message))
    }
  }

  channel.addEventListener('message', onMessage)

  const postCall = <T>(
    method:
      | 'read'
      | 'waitForRange'
      | 'getPlaybackCapabilities'
      | 'getPlaybackOptions'
      | 'preparePlaybackMetadata'
      | 'getPreparedPlaybackMetadata'
      | 'getPieceTimelineSnapshot',
    args: unknown[],
    signal?: AbortSignal,
  ): Promise<T> => {
    if (disposed) {
      return Promise.reject(new Error('Video popup session closed'))
    }

    const id = createRequestId()
    return new Promise<T>((resolve, reject) => {
      pendingCalls.set(id, { resolve: resolve as (value: unknown) => void, reject })

      const onAbort = () => {
        pendingCalls.delete(id)
        channel.postMessage({ type: 'abort', id } satisfies HostMessage)
        reject(new DOMException('Aborted', 'AbortError'))
      }

      if (signal?.aborted) {
        onAbort()
        return
      }

      signal?.addEventListener('abort', onAbort, { once: true })

      const finalizeResolve = (value: T) => {
        signal?.removeEventListener('abort', onAbort)
        resolve(value)
      }

      const finalizeReject = (error: Error) => {
        signal?.removeEventListener('abort', onAbort)
        reject(error)
      }

      pendingCalls.set(id, {
        resolve: finalizeResolve as (value: unknown) => void,
        reject: finalizeReject,
      })

      channel.postMessage({ type: 'call', id, method, args } satisfies HostMessage)
    })
  }

  const dispose = (notifyHost = true) => {
    if (disposed) return
    disposed = true
    if (notifyHost) {
      channel.postMessage({ type: 'close' } satisfies HostMessage)
    }
    rejectAll(new Error('Video popup session closed'))
    channel.removeEventListener('message', onMessage)
    channel.close()
  }

  const bytes: ByteRangeStreamingSession = {
    fileSize: descriptor.fileSize,
    read: (offset, length, signal) => postCall<Uint8Array>('read', [offset, length], signal),
    waitForRange: (offset, length, signal) =>
      postCall<void>('waitForRange', [offset, length], signal).then(() => undefined),
    close: () => {
      dispose(true)
    },
  }

  const controller: StreamingPlayerController = {
    getPlaybackCapabilities: () =>
      postCall<StreamingPlaybackCapabilities | null>('getPlaybackCapabilities', []),
    getPlaybackOptions: () => postCall<StreamingPlaybackOption[] | null>('getPlaybackOptions', []),
    preparePlaybackMetadata: () =>
      postCall<PreparedPlaybackMetadata | null>('preparePlaybackMetadata', []),
    getPreparedPlaybackMetadata: () =>
      postCall<PreparedPlaybackMetadata | null>('getPreparedPlaybackMetadata', []),
  }

  const diagnostics: StreamingVisualization = {
    getPieceTimelineSnapshot: () =>
      postCall<StreamingFilePieceSnapshot | null>('getPieceTimelineSnapshot', []),
  }

  return {
    playback: {
      bytes,
      controller,
      diagnostics,
    },
    dispose,
  }
}
