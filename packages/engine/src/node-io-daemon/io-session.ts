import type { Duplex } from 'node:stream'
import {
  IO_OP_AUTH,
  IO_OP_CLIENT_HELLO,
  IO_OP_SERVER_HELLO,
  IO_PROTOCOL_VERSION,
  buildIoProtocolAuthResultFrame,
  buildIoProtocolErrorFrame,
  buildIoProtocolFrame,
  parseIoProtocolAuthPayload,
  parseIoProtocolEnvelope,
} from './io-protocol'
import {
  createWebSocketAcceptValue,
  decodeWebSocketFrame,
  encodeBinaryWebSocketFrame,
  encodeCloseWebSocketFrame,
  encodePongWebSocketFrame,
} from './websocket'
import type { NodeIoDaemonBootstrapMode } from './types'

export interface NodeIoDaemonIoSessionOptions {
  path: '/io' | '/control'
  socket: Duplex
  expectedAuthToken: string | null
  bootstrapMode: NodeIoDaemonBootstrapMode
  onClose: () => void
}

type SessionState = 'await_hello' | 'await_auth' | 'authenticated' | 'closed'

export class NodeIoDaemonIoSession {
  private state: SessionState = 'await_hello'
  private buffer = Buffer.alloc(0)

  constructor(private readonly options: NodeIoDaemonIoSessionOptions) {
    const { socket } = options
    socket.on('data', (chunk) => this.handleData(chunk))
    socket.on('end', () => this.close())
    socket.on('close', () => this.close())
    socket.on('error', () => this.close())
  }

  static upgrade(
    request: { headers: Record<string, string | string[] | undefined> },
    options: NodeIoDaemonIoSessionOptions,
  ): NodeIoDaemonIoSession | null {
    const keyHeader = request.headers['sec-websocket-key']
    const versionHeader = request.headers['sec-websocket-version']
    const key = Array.isArray(keyHeader) ? keyHeader[0] : keyHeader
    const version = Array.isArray(versionHeader) ? versionHeader[0] : versionHeader

    if (!key || version !== '13') {
      options.socket.write('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      options.socket.destroy()
      return null
    }

    const accept = createWebSocketAcceptValue(key)
    options.socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Accept: ${accept}`,
        '\r\n',
      ].join('\r\n'),
    )

    return new NodeIoDaemonIoSession(options)
  }

  receiveHead(head: Buffer): void {
    if (head.length > 0) {
      this.handleData(head)
    }
  }

  destroy(): void {
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    this.options.socket.destroy()
    this.options.onClose()
  }

  private close(): void {
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    this.options.onClose()
  }

  private handleData(chunk: Buffer): void {
    if (this.state === 'closed') {
      return
    }

    this.buffer = Buffer.concat([this.buffer, chunk])

    while (this.buffer.length > 0) {
      let frame
      try {
        frame = decodeWebSocketFrame(this.buffer)
      } catch {
        this.sendClose(1009, 'Frame too large')
        return
      }

      if (!frame) {
        return
      }

      this.buffer = this.buffer.subarray(frame.bytesConsumed)
      this.handleFrame(frame.opcode, frame.payload, frame.masked, frame.fin)
    }
  }

  private handleFrame(opcode: number, payload: Buffer, masked: boolean, fin: boolean): void {
    if (!fin || !masked) {
      this.sendClose(1002, 'Unsupported frame')
      return
    }

    if (opcode === 0x8) {
      this.sendClose()
      return
    }

    if (opcode === 0x9) {
      this.options.socket.write(encodePongWebSocketFrame(payload))
      return
    }

    if (opcode !== 0x2) {
      this.sendClose(1003, 'Binary frames only')
      return
    }

    const envelope = parseIoProtocolEnvelope(payload)
    if (!envelope) {
      this.sendProtocolError(0, 'Invalid envelope')
      return
    }

    if (envelope.version !== IO_PROTOCOL_VERSION) {
      this.sendProtocolError(envelope.requestId, 'Invalid protocol version')
      return
    }

    if (this.state === 'await_hello') {
      if (envelope.msgType !== IO_OP_CLIENT_HELLO) {
        this.sendProtocolError(envelope.requestId, 'Authentication required')
        return
      }

      this.state = 'await_auth'
      this.sendProtocolFrame(IO_OP_SERVER_HELLO, envelope.requestId)
      return
    }

    if (this.state === 'await_auth') {
      if (envelope.msgType !== IO_OP_AUTH) {
        this.sendProtocolError(envelope.requestId, 'Authentication required')
        return
      }

      const auth = parseIoProtocolAuthPayload(envelope.payload)
      if (!auth) {
        this.sendProtocolError(envelope.requestId, 'Invalid auth payload')
        return
      }

      if (this.isAuthAccepted(auth.token)) {
        this.state = 'authenticated'
        this.options.socket.write(
          encodeBinaryWebSocketFrame(buildIoProtocolAuthResultFrame(envelope.requestId, true)),
        )
        return
      }

      this.options.socket.write(
        encodeBinaryWebSocketFrame(
          buildIoProtocolAuthResultFrame(envelope.requestId, false, 'Invalid token'),
        ),
      )
      this.sendClose(1008, 'Invalid token')
      return
    }

    this.sendProtocolError(envelope.requestId, `${this.options.path} socket ops not implemented`)
  }

  private isAuthAccepted(token: string): boolean {
    if (this.options.expectedAuthToken !== null) {
      return token === this.options.expectedAuthToken
    }

    return this.options.bootstrapMode === 'test'
  }

  private sendProtocolFrame(msgType: number, requestId: number, payload?: Uint8Array): void {
    this.options.socket.write(
      encodeBinaryWebSocketFrame(buildIoProtocolFrame(msgType, requestId, payload)),
    )
  }

  private sendProtocolError(requestId: number, message: string): void {
    this.options.socket.write(
      encodeBinaryWebSocketFrame(buildIoProtocolErrorFrame(requestId, message)),
    )
    this.sendClose(1008, message)
  }

  private sendClose(code = 1000, reason = ''): void {
    if (this.state === 'closed') {
      return
    }

    this.state = 'closed'
    this.options.socket.end(encodeCloseWebSocketFrame(code, reason))
    this.options.onClose()
  }
}
