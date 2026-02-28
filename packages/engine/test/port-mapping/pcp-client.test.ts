import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PcpClient,
  PcpError,
  PcpResultCode,
  PCP_VERSION,
  buildPcpMapRequest,
  parsePcpMapResponse,
  ipToMappedIPv6,
  mappedIPv6ToIP,
} from '../../src/port-mapping/pcp-client'
import { NATPMP_GATEWAY_PORT } from '../../src/port-mapping/nat-pmp-client'
import type { IUdpSocket } from '../../src/interfaces/socket'

class MockUdpSocket implements IUdpSocket {
  public sentData: Array<{ addr: string; port: number; data: Uint8Array }> = []
  private messageCallback:
    | ((src: { addr: string; port: number }, data: Uint8Array) => void)
    | null = null

  send(addr: string, port: number, data: Uint8Array): void {
    this.sentData.push({ addr, port, data: new Uint8Array(data) })
  }

  onMessage(cb: (src: { addr: string; port: number }, data: Uint8Array) => void): void {
    this.messageCallback = cb
  }

  close(): void {
    this.messageCallback = null
  }

  async joinMulticast(): Promise<void> {}
  async leaveMulticast(): Promise<void> {}

  emitMessage(data: Uint8Array, addr = '192.168.1.1', port = NATPMP_GATEWAY_PORT): void {
    if (this.messageCallback) {
      this.messageCallback({ addr, port }, data)
    }
  }
}

const GATEWAY_IP = '192.168.1.1'
const CLIENT_IP = '192.168.1.100'
const TEST_NONCE = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])

function buildPcpMapResponse(
  nonce: Uint8Array,
  protocol: number,
  internalPort: number,
  externalPort: number,
  lifetime: number,
  externalIP: [number, number, number, number] = [203, 0, 113, 5],
  resultCode = 0,
): Uint8Array {
  const buf = new Uint8Array(60)
  const view = new DataView(buf.buffer)

  // Header (24 bytes)
  buf[0] = PCP_VERSION
  buf[1] = 0x01 | 0x80 // MAP opcode with R bit set
  buf[2] = 0 // reserved
  buf[3] = resultCode
  view.setUint32(4, lifetime)
  view.setUint32(8, 12345) // gateway epoch
  // bytes 12-23 reserved

  // MAP payload (36 bytes)
  buf.set(nonce.subarray(0, 12), 24)
  buf[36] = protocol
  // bytes 37-39 reserved
  view.setUint16(40, internalPort)
  view.setUint16(42, externalPort)
  // External IP as IPv4-mapped-IPv6 (bytes 44-59)
  buf[54] = 0xff
  buf[55] = 0xff
  buf[56] = externalIP[0]
  buf[57] = externalIP[1]
  buf[58] = externalIP[2]
  buf[59] = externalIP[3]

  return buf
}

describe('IPv4-Mapped-IPv6 Encoding/Decoding', () => {
  it('encodes 192.168.1.1 correctly', () => {
    const bytes = ipToMappedIPv6('192.168.1.1')
    expect(bytes.length).toBe(16)
    // First 10 bytes are zero
    for (let i = 0; i < 10; i++) {
      expect(bytes[i]).toBe(0)
    }
    // Bytes 10-11 are 0xFF
    expect(bytes[10]).toBe(0xff)
    expect(bytes[11]).toBe(0xff)
    // Last 4 bytes are the IPv4 address
    expect(bytes[12]).toBe(192)
    expect(bytes[13]).toBe(168)
    expect(bytes[14]).toBe(1)
    expect(bytes[15]).toBe(1)
  })

  it('encodes 10.0.0.1 correctly', () => {
    const bytes = ipToMappedIPv6('10.0.0.1')
    expect(bytes[12]).toBe(10)
    expect(bytes[13]).toBe(0)
    expect(bytes[14]).toBe(0)
    expect(bytes[15]).toBe(1)
  })

  it('round-trips IPv4 addresses', () => {
    const addresses = ['192.168.1.1', '10.0.0.1', '203.0.113.42', '0.0.0.0', '255.255.255.255']
    for (const addr of addresses) {
      expect(mappedIPv6ToIP(ipToMappedIPv6(addr))).toBe(addr)
    }
  })

  it('decodes non-IPv4-mapped address as IPv6', () => {
    const bytes = new Uint8Array(16)
    bytes[0] = 0x20
    bytes[1] = 0x01
    // rest are zeros except last
    bytes[15] = 0x01
    const result = mappedIPv6ToIP(bytes)
    expect(result).toBe('2001:0:0:0:0:0:0:1')
  })
})

