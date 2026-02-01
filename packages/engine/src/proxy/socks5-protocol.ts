/**
 * SOCKS5 Protocol Implementation (RFC 1928, RFC 1929)
 *
 * Constants and message builders for the SOCKS5 handshake.
 * Uses DOMAINNAME address type to prevent DNS leaks.
 */

/** SOCKS protocol version */
export const SOCKS5_VERSION = 0x05

/** Authentication methods */
export const SOCKS5_AUTH = {
  NONE: 0x00,
  GSSAPI: 0x01,
  USERNAME_PASSWORD: 0x02,
  NO_ACCEPTABLE: 0xff,
} as const

/** SOCKS5 commands */
export const SOCKS5_CMD = {
  CONNECT: 0x01,
  BIND: 0x02,
  UDP_ASSOCIATE: 0x03,
} as const

/** Address types */
export const SOCKS5_ATYP = {
  IPV4: 0x01,
  DOMAIN: 0x03,
  IPV6: 0x04,
} as const

/** Reply codes */
export const SOCKS5_REPLY = {
  SUCCESS: 0x00,
  GENERAL_FAILURE: 0x01,
  NOT_ALLOWED: 0x02,
  NETWORK_UNREACHABLE: 0x03,
  HOST_UNREACHABLE: 0x04,
  CONNECTION_REFUSED: 0x05,
  TTL_EXPIRED: 0x06,
  COMMAND_NOT_SUPPORTED: 0x07,
  ADDRESS_NOT_SUPPORTED: 0x08,
} as const

/**
 * Build the initial greeting message.
 * Offers authentication methods supported by the client.
 *
 * @param supportAuth - Whether to offer username/password auth
 * @returns Greeting message bytes
 */
export function buildGreeting(supportAuth: boolean): Uint8Array {
  if (supportAuth) {
    // VER | NMETHODS | METHODS (no auth + username/password)
    return new Uint8Array([SOCKS5_VERSION, 2, SOCKS5_AUTH.NONE, SOCKS5_AUTH.USERNAME_PASSWORD])
  }
  // VER | NMETHODS | METHODS (no auth only)
  return new Uint8Array([SOCKS5_VERSION, 1, SOCKS5_AUTH.NONE])
}

/**
 * Build username/password authentication request (RFC 1929).
 *
 * @param username - Username (max 255 bytes UTF-8)
 * @param password - Password (max 255 bytes UTF-8)
 * @returns Auth request message bytes
 * @throws Error if username or password exceeds 255 bytes
 */
export function buildAuthRequest(username: string, password: string): Uint8Array {
  const userBytes = new TextEncoder().encode(username)
  const passBytes = new TextEncoder().encode(password)

  if (userBytes.length > 255) {
    throw new Error('SOCKS5 username too long (max 255 bytes)')
  }
  if (passBytes.length > 255) {
    throw new Error('SOCKS5 password too long (max 255 bytes)')
  }

  // VER | ULEN | UNAME | PLEN | PASSWD
  const buffer = new Uint8Array(3 + userBytes.length + passBytes.length)
  buffer[0] = 0x01 // Auth sub-negotiation version
  buffer[1] = userBytes.length
  buffer.set(userBytes, 2)
  buffer[2 + userBytes.length] = passBytes.length
  buffer.set(passBytes, 3 + userBytes.length)

  return buffer
}

/**
 * Build CONNECT request.
 * Uses DOMAINNAME address type to let the proxy resolve DNS (prevents leaks).
 *
 * @param host - Target hostname or IP address
 * @param port - Target port
 * @returns CONNECT request message bytes
 * @throws Error if hostname exceeds 255 bytes
 */
