import * as net from 'node:net'
import type { Duplex } from 'node:stream'
import {
  IO_OP_AUTH,
  IO_OP_CLIENT_HELLO,
  IO_OP_SERVER_HELLO,
  IO_OP_TCP_CLOSE,
  IO_OP_TCP_CONNECT,
  IO_OP_TCP_CONNECTED,
  IO_OP_TCP_RECV,
  IO_OP_TCP_SEND,
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

interface TcpSocketRecord {
  socket: net.Socket
  active: boolean
}

export class NodeIoDaemonIoSession {
  private state: SessionState = 'await_hello'
  private buffer = Buffer.alloc(0)
  private readonly tcpSockets = new Map<number, TcpSocketRecord>()

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
    this.destroyTcpSockets()
    this.options.socket.destroy()
    this.options.onClose()
  }

  private close(): void {
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    this.destroyTcpSockets()
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

    if (this.options.path !== '/io') {
      this.sendProtocolError(envelope.requestId, `${this.options.path} socket ops not implemented`)
      return
    }

    this.handleIoFrame(envelope)
  }

  private handleIoFrame(envelope: {
    msgType: number
    requestId: number
    payload: Uint8Array
  }): void {
    if (envelope.msgType === IO_OP_TCP_CONNECT) {
      this.handleTcpConnect(envelope.requestId, envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_TCP_SEND) {
      this.handleTcpSend(envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_TCP_CLOSE) {
      this.handleTcpClose(envelope.payload)
      return
    }

    this.sendProtocolError(envelope.requestId, `Unsupported /io opcode ${envelope.msgType}`)
  }

  private handleTcpConnect(requestId: number, payload: Uint8Array): void {
    if (payload.byteLength < 6) {
      this.sendProtocolFrame(IO_OP_TCP_CONNECTED, requestId, this.buildTcpConnectFailurePayload(0))
      return
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const socketId = view.getUint32(0, true)
    const port = view.getUint16(4, true)
    const host = new TextDecoder().decode(payload.slice(6))

    if (!host || this.tcpSockets.has(socketId)) {
      this.sendProtocolFrame(
        IO_OP_TCP_CONNECTED,
        requestId,
        this.buildTcpConnectFailurePayload(socketId),
      )
      return
    }

    const socket = net.createConnection({ host, port })
    socket.setNoDelay(true)

    const timeoutId = setTimeout(() => {
      socket.destroy(new Error('Connection timeout'))
    }, 30000)

    const cleanupPendingListeners = () => {
      clearTimeout(timeoutId)
      socket.removeListener('connect', handleConnect)
      socket.removeListener('error', handleError)
    }

    const handleConnect = () => {
      cleanupPendingListeners()

      this.tcpSockets.set(socketId, { socket, active: false })
      socket.on('close', (hadError) => {
        this.handleSocketClosed(socketId, hadError)
      })

      this.sendProtocolFrame(
        IO_OP_TCP_CONNECTED,
        requestId,
        this.buildTcpConnectSuccessPayload(socketId, socket.remoteAddress ?? host),
      )
    }

    const handleError = () => {
      cleanupPendingListeners()
      socket.destroy()
      this.sendProtocolFrame(
        IO_OP_TCP_CONNECTED,
        requestId,
        this.buildTcpConnectFailurePayload(socketId),
      )
    }

    socket.once('connect', handleConnect)
    socket.once('error', handleError)
  }

  private handleTcpSend(payload: Uint8Array): void {
    if (payload.byteLength < 4) {
      return
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const socketId = view.getUint32(0, true)
    const record = this.tcpSockets.get(socketId)
    if (!record) {
      this.sendTcpClose(socketId, true)
      return
    }

    if (!record.active) {
      record.active = true
      record.socket.on('data', (chunk: Buffer) => {
        const data = new Uint8Array(4 + chunk.byteLength)
        new DataView(data.buffer).setUint32(0, socketId, true)
        data.set(chunk, 4)
        this.sendProtocolFrame(IO_OP_TCP_RECV, 0, data)
      })
    }

    const writePayload = Buffer.from(payload.slice(4))
    if (writePayload.byteLength === 0) {
      return
    }

    record.socket.write(writePayload, (error) => {
      if (error) {
        record.socket.destroy(error)
      }
    })
  }

  private handleTcpClose(payload: Uint8Array): void {
    if (payload.byteLength < 4) {
      return
    }

    const socketId = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
      0,
      true,
    )
    const record = this.tcpSockets.get(socketId)
    if (!record) {
      return
    }

    this.tcpSockets.delete(socketId)
    record.socket.destroy()
  }

  private handleSocketClosed(socketId: number, hadError: boolean): void {
    const record = this.tcpSockets.get(socketId)
    if (!record) {
      return
    }

    this.tcpSockets.delete(socketId)
    this.sendTcpClose(socketId, hadError)
  }

  private sendTcpClose(socketId: number, hadError: boolean): void {
    const payload = new Uint8Array(9)
    const view = new DataView(payload.buffer)
    view.setUint32(0, socketId, true)
    payload[4] = hadError ? 1 : 0
    view.setUint32(5, 0, true)
    this.sendProtocolFrame(IO_OP_TCP_CLOSE, 0, payload)
  }

  private buildTcpConnectSuccessPayload(socketId: number, remoteAddress: string): Uint8Array {
    const remoteAddressBytes = new TextEncoder().encode(remoteAddress)
    const payload = new Uint8Array(11 + remoteAddressBytes.byteLength)
    const view = new DataView(payload.buffer)
    view.setUint32(0, socketId, true)
    payload[4] = 0
    view.setUint32(5, 0, true)
    view.setUint16(9, remoteAddressBytes.byteLength, true)
    payload.set(remoteAddressBytes, 11)
    return payload
  }

  private buildTcpConnectFailurePayload(socketId: number): Uint8Array {
    const payload = new Uint8Array(9)
    const view = new DataView(payload.buffer)
    view.setUint32(0, socketId, true)
    payload[4] = 1
    view.setUint32(5, 1, true)
    return payload
  }

  private destroyTcpSockets(): void {
    for (const [socketId, record] of this.tcpSockets) {
      this.tcpSockets.delete(socketId)
      record.socket.destroy()
    }
  }

  private isAuthAccepted(token: string): boolean {
    if (this.options.expectedAuthToken !== null) {
      return token === this.options.expectedAuthToken
    }

    return this.options.bootstrapMode === 'test'
  }

  private sendProtocolFrame(msgType: number, requestId: number, payload?: Uint8Array): void {
    if (this.state === 'closed') {
      return
    }
    this.options.socket.write(
      encodeBinaryWebSocketFrame(buildIoProtocolFrame(msgType, requestId, payload)),
    )
  }

  private sendProtocolError(requestId: number, message: string): void {
    if (this.state === 'closed') {
      return
    }
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
    this.destroyTcpSockets()
    this.options.socket.end(encodeCloseWebSocketFrame(code, reason))
    this.options.onClose()
  }
}
