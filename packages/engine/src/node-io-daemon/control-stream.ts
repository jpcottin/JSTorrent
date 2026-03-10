import {
  CONTROL_OP_CANCEL_HTTP_STREAM_RANGE_WAIT,
  CONTROL_OP_CLOSE_HTTP_STREAM_SESSION,
  CONTROL_OP_OPEN_HTTP_STREAM_SESSION,
  CONTROL_OP_WAIT_FOR_HTTP_STREAM_RANGE,
} from './control-protocol'
import type { NodeIoDaemonRegisteredHttpStream } from './http-stream-registry'
import type { NodeIoDaemonIoSession } from './io-session'
import {
  NODE_IO_DAEMON_HTTP_STREAM_STATUS,
  type NodeIoDaemonHttpStreamStatus,
} from './types'
import type { NodeIoDaemonHttpStreamRegistry } from './http-stream-registry'

function createHttpStreamStatusError(
  status: NodeIoDaemonHttpStreamStatus,
  message: string = status,
): Error {
  const error = new Error(message)
  error.name = status
  return error
}

function isAbortResponse(payload: Record<string, unknown>): boolean {
  return String(payload.error ?? '') === 'Aborted'
}

function ensureOk(payload: Record<string, unknown>, signal?: AbortSignal): void {
  if (payload.ok === true) {
    return
  }

  if (signal?.aborted && isAbortResponse(payload)) {
    const error =
      typeof DOMException !== 'undefined'
        ? new DOMException('Aborted', 'AbortError')
        : Object.assign(new Error('Aborted'), { name: 'AbortError' })
    throw error
  }

  const status = String(payload.status ?? '')
  const message = String(payload.error ?? 'Control stream request failed')
  switch (status) {
    case NODE_IO_DAEMON_HTTP_STREAM_STATUS.FileSkipped:
    case NODE_IO_DAEMON_HTTP_STREAM_STATUS.StreamSessionMismatch:
    case NODE_IO_DAEMON_HTTP_STREAM_STATUS.StreamSessionNotFound:
    case NODE_IO_DAEMON_HTTP_STREAM_STATUS.TorrentErrored:
    case NODE_IO_DAEMON_HTTP_STREAM_STATUS.TorrentInactive:
    case NODE_IO_DAEMON_HTTP_STREAM_STATUS.TorrentRemoved:
    case NODE_IO_DAEMON_HTTP_STREAM_STATUS.TorrentStopped:
      throw createHttpStreamStatusError(status, message)
    default:
      throw createHttpStreamStatusError(
        NODE_IO_DAEMON_HTTP_STREAM_STATUS.StreamSessionNotFound,
        message,
      )
  }
}

export class NodeIoDaemonControlStreamRegistry {
  private readonly sessions = new Map<string, NodeIoDaemonIoSession>()

  insert(ownerId: string, session: NodeIoDaemonIoSession): void {
    this.sessions.set(ownerId, session)
  }

  get(ownerId: string): NodeIoDaemonIoSession | null {
    return this.sessions.get(ownerId) ?? null
  }

  remove(ownerId: string): NodeIoDaemonIoSession | null {
    const session = this.sessions.get(ownerId) ?? null
    if (session) {
      this.sessions.delete(ownerId)
    }
    return session
  }
}

export class NodeIoDaemonControlChannelHttpStreamBridge {
  private readonly activeSessions = new Map<string, string>()

  constructor(
    private readonly httpStreams: NodeIoDaemonHttpStreamRegistry,
    private readonly controlSessions: NodeIoDaemonControlStreamRegistry,
  ) {}

