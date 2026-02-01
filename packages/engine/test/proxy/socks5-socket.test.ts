import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Socks5Socket, Socks5ProxyConfig } from '../../src/proxy/socks5-socket'
import {
  SOCKS5_VERSION,
  SOCKS5_AUTH,
  SOCKS5_ATYP,
  SOCKS5_REPLY,
} from '../../src/proxy/socks5-protocol'
import type { ITcpSocket } from '../../src/interfaces/socket'

/**
 * Mock socket that simulates the underlying TCP connection.
 * Can be scripted to send responses for SOCKS5 handshake testing.
 */
class MockSocket implements ITcpSocket {
  public sentData: Uint8Array[] = []
  public onDataCb: ((data: Uint8Array) => void) | null = null
  public onCloseCb: ((hadError: boolean) => void) | null = null
  public onErrorCb: ((err: Error) => void) | null = null
  public closed = false
  public connectCalled = false
  public connectedHost?: string
  public connectedPort?: number

  // Whether connect() should succeed or fail
  public connectShouldFail = false
  public connectError = new Error('Connection refused')

  send(data: Uint8Array): void {
    this.sentData.push(data)
  }

  onData(cb: (data: Uint8Array) => void): void {
    this.onDataCb = cb
  }

  onClose(cb: (hadError: boolean) => void): void {
    this.onCloseCb = cb
  }

  onError(cb: (err: Error) => void): void {
    this.onErrorCb = cb
  }

  close(): void {
    this.closed = true
    if (this.onCloseCb) this.onCloseCb(false)
  }

  async connect(port: number, host: string): Promise<void> {
    this.connectCalled = true
    this.connectedHost = host
    this.connectedPort = port
    if (this.connectShouldFail) {
      throw this.connectError
    }
  }

  // Test helpers
  emitData(data: Uint8Array): void {
    if (this.onDataCb) this.onDataCb(data)
  }

  emitError(err: Error): void {
    if (this.onErrorCb) this.onErrorCb(err)
  }

  emitClose(hadError: boolean): void {
    if (this.onCloseCb) this.onCloseCb(hadError)
  }
}

/**
 * Wait for microtask queue to flush.
 * This is needed because Socks5Socket.connect() uses await internally,
 * which yields control before the greeting is sent.
 */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve()
}

/**
 * Build a SOCKS5 greeting response.
 */
function buildGreetingResponse(method: number): Uint8Array {
  return new Uint8Array([SOCKS5_VERSION, method])
}

/**
 * Build a SOCKS5 auth response.
 */
function buildAuthResponse(success: boolean): Uint8Array {
  return new Uint8Array([0x01, success ? 0x00 : 0x01])
}

/**
 * Build a SOCKS5 CONNECT response (success with IPv4 bound address).
 */
function buildConnectResponse(reply: number = SOCKS5_REPLY.SUCCESS): Uint8Array {
  return new Uint8Array([
    SOCKS5_VERSION,
    reply,
    0x00, // Reserved
    SOCKS5_ATYP.IPV4, // Address type
    0,
    0,
    0,
    0, // Bound address (0.0.0.0)
    0x00,
    0x00, // Bound port (0)
  ])
}

