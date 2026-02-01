/**
 * SOCKS5 Proxy Socket
 *
 * Wraps an ITcpSocket to route connections through a SOCKS5 proxy.
 * The SOCKS5 handshake is performed when connect() is called.
 */

import type { ITcpSocket } from '../interfaces/socket'
import { concat } from '../utils/buffer'
import {
  SOCKS5_VERSION,
  SOCKS5_AUTH,
  buildGreeting,
  buildAuthRequest,
  buildConnectRequest,
  parseGreetingResponse,
  parseAuthResponse,
  getConnectResponseLength,
  parseConnectReply,
  getReplyError,
} from './socks5-protocol'

/** SOCKS5 proxy configuration */
export interface Socks5ProxyConfig {
  /** Proxy server hostname or IP */
  host: string
  /** Proxy server port */
  port: number
  /** Optional username for authentication */
  username?: string
  /** Optional password for authentication */
  password?: string
  /** Handshake timeout in milliseconds (default: 10000) */
  timeout?: number
}

/** State machine for SOCKS5 handshake */
type Socks5State =
  | 'initial'
  | 'greeting_sent'
  | 'auth_sent'
  | 'connect_sent'
  | 'connected'
  | 'error'

/**
 * SocksProxySocket wraps an ITcpSocket and performs SOCKS5 negotiation
 * on connect(). After handshake completes, the socket behaves normally.
 */
export class Socks5Socket implements ITcpSocket {
  private socket: ITcpSocket
  private proxyConfig: Socks5ProxyConfig

  // Handshake state
  private state: Socks5State = 'initial'
  private handshakeBuffer: Uint8Array = new Uint8Array(0)
  private handshakeResolve?: () => void
  private handshakeReject?: (err: Error) => void
  private handshakeTimeout?: ReturnType<typeof setTimeout>

  // Target connection info
  private targetHost?: string
  private targetPort?: number

  // User callbacks (forwarded after handshake)
  private userOnData?: (data: Uint8Array) => void
  private userOnClose?: (hadError: boolean) => void
  private userOnError?: (err: Error) => void

  // Forward these from underlying socket
  get remoteAddress(): string | undefined {
    return this.targetHost
  }

  get remotePort(): number | undefined {
    return this.targetPort
  }

  get isEncrypted(): boolean | undefined {
    return this.socket.isEncrypted
  }

  get isSecure(): boolean | undefined {
    return this.socket.isSecure
  }

  constructor(socket: ITcpSocket, proxyConfig: Socks5ProxyConfig) {
    this.socket = socket
    this.proxyConfig = proxyConfig
  }

  /**
   * Connect to the target through the SOCKS5 proxy.
   * 1. Connect underlying socket to proxy server
   * 2. Perform SOCKS5 greeting/auth handshake
   * 3. Send CONNECT request with target host:port
   * 4. Wait for success reply
   */
  async connect(port: number, host: string): Promise<void> {
    if (this.state !== 'initial') {
      throw new Error('Socket already connected or connecting')
    }

    this.targetHost = host
    this.targetPort = port

    // Set up internal handlers for handshake
    this.socket.onData((data) => this.handleData(data))
    this.socket.onError((err) => this.handleError(err))
    this.socket.onClose((hadError) => this.handleClose(hadError))

    // Connect to proxy server first
    if (!this.socket.connect) {
      throw new Error('Underlying socket does not support connect()')
    }
    await this.socket.connect(this.proxyConfig.port, this.proxyConfig.host)

    // Now do SOCKS5 handshake
    return new Promise((resolve, reject) => {
      this.handshakeResolve = resolve
      this.handshakeReject = reject

      // Set handshake timeout
      const timeout = this.proxyConfig.timeout ?? 10000
      this.handshakeTimeout = setTimeout(() => {
        this.failHandshake(new Error('SOCKS5 handshake timeout'))
      }, timeout)

      // Start handshake: send greeting
      const hasAuth = !!(this.proxyConfig.username && this.proxyConfig.password)
      this.socket.send(buildGreeting(hasAuth))
      this.state = 'greeting_sent'
    })
  }

  private handleData(data: Uint8Array): void {
    if (this.state === 'connected') {
      // Forward to user handler
      this.userOnData?.(data)
      return
    }

    if (this.state === 'error') {
      // Ignore data after error
      return
    }

    // Accumulate data for handshake
    this.handshakeBuffer = concat([this.handshakeBuffer, data])
    this.processHandshake()
  }

  private processHandshake(): void {
    switch (this.state) {
      case 'greeting_sent':
        this.handleGreetingResponse()
        break
      case 'auth_sent':
        this.handleAuthResponse()
        break
      case 'connect_sent':
        this.handleConnectResponse()
        break
    }
  }

