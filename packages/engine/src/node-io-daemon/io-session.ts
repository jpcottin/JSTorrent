import * as dgram from 'node:dgram'
import * as net from 'node:net'
import * as tls from 'node:tls'
import type { Duplex } from 'node:stream'
import {
  CONTROL_OP_EVENT,
  CONTROL_OP_GET_CAPABILITIES,
  CONTROL_OP_OPEN_FILE,
  CONTROL_OP_OPEN_FOLDER_PICKER,
  CONTROL_OP_POWER_HINT,
  CONTROL_OP_REGISTER_HTTP_STREAM,
  CONTROL_OP_REVOKE_TORRENT_HTTP_STREAMS,
  CONTROL_OP_REVEAL_IN_FOLDER,
  CONTROL_OP_ROOTS_CHANGED,
  type NodeIoDaemonExternalCapabilities,
} from './control-protocol'
import {
  IO_OP_AUTH,
  IO_OP_CLIENT_HELLO,
  IO_OP_ERROR,
  IO_OP_SERVER_HELLO,
  IO_OP_TCP_ACCEPT,
  IO_OP_TCP_CLOSE,
  IO_OP_TCP_CONNECT,
  IO_OP_TCP_CONNECTED,
  IO_OP_TCP_LISTEN,
  IO_OP_TCP_LISTEN_RESULT,
  IO_OP_TCP_RECV,
  IO_OP_TCP_SECURE,
  IO_OP_TCP_SECURED,
  IO_OP_TCP_SEND,
  IO_OP_TCP_STOP_LISTEN,
  IO_OP_UDP_BIND,
  IO_OP_UDP_BOUND,
  IO_OP_UDP_CLOSE,
  IO_OP_UDP_JOIN_MULTICAST,
  IO_OP_UDP_LEAVE_MULTICAST,
  IO_OP_UDP_RECV,
  IO_OP_UDP_SEND,
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
  ownerId: string | null
  getExpectedAuthToken: () => string | null
  bootstrapMode: NodeIoDaemonBootstrapMode
  getExternalCapabilities: () => NodeIoDaemonExternalCapabilities
  handleFolderPickerRequest: () => Promise<unknown>
  handleRegisterHttpStreamRequest: (request: unknown) => Promise<unknown> | unknown
  handleRevokeTorrentHttpStreamsRequest: (request: unknown) => Promise<unknown> | unknown
  onAuthenticated?: () => void
  onClose: () => void
}

type SessionState = 'await_hello' | 'await_auth' | 'authenticated' | 'closed'

interface TcpSocketRecord {
  socket: net.Socket | tls.TLSSocket
  active: boolean
}

interface TcpServerRecord {
  server: net.Server
}

interface UdpSocketRecord {
  socket: dgram.Socket
}

interface PendingControlRequest {
  opcode: number
  resolve: (payload: Record<string, unknown>) => void
  reject: (error: Error) => void
  timeout: ReturnType<typeof setTimeout> | null
}

