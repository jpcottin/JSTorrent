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
 * Uses IPv4 address type for IP addresses, DOMAINNAME for hostnames
 * to let the proxy resolve DNS (prevents leaks).
 *
 * @param host - Target hostname or IP address
 * @param port - Target port
 * @returns CONNECT request message bytes
 * @throws Error if hostname exceeds 255 bytes
 */
export function buildConnectRequest(host: string, port: number): Uint8Array {
  // Check if it's an IPv4 address
  const ipv4Match = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)

  if (ipv4Match) {
    // VER | CMD | RSV | ATYP | DST.ADDR (4 bytes) | DST.PORT (2 bytes)
    const buffer = new Uint8Array(10)
    buffer[0] = SOCKS5_VERSION
    buffer[1] = SOCKS5_CMD.CONNECT
    buffer[2] = 0x00 // Reserved
    buffer[3] = SOCKS5_ATYP.IPV4
    buffer[4] = parseInt(ipv4Match[1])
    buffer[5] = parseInt(ipv4Match[2])
    buffer[6] = parseInt(ipv4Match[3])
    buffer[7] = parseInt(ipv4Match[4])
    // Port in network byte order (big endian)
    buffer[8] = (port >> 8) & 0xff
    buffer[9] = port & 0xff
    return buffer
  }

  // Use domain name format for hostnames
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

// ============================================================================
// UDP ASSOCIATE Support (RFC 1928 Section 7)
// ============================================================================

/**
 * Build UDP ASSOCIATE request.
 * The client specifies the address and port from which it will send UDP datagrams.
 * Using 0.0.0.0:0 tells the proxy to accept from any address (common for NAT).
 *
 * @param clientAddr - Client's expected source address (use "0.0.0.0" for any)
 * @param clientPort - Client's expected source port (use 0 for any)
 * @returns UDP ASSOCIATE request message bytes
 */
export function buildUdpAssociateRequest(clientAddr: string, clientPort: number): Uint8Array {
  // Check if it's an IPv4 address
  const ipv4Match = clientAddr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)

  if (ipv4Match) {
    // VER | CMD | RSV | ATYP | DST.ADDR (4 bytes) | DST.PORT (2 bytes)
    const buffer = new Uint8Array(10)
    buffer[0] = SOCKS5_VERSION
    buffer[1] = SOCKS5_CMD.UDP_ASSOCIATE
    buffer[2] = 0x00 // Reserved
    buffer[3] = SOCKS5_ATYP.IPV4
    buffer[4] = parseInt(ipv4Match[1])
    buffer[5] = parseInt(ipv4Match[2])
    buffer[6] = parseInt(ipv4Match[3])
    buffer[7] = parseInt(ipv4Match[4])
    buffer[8] = (clientPort >> 8) & 0xff
    buffer[9] = clientPort & 0xff
    return buffer
  }

  // Use domain name format for non-IPv4 addresses
  const addrBytes = new TextEncoder().encode(clientAddr)
  if (addrBytes.length > 255) {
    throw new Error('SOCKS5 address too long (max 255 bytes)')
  }

  const buffer = new Uint8Array(4 + 1 + addrBytes.length + 2)
  buffer[0] = SOCKS5_VERSION
  buffer[1] = SOCKS5_CMD.UDP_ASSOCIATE
  buffer[2] = 0x00 // Reserved
  buffer[3] = SOCKS5_ATYP.DOMAIN
  buffer[4] = addrBytes.length
  buffer.set(addrBytes, 5)
  buffer[5 + addrBytes.length] = (clientPort >> 8) & 0xff
  buffer[6 + addrBytes.length] = clientPort & 0xff

  return buffer
}

/**
 * Parse UDP ASSOCIATE response to extract the relay address and port.
 * The response format is the same as CONNECT response.
 *
 * @param data - Response bytes
 * @returns Relay address and port, or null if invalid/failed
 */
export function parseUdpAssociateResponse(
  data: Uint8Array,
): { address: string; port: number } | null {
  // Check minimum length and version
  if (data.length < 10) return null
  if (data[0] !== SOCKS5_VERSION) return null

  // Check reply code
  const reply = data[1]
  if (reply !== SOCKS5_REPLY.SUCCESS) return null

  const atyp = data[3]

  switch (atyp) {
    case SOCKS5_ATYP.IPV4: {
      if (data.length < 10) return null
      const address = `${data[4]}.${data[5]}.${data[6]}.${data[7]}`
      const port = (data[8] << 8) | data[9]
      return { address, port }
    }
    case SOCKS5_ATYP.IPV6: {
      if (data.length < 22) return null
      // Convert 16 bytes to IPv6 string
      const parts: string[] = []
      for (let i = 0; i < 8; i++) {
        const word = (data[4 + i * 2] << 8) | data[5 + i * 2]
        parts.push(word.toString(16))
      }
      const address = parts.join(':')
      const port = (data[20] << 8) | data[21]
      return { address, port }
    }
    case SOCKS5_ATYP.DOMAIN: {
      const domainLen = data[4]
      if (data.length < 4 + 1 + domainLen + 2) return null
      const address = new TextDecoder().decode(data.slice(5, 5 + domainLen))
      const port = (data[5 + domainLen] << 8) | data[6 + domainLen]
      return { address, port }
    }
    default:
      return null
  }
}

