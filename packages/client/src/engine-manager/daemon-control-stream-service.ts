import {
  BtEngine,
  createStreamingFileProvider,
  createStreamingPlaybackSession,
  type Torrent,
} from '@jstorrent/engine'

const PROTOCOL_VERSION = 1
const OP_CLIENT_HELLO = 0x01
const OP_SERVER_HELLO = 0x02
const OP_AUTH = 0x03
const OP_AUTH_RESULT = 0x04
const OP_ERROR = 0x7f
const OP_CTRL_REGISTER_HTTP_STREAM = 0xec
const OP_CTRL_OPEN_HTTP_STREAM_SESSION = 0xee
const OP_CTRL_WAIT_FOR_HTTP_STREAM_RANGE = 0xef
const OP_CTRL_CANCEL_HTTP_STREAM_RANGE_WAIT = 0xf0
const OP_CTRL_CLOSE_HTTP_STREAM_SESSION = 0xf1
const OP_CTRL_REVOKE_TORRENT_HTTP_STREAMS = 0xf2

const HTTP_STREAM_STATUS = {
  FileSkipped: 'FileSkipped',
  StreamSessionMismatch: 'StreamSessionMismatch',
  StreamSessionNotFound: 'StreamSessionNotFound',
  TorrentErrored: 'TorrentErrored',
  TorrentInactive: 'TorrentInactive',
  TorrentRemoved: 'TorrentRemoved',
  TorrentStopped: 'TorrentStopped',
} as const

type HttpStreamStatus = (typeof HTTP_STREAM_STATUS)[keyof typeof HTTP_STREAM_STATUS]

interface PendingRequest {
  resolve: (response: Record<string, unknown>) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

interface ActiveStreamSession {
  streamToken: string
  torrentId: string
  fileIndex: number
  torrent: Torrent
  waitAbortController: AbortController | null
  closeReason: string | null
  session: ReturnType<typeof createStreamingPlaybackSession>
}

interface RegisterHttpStreamRequest {
  streamToken: string
  torrentId: string
  fileIndex: number
  rootKey: string
  path: string
  fileSize: number
  mimeType?: string | null
}

function buildFrame(opcode: number, requestId: number, payload: Uint8Array): ArrayBuffer {
  const frame = new Uint8Array(8 + payload.length)
  frame[0] = PROTOCOL_VERSION
  frame[1] = opcode
  const view = new DataView(frame.buffer)
  view.setUint32(4, requestId, true)
  frame.set(payload, 8)
  return frame.buffer
}

function parseHeader(frame: Uint8Array): { version: number; opcode: number; requestId: number } {
  if (frame.byteLength < 8) {
    throw new Error('Frame too short')
  }
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength)
  return {
    version: frame[0],
    opcode: frame[1],
    requestId: view.getUint32(4, true),
  }
}

function parseJsonPayload(frame: Uint8Array): Record<string, unknown> {
  const payload = frame.slice(8)
  if (payload.byteLength === 0) {
    return {}
  }
  return JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>
}

function createStatusError(status: HttpStreamStatus, message?: string): Error {
  const error = new Error(message ?? status)
  error.name = status
  return error
}

function getStatusFromError(error: unknown): HttpStreamStatus | null {
  if (!(error instanceof Error)) return null
  const candidates = [error.name, error.message]
  for (const candidate of candidates) {
    if (candidate && Object.values(HTTP_STREAM_STATUS).includes(candidate as HttpStreamStatus)) {
      return candidate as HttpStreamStatus
    }
  }
  return null
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.message === 'Aborted')
}

export class DaemonControlStreamService {
  private ws: WebSocket | null = null
  private connectPromise: Promise<void> | null = null
  private pendingRequests = new Map<number, PendingRequest>()
  private nextRequestId = 1
  private readonly sessions = new Map<string, ActiveStreamSession>()
  private readonly handleTorrentRemoved = (torrent: Torrent) => {
    this.closeSessionsForTorrent(torrent.infoHashStr, 'torrent-removed')
    this.sendNotification(OP_CTRL_REVOKE_TORRENT_HTTP_STREAMS, {
      torrentId: torrent.infoHashStr,
      reason: 'torrent-removed',
    })
  }
  private readonly handleTorrentStopped = (torrent: Torrent) => {
    this.closeSessionsForTorrent(torrent.infoHashStr, 'torrent-stopped')
  }

