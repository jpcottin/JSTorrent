/**
 * SOCKS5 Proxy Socket Factory
 *
 * Decorates an existing ISocketFactory to route connections through
 * a SOCKS5 proxy based on configurable routing rules.
 */

import type {
  ISocketFactory,
  ITcpSocket,
  IUdpSocket,
  ITcpServer,
  TcpSocketOptions,
  UdpSocketOptions,
} from '../interfaces/socket'
import { Socks5Socket, Socks5ProxyConfig } from './socks5-socket'
import { Socks5UdpSocket } from './socks5-udp-socket'

/** Configuration for which traffic types to route through the proxy */
export interface Socks5RoutingConfig {
  /** Route HTTP/HTTPS tracker requests through proxy (default: true) */
  proxyHttpTrackers: boolean
  /** Route UDP tracker requests through proxy (default: true) */
  proxyUdpTrackers: boolean
  /** Route peer connections through proxy (default: true) */
  proxyPeerConnections: boolean
}

/**
 * Socks5SocketFactory decorates an existing ISocketFactory
 * to route connections through a SOCKS5 proxy.
 *
 * Routing is based on the `purpose` option passed to createTcpSocket/createUdpSocket:
 * - 'peer' -> proxied if proxyPeerConnections is true
 * - 'http-tracker' -> proxied if proxyHttpTrackers is true
 * - 'web-seed' -> proxied if proxyHttpTrackers is true
 * - 'udp-tracker' -> proxied if proxyUdpTrackers is true (requires UDP ASSOCIATE)
 * - 'dht', 'upnp', 'lpd' -> never proxied (local network / not applicable)
 *
 * TCP servers and incoming connections are never proxied.
 */
export class Socks5SocketFactory implements ISocketFactory {
  private underlying: ISocketFactory
  private proxyConfig: Socks5ProxyConfig
  private routingConfig: Socks5RoutingConfig

  constructor(
    underlying: ISocketFactory,
    proxyConfig: Socks5ProxyConfig,
    routingConfig: Socks5RoutingConfig = {
      proxyHttpTrackers: true,
      proxyUdpTrackers: true,
      proxyPeerConnections: true,
    },
  ) {
    this.underlying = underlying
    this.proxyConfig = proxyConfig
    this.routingConfig = routingConfig
  }

  /**
   * Create a TCP socket, optionally proxied based on purpose.
   *
   * @param options - Socket options including purpose for routing decisions
   * @returns Proxied or direct socket based on routing config
   */
  async createTcpSocket(options?: TcpSocketOptions): Promise<ITcpSocket> {
    const purpose = options?.purpose

    // Check if this traffic should be proxied based on purpose
    // Only explicitly marked traffic is proxied - undefined purpose = direct connection
    const shouldProxy =
      (purpose === 'peer' && this.routingConfig.proxyPeerConnections) ||
      ((purpose === 'http-tracker' || purpose === 'web-seed') &&
        this.routingConfig.proxyHttpTrackers)

    if (!shouldProxy) {
      // Direct connection
      return this.underlying.createTcpSocket(options)
    }

    // Create underlying socket (unconnected)
    const rawSocket = await this.underlying.createTcpSocket()

    // Wrap with SOCKS5 handler
    const socks5Socket = new Socks5Socket(rawSocket, this.proxyConfig)

    // If host and port are provided, connect through the proxy
    // This matches the behavior of direct socket factories
    if (options?.host && options?.port) {
      await socks5Socket.connect(options.port, options.host)
    }

    return socks5Socket
  }

  /**
   * Create a UDP socket, optionally proxied based on purpose.
   *
   * @param options - Socket options including purpose for routing decisions
   * @returns Proxied or direct socket based on routing config
   */
  async createUdpSocket(options?: UdpSocketOptions): Promise<IUdpSocket> {
    const purpose = options?.purpose

    // Only proxy UDP trackers, and only if enabled
    if (purpose === 'udp-tracker' && this.routingConfig.proxyUdpTrackers) {
      // Create a SOCKS5 UDP socket
      const udpSocket = new Socks5UdpSocket(this.underlying, this.proxyConfig)
      await udpSocket.init()
      return udpSocket
    }

    // Direct UDP for everything else (DHT, UPnP, LPD, etc.)
    return this.underlying.createUdpSocket(options)
  }

  /**
   * TCP servers cannot be proxied (no incoming connections through SOCKS5).
   * Pass through to underlying factory.
   */
  createTcpServer(): ITcpServer {
    return this.underlying.createTcpServer()
  }

  /**
   * Wrap an existing native socket.
   * This is used for incoming connections, which are not proxied.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapTcpSocket(socket: any): ITcpSocket {
    return this.underlying.wrapTcpSocket(socket)
  }

  // Pass through optional methods if they exist on underlying factory

  batchSend?(sends: Array<{ socketId: number; data: Uint8Array }>): void {
    this.underlying.batchSend?.(sends)
  }

  setBackpressure?(active: boolean): void {
    this.underlying.setBackpressure?.(active)
  }

  flushCallbacks?(): void {
    this.underlying.flushCallbacks?.()
  }
}