/**
 * Build a UDP datagram with SOCKS5 header for sending through the relay.
 *
 * Format:
 * +----+------+------+----------+----------+----------+
 * |RSV | FRAG | ATYP | DST.ADDR | DST.PORT |   DATA   |
 * +----+------+------+----------+----------+----------+
 * | 2  |  1   |  1   | Variable |    2     | Variable |
 * +----+------+------+----------+----------+----------+
 *
 * @param destAddr - Destination address (hostname or IP)
 * @param destPort - Destination port
 * @param data - Payload data
 * @returns Complete UDP packet with SOCKS5 header
 */
export function buildUdpPacket(destAddr: string, destPort: number, data: Uint8Array): Uint8Array {
  // Check if it's an IPv4 address
  const ipv4Match = destAddr.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)

  if (ipv4Match) {
    // RSV(2) + FRAG(1) + ATYP(1) + ADDR(4) + PORT(2) + DATA
    const buffer = new Uint8Array(10 + data.length)
    buffer[0] = 0x00 // RSV
    buffer[1] = 0x00 // RSV
    buffer[2] = 0x00 // FRAG (0 = standalone datagram, no fragmentation)
    buffer[3] = SOCKS5_ATYP.IPV4
    buffer[4] = parseInt(ipv4Match[1])
    buffer[5] = parseInt(ipv4Match[2])
    buffer[6] = parseInt(ipv4Match[3])
    buffer[7] = parseInt(ipv4Match[4])
    buffer[8] = (destPort >> 8) & 0xff
    buffer[9] = destPort & 0xff
    buffer.set(data, 10)
    return buffer
  }

  // Use domain name format
  const addrBytes = new TextEncoder().encode(destAddr)
  if (addrBytes.length > 255) {
    throw new Error('SOCKS5 destination address too long (max 255 bytes)')
  }

  // RSV(2) + FRAG(1) + ATYP(1) + LEN(1) + ADDR(n) + PORT(2) + DATA
  const buffer = new Uint8Array(4 + 1 + addrBytes.length + 2 + data.length)
  buffer[0] = 0x00 // RSV
  buffer[1] = 0x00 // RSV
  buffer[2] = 0x00 // FRAG
  buffer[3] = SOCKS5_ATYP.DOMAIN
  buffer[4] = addrBytes.length
  buffer.set(addrBytes, 5)
  buffer[5 + addrBytes.length] = (destPort >> 8) & 0xff
  buffer[6 + addrBytes.length] = destPort & 0xff
  buffer.set(data, 7 + addrBytes.length)

  return buffer
}

/**
 * Parse a UDP datagram received from the relay to extract source address and payload.
 *
 * @param packet - Raw UDP packet from relay
 * @returns Source address, port, and payload data, or null if invalid
 */
export function parseUdpPacket(
  packet: Uint8Array,
): { srcAddr: string; srcPort: number; data: Uint8Array } | null {
  // Minimum: RSV(2) + FRAG(1) + ATYP(1) + at least IPv4(4) + PORT(2) = 10 bytes
  if (packet.length < 10) return null

  // Check RSV bytes are zero
  if (packet[0] !== 0 || packet[1] !== 0) return null

  // Check FRAG - we don't support fragmentation
  const frag = packet[2]
  if (frag !== 0) {
    // Fragmented packet - not supported
    return null
  }

  const atyp = packet[3]

  switch (atyp) {
    case SOCKS5_ATYP.IPV4: {
      if (packet.length < 10) return null
      const srcAddr = `${packet[4]}.${packet[5]}.${packet[6]}.${packet[7]}`
      const srcPort = (packet[8] << 8) | packet[9]
      const data = packet.slice(10)
      return { srcAddr, srcPort, data }
    }
    case SOCKS5_ATYP.IPV6: {
      if (packet.length < 22) return null
      const parts: string[] = []
      for (let i = 0; i < 8; i++) {
        const word = (packet[4 + i * 2] << 8) | packet[5 + i * 2]
        parts.push(word.toString(16))
      }
      const srcAddr = parts.join(':')
      const srcPort = (packet[20] << 8) | packet[21]
      const data = packet.slice(22)
      return { srcAddr, srcPort, data }
    }
    case SOCKS5_ATYP.DOMAIN: {
      const domainLen = packet[4]
      const headerLen = 4 + 1 + domainLen + 2
      if (packet.length < headerLen) return null
      const srcAddr = new TextDecoder().decode(packet.slice(5, 5 + domainLen))
      const srcPort = (packet[5 + domainLen] << 8) | packet[6 + domainLen]
      const data = packet.slice(headerLen)
      return { srcAddr, srcPort, data }
    }
    default:
      return null
  }
}
