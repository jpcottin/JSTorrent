/**
 * SOCKS5 Proxy Support
 *
 * Provides SOCKS5 proxy functionality for routing TCP connections
 * through a proxy server.
 */

export { Socks5Socket, type Socks5ProxyConfig } from './socks5-socket'
export { Socks5SocketFactory } from './socks5-socket-factory'
export {
  SOCKS5_VERSION,
  SOCKS5_AUTH,
  SOCKS5_CMD,
  SOCKS5_ATYP,
  SOCKS5_REPLY,
} from './socks5-protocol'