describe('PCP Packet Encoding', () => {
  it('builds a 60-byte MAP request', () => {
    const request = buildPcpMapRequest(CLIENT_IP, TEST_NONCE, 6881, 6881, 'TCP', 3600)
    expect(request.length).toBe(60)
  })

  it('encodes header fields correctly', () => {
    const request = buildPcpMapRequest(CLIENT_IP, TEST_NONCE, 6881, 6881, 'TCP', 3600)
    const view = new DataView(request.buffer)

    expect(request[0]).toBe(PCP_VERSION)
    expect(request[1]).toBe(1) // MAP opcode
    expect(request[2]).toBe(0) // reserved
    expect(request[3]).toBe(0) // reserved
    expect(view.getUint32(4)).toBe(3600) // lifetime
  })

  it('encodes client IP as IPv4-mapped-IPv6', () => {
    const request = buildPcpMapRequest('192.168.1.100', TEST_NONCE, 6881, 6881, 'TCP', 3600)
    // Client IP at bytes 8-23
    expect(request[18]).toBe(0xff)
    expect(request[19]).toBe(0xff)
    expect(request[20]).toBe(192)
    expect(request[21]).toBe(168)
    expect(request[22]).toBe(1)
    expect(request[23]).toBe(100)
  })

  it('encodes nonce at bytes 24-35', () => {
    const request = buildPcpMapRequest(CLIENT_IP, TEST_NONCE, 6881, 6881, 'TCP', 3600)
    for (let i = 0; i < 12; i++) {
      expect(request[24 + i]).toBe(TEST_NONCE[i])
    }
  })

  it('encodes TCP protocol as 6', () => {
    const request = buildPcpMapRequest(CLIENT_IP, TEST_NONCE, 6881, 6881, 'TCP', 3600)
    expect(request[36]).toBe(6)
  })

  it('encodes UDP protocol as 17', () => {
    const request = buildPcpMapRequest(CLIENT_IP, TEST_NONCE, 6881, 6881, 'UDP', 3600)
    expect(request[36]).toBe(17)
  })

  it('encodes ports correctly', () => {
    const request = buildPcpMapRequest(CLIENT_IP, TEST_NONCE, 6881, 12345, 'TCP', 3600)
    const view = new DataView(request.buffer)
    expect(view.getUint16(40)).toBe(6881) // internal port
    expect(view.getUint16(42)).toBe(12345) // external port
  })

  it('encodes delete request (lifetime=0, externalPort=0)', () => {
    const request = buildPcpMapRequest(CLIENT_IP, TEST_NONCE, 6881, 0, 'TCP', 0)
    const view = new DataView(request.buffer)
    expect(view.getUint32(4)).toBe(0) // lifetime
    expect(view.getUint16(42)).toBe(0) // external port
  })
})

