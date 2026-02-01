import { describe, it, expect } from 'vitest'
import {
  SOCKS5_VERSION,
  SOCKS5_AUTH,
  SOCKS5_CMD,
  SOCKS5_ATYP,
  SOCKS5_REPLY,
  buildGreeting,
  buildAuthRequest,
  buildConnectRequest,
  parseGreetingResponse,
  parseAuthResponse,
  getConnectResponseLength,
  parseConnectReply,
  getReplyError,
} from '../../src/proxy/socks5-protocol'

describe('SOCKS5 Protocol', () => {
  describe('buildGreeting', () => {
    it('should build greeting without auth support', () => {
      const greeting = buildGreeting(false)

      expect(greeting).toEqual(new Uint8Array([SOCKS5_VERSION, 1, SOCKS5_AUTH.NONE]))
    })

    it('should build greeting with auth support', () => {
      const greeting = buildGreeting(true)

      expect(greeting).toEqual(
        new Uint8Array([SOCKS5_VERSION, 2, SOCKS5_AUTH.NONE, SOCKS5_AUTH.USERNAME_PASSWORD]),
      )
    })
  })

  describe('buildAuthRequest', () => {
    it('should build auth request with username and password', () => {
      const request = buildAuthRequest('user', 'pass')

      // VER(0x01) | ULEN(4) | UNAME(user) | PLEN(4) | PASSWD(pass)
      expect(request).toEqual(
        new Uint8Array([
          0x01, // Auth version
          4,
          0x75,
          0x73,
          0x65,
          0x72, // "user"
          4,
          0x70,
          0x61,
          0x73,
          0x73, // "pass"
        ]),
      )
    })

    it('should handle empty username and password', () => {
      const request = buildAuthRequest('', '')

      expect(request).toEqual(new Uint8Array([0x01, 0, 0]))
    })

    it('should handle unicode characters', () => {
      const request = buildAuthRequest('u', '\u00e9') // e with accent

      expect(request[0]).toBe(0x01)
      expect(request[1]).toBe(1) // "u" is 1 byte
      expect(request[2]).toBe(0x75) // "u"
      expect(request[3]).toBe(2) // "\u00e9" is 2 bytes in UTF-8
    })

    it('should throw for username over 255 bytes', () => {
      const longUsername = 'a'.repeat(256)

      expect(() => buildAuthRequest(longUsername, 'pass')).toThrow('username too long')
    })

    it('should throw for password over 255 bytes', () => {
      const longPassword = 'a'.repeat(256)

      expect(() => buildAuthRequest('user', longPassword)).toThrow('password too long')
    })
  })

  describe('buildConnectRequest', () => {
    it('should build CONNECT request with domain name', () => {
      const request = buildConnectRequest('example.com', 80)

      expect(request[0]).toBe(SOCKS5_VERSION)
      expect(request[1]).toBe(SOCKS5_CMD.CONNECT)
      expect(request[2]).toBe(0x00) // Reserved
      expect(request[3]).toBe(SOCKS5_ATYP.DOMAIN)
      expect(request[4]).toBe(11) // "example.com" length

      // Hostname bytes
      const hostname = new TextDecoder().decode(request.slice(5, 16))
      expect(hostname).toBe('example.com')

      // Port in big endian
      expect(request[16]).toBe(0x00)
      expect(request[17]).toBe(0x50) // 80
    })

    it('should build CONNECT request with high port number', () => {
      const request = buildConnectRequest('x.y', 65535)

      // Port bytes should be 0xFF 0xFF
      const portOffset = 4 + 1 + 3 // header + len + "x.y"
      expect(request[portOffset]).toBe(0xff)
      expect(request[portOffset + 1]).toBe(0xff)
    })

    it('should build CONNECT request with IP address (as domain)', () => {
      // Even for IP addresses, we use DOMAIN type to keep the code simple
      // and let the proxy resolve it
      const request = buildConnectRequest('192.168.1.1', 443)

      expect(request[3]).toBe(SOCKS5_ATYP.DOMAIN)
      expect(request[4]).toBe(11) // "192.168.1.1" length
    })

    it('should throw for hostname over 255 bytes', () => {
      const longHost = 'a'.repeat(256) + '.com'

      expect(() => buildConnectRequest(longHost, 80)).toThrow('hostname too long')
    })
  })

  describe('parseGreetingResponse', () => {
    it('should parse valid greeting response', () => {
      const response = new Uint8Array([SOCKS5_VERSION, SOCKS5_AUTH.NONE])

      expect(parseGreetingResponse(response)).toBe(SOCKS5_AUTH.NONE)
    })

    it('should parse auth required response', () => {
      const response = new Uint8Array([SOCKS5_VERSION, SOCKS5_AUTH.USERNAME_PASSWORD])

      expect(parseGreetingResponse(response)).toBe(SOCKS5_AUTH.USERNAME_PASSWORD)
    })

    it('should parse no acceptable method response', () => {
      const response = new Uint8Array([SOCKS5_VERSION, SOCKS5_AUTH.NO_ACCEPTABLE])

      expect(parseGreetingResponse(response)).toBe(SOCKS5_AUTH.NO_ACCEPTABLE)
    })

    it('should return null for insufficient data', () => {
      expect(parseGreetingResponse(new Uint8Array([SOCKS5_VERSION]))).toBeNull()
      expect(parseGreetingResponse(new Uint8Array([]))).toBeNull()
    })

    it('should return null for wrong version', () => {
      const response = new Uint8Array([0x04, SOCKS5_AUTH.NONE]) // SOCKS4 version

      expect(parseGreetingResponse(response)).toBeNull()
    })
  })

  describe('parseAuthResponse', () => {
    it('should return true for successful auth', () => {
      const response = new Uint8Array([0x01, 0x00])

      expect(parseAuthResponse(response)).toBe(true)
    })

    it('should return false for failed auth', () => {
      const response = new Uint8Array([0x01, 0x01])

      expect(parseAuthResponse(response)).toBe(false)
    })

    it('should return null for insufficient data', () => {
      expect(parseAuthResponse(new Uint8Array([0x01]))).toBeNull()
      expect(parseAuthResponse(new Uint8Array([]))).toBeNull()
    })

    it('should return null for wrong version', () => {
      const response = new Uint8Array([0x05, 0x00]) // Wrong auth version

      expect(parseAuthResponse(response)).toBeNull()
    })
  })

  describe('getConnectResponseLength', () => {
    it('should return 10 for IPv4 address', () => {
      const response = new Uint8Array([SOCKS5_VERSION, 0x00, 0x00, SOCKS5_ATYP.IPV4])

      expect(getConnectResponseLength(response)).toBe(10)
    })

    it('should return 22 for IPv6 address', () => {
      const response = new Uint8Array([SOCKS5_VERSION, 0x00, 0x00, SOCKS5_ATYP.IPV6])

      expect(getConnectResponseLength(response)).toBe(22)
    })

    it('should calculate length for domain address', () => {
      // Domain length = 11 (e.g., "example.com")
      const response = new Uint8Array([SOCKS5_VERSION, 0x00, 0x00, SOCKS5_ATYP.DOMAIN, 11])

      // 4 (header) + 1 (len) + 11 (domain) + 2 (port) = 18
      expect(getConnectResponseLength(response)).toBe(18)
    })

    it('should return null for insufficient data', () => {
      expect(getConnectResponseLength(new Uint8Array([0x05, 0x00, 0x00]))).toBeNull()
      expect(getConnectResponseLength(new Uint8Array([]))).toBeNull()
    })

    it('should return null for domain without length byte', () => {
      const response = new Uint8Array([SOCKS5_VERSION, 0x00, 0x00, SOCKS5_ATYP.DOMAIN])

      expect(getConnectResponseLength(response)).toBeNull()
    })

    it('should return null for unknown address type', () => {
      const response = new Uint8Array([SOCKS5_VERSION, 0x00, 0x00, 0x99])

      expect(getConnectResponseLength(response)).toBeNull()
    })
  })

  describe('parseConnectReply', () => {
    it('should parse success reply', () => {
      const response = new Uint8Array([SOCKS5_VERSION, SOCKS5_REPLY.SUCCESS])

      expect(parseConnectReply(response)).toBe(SOCKS5_REPLY.SUCCESS)
    })

    it('should parse error replies', () => {
      const response = new Uint8Array([SOCKS5_VERSION, SOCKS5_REPLY.CONNECTION_REFUSED])

      expect(parseConnectReply(response)).toBe(SOCKS5_REPLY.CONNECTION_REFUSED)
    })

    it('should return null for insufficient data', () => {
      expect(parseConnectReply(new Uint8Array([SOCKS5_VERSION]))).toBeNull()
    })

    it('should return null for wrong version', () => {
      expect(parseConnectReply(new Uint8Array([0x04, 0x00]))).toBeNull()
    })
  })

  describe('getReplyError', () => {
    it('should return null for success', () => {
      expect(getReplyError(SOCKS5_REPLY.SUCCESS)).toBeNull()
    })

    it('should return error message for general failure', () => {
      expect(getReplyError(SOCKS5_REPLY.GENERAL_FAILURE)).toBe('General SOCKS server failure')
    })

    it('should return error message for connection refused', () => {
      expect(getReplyError(SOCKS5_REPLY.CONNECTION_REFUSED)).toBe('Connection refused')
    })

    it('should return error message for host unreachable', () => {
      expect(getReplyError(SOCKS5_REPLY.HOST_UNREACHABLE)).toBe('Host unreachable')
    })

    it('should return error message for network unreachable', () => {
      expect(getReplyError(SOCKS5_REPLY.NETWORK_UNREACHABLE)).toBe('Network unreachable')
    })

    it('should return error message for unknown codes', () => {
      expect(getReplyError(0x99)).toBe('Unknown SOCKS5 error (153)')
    })
  })
})
