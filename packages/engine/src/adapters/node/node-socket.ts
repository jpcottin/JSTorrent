import * as net from 'net'
import * as tls from 'tls'
import * as dgram from 'dgram'
import { ITcpServer, ITcpSocket, ISocketFactory, IUdpSocket } from '../../interfaces/socket'

export class NodeTcpSocket implements ITcpSocket {
  private socket: net.Socket | tls.TLSSocket
  private _isSecure = false

  // Track registered callbacks so we can transfer them to TLS socket
  private dataCallbacks: Array<(data: Uint8Array) => void> = []
  private closeCallbacks: Array<(hadError: boolean) => void> = []
  private errorCallbacks: Array<(err: Error) => void> = []

  constructor(socket?: net.Socket | tls.TLSSocket) {
    this.socket = socket || new net.Socket()
    if (socket instanceof tls.TLSSocket) {
      this._isSecure = true
    }
  }

  get remoteAddress(): string | undefined {
    return this.socket.remoteAddress
  }

  get remotePort(): number | undefined {
    return this.socket.remotePort
  }

  get isSecure(): boolean {
    return this._isSecure
  }

  connect(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      // console.error(`NodeTcpSocket: Connecting to ${host}:${port}`)
      // Use the existing socket - don't create a new one!
      // Callbacks may already be registered on this.socket.
      this.socket.connect(port, host, () => {
        // console.error(`NodeTcpSocket: Connected to ${host}:${port}`)
        resolve()
      })

      // Use 'once' to avoid duplicate error handlers if connect is called multiple times
      this.socket.once('error', (err) => {
        console.error(`NodeTcpSocket: Error connecting: ${err.message}`)
        reject(err)
      })
    })
  }

  send(data: Uint8Array): void {
    if (this.socket.destroyed || !this.socket.writable) {
      console.error('NodeTcpSocket: Socket not writable, skipping send')
      return
    }
    try {
      this.socket.write(data, (err) => {
        if (err) {
          console.error(`NodeTcpSocket: Error sending data: ${err.message}`)
        }
      })
    } catch (err) {
      console.error(
        `NodeTcpSocket: Exception sending data: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  onData(cb: (data: Uint8Array) => void): void {
    // console.error('NodeTcpSocket: Registering onData listener')
    this.dataCallbacks.push(cb)
    this.socket.on('data', (data) => {
      // console.error(`NodeTcpSocket: Received ${data.length} bytes from net.Socket`)
      cb(new Uint8Array(data))
    })
  }

  onClose(cb: (hadError: boolean) => void): void {
    this.closeCallbacks.push(cb)
    this.socket.on('close', cb)
  }

  onError(cb: (err: Error) => void): void {
    this.errorCallbacks.push(cb)
    this.socket.on('error', cb)
  }

  close(): void {
    // console.error('NodeTcpSocket: Closing socket')
    this.socket.destroy()
  }

  /**
   * Upgrade the connection to TLS.
   * This wraps the existing socket in a TLS layer.
   */
  async secure(hostname: string, options?: { skipValidation?: boolean }): Promise<void> {
    if (this._isSecure) {
      throw new Error('Socket is already secure')
    }

    const plainSocket = this.socket as net.Socket
    // console.error(`NodeTcpSocket.secure: upgrading to TLS for ${hostname}`)

    return new Promise((resolve, reject) => {
      const tlsOptions: tls.ConnectionOptions = {
        socket: plainSocket,
        servername: hostname,
        rejectUnauthorized: !options?.skipValidation,
      }

      const tlsSocket = tls.connect(tlsOptions, () => {
        // console.error(`NodeTcpSocket: TLS handshake complete for ${hostname}`)
        this._isSecure = true

        // Now that TLS is established, move listeners to TLS socket
        // The plain socket is now internal to the TLS socket and should not emit events
        plainSocket.removeAllListeners('data')
        plainSocket.removeAllListeners('close')
        plainSocket.removeAllListeners('error')

        // Re-register callbacks on TLS socket
        for (const cb of this.dataCallbacks) {
          tlsSocket.on('data', (data) => cb(new Uint8Array(data)))
        }
        for (const cb of this.closeCallbacks) {
          tlsSocket.on('close', cb)
        }
        for (const cb of this.errorCallbacks) {
          tlsSocket.on('error', cb)
        }

        // Replace socket reference
        this.socket = tlsSocket

        resolve()
      })

      tlsSocket.once('error', (err) => {
        // console.error(`NodeTcpSocket: TLS error: ${err.message}`)
        reject(err)
      })
    })
  }
}

export class NodeUdpSocket implements IUdpSocket {
  private socket: dgram.Socket

  constructor(socket?: dgram.Socket) {
    this.socket = socket || dgram.createSocket('udp4')
  }

  send(addr: string, port: number, data: Uint8Array): void {
    this.socket.send(data, port, addr, (err) => {
      if (err) {
        console.error(`NodeUdpSocket: Error sending data: ${err.message}`)
      }
    })
  }

  onMessage(cb: (src: { addr: string; port: number }, data: Uint8Array) => void): void {
    this.socket.on('message', (msg, rinfo) => {
      cb({ addr: rinfo.address, port: rinfo.port }, new Uint8Array(msg))
    })
  }

  close(): void {
    this.socket.close()
  }

  async joinMulticast(group: string): Promise<void> {
    this.socket.addMembership(group)
  }

  async leaveMulticast(group: string): Promise<void> {
    this.socket.dropMembership(group)
  }
}

export class NodeTcpServer implements ITcpServer {
  private server: net.Server

  constructor() {
    this.server = net.createServer()
  }

  listen(port: number, callback?: () => void): void {
    this.server.listen(port, callback)
  }

  address(): { port: number } | null {
    const addr = this.server.address()
    if (addr && typeof addr === 'object' && 'port' in addr) {
      return { port: addr.port }
    }
    return null
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: 'connection', cb: (socket: any) => void): void {
    this.server.on(event, cb)
  }

  close(): void {
    this.server.close()
  }
}

export class NodeSocketFactory implements ISocketFactory {
  async createTcpSocket(options?: {
    host?: string
    port?: number
    purpose?: string
  }): Promise<ITcpSocket> {
    const socket = new NodeTcpSocket()
    if (options?.host && options?.port) {
      await socket.connect(options.port, options.host)
    }
    return socket
  }

  async createUdpSocket(_options?: {
    bindAddr?: string
    bindPort?: number
    purpose?: string
  }): Promise<IUdpSocket> {
    return new NodeUdpSocket()
  }

  createTcpServer(): ITcpServer {
    return new NodeTcpServer()
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapTcpSocket(socket: any): ITcpSocket {
    return new NodeTcpSocket(socket)
  }
}