describe('Socks5Socket', () => {
  let mockSocket: MockSocket
  let proxyConfig: Socks5ProxyConfig

  beforeEach(() => {
    mockSocket = new MockSocket()
    proxyConfig = {
      host: '127.0.0.1',
      port: 1080,
      timeout: 1000, // Short timeout for tests
    }
  })

  describe('connect() - proxy connection', () => {
    it('should connect to proxy server first', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)

      // Start connect (don't await yet)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks() // Let internal await complete

      // Verify it connected to proxy, not target
      expect(mockSocket.connectCalled).toBe(true)
      expect(mockSocket.connectedHost).toBe('127.0.0.1')
      expect(mockSocket.connectedPort).toBe(1080)

      // Complete handshake
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())

      await connectPromise
    })

    it('should fail if underlying connect fails', async () => {
      mockSocket.connectShouldFail = true
      mockSocket.connectError = new Error('ECONNREFUSED')

      const socks = new Socks5Socket(mockSocket, proxyConfig)

      await expect(socks.connect(80, 'example.com')).rejects.toThrow('ECONNREFUSED')
    })
  })

  describe('connect() - no auth handshake', () => {
    it('should complete handshake without auth', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      // Should have sent greeting offering no auth
      expect(mockSocket.sentData.length).toBe(1)
      expect(mockSocket.sentData[0]).toEqual(new Uint8Array([SOCKS5_VERSION, 1, SOCKS5_AUTH.NONE]))

      // Server selects no auth
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))

      // Should have sent CONNECT request
      expect(mockSocket.sentData.length).toBe(2)
      const connectReq = mockSocket.sentData[1]
      expect(connectReq[0]).toBe(SOCKS5_VERSION)
      expect(connectReq[1]).toBe(0x01) // CONNECT
      expect(connectReq[3]).toBe(SOCKS5_ATYP.DOMAIN)
      expect(connectReq[4]).toBe(11) // "example.com" length

      // Server responds success
      mockSocket.emitData(buildConnectResponse())

      await connectPromise
    })

    it('should report correct target host/port after connect', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(443, 'secure.example.com')
      await flushMicrotasks()

      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())

      await connectPromise

      expect(socks.remoteAddress).toBe('secure.example.com')
      expect(socks.remotePort).toBe(443)
    })
  })

  describe('connect() - with auth', () => {
    beforeEach(() => {
      proxyConfig.username = 'testuser'
      proxyConfig.password = 'testpass'
    })

    it('should complete handshake with username/password auth', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      // Should have sent greeting offering both methods
      expect(mockSocket.sentData[0]).toEqual(
        new Uint8Array([SOCKS5_VERSION, 2, SOCKS5_AUTH.NONE, SOCKS5_AUTH.USERNAME_PASSWORD]),
      )

      // Server requires auth
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.USERNAME_PASSWORD))

      // Should have sent auth request
      expect(mockSocket.sentData.length).toBe(2)
      const authReq = mockSocket.sentData[1]
      expect(authReq[0]).toBe(0x01) // Auth version
      expect(authReq[1]).toBe(8) // "testuser" length
      expect(authReq[10]).toBe(8) // "testpass" length

      // Server accepts auth
      mockSocket.emitData(buildAuthResponse(true))

      // Should have sent CONNECT request
      expect(mockSocket.sentData.length).toBe(3)

      // Server responds success
      mockSocket.emitData(buildConnectResponse())

      await connectPromise
    })

    it('should fail if auth is rejected', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.USERNAME_PASSWORD))
      mockSocket.emitData(buildAuthResponse(false))

      await expect(connectPromise).rejects.toThrow('authentication failed')
      expect(mockSocket.closed).toBe(true)
    })

    it('should fail if server requires auth but no credentials provided', async () => {
      proxyConfig.username = undefined
      proxyConfig.password = undefined

      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.USERNAME_PASSWORD))

      await expect(connectPromise).rejects.toThrow('no credentials provided')
      expect(mockSocket.closed).toBe(true)
    })
  })

  describe('connect() - error cases', () => {
    it('should fail if server returns no acceptable auth method', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NO_ACCEPTABLE))

      await expect(connectPromise).rejects.toThrow('no acceptable authentication method')
    })

    it('should fail if CONNECT returns connection refused', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse(SOCKS5_REPLY.CONNECTION_REFUSED))

      await expect(connectPromise).rejects.toThrow('Connection refused')
    })

    it('should fail if CONNECT returns host unreachable', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse(SOCKS5_REPLY.HOST_UNREACHABLE))

      await expect(connectPromise).rejects.toThrow('Host unreachable')
    })

    it('should fail on handshake timeout', async () => {
      // Use a very short timeout for this test
      proxyConfig.timeout = 10

      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')

      // Don't send any responses - just wait for timeout
      await expect(connectPromise).rejects.toThrow('timeout')
      expect(mockSocket.closed).toBe(true)
    })

    it('should fail if socket closes during handshake', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      mockSocket.emitClose(true)

      await expect(connectPromise).rejects.toThrow('closed during')
    })

    it('should fail if socket errors during handshake', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      mockSocket.emitError(new Error('Network error'))

      await expect(connectPromise).rejects.toThrow('Network error')
    })

    it('should reject double connect', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      await expect(socks.connect(80, 'other.com')).rejects.toThrow('already connected')

      // Clean up
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())
      await connectPromise
    })
  })

  describe('data forwarding after handshake', () => {
    it('should forward data to user callback after handshake', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const dataCallback = vi.fn()
      socks.onData(dataCallback)

      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())
      await connectPromise

      // Now emit some data
      const testData = new Uint8Array([1, 2, 3, 4, 5])
      mockSocket.emitData(testData)

      expect(dataCallback).toHaveBeenCalledWith(testData)
    })

    it('should forward extra data that arrives with CONNECT response', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const dataCallback = vi.fn()
      socks.onData(dataCallback)

      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))

      // Server sends CONNECT response + extra data in one packet
      const connectResponse = buildConnectResponse()
      const extraData = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
      const combined = new Uint8Array(connectResponse.length + extraData.length)
      combined.set(connectResponse)
      combined.set(extraData, connectResponse.length)
      mockSocket.emitData(combined)

      await connectPromise

      expect(dataCallback).toHaveBeenCalledWith(extraData)
    })

    it('should send data through underlying socket after handshake', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)

      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())
      await connectPromise

      // Clear handshake messages
      mockSocket.sentData = []

      // Send some data
      const testData = new Uint8Array([10, 20, 30])
      socks.send(testData)

      expect(mockSocket.sentData).toEqual([testData])
    })

    it('should throw if send called before handshake completes', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      socks.connect(80, 'example.com')
      await flushMicrotasks()

      expect(() => socks.send(new Uint8Array([1, 2, 3]))).toThrow('before SOCKS5 handshake')
    })
  })

  describe('close and error handling after handshake', () => {
    it('should forward close events to user callback', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const closeCallback = vi.fn()
      socks.onClose(closeCallback)

      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())
      await connectPromise

      mockSocket.emitClose(false)

      expect(closeCallback).toHaveBeenCalledWith(false)
    })

    it('should forward error events to user callback', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const errorCallback = vi.fn()
      socks.onError(errorCallback)

      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())
      await connectPromise

      const testError = new Error('Connection reset')
      mockSocket.emitError(testError)

      expect(errorCallback).toHaveBeenCalledWith(testError)
    })

    it('should close underlying socket on close()', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)

      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())
      await connectPromise

      socks.close()

      expect(mockSocket.closed).toBe(true)
    })
  })

  describe('TLS upgrade', () => {
    it('should delegate secure() to underlying socket after handshake', async () => {
      const secureMock = vi.fn().mockResolvedValue(undefined)
      mockSocket.secure = secureMock

      const socks = new Socks5Socket(mockSocket, proxyConfig)

      const connectPromise = socks.connect(443, 'secure.example.com')
      await flushMicrotasks()
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())
      await connectPromise

      await socks.secure('secure.example.com', { skipValidation: false })

      expect(secureMock).toHaveBeenCalledWith('secure.example.com', { skipValidation: false })
    })

    it('should throw if secure() called before handshake', async () => {
      mockSocket.secure = vi.fn()

      const socks = new Socks5Socket(mockSocket, proxyConfig)
      socks.connect(443, 'secure.example.com')
      await flushMicrotasks()

      await expect(socks.secure('secure.example.com')).rejects.toThrow('before SOCKS5 handshake')
    })

    it('should throw if underlying socket does not support TLS', async () => {
      // Don't add secure method to mockSocket

      const socks = new Socks5Socket(mockSocket, proxyConfig)

      const connectPromise = socks.connect(443, 'secure.example.com')
      await flushMicrotasks()
      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))
      mockSocket.emitData(buildConnectResponse())
      await connectPromise

      await expect(socks.secure('secure.example.com')).rejects.toThrow('does not support TLS')
    })
  })

  describe('fragmented responses', () => {
    it('should handle greeting response arriving in fragments', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      // Send response one byte at a time
      mockSocket.emitData(new Uint8Array([SOCKS5_VERSION]))
      mockSocket.emitData(new Uint8Array([SOCKS5_AUTH.NONE]))

      mockSocket.emitData(buildConnectResponse())

      await connectPromise
    })

    it('should handle CONNECT response arriving in fragments', async () => {
      const socks = new Socks5Socket(mockSocket, proxyConfig)
      const connectPromise = socks.connect(80, 'example.com')
      await flushMicrotasks()

      mockSocket.emitData(buildGreetingResponse(SOCKS5_AUTH.NONE))

      // Send CONNECT response in fragments
      const fullResponse = buildConnectResponse()
      mockSocket.emitData(fullResponse.slice(0, 3))
      mockSocket.emitData(fullResponse.slice(3, 6))
      mockSocket.emitData(fullResponse.slice(6))

      await connectPromise
    })
  })
})
