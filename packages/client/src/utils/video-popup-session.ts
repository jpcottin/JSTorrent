import type { PrebuiltKeyframeIndex, StreamingFileProvider } from '@jstorrent/engine'
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

interface HostPendingWait {
  controller: AbortController
}

type HostMessage =
  | { type: 'setStreamingPieces'; pieces: number[] | null }
  | {
      type: 'updateStreamingDemand'
      token: string
      pieces: number[] | null
      urgency?: 'metadata' | 'next' | 'now'
    }
  | {
      type: 'call'
      id: string
      method: 'waitForPieces' | 'readFileBytes' | 'buildPrebuiltKeyframeIndex'
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

export interface RemoteStreamingProviderHandle {
  provider: StreamingFileProvider
  dispose(): void
}

export interface RemoteStreamingProviderOptions {
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

function fileBytesToPieces(
  fileOffset: number,
  pieceLength: number,
  fileSize: number,
  offset: number,
  length: number,
): number[] {
  if (offset < 0 || length <= 0 || offset + length > fileSize) {
    throw new Error(`Invalid range: offset=${offset} length=${length} fileLength=${fileSize}`)
  }

  const torrentStart = fileOffset + offset
  const torrentEnd = torrentStart + length
  const firstPiece = Math.floor(torrentStart / pieceLength)
  const lastPiece = Math.floor((torrentEnd - 1) / pieceLength)
  const pieces: number[] = []
  for (let i = firstPiece; i <= lastPiece; i++) {
    pieces.push(i)
  }
  return pieces
}

export function createVideoPopupSessionHost(
  sessionId: string,
  provider: StreamingFileProvider,
  createChannel: ChannelFactory = createDefaultChannel,
): VideoPopupSessionHost {
  const channel = createChannel(getChannelName(sessionId))
  const pendingWaits = new Map<string, HostPendingWait>()
  let disposed = false

  const cleanupPendingWait = (id: string) => {
    pendingWaits.delete(id)
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

    if (message.type === 'setStreamingPieces') {
      provider.setStreamingPieces(message.pieces ? new Set(message.pieces) : null)
      return
    }

    if (message.type === 'updateStreamingDemand') {
      if (provider.updateStreamingDemand) {
        provider.updateStreamingDemand(
          message.token,
          message.pieces ? new Set(message.pieces) : null,
          message.urgency,
        )
      } else {
        provider.setStreamingPieces(message.pieces ? new Set(message.pieces) : null)
      }
      return
    }

    if (message.type === 'abort') {
      pendingWaits.get(message.id)?.controller.abort()
      cleanupPendingWait(message.id)
      return
    }

    if (message.type === 'close') {
      dispose()
      return
    }

    if (message.type !== 'call') return

    if (message.method === 'waitForPieces') {
      const [pieceIndices] = message.args as [number[]]
      const controller = new AbortController()
      pendingWaits.set(message.id, { controller })
      provider
        .waitForPieces(pieceIndices, controller.signal)
        .then(() => {
          cleanupPendingWait(message.id)
          reply({ type: 'result', id: message.id, value: null })
        })
        .catch((error) => {
          cleanupPendingWait(message.id)
          reply({ type: 'error', id: message.id, message: makeError(error).message })
        })
      return
    }

    if (message.method === 'readFileBytes') {
      const [offset, length] = message.args as [number, number]
      provider
        .readFileBytes(offset, length)
        .then((bytes) => {
          reply({ type: 'result', id: message.id, value: bytes })
        })
        .catch((error) => {
          reply({ type: 'error', id: message.id, message: makeError(error).message })
        })
      return
    }

    if (message.method === 'buildPrebuiltKeyframeIndex') {
      Promise.resolve(
        provider.buildPrebuiltKeyframeIndex ? provider.buildPrebuiltKeyframeIndex() : null,
      )
        .then((index) => {
          reply({ type: 'result', id: message.id, value: index ?? null })
        })
        .catch((error) => {
          reply({ type: 'error', id: message.id, message: makeError(error).message })
        })
    }
  }

  const dispose = () => {
    if (disposed) return
    disposed = true
    provider.setStreamingPieces(null)
    for (const pending of pendingWaits.values()) {
      pending.controller.abort()
    }
    pendingWaits.clear()
    channel.postMessage({ type: 'closing' } satisfies PopupMessage)
    channel.removeEventListener('message', onMessage)
    channel.close()
  }

  channel.addEventListener('message', onMessage)

  return { dispose }
}

export function createRemoteStreamingFileProvider(
  descriptor: VideoPopupLaunchOptions,
  options: RemoteStreamingProviderOptions = {},
): RemoteStreamingProviderHandle {
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
    method: 'waitForPieces' | 'readFileBytes' | 'buildPrebuiltKeyframeIndex',
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

  return {
    provider: {
      fileSize: descriptor.fileSize,
      fileBytesToPieces: (offset, length) =>
        fileBytesToPieces(
          descriptor.fileOffset,
          descriptor.pieceLength,
          descriptor.fileSize,
          offset,
          length,
        ),
      setStreamingPieces: (pieces) => {
        if (disposed) return
        channel.postMessage({
          type: 'setStreamingPieces',
          pieces: pieces ? [...pieces] : null,
        } satisfies HostMessage)
      },
      updateStreamingDemand: (token, pieces, urgency) => {
        if (disposed) return
        channel.postMessage({
          type: 'updateStreamingDemand',
          token,
          pieces: pieces ? [...pieces] : null,
          urgency,
        } satisfies HostMessage)
      },
      waitForPieces: (pieceIndices, signal) =>
        postCall<void>('waitForPieces', [pieceIndices], signal).then(() => undefined),
      readFileBytes: (offset, length) => postCall<Uint8Array>('readFileBytes', [offset, length]),
      buildPrebuiltKeyframeIndex: () =>
        postCall<PrebuiltKeyframeIndex | null>('buildPrebuiltKeyframeIndex', []),
    },
    dispose,
  }
}
