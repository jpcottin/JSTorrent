/**
 * SOCKS5 UDP Socket
 *
 * Implements IUdpSocket using SOCKS5 UDP ASSOCIATE (RFC 1928 Section 7).
 * Routes UDP traffic through a SOCKS5 proxy.
 *
 * Architecture:
 * - A TCP control connection is established to the proxy for the UDP_ASSOCIATE handshake
 * - The proxy returns a relay address:port for UDP traffic
 * - All UDP packets are sent to/received from the relay with SOCKS5 headers
 * - The TCP connection must stay open for the association to remain valid
 */

import type { ITcpSocket, IUdpSocket, ISocketFactory } from '../interfaces/socket'
import { concat } from '../utils/buffer'
import type { Socks5ProxyConfig } from './socks5-socket'
import {
  SOCKS5_VERSION,
  SOCKS5_AUTH,
  buildGreeting,
  buildAuthRequest,
  buildUdpAssociateRequest,
  parseGreetingResponse,
  parseAuthResponse,
  parseUdpAssociateResponse,
  getConnectResponseLength,
  parseConnectReply,
  getReplyError,
  buildUdpPacket,
  parseUdpPacket,
} from './socks5-protocol'

/** State machine for SOCKS5 UDP ASSOCIATE handshake */
type Socks5UdpState =
  | 'initial'
  | 'greeting_sent'
  | 'auth_sent'
  | 'associate_sent'
  | 'ready'
  | 'error'
  | 'closed'

/**
 * Socks5UdpSocket wraps UDP traffic through a SOCKS5 proxy using UDP ASSOCIATE.
 *
 * The socket must be initialized with init() before use. After initialization,
 * all UDP traffic is routed through the proxy's relay.
 */
export class Socks5UdpSocket implements IUdpSocket {
  private socketFactory: ISocketFactory
  private proxyConfig: Socks5ProxyConfig

  // TCP control connection (must stay open)
  private controlSocket: ITcpSocket | null = null

  // Local UDP socket for relay communication
  private localUdp: IUdpSocket | null = null

  // Relay address from proxy
  private relayAddress: string | null = null
  private relayPort: number | null = null

  // State machine
  private state: Socks5UdpState = 'initial'
  private handshakeBuffer: Uint8Array = new Uint8Array(0)
  private handshakeResolve?: () => void
  private handshakeReject?: (err: Error) => void
  private handshakeTimeout?: ReturnType<typeof setTimeout>

  // User callback
  private userOnMessage?: (src: { addr: string; port: number }, data: Uint8Array) => void

  // Error handler
  private onErrorCallback?: (err: Error) => void

  constructor(socketFactory: ISocketFactory, proxyConfig: Socks5ProxyConfig) {
    this.socketFactory = socketFactory
    this.proxyConfig = proxyConfig
  }

  /**
   * Initialize the UDP association with the proxy.
   * Must be called before sending/receiving data.
   *
   * @throws Error if the proxy doesn't support UDP ASSOCIATE
   */
  async init(): Promise<void> {
    if (this.state !== 'initial') {
      throw new Error('UDP socket already initialized or closed')
    }

    // Create the TCP control connection
    this.controlSocket = await this.socketFactory.createTcpSocket()
    if (!this.controlSocket.connect) {
      throw new Error('Underlying TCP socket does not support connect()')
    }

    // Set up control socket handlers
    this.controlSocket.onData((data) => this.handleControlData(data))
    this.controlSocket.onError((err) => this.handleControlError(err))
    this.controlSocket.onClose(() => this.handleControlClose())

    // Connect to proxy
    await this.controlSocket.connect(this.proxyConfig.port, this.proxyConfig.host)

    // Create local UDP socket for relay communication
    // Bind to 0.0.0.0:0 to get an ephemeral port
    this.localUdp = await this.socketFactory.createUdpSocket()

    // Set up UDP relay handler
    this.localUdp.onMessage((src, data) => this.handleRelayData(src, data))

    // Perform UDP ASSOCIATE handshake
    return new Promise((resolve, reject) => {
      this.handshakeResolve = resolve
      this.handshakeReject = reject

      // Set handshake timeout
      const timeout = this.proxyConfig.timeout ?? 10000
      this.handshakeTimeout = setTimeout(() => {
        this.failHandshake(new Error('SOCKS5 UDP ASSOCIATE handshake timeout'))
      }, timeout)

      // Start handshake: send greeting
      const hasAuth = !!(this.proxyConfig.username && this.proxyConfig.password)
      this.controlSocket!.send(buildGreeting(hasAuth))
      this.state = 'greeting_sent'
    })
  }