describe('PCP Packet Decoding', () => {
  it('decodes a valid MAP response', () => {
    const response = buildPcpMapResponse(TEST_NONCE, 6, 6881, 6881, 3600)
    const mapping = parsePcpMapResponse(response, TEST_NONCE)
    expect(mapping.internalPort).toBe(6881)
    expect(mapping.externalPort).toBe(6881)
    expect(mapping.lifetime).toBe(3600)
    expect(mapping.externalIP).toBe('203.0.113.5')
    expect(mapping.protocol).toBe('TCP')
    expect(mapping.nonce).toEqual(TEST_NONCE)
  })

  it('decodes UDP protocol', () => {
    const response = buildPcpMapResponse(TEST_NONCE, 17, 6881, 6881, 3600)
    const mapping = parsePcpMapResponse(response, TEST_NONCE)
    expect(mapping.protocol).toBe('UDP')
  })

  it('rejects wrong response size', () => {
    const response = new Uint8Array(30)
    expect(() => parsePcpMapResponse(response, TEST_NONCE)).toThrow('Unexpected response size')
  })

  it('rejects wrong version', () => {
    const response = buildPcpMapResponse(TEST_NONCE, 6, 6881, 6881, 3600)
    response[0] = 0 // NAT-PMP version
    try {
      parsePcpMapResponse(response, TEST_NONCE)
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(PcpError)
      expect((e as PcpError).resultCode).toBe(PcpResultCode.UnsupportedVersion)
    }
  })

  it('rejects wrong opcode', () => {
    const response = buildPcpMapResponse(TEST_NONCE, 6, 6881, 6881, 3600)
    response[1] = 0x82 // wrong opcode
    expect(() => parsePcpMapResponse(response, TEST_NONCE)).toThrow('Unexpected opcode')
  })

  it('rejects nonce mismatch', () => {
    const response = buildPcpMapResponse(TEST_NONCE, 6, 6881, 6881, 3600)
    const wrongNonce = new Uint8Array([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])
    expect(() => parsePcpMapResponse(response, wrongNonce)).toThrow('Nonce mismatch')
  })

  describe('error result codes', () => {
    const codes = [
      [PcpResultCode.UnsupportedVersion, 'Unsupported Version'],
      [PcpResultCode.NotAuthorized, 'Not Authorized'],
      [PcpResultCode.MalformedRequest, 'Malformed Request'],
      [PcpResultCode.UnsupportedOpcode, 'Unsupported Opcode'],
      [PcpResultCode.UnsupportedOption, 'Unsupported Option'],
      [PcpResultCode.MalformedOption, 'Malformed Option'],
      [PcpResultCode.NetworkFailure, 'Network Failure'],
      [PcpResultCode.NoResources, 'No Resources'],
      [PcpResultCode.UnsupportedProtocol, 'Unsupported Protocol'],
      [PcpResultCode.UserExceededQuota, 'User Exceeded Quota'],
      [PcpResultCode.CannotProvideExternal, 'Cannot Provide External'],
      [PcpResultCode.AddressMismatch, 'Address Mismatch'],
      [PcpResultCode.ExcessiveRemotePeers, 'Excessive Remote Peers'],
    ] as const

    for (const [code, name] of codes) {
      it(`rejects result code ${code} (${name})`, () => {
        const response = buildPcpMapResponse(TEST_NONCE, 6, 6881, 6881, 3600, [1, 2, 3, 4], code)
        try {
          parsePcpMapResponse(response, TEST_NONCE)
          expect.unreachable('should throw')
        } catch (e) {
          expect(e).toBeInstanceOf(PcpError)
          expect((e as PcpError).resultCode).toBe(code)
          expect((e as PcpError).message).toContain(name)
        }
      })
    }
  })
})

describe('PCP Retry Logic', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries with exponential backoff', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    // Initial send
    expect(socket.sentData.length).toBe(1)

    // Advance 250ms — first retry
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.sentData.length).toBe(2)

    // Advance 500ms — second retry
    await vi.advanceTimersByTimeAsync(500)
    expect(socket.sentData.length).toBe(3)

    // Advance 1000ms — third retry
    await vi.advanceTimersByTimeAsync(1000)
    expect(socket.sentData.length).toBe(4)

    // Extract nonce from the sent request to build matching response
    const sentRequest = socket.sentData[0].data
    const nonce = sentRequest.subarray(24, 36)
    socket.emitMessage(buildPcpMapResponse(nonce, 6, 6881, 6881, 3600))
    const mapping = await promise
    expect(mapping.internalPort).toBe(6881)

    client.close()
  })

  it('gives up after max retries', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600).catch((e) => e)

    // Exhaust all 9 retries
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(250 * Math.pow(2, i))
    }

    const error = await promise
    expect(error).toBeInstanceOf(PcpError)
    expect(error.message).toContain('No response after 9 retries')
    expect(socket.sentData.length).toBe(9)

    client.close()
  })

  it('all requests go to gateway IP and port 5351', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, '10.0.0.1', CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(500)

    for (const sent of socket.sentData) {
      expect(sent.addr).toBe('10.0.0.1')
      expect(sent.port).toBe(5351)
    }

    client.close()
    await promise.catch(() => {})
  })
})