  private resolveOwner(streamToken: string): {
    ownerId: string
    session: NodeIoDaemonIoSession
    stream: NodeIoDaemonRegisteredHttpStream
  } {
    const stream = this.httpStreams.peek(streamToken)
    if (!stream) {
      throw createHttpStreamStatusError(
        NODE_IO_DAEMON_HTTP_STREAM_STATUS.StreamSessionNotFound,
        'HTTP stream token not found',
      )
    }
    if (!stream.ownerId) {
      throw createHttpStreamStatusError(
        NODE_IO_DAEMON_HTTP_STREAM_STATUS.StreamSessionNotFound,
        'HTTP stream token has no control owner',
      )
    }
    const session = this.controlSessions.get(stream.ownerId)
    if (!session) {
      throw createHttpStreamStatusError(
        NODE_IO_DAEMON_HTTP_STREAM_STATUS.StreamSessionNotFound,
        'Control stream session not found',
      )
    }
    return { ownerId: stream.ownerId, session, stream }
  }

  private getSessionOwner(sessionId: string): { ownerId: string; session: NodeIoDaemonIoSession } {
    const ownerId = this.activeSessions.get(sessionId)
    if (!ownerId) {
      throw createHttpStreamStatusError(
        NODE_IO_DAEMON_HTTP_STREAM_STATUS.StreamSessionNotFound,
        'HTTP stream session not found',
      )
    }
    const session = this.controlSessions.get(ownerId)
    if (!session) {
      throw createHttpStreamStatusError(
        NODE_IO_DAEMON_HTTP_STREAM_STATUS.StreamSessionNotFound,
        'Control stream session not found',
      )
    }
    return { ownerId, session }
  }

  async openRequestSession(request: {
    sessionId: string
    streamToken: string
    torrentId: string
    fileIndex: number
  }): Promise<void> {
    const { ownerId, session } = this.resolveOwner(request.streamToken)
    const payload = await session.sendControlRequest(
      CONTROL_OP_OPEN_HTTP_STREAM_SESSION,
      request,
      10_000,
    )
    ensureOk(payload)
    this.activeSessions.set(request.sessionId, ownerId)
  }

  async waitForRange(request: {
    sessionId: string
    streamToken: string
    torrentId: string
    fileIndex: number
    offset: number
    length: number
    signal?: AbortSignal
  }): Promise<void> {
    const { session } = this.getSessionOwner(request.sessionId)
    let abortListener: (() => void) | null = null
    if (request.signal) {
      abortListener = () => {
        void session.sendControlNotification(CONTROL_OP_CANCEL_HTTP_STREAM_RANGE_WAIT, {
          sessionId: request.sessionId,
        })
      }
      if (request.signal.aborted) {
        abortListener()
      } else {
        request.signal.addEventListener('abort', abortListener, { once: true })
      }
    }

    try {
      const payload = await session.sendControlRequest(
        CONTROL_OP_WAIT_FOR_HTTP_STREAM_RANGE,
        {
          sessionId: request.sessionId,
          torrentId: request.torrentId,
          fileIndex: request.fileIndex,
          offset: request.offset,
          length: request.length,
        },
        null,
      )
      ensureOk(payload, request.signal)
    } catch (error) {
      if (request.signal?.aborted && error instanceof Error && error.message === 'Aborted') {
        const abortError =
          typeof DOMException !== 'undefined'
            ? new DOMException('Aborted', 'AbortError')
            : Object.assign(new Error('Aborted'), { name: 'AbortError' })
        throw abortError
      }
      throw error
    } finally {
      if (request.signal && abortListener) {
        request.signal.removeEventListener('abort', abortListener)
      }
    }
  }

  async closeRequestSession(sessionId: string, reason: string): Promise<void> {
    const active = this.activeSessions.get(sessionId)
    this.activeSessions.delete(sessionId)
    if (!active) {
      return
    }

    const session = this.controlSessions.get(active)
    if (!session) {
      return
    }

    await session.sendControlNotification(CONTROL_OP_CLOSE_HTTP_STREAM_SESSION, {
      sessionId,
      reason,
    })
  }

  removeOwner(ownerId: string): void {
    for (const [sessionId, activeOwnerId] of this.activeSessions.entries()) {
      if (activeOwnerId === ownerId) {
        this.activeSessions.delete(sessionId)
      }
    }
  }
}