  constructor(
    private readonly engine: BtEngine,
    private readonly host: string,
    private readonly port: number,
    private readonly token: string,
    private readonly extensionId: string,
    private readonly installId: string,
  ) {
    engine.on('torrent-removed', this.handleTorrentRemoved)
    engine.on('torrent-stopped', this.handleTorrentStopped)
  }

  async connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return
    }
    if (this.connectPromise) {
      return this.connectPromise
    }

    this.connectPromise = new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(`ws://${this.host}:${this.port}/control`)
      ws.binaryType = 'arraybuffer'
      const timeout = setTimeout(() => {
        ws.close()
        reject(new Error('Control stream connection timeout'))
      }, 10_000)

      ws.onopen = () => {
        ws.send(buildFrame(OP_CLIENT_HELLO, 1, new Uint8Array(0)))
      }

      ws.onmessage = (event) => {
        const frame = new Uint8Array(event.data as ArrayBuffer)
        const header = parseHeader(frame)
        if (header.version !== PROTOCOL_VERSION) {
          return
        }

        if (header.opcode === OP_SERVER_HELLO) {
          const encoder = new TextEncoder()
          const tokenBytes = encoder.encode(this.token)
          const extIdBytes = encoder.encode(this.extensionId)
          const installIdBytes = encoder.encode(this.installId)
          const payload = new Uint8Array(
            1 + tokenBytes.length + 1 + extIdBytes.length + 1 + installIdBytes.length,
          )
          payload[0] = 0
          let offset = 1
          payload.set(tokenBytes, offset)
          offset += tokenBytes.length
          payload[offset++] = 0
          payload.set(extIdBytes, offset)
          offset += extIdBytes.length
          payload[offset++] = 0
          payload.set(installIdBytes, offset)
          ws.send(buildFrame(OP_AUTH, 2, payload))
          return
        }

        if (header.opcode === OP_AUTH_RESULT) {
          clearTimeout(timeout)
          if (frame[8] === 0) {
            this.ws = ws
            ws.onmessage = (messageEvent) => {
              void this.handleFrame(new Uint8Array(messageEvent.data as ArrayBuffer))
            }
            ws.onclose = () => {
              if (this.ws === ws) {
                this.ws = null
              }
              this.rejectPendingRequests(new Error('Control stream disconnected'))
            }
            ws.onerror = () => {
              this.rejectPendingRequests(new Error('Control stream WebSocket error'))
            }
            resolve()
          } else {
            ws.close()
            reject(new Error('Control stream auth failed'))
          }
        }
      }

      ws.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('Control stream WebSocket error'))
      }

      ws.onclose = () => {
        clearTimeout(timeout)
      }
    }).finally(() => {
      this.connectPromise = null
    })

    return this.connectPromise ?? Promise.resolve()
  }

  close(): void {
    this.rejectPendingRequests(new Error('Control stream closed'))
    this.ws?.close()
    this.ws = null
    this.closeAllSessions('control-stream-closed')
    this.engine.off('torrent-removed', this.handleTorrentRemoved)
    this.engine.off('torrent-stopped', this.handleTorrentStopped)
  }

  async registerHttpStream(request: RegisterHttpStreamRequest): Promise<{ mediaPort: number }> {
    await this.connect()
    const response = await this.sendRequest(OP_CTRL_REGISTER_HTTP_STREAM, request)
    const mediaPort = Number(response.mediaPort)
    if (response.ok !== true || !Number.isFinite(mediaPort) || mediaPort <= 0) {
      throw new Error(String(response.error ?? 'Failed to register HTTP stream'))
    }
    return { mediaPort }
  }

  private async handleFrame(frame: Uint8Array): Promise<void> {
    const header = parseHeader(frame)
    if (header.version !== PROTOCOL_VERSION) {
      return
    }

    if (header.opcode === OP_ERROR) {
      const pending = this.pendingRequests.get(header.requestId)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(header.requestId)
      pending.reject(new Error(new TextDecoder().decode(frame.slice(8)) || 'Daemon error'))
      return
    }

    if (header.requestId !== 0 && this.pendingRequests.has(header.requestId)) {
      const pending = this.pendingRequests.get(header.requestId)
      if (!pending) return
      clearTimeout(pending.timeout)
      this.pendingRequests.delete(header.requestId)
      pending.resolve(parseJsonPayload(frame))
      return
    }

    if (header.requestId === 0) {
      await this.handleNotification(header.opcode, parseJsonPayload(frame))
      return
    }

    const payload = parseJsonPayload(frame)
    let response: Record<string, unknown>
    try {
      response = await this.handleDaemonRequest(header.opcode, payload)
    } catch (error) {
      const status = getStatusFromError(error)
      response = {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        ...(status ? { status } : {}),
      }
    }

    this.ws?.send(
      buildFrame(header.opcode, header.requestId, new TextEncoder().encode(JSON.stringify(response))),
    )
  }

  private async handleNotification(
    opcode: number,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (opcode === OP_CTRL_CANCEL_HTTP_STREAM_RANGE_WAIT) {
      const sessionId = String(payload.sessionId ?? '')
      this.abortActiveWait(sessionId)
      return
    }

    if (opcode === OP_CTRL_CLOSE_HTTP_STREAM_SESSION) {
      const sessionId = String(payload.sessionId ?? '')
      const reason = String(payload.reason ?? 'closed')
      this.closeSession(sessionId, reason)
    }
  }

  private async handleDaemonRequest(
    opcode: number,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (opcode === OP_CTRL_OPEN_HTTP_STREAM_SESSION) {
      const sessionId = String(payload.sessionId ?? '')
      const streamToken = String(payload.streamToken ?? '')
      const torrentId = String(payload.torrentId ?? '')
      const fileIndex = Number(payload.fileIndex)
      const session = this.createSession(sessionId, streamToken, torrentId, fileIndex)
      return {
        ok: true,
        fileSize: session.session.fileSize,
      }
    }

    if (opcode === OP_CTRL_WAIT_FOR_HTTP_STREAM_RANGE) {
      const sessionId = String(payload.sessionId ?? '')
      const offset = Number(payload.offset)
      const length = Number(payload.length)
      await this.waitForRange(sessionId, offset, length)
      return { ok: true }
    }

    throw new Error(`Unsupported stream control opcode: 0x${opcode.toString(16)}`)
  }

  private createSession(
    sessionId: string,
    streamToken: string,
    torrentId: string,
    fileIndex: number,
  ): ActiveStreamSession {
    const torrent = this.engine.getTorrent(torrentId)
    if (!torrent) {
      throw createStatusError(HTTP_STREAM_STATUS.TorrentRemoved)
    }

    const file = torrent.files[fileIndex]
    if (!file) {
      throw createStatusError(HTTP_STREAM_STATUS.StreamSessionMismatch)
    }

    this.closeSession(sessionId, 'replaced')

    const session = createStreamingPlaybackSession(createStreamingFileProvider(torrent, fileIndex), {
      tokenPrefix: `daemon-control:${streamToken}`,
      logPrefix: `[daemon-control:${sessionId}]`,
    })
    session.open()

    const activeSession: ActiveStreamSession = {
      streamToken,
      torrentId,
      fileIndex,
      torrent,
      waitAbortController: null,
      closeReason: null,
      session,
    }
    this.sessions.set(sessionId, activeSession)
    return activeSession
  }

  private async waitForRange(sessionId: string, offset: number, requestedLength: number): Promise<void> {
    const activeSession = this.sessions.get(sessionId)
    if (!activeSession) {
      throw createStatusError(HTTP_STREAM_STATUS.StreamSessionNotFound)
    }

    const { torrent, fileIndex, session } = activeSession
    const currentTorrent = this.engine.getTorrent(activeSession.torrentId)
    if (!currentTorrent || currentTorrent !== torrent) {
      throw createStatusError(HTTP_STREAM_STATUS.TorrentRemoved)
    }

    const length = Math.max(0, Math.min(requestedLength, session.fileSize - offset))
    if (length === 0) {
      return
    }

    if (this.isRangeAvailable(torrent, fileIndex, offset, length)) {
      return
    }

    const unstreamableStateError = this.getUnstreamableStateError(torrent, fileIndex)
    if (unstreamableStateError) {
      throw createStatusError(unstreamableStateError)
    }

    const controller = new AbortController()
    activeSession.waitAbortController = controller
    try {
      await session.waitForRange(offset, length, controller.signal)
    } catch (error) {
      if (isAbortError(error) && activeSession.closeReason) {
        const closeReason = activeSession.closeReason
        if (closeReason === 'torrent-removed') {
          throw createStatusError(HTTP_STREAM_STATUS.TorrentRemoved)
        }
        if (closeReason === 'torrent-stopped') {
          throw createStatusError(HTTP_STREAM_STATUS.TorrentStopped)
        }
        if (closeReason === 'torrent-errored') {
          throw createStatusError(HTTP_STREAM_STATUS.TorrentErrored)
        }
        if (closeReason === 'client-aborted' || closeReason === 'closed') {
          throw new Error('Aborted')
        }
      }
      const status = getStatusFromError(error)
      if (status) {
        throw createStatusError(status)
      }
      throw error
    } finally {
      if (activeSession.waitAbortController === controller) {
        activeSession.waitAbortController = null
      }
    }
  }

  private abortActiveWait(sessionId: string): void {
    this.sessions.get(sessionId)?.waitAbortController?.abort()
  }

  private closeSession(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    session.closeReason = reason
    session.waitAbortController?.abort()
    session.waitAbortController = null
    session.session.close()
    this.sessions.delete(sessionId)
  }

  private closeSessionsForTorrent(torrentId: string, reason: string): void {
    for (const [sessionId, session] of this.sessions.entries()) {
      if (session.torrentId !== torrentId) continue
      this.closeSession(sessionId, reason)
    }
  }

  private closeAllSessions(reason: string): void {
    for (const sessionId of [...this.sessions.keys()]) {
      this.closeSession(sessionId, reason)
    }
  }

  private async sendRequest(
    opcode: number,
    payload: object,
    timeoutMs = 10_000,
  ): Promise<Record<string, unknown>> {
    await this.connect()
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Control stream WebSocket not connected')
    }

    const requestId = this.nextRequestId++
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId)
        reject(new Error('Control stream request timed out'))
      }, timeoutMs)

      this.pendingRequests.set(requestId, {
        resolve,
        reject,
        timeout,
      })

      this.ws!.send(buildFrame(opcode, requestId, payloadBytes))
    })
  }

  private sendNotification(opcode: number, payload: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return
    }
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))
    this.ws.send(buildFrame(opcode, 0, payloadBytes))
  }

  private rejectPendingRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout)
      pending.reject(error)
      this.pendingRequests.delete(requestId)
    }
  }

  private isRangeAvailable(torrent: Torrent, fileIndex: number, offset: number, length: number): boolean {
    const pieces = torrent.fileBytesToPieces(fileIndex, offset, length)
    return pieces.every((pieceIndex) => torrent.hasPiece(pieceIndex))
  }

  private getUnstreamableStateError(
    torrent: Torrent,
    fileIndex: number,
  ): HttpStreamStatus | null {
    if (torrent.isFileSkipped(fileIndex)) {
      return HTTP_STREAM_STATUS.FileSkipped
    }
    if (torrent.errorMessage) {
      return HTTP_STREAM_STATUS.TorrentErrored
    }
    if (torrent.userState !== 'active') {
      return torrent.userState === 'stopped'
        ? HTTP_STREAM_STATUS.TorrentStopped
        : HTTP_STREAM_STATUS.TorrentInactive
    }
    if (torrent.activityState === 'stopped' || torrent.activityState === 'queued') {
      return HTTP_STREAM_STATUS.TorrentInactive
    }
    return null
  }
}