describe('PCP Happy Path', () => {
  it('adds TCP mapping', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    const sent = socket.sentData[0].data
    expect(sent[0]).toBe(PCP_VERSION)
    expect(sent[1]).toBe(1) // MAP opcode
    expect(sent[36]).toBe(6) // TCP

    const nonce = sent.subarray(24, 36)
    socket.emitMessage(buildPcpMapResponse(nonce, 6, 6881, 6881, 3600))
    const mapping = await promise
    expect(mapping.internalPort).toBe(6881)
    expect(mapping.externalPort).toBe(6881)
    expect(mapping.lifetime).toBe(3600)
    expect(mapping.externalIP).toBe('203.0.113.5')
    expect(mapping.protocol).toBe('TCP')
    expect(mapping.nonce.length).toBe(12)

    client.close()
  })

  it('adds UDP mapping', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'UDP', 3600)

    const sent = socket.sentData[0].data
    expect(sent[36]).toBe(17) // UDP

    const nonce = sent.subarray(24, 36)
    socket.emitMessage(buildPcpMapResponse(nonce, 17, 6881, 6881, 3600))
    const mapping = await promise
    expect(mapping.protocol).toBe('UDP')

    client.close()
  })

  it('removes mapping', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const existingMapping = {
      internalPort: 6881,
      externalPort: 6881,
      externalIP: '203.0.113.5',
      lifetime: 3600,
      nonce: TEST_NONCE,
      protocol: 'TCP' as const,
    }

    const promise = client.removeMapping(existingMapping)

    const sent = socket.sentData[0].data
    const view = new DataView(sent.buffer, sent.byteOffset, sent.byteLength)
    expect(view.getUint32(4)).toBe(0) // lifetime = 0
    expect(view.getUint16(42)).toBe(0) // external port = 0

    // Verify nonce is reused from original mapping
    for (let i = 0; i < 12; i++) {
      expect(sent[24 + i]).toBe(TEST_NONCE[i])
    }

    socket.emitMessage(buildPcpMapResponse(TEST_NONCE, 6, 6881, 0, 0))
    const result = await promise
    expect(result).toBe(true)

    client.close()
  })
})

describe('PCP Edge Cases', () => {
  it('handles server granting different port than requested', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    const nonce = socket.sentData[0].data.subarray(24, 36)
    socket.emitMessage(buildPcpMapResponse(nonce, 6, 6881, 12345, 3600))
    const mapping = await promise
    expect(mapping.internalPort).toBe(6881)
    expect(mapping.externalPort).toBe(12345)

    client.close()
  })

  it('handles server granting different lifetime than requested', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    const nonce = socket.sentData[0].data.subarray(24, 36)
    socket.emitMessage(buildPcpMapResponse(nonce, 6, 6881, 6881, 7200))
    const mapping = await promise
    expect(mapping.lifetime).toBe(7200)

    client.close()
  })

  it('handles server granting different external IP', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    const nonce = socket.sentData[0].data.subarray(24, 36)
    socket.emitMessage(buildPcpMapResponse(nonce, 6, 6881, 6881, 3600, [198, 51, 100, 1]))
    const mapping = await promise
    expect(mapping.externalIP).toBe('198.51.100.1')

    client.close()
  })

  it('unsupported version error (result code 1) — critical for PCP→NAT-PMP fallback', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    const nonce = socket.sentData[0].data.subarray(24, 36)
    socket.emitMessage(
      buildPcpMapResponse(nonce, 6, 0, 0, 0, [0, 0, 0, 0], PcpResultCode.UnsupportedVersion),
    )

    try {
      await promise
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(PcpError)
      expect((e as PcpError).resultCode).toBe(PcpResultCode.UnsupportedVersion)
    }

    client.close()
  })

  it('removeMapping returns false on error', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const existingMapping = {
      internalPort: 6881,
      externalPort: 6881,
      externalIP: '203.0.113.5',
      lifetime: 3600,
      nonce: TEST_NONCE,
      protocol: 'TCP' as const,
    }

    const promise = client.removeMapping(existingMapping)
    socket.emitMessage(
      buildPcpMapResponse(TEST_NONCE, 6, 6881, 0, 0, [0, 0, 0, 0], PcpResultCode.NotAuthorized),
    )
    const result = await promise
    expect(result).toBe(false)

    client.close()
  })

  it('close() causes pending RPC to reject', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    client.close()

    await expect(promise).rejects.toThrow('Client is closed')
  })

  it('RPC ignores responses with wrong version', async () => {
    const socket = new MockUdpSocket()
    const client = new PcpClient(socket, GATEWAY_IP, CLIENT_IP)

    vi.useFakeTimers()

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    // Send a NAT-PMP response (version 0) — should be ignored by RPC
    const wrongVersionResponse = buildPcpMapResponse(
      socket.sentData[0].data.subarray(24, 36),
      6,
      6881,
      6881,
      3600,
    )
    wrongVersionResponse[0] = 0
    socket.emitMessage(wrongVersionResponse)

    // Should still be waiting — advance timer to trigger retry
    await vi.advanceTimersByTimeAsync(250)
    expect(socket.sentData.length).toBe(2)

    // Now send correct response
    const nonce = socket.sentData[0].data.subarray(24, 36)
    socket.emitMessage(buildPcpMapResponse(nonce, 6, 6881, 6881, 3600))
    const mapping = await promise
    expect(mapping.internalPort).toBe(6881)

    client.close()
    vi.useRealTimers()
  })
})