export function buildConnectRequest(host: string, port: number): Uint8Array {
  const hostBytes = new TextEncoder().encode(host)

  if (hostBytes.length > 255) {
    throw new Error('SOCKS5 hostname too long (max 255 bytes)')
  }

  // VER | CMD | RSV | ATYP | DST.ADDR | DST.PORT
  // For DOMAIN: ATYP(1) + LEN(1) + HOSTNAME(n) + PORT(2)
  const buffer = new Uint8Array(4 + 1 + hostBytes.length + 2)
  buffer[0] = SOCKS5_VERSION
  buffer[1] = SOCKS5_CMD.CONNECT
  buffer[2] = 0x00 // Reserved
  buffer[3] = SOCKS5_ATYP.DOMAIN
  buffer[4] = hostBytes.length
  buffer.set(hostBytes, 5)
  // Port in network byte order (big endian)
  buffer[5 + hostBytes.length] = (port >> 8) & 0xff
  buffer[6 + hostBytes.length] = port & 0xff

  return buffer
}

/**
 * Parse greeting response to get selected auth method.
 *
 * @param data - Response bytes (at least 2 bytes)
 * @returns Selected auth method, or null if invalid
 */
export function parseGreetingResponse(data: Uint8Array): number | null {
  if (data.length < 2) return null
  if (data[0] !== SOCKS5_VERSION) return null
  return data[1]
}

/**
 * Parse auth response to check if authentication succeeded.
 *
 * @param data - Response bytes (at least 2 bytes)
 * @returns true if auth succeeded, false if failed, null if invalid
 */
export function parseAuthResponse(data: Uint8Array): boolean | null {
  if (data.length < 2) return null
  if (data[0] !== 0x01) return null // Auth sub-negotiation version
  return data[1] === 0x00
}

/**
 * Calculate the length of a CONNECT response based on address type.
 *
 * @param data - Response bytes (at least 4 bytes to determine length)
 * @returns Total response length, or null if not enough data
 */
export function getConnectResponseLength(data: Uint8Array): number | null {
  if (data.length < 4) return null

  const atyp = data[3]
  // VER(1) + REP(1) + RSV(1) + ATYP(1) + BND.ADDR(variable) + BND.PORT(2)
  switch (atyp) {
    case SOCKS5_ATYP.IPV4:
      return 4 + 4 + 2 // 10 bytes
    case SOCKS5_ATYP.IPV6:
      return 4 + 16 + 2 // 22 bytes
    case SOCKS5_ATYP.DOMAIN:
      if (data.length < 5) return null
      return 4 + 1 + data[4] + 2
    default:
      return null
  }
}

/**
 * Parse CONNECT response reply code.
 *
 * @param data - Response bytes (at least 2 bytes)
 * @returns Reply code, or null if invalid
 */
export function parseConnectReply(data: Uint8Array): number | null {
  if (data.length < 2) return null
  if (data[0] !== SOCKS5_VERSION) return null
  return data[1]
}

/**
 * Get human-readable error message for a reply code.
 *
 * @param reply - SOCKS5 reply code
 * @returns Error message, or null if success
 */
export function getReplyError(reply: number): string | null {
  switch (reply) {
    case SOCKS5_REPLY.SUCCESS:
      return null
    case SOCKS5_REPLY.GENERAL_FAILURE:
      return 'General SOCKS server failure'
    case SOCKS5_REPLY.NOT_ALLOWED:
      return 'Connection not allowed by ruleset'
    case SOCKS5_REPLY.NETWORK_UNREACHABLE:
      return 'Network unreachable'
    case SOCKS5_REPLY.HOST_UNREACHABLE:
      return 'Host unreachable'
    case SOCKS5_REPLY.CONNECTION_REFUSED:
      return 'Connection refused'
    case SOCKS5_REPLY.TTL_EXPIRED:
      return 'TTL expired'
    case SOCKS5_REPLY.COMMAND_NOT_SUPPORTED:
      return 'Command not supported'
    case SOCKS5_REPLY.ADDRESS_NOT_SUPPORTED:
      return 'Address type not supported'
    default:
      return `Unknown SOCKS5 error (${reply})`
  }
}
