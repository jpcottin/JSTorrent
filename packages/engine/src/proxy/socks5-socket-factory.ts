/**
 * SOCKS5 Proxy Socket Factory
 *
 * Decorates an existing ISocketFactory to route TCP connections through
 * a SOCKS5 proxy. UDP sockets and TCP servers pass through unchanged.
 */

import type { ISocketFactory, ITcpSocket, IUdpSocket, ITcpServer } from '../interfaces/socket'
import { Socks5Socket, Socks5ProxyConfig } from './socks5-socket'

/**
 * SocksProxySocketFactory decorates an existing ISocketFactory
 * to route TCP connections through a SOCKS5 proxy.
 *
 * UDP sockets and TCP servers are passed through unchanged since
 * SOCKS5 UDP ASSOCIATE is complex and rarely needed for BitTorrent
 * (users can disable DHT if they need full privacy).
 */
export class Socks5SocketFactory implements ISocketFactory {
  private underlying: ISocketFactory
  private proxyConfig: Socks5ProxyConfig

  constructor(underlying: ISocketFactory, proxyConfig: Socks5ProxyConfig) {
    this.underlying = underlying
    this.proxyConfig = proxyConfig
  }

  /**
   * Create a proxied TCP socket.
   *
   * Returns a Socks5Socket that will route through the proxy when connect() is called.
   * The host/port parameters are ignored - use connect() to specify the target.
   */
  async createTcpSocket(_host?: string, _port?: number): Promise<ITcpSocket> {
    // Create underlying socket (unconnected)
    const rawSocket = await this.underlying.createTcpSocket()

    // Wrap with SOCKS5 handler
    return new Socks5Socket(rawSocket, this.proxyConfig)
  }

  /**
   * UDP sockets are not proxied.
   * Users should disable DHT if they need full privacy through the proxy.
   */
  async createUdpSocket(bindAddr?: string, bindPort?: number): Promise<IUdpSocket> {
    return this.underlying.createUdpSocket(bindAddr, bindPort)
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