export class NodeIoDaemonIoSession {
  private state: SessionState = 'await_hello'
  private buffer = Buffer.alloc(0)
  private readonly tcpSockets = new Map<number, TcpSocketRecord>()
  private readonly tcpServers = new Map<number, TcpServerRecord>()
  private readonly udpSockets = new Map<number, UdpSocketRecord>()
  private readonly pendingControlRequests = new Map<number, PendingControlRequest>()
  private nextControlRequestId = 1
  private nextAcceptedSocketId = 0x10000

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
    this.rejectPendingControlRequests(new Error('Control stream closed'))
    this.destroyTcpSockets()
    this.destroyTcpServers()
    this.destroyUdpSockets()
    this.options.socket.destroy()
    this.options.onClose()
  }

  private close(): void {
    if (this.state === 'closed') {
      return
    }
    this.state = 'closed'
    this.rejectPendingControlRequests(new Error('Control stream closed'))
    this.destroyTcpSockets()
    this.destroyTcpServers()
    this.destroyUdpSockets()
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
        this.options.onAuthenticated?.()
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
      if (this.handlePendingControlResponse(envelope)) {
        return
      }
      this.handleControlFrame(envelope)
      return
    }

    this.handleIoFrame(envelope)
  }

  sendControlRootsChanged(roots: unknown): void {
    if (this.options.path !== '/control' || this.state !== 'authenticated') {
      return
    }
    this.sendProtocolFrame(
      CONTROL_OP_ROOTS_CHANGED,
      0,
      new TextEncoder().encode(JSON.stringify(roots)),
    )
  }

  sendControlEvent(event: unknown): void {
    if (this.options.path !== '/control' || this.state !== 'authenticated') {
      return
    }
    this.sendProtocolFrame(CONTROL_OP_EVENT, 0, new TextEncoder().encode(JSON.stringify(event)))
  }

  sendControlRequest(
    opcode: number,
    payload: unknown,
    timeoutMs: number | null = 10000,
  ): Promise<Record<string, unknown>> {
    if (this.options.path !== '/control' || this.state !== 'authenticated') {
      return Promise.reject(new Error('Control stream is not authenticated'))
    }

    const requestId = this.nextControlRequestId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              this.pendingControlRequests.delete(requestId)
              reject(new Error('Control stream request timed out'))
            }, timeoutMs)

      this.pendingControlRequests.set(requestId, {
        opcode,
        resolve,
        reject,
        timeout,
      })

      this.sendControlResponse(opcode, requestId, payload)
    })
  }

  async sendControlNotification(opcode: number, payload: unknown): Promise<void> {
    if (this.options.path !== '/control' || this.state !== 'authenticated') {
      return
    }
    this.sendControlResponse(opcode, 0, payload)
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

    if (envelope.msgType === IO_OP_TCP_LISTEN) {
      this.handleTcpListen(envelope.requestId, envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_TCP_SECURE) {
      this.handleTcpSecure(envelope.requestId, envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_TCP_STOP_LISTEN) {
      this.handleTcpStopListen(envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_TCP_CLOSE) {
      this.handleTcpClose(envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_UDP_BIND) {
      this.handleUdpBind(envelope.requestId, envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_UDP_SEND) {
      this.handleUdpSend(envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_UDP_CLOSE) {
      this.handleUdpClose(envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_UDP_JOIN_MULTICAST) {
      this.handleUdpJoinMulticast(envelope.payload)
      return
    }

    if (envelope.msgType === IO_OP_UDP_LEAVE_MULTICAST) {
      this.handleUdpLeaveMulticast(envelope.payload)
      return
    }

    this.sendProtocolError(envelope.requestId, `Unsupported /io opcode ${envelope.msgType}`)
  }

  private handleControlFrame(envelope: {
    msgType: number
    requestId: number
    payload: Uint8Array
  }): void {
    if (envelope.msgType === CONTROL_OP_GET_CAPABILITIES) {
      this.sendControlResponse(envelope.msgType, envelope.requestId, {
        ok: true,
        capabilities: this.options.getExternalCapabilities(),
      })
      return
    }

    if (envelope.msgType === CONTROL_OP_POWER_HINT) {
      return
    }

    if (envelope.msgType === CONTROL_OP_OPEN_FOLDER_PICKER) {
      void this.handleFolderPickerRequest(envelope.requestId)
      return
    }

    if (
      envelope.msgType === CONTROL_OP_OPEN_FILE ||
      envelope.msgType === CONTROL_OP_REVEAL_IN_FOLDER
    ) {
      this.sendControlResponse(envelope.msgType, envelope.requestId, {
        ok: false,
        error: 'Control operation not implemented',
      })
      return
    }

    if (envelope.msgType === CONTROL_OP_REGISTER_HTTP_STREAM) {
      void this.handleRegisterHttpStreamRequest(envelope.requestId, envelope.payload)
      return
    }

    if (envelope.msgType === CONTROL_OP_REVOKE_TORRENT_HTTP_STREAMS) {
      void this.handleRevokeTorrentHttpStreamsRequest(envelope.requestId, envelope.payload)
      return
    }

    this.sendControlResponse(IO_OP_ERROR, envelope.requestId, {
      ok: false,
      error: `Unsupported /control opcode ${envelope.msgType}`,
    })
  }

  private handlePendingControlResponse(envelope: {
    msgType: number
    requestId: number
    payload: Uint8Array
  }): boolean {
    if (envelope.requestId === 0) {
      return false
    }

    const pending = this.pendingControlRequests.get(envelope.requestId)
    if (!pending) {
      return false
    }

    this.pendingControlRequests.delete(envelope.requestId)
    if (pending.timeout) {
      clearTimeout(pending.timeout)
    }

    if (envelope.msgType === IO_OP_ERROR) {
      pending.reject(new Error(new TextDecoder().decode(envelope.payload) || 'Daemon error'))
      return true
    }

    if (envelope.msgType !== pending.opcode) {
      pending.reject(new Error('Control stream opcode mismatch'))
      return true
    }

    try {
      const text = new TextDecoder().decode(envelope.payload)
      const parsed = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {}
      pending.resolve(parsed)
    } catch (error) {
      pending.reject(
        error instanceof Error ? error : new Error('Invalid control response payload'),
      )
    }
    return true
  }

  private async handleFolderPickerRequest(requestId: number): Promise<void> {
    try {
      const response = await this.options.handleFolderPickerRequest()
      this.sendControlResponse(CONTROL_OP_OPEN_FOLDER_PICKER, requestId, response)
    } catch (error) {
      this.sendControlResponse(CONTROL_OP_OPEN_FOLDER_PICKER, requestId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleRegisterHttpStreamRequest(
    requestId: number,
    payload: Uint8Array,
  ): Promise<void> {
    try {
      const body = JSON.parse(new TextDecoder().decode(payload)) as unknown
      if (
        body &&
        typeof body === 'object' &&
        this.options.ownerId &&
        !('ownerId' in (body as Record<string, unknown>))
      ) {
        ;(body as Record<string, unknown>).ownerId = this.options.ownerId
      }
      const response = await this.options.handleRegisterHttpStreamRequest(body)
      this.sendControlResponse(CONTROL_OP_REGISTER_HTTP_STREAM, requestId, response)
    } catch (error) {
      this.sendControlResponse(CONTROL_OP_REGISTER_HTTP_STREAM, requestId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  private async handleRevokeTorrentHttpStreamsRequest(
    requestId: number,
    payload: Uint8Array,
  ): Promise<void> {
    try {
      const body = JSON.parse(new TextDecoder().decode(payload)) as unknown
      const response = await this.options.handleRevokeTorrentHttpStreamsRequest(body)
      this.sendControlResponse(CONTROL_OP_REVOKE_TORRENT_HTTP_STREAMS, requestId, response)
    } catch (error) {
      this.sendControlResponse(CONTROL_OP_REVOKE_TORRENT_HTTP_STREAMS, requestId, {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
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

  private handleTcpSecure(requestId: number, payload: Uint8Array): void {
    if (payload.byteLength < 5) {
      this.sendProtocolFrame(IO_OP_TCP_SECURED, requestId, this.buildTcpSecureFailurePayload(0))
      return
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const socketId = view.getUint32(0, true)
    const flags = payload[4]
    const skipValidation = (flags & 1) !== 0
    const hostname = new TextDecoder().decode(payload.slice(5))
    const record = this.tcpSockets.get(socketId)

    if (!record || record.active || record.socket instanceof tls.TLSSocket) {
      this.sendProtocolFrame(
        IO_OP_TCP_SECURED,
        requestId,
        this.buildTcpSecureFailurePayload(socketId),
      )
      return
    }

    const plainSocket = record.socket
    const handleTlsError = () => {
      this.tcpSockets.delete(socketId)
      tlsSocket.destroy()
      this.sendProtocolFrame(
        IO_OP_TCP_SECURED,
        requestId,
        this.buildTcpSecureFailurePayload(socketId),
      )
    }

    const tlsSocket = tls.connect(
      {
        socket: plainSocket,
        servername: hostname,
        rejectUnauthorized: !skipValidation,
      },
      () => {
        tlsSocket.removeListener('error', handleTlsError)
        this.tcpSockets.set(socketId, { socket: tlsSocket, active: false })
        this.sendProtocolFrame(
          IO_OP_TCP_SECURED,
          requestId,
          this.buildTcpSecureSuccessPayload(socketId),
        )
      },
    )

    tlsSocket.once('error', handleTlsError)
  }

  private handleTcpListen(requestId: number, payload: Uint8Array): void {
    if (payload.byteLength < 6) {
      this.sendProtocolFrame(
        IO_OP_TCP_LISTEN_RESULT,
        requestId,
        this.buildTcpListenFailurePayload(0),
      )
      return
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const serverId = view.getUint32(0, true)
    const port = view.getUint16(4, true)
    const bindAddr = new TextDecoder().decode(payload.slice(6))
    const host = bindAddr || '0.0.0.0'

    if (this.tcpServers.has(serverId)) {
      this.sendProtocolFrame(
        IO_OP_TCP_LISTEN_RESULT,
        requestId,
        this.buildTcpListenFailurePayload(serverId),
      )
      return
    }

    const server = net.createServer((socket) => {
      const socketId = this.nextAcceptedSocketId++
      this.tcpSockets.set(socketId, { socket, active: true })
      socket.setNoDelay(true)
      this.attachActiveTcpSocket(socketId, socket)

      this.sendProtocolFrame(
        IO_OP_TCP_ACCEPT,
        0,
        this.buildTcpAcceptPayload(
          serverId,
          socketId,
          socket.remotePort ?? 0,
          socket.remoteAddress ?? '',
        ),
      )
    })

    server.on('error', () => {
      if (this.tcpServers.get(serverId)?.server === server) {
        this.tcpServers.delete(serverId)
      }
      this.sendProtocolFrame(
        IO_OP_TCP_LISTEN_RESULT,
        requestId,
        this.buildTcpListenFailurePayload(serverId),
      )
    })

    server.listen(port, host, () => {
      const address = server.address()
      const boundPort =
        typeof address === 'object' && address && typeof address.port === 'number'
          ? address.port
          : 0
      this.tcpServers.set(serverId, { server })
      this.sendProtocolFrame(
        IO_OP_TCP_LISTEN_RESULT,
        requestId,
        this.buildTcpListenSuccessPayload(serverId, boundPort),
      )
    })
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
      this.attachActiveTcpSocket(socketId, record.socket)
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

  private handleTcpStopListen(payload: Uint8Array): void {
    if (payload.byteLength < 4) {
      return
    }

    const serverId = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
      0,
      true,
    )
    const record = this.tcpServers.get(serverId)
    if (!record) {
      return
    }

    this.tcpServers.delete(serverId)
    record.server.close()
  }

  private handleUdpBind(requestId: number, payload: Uint8Array): void {
    if (payload.byteLength < 6) {
      this.sendProtocolFrame(IO_OP_UDP_BOUND, requestId, this.buildUdpBoundFailurePayload(0))
      return
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const socketId = view.getUint32(0, true)
    const port = view.getUint16(4, true)
    const bindAddr = new TextDecoder().decode(payload.slice(6))

    if (this.udpSockets.has(socketId)) {
      this.sendProtocolFrame(
        IO_OP_UDP_BOUND,
        requestId,
        this.buildUdpBoundFailurePayload(socketId),
      )
      return
    }

    const socketType = bindAddr.includes(':') ? 'udp6' : 'udp4'
    const socket = dgram.createSocket(socketType)

    socket.on('message', (message, remoteInfo) => {
      const remoteAddressBytes = new TextEncoder().encode(remoteInfo.address)
      const response = new Uint8Array(8 + remoteAddressBytes.byteLength + message.byteLength)
      const responseView = new DataView(response.buffer)
      responseView.setUint32(0, socketId, true)
      responseView.setUint16(4, remoteInfo.port, true)
      responseView.setUint16(6, remoteAddressBytes.byteLength, true)
      response.set(remoteAddressBytes, 8)
      response.set(message, 8 + remoteAddressBytes.byteLength)
      this.sendProtocolFrame(IO_OP_UDP_RECV, 0, response)
    })

    socket.once('error', () => {
      this.udpSockets.delete(socketId)
      socket.close()
      this.sendProtocolFrame(IO_OP_UDP_BOUND, requestId, this.buildUdpBoundFailurePayload(socketId))
    })

    socket.bind(port, bindAddr || undefined, () => {
      const address = socket.address()
      const boundPort = typeof address === 'object' ? address.port : 0
      this.udpSockets.set(socketId, { socket })
      this.sendProtocolFrame(
        IO_OP_UDP_BOUND,
        requestId,
        this.buildUdpBoundSuccessPayload(socketId, boundPort),
      )
    })
  }

  private handleUdpSend(payload: Uint8Array): void {
    if (payload.byteLength < 8) {
      return
    }

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const socketId = view.getUint32(0, true)
    const destPort = view.getUint16(4, true)
    const addrLength = view.getUint16(6, true)
    if (payload.byteLength < 8 + addrLength) {
      return
    }

    const record = this.udpSockets.get(socketId)
    if (!record) {
      this.sendUdpClose(socketId, true)
      return
    }

    const destAddr = new TextDecoder().decode(payload.slice(8, 8 + addrLength))
    const body = Buffer.from(payload.slice(8 + addrLength))

    record.socket.send(body, destPort, destAddr, (error) => {
      if (error) {
        this.handleUdpSocketClosed(socketId, true)
      }
    })
  }

  private handleUdpClose(payload: Uint8Array): void {
    if (payload.byteLength < 4) {
      return
    }

    const socketId = new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getUint32(
      0,
      true,
    )
    const record = this.udpSockets.get(socketId)
    if (!record) {
      return
    }

    this.udpSockets.delete(socketId)
    record.socket.close()
  }

  private handleUdpJoinMulticast(payload: Uint8Array): void {
    if (payload.byteLength < 4) {
      return
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const socketId = view.getUint32(0, true)
    const groupAddress = new TextDecoder().decode(payload.slice(4))
    const record = this.udpSockets.get(socketId)
    if (!record || !groupAddress) {
      return
    }

    try {
      record.socket.addMembership(groupAddress)
    } catch {
      // Best-effort only for now.
    }
  }

  private handleUdpLeaveMulticast(payload: Uint8Array): void {
    if (payload.byteLength < 4) {
      return
    }
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const socketId = view.getUint32(0, true)
    const groupAddress = new TextDecoder().decode(payload.slice(4))
    const record = this.udpSockets.get(socketId)
    if (!record || !groupAddress) {
      return
    }

    try {
      record.socket.dropMembership(groupAddress)
    } catch {
      // Best-effort only for now.
    }
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

  private handleUdpSocketClosed(socketId: number, hadError: boolean): void {
    const record = this.udpSockets.get(socketId)
    if (!record) {
      return
    }

    this.udpSockets.delete(socketId)
    record.socket.close()
    this.sendUdpClose(socketId, hadError)
  }

  private sendUdpClose(socketId: number, hadError: boolean): void {
    const payload = new Uint8Array(9)
    const view = new DataView(payload.buffer)
    view.setUint32(0, socketId, true)
    payload[4] = hadError ? 1 : 0
    view.setUint32(5, 0, true)
    this.sendProtocolFrame(IO_OP_UDP_CLOSE, 0, payload)
  }

  private attachActiveTcpSocket(socketId: number, socket: net.Socket | tls.TLSSocket): void {
    socket.on('data', (chunk: Buffer) => {
      const data = new Uint8Array(4 + chunk.byteLength)
      new DataView(data.buffer).setUint32(0, socketId, true)
      data.set(chunk, 4)
      this.sendProtocolFrame(IO_OP_TCP_RECV, 0, data)
    })
    socket.on('close', (hadError) => {
      this.handleSocketClosed(socketId, hadError)
    })
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

  private buildTcpListenSuccessPayload(serverId: number, boundPort: number): Uint8Array {
    const payload = new Uint8Array(11)
    const view = new DataView(payload.buffer)
    view.setUint32(0, serverId, true)
    payload[4] = 0
    view.setUint16(5, boundPort, true)
    view.setUint32(7, 0, true)
    return payload
  }

  private buildTcpListenFailurePayload(serverId: number): Uint8Array {
    const payload = new Uint8Array(11)
    const view = new DataView(payload.buffer)
    view.setUint32(0, serverId, true)
    payload[4] = 1
    view.setUint16(5, 0, true)
    view.setUint32(7, 1, true)
    return payload
  }

  private buildTcpAcceptPayload(
    serverId: number,
    socketId: number,
    remotePort: number,
    remoteAddress: string,
  ): Uint8Array {
    const remoteAddressBytes = new TextEncoder().encode(remoteAddress)
    const payload = new Uint8Array(10 + remoteAddressBytes.byteLength)
    const view = new DataView(payload.buffer)
    view.setUint32(0, serverId, true)
    view.setUint32(4, socketId, true)
    view.setUint16(8, remotePort, true)
    payload.set(remoteAddressBytes, 10)
    return payload
  }

  private buildTcpSecureSuccessPayload(socketId: number): Uint8Array {
    const payload = new Uint8Array(5)
    const view = new DataView(payload.buffer)
    view.setUint32(0, socketId, true)
    payload[4] = 0
    return payload
  }

  private buildTcpSecureFailurePayload(socketId: number): Uint8Array {
    const payload = new Uint8Array(5)
    const view = new DataView(payload.buffer)
    view.setUint32(0, socketId, true)
    payload[4] = 1
    return payload
  }

  private buildUdpBoundSuccessPayload(socketId: number, boundPort: number): Uint8Array {
    const payload = new Uint8Array(11)
    const view = new DataView(payload.buffer)
    view.setUint32(0, socketId, true)
    payload[4] = 0
    view.setUint16(5, boundPort, true)
    view.setUint32(7, 0, true)
    return payload
  }

  private buildUdpBoundFailurePayload(socketId: number): Uint8Array {
    const payload = new Uint8Array(11)
    const view = new DataView(payload.buffer)
    view.setUint32(0, socketId, true)
    payload[4] = 1
    view.setUint16(5, 0, true)
    view.setUint32(7, 1, true)
    return payload
  }

  private destroyTcpSockets(): void {
    for (const [socketId, record] of this.tcpSockets) {
      this.tcpSockets.delete(socketId)
      record.socket.destroy()
    }
  }

  private destroyTcpServers(): void {
    for (const [serverId, record] of this.tcpServers) {
      this.tcpServers.delete(serverId)
      record.server.close()
    }
  }

  private destroyUdpSockets(): void {
    for (const [socketId, record] of this.udpSockets) {
      this.udpSockets.delete(socketId)
      record.socket.close()
    }
  }

  private isAuthAccepted(token: string): boolean {
    const expectedAuthToken = this.options.getExpectedAuthToken()
    if (expectedAuthToken !== null) {
      return token === expectedAuthToken
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

  private sendControlResponse(opcode: number, requestId: number, payload: unknown): void {
    if (this.state === 'closed') {
      return
    }
    this.sendProtocolFrame(opcode, requestId, new TextEncoder().encode(JSON.stringify(payload)))
  }

  private sendClose(code = 1000, reason = ''): void {
    if (this.state === 'closed') {
      return
    }

    this.state = 'closed'
    this.rejectPendingControlRequests(new Error(reason || 'Control stream closed'))
    this.destroyTcpSockets()
    this.destroyTcpServers()
    this.destroyUdpSockets()
    this.options.socket.end(encodeCloseWebSocketFrame(code, reason))
    this.options.onClose()
  }

  private rejectPendingControlRequests(error: Error): void {
    for (const [requestId, pending] of this.pendingControlRequests.entries()) {
      if (pending.timeout) {
        clearTimeout(pending.timeout)
      }
      pending.reject(error)
      this.pendingControlRequests.delete(requestId)
    }
  }
}