  private handleControlData(data: Uint8Array): void {
    if (this.state === 'ready' || this.state === 'closed' || this.state === 'error') {
      // Ignore unexpected data on control connection after handshake
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
      case 'associate_sent':
        this.handleAssociateResponse()
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
      this.controlSocket!.send(
        buildAuthRequest(this.proxyConfig.username, this.proxyConfig.password),
      )
      this.state = 'auth_sent'
    } else if (method === SOCKS5_AUTH.NONE) {
      this.sendUdpAssociateRequest()
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

    this.sendUdpAssociateRequest()
  }

  private sendUdpAssociateRequest(): void {
    // Tell proxy we'll send from any address (0.0.0.0:0)
    // This is the most compatible approach for clients behind NAT
    this.controlSocket!.send(buildUdpAssociateRequest('0.0.0.0', 0))
    this.state = 'associate_sent'
  }

  private handleAssociateResponse(): void {
    // Check if we have enough data to determine response length
    const responseLen = getConnectResponseLength(this.handshakeBuffer)
    if (responseLen === null || this.handshakeBuffer.length < responseLen) {
      return // Need more data
    }

    // Check version
    if (this.handshakeBuffer[0] !== SOCKS5_VERSION) {
      this.failHandshake(
        new Error(`Invalid SOCKS version in UDP ASSOCIATE reply: ${this.handshakeBuffer[0]}`),
      )
      return
    }

    // Check reply code
    const reply = parseConnectReply(this.handshakeBuffer)
    if (reply === null) {
      this.failHandshake(new Error('Invalid SOCKS5 UDP ASSOCIATE reply'))
      return
    }

    const errorMsg = getReplyError(reply)
    if (errorMsg) {
      this.failHandshake(new Error(`SOCKS5 UDP ASSOCIATE: ${errorMsg}`))
      return
    }

    // Parse the relay address
    const relayInfo = parseUdpAssociateResponse(this.handshakeBuffer)
    if (!relayInfo) {
      this.failHandshake(new Error('Failed to parse SOCKS5 UDP ASSOCIATE response'))
      return
    }

    this.relayAddress = relayInfo.address
    this.relayPort = relayInfo.port

    // If relay address is 0.0.0.0, use the proxy host instead
    // This is common - proxy returns 0.0.0.0 meaning "use my address"
    if (this.relayAddress === '0.0.0.0') {
      this.relayAddress = this.proxyConfig.host
    }

    // Handshake complete
    this.handshakeBuffer = new Uint8Array(0)
    this.completeHandshake()
  }

  private completeHandshake(): void {
    this.state = 'ready'
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout)
      this.handshakeTimeout = undefined
    }
    this.handshakeResolve?.()
    this.handshakeResolve = undefined
    this.handshakeReject = undefined
  }

  private failHandshake(err: Error): void {
    if (this.state === 'error' || this.state === 'closed') return

    this.state = 'error'
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout)
      this.handshakeTimeout = undefined
    }
    this.cleanup()
    this.handshakeReject?.(err)
    this.handshakeResolve = undefined
    this.handshakeReject = undefined
  }

  private handleControlError(err: Error): void {
    if (this.state === 'ready') {
      // Control connection error after handshake - association is dead
      this.state = 'error'
      this.onErrorCallback?.(new Error(`SOCKS5 UDP control connection error: ${err.message}`))
      this.cleanup()
    } else if (this.state !== 'error' && this.state !== 'closed') {
      this.failHandshake(err)
    }
  }

  private handleControlClose(): void {
    if (this.state === 'ready') {
      // Control connection closed - association is dead
      this.state = 'error'
      this.onErrorCallback?.(new Error('SOCKS5 UDP control connection closed'))
      this.cleanup()
    } else if (this.state !== 'error' && this.state !== 'closed') {
      this.failHandshake(new Error('SOCKS5 control connection closed during handshake'))
    }
  }

  private handleRelayData(_src: { addr: string; port: number }, data: Uint8Array): void {
    if (this.state !== 'ready') return

    // Verify data came from the relay
    // Note: Some proxies might use different source addresses, so we're lenient here
    // In strict mode, we'd check: _src.addr === this.relayAddress && _src.port === this.relayPort

    // Parse the SOCKS5 UDP header to extract real source
    const parsed = parseUdpPacket(data)
    if (!parsed) {
      // Invalid packet format - ignore
      return
    }

    // Forward to user with original source address
    this.userOnMessage?.({ addr: parsed.srcAddr, port: parsed.srcPort }, parsed.data)
  }

  private cleanup(): void {
    if (this.localUdp) {
      this.localUdp.close()
      this.localUdp = null
    }
    if (this.controlSocket) {
      this.controlSocket.close()
      this.controlSocket = null
    }
  }

  // --- IUdpSocket interface ---

  send(addr: string, port: number, data: Uint8Array): void {
    if (this.state !== 'ready') {
      throw new Error('SOCKS5 UDP socket not ready (call init() first)')
    }

    if (!this.localUdp || !this.relayAddress || !this.relayPort) {
      throw new Error('SOCKS5 UDP socket not properly initialized')
    }

    // Wrap the data with SOCKS5 UDP header
    const packet = buildUdpPacket(addr, port, data)

    // Send to the relay
    this.localUdp.send(this.relayAddress, this.relayPort, packet)
  }

  onMessage(cb: (src: { addr: string; port: number }, data: Uint8Array) => void): void {
    this.userOnMessage = cb
  }

  close(): void {
    if (this.state === 'closed') return

    this.state = 'closed'
    if (this.handshakeTimeout) {
      clearTimeout(this.handshakeTimeout)
      this.handshakeTimeout = undefined
    }
    this.cleanup()
  }

  /**
   * Register an error callback.
   * Called if the control connection dies after handshake completes.
   */
  onError(cb: (err: Error) => void): void {
    this.onErrorCallback = cb
  }

  // Multicast is not supported through SOCKS5 proxy
  async joinMulticast(_group: string): Promise<void> {
    throw new Error('Multicast is not supported through SOCKS5 proxy')
  }

  async leaveMulticast(_group: string): Promise<void> {
    throw new Error('Multicast is not supported through SOCKS5 proxy')
  }
}