  private handleGreetingResponse(): void {
    const method = parseGreetingResponse(this.handshakeBuffer)
    if (method === null) return // Need more data

    // Consume the 2-byte response
    this.handshakeBuffer = this.handshakeBuffer.slice(2)

    if (method === SOCKS5_AUTH.NO_ACCEPTABLE) {
      this.failHandshake(new Error('SOCKS5 proxy: no acceptable authentication method'))
      return
    }

    if (method === SOCKS5_AUTH.USERNAME_PASSWORD) {
      if (!this.proxyConfig.username || !this.proxyConfig.password) {
        this.failHandshake(new Error('SOCKS5 proxy requires auth but no credentials provided'))
        return
      }
      this.socket.send(buildAuthRequest(this.proxyConfig.username, this.proxyConfig.password))
      this.state = 'auth_sent'
    } else if (method === SOCKS5_AUTH.NONE) {
      this.sendConnectRequest()
    } else {
      this.failHandshake(new Error(`SOCKS5 proxy selected unknown auth method: ${method}`))
    }
  }

  private handleAuthResponse(): void {
    const success = parseAuthResponse(this.handshakeBuffer)
    if (success === null) return // Need more data

    // Consume the 2-byte response
    this.handshakeBuffer = this.handshakeBuffer.slice(2)

    if (!success) {
      this.failHandshake(new Error('SOCKS5 authentication failed'))
      return
    }

    this.sendConnectRequest()
  }

  private sendConnectRequest(): void {
    this.socket.send(buildConnectRequest(this.targetHost!, this.targetPort!))
    this.state = 'connect_sent'
  }

  private handleConnectResponse(): void {
    // Check if we have enough data to determine response length
    const responseLen = getConnectResponseLength(this.handshakeBuffer)
    if (responseLen === null || this.handshakeBuffer.length < responseLen) {
      return // Need more data
    }

    // Check version
    if (this.handshakeBuffer[0] !== SOCKS5_VERSION) {
      this.failHandshake(new Error(`Invalid SOCKS version in reply: ${this.handshakeBuffer[0]}`))
      return
    }

    // Check reply code
    const reply = parseConnectReply(this.handshakeBuffer)
    if (reply === null) {
      this.failHandshake(new Error('Invalid SOCKS5 reply'))
      return
    }

    const errorMsg = getReplyError(reply)
    if (errorMsg) {
      this.failHandshake(new Error(`SOCKS5 proxy: ${errorMsg}`))
      return
    }

    // Consume the response, keep any extra data (could be early application data)
    const extraData = this.handshakeBuffer.slice(responseLen)
    this.handshakeBuffer = new Uint8Array(0)

    // Handshake complete!
    this.completeHandshake()

    // Forward any extra data to user handler
    if (extraData.length > 0 && this.userOnData) {
      this.userOnData(extraData)
    }
  }

  private completeHandshake(): void {
    this.state = 'connected'
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout)
      this.handshakeTimeout = undefined
    }
    this.handshakeResolve?.()
    this.handshakeResolve = undefined
    this.handshakeReject = undefined
  }

  private failHandshake(err: Error): void {
    if (this.state === 'error') return // Already failed

    this.state = 'error'
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout)
      this.handshakeTimeout = undefined
    }
    this.socket.close()
    this.handshakeReject?.(err)
    this.handshakeResolve = undefined
    this.handshakeReject = undefined
  }

  private handleError(err: Error): void {
    if (this.state !== 'connected') {
      this.failHandshake(err)
    } else {
      this.userOnError?.(err)
    }
  }

  private handleClose(hadError: boolean): void {
    if (this.state !== 'connected' && this.state !== 'error') {
      this.failHandshake(new Error('Connection closed during SOCKS5 handshake'))
    } else if (this.state === 'connected') {
      this.userOnClose?.(hadError)
    }
  }

  // --- ITcpSocket interface ---

  send(data: Uint8Array): void {
    if (this.state !== 'connected') {
      throw new Error('Cannot send before SOCKS5 handshake completes')
    }
    this.socket.send(data)
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.userOnData = cb
  }

  onClose(cb: (hadError: boolean) => void): void {
    this.userOnClose = cb
  }

  onError(cb: (err: Error) => void): void {
    this.userOnError = cb
  }

  close(): void {
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout)
      this.handshakeTimeout = undefined
    }
    this.socket.close()
  }

  /**
   * TLS upgrade - delegates to underlying socket.
   * Call this after SOCKS5 handshake to upgrade the tunneled connection to TLS.
   */
  async secure(hostname: string, options?: { skipValidation?: boolean }): Promise<void> {
    if (this.state !== 'connected') {
      throw new Error('Cannot upgrade to TLS before SOCKS5 handshake completes')
    }
    if (!this.socket.secure) {
      throw new Error('Underlying socket does not support TLS')
    }
    return this.socket.secure(hostname, options)
  }
}
