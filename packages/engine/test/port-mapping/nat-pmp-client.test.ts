import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  NatPmpClient,
  NatPmpError,
  NatPmpResultCode,
  NATPMP_GATEWAY_PORT,
  buildMappingRequest,
  checkResponse,
} from '../../src/port-mapping/nat-pmp-client'
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

function buildExternalAddressResponse(
  ip: [number, number, number, number],
  resultCode = 0,
  epoch = 12345,
): Uint8Array {
  const buf = new Uint8Array(12)
  const view = new DataView(buf.buffer)
  buf[0] = 0 // version
  buf[1] = 0x80 // opcode 0 | 0x80
  view.setUint16(2, resultCode)
  view.setUint32(4, epoch)
  buf[8] = ip[0]
  buf[9] = ip[1]
  buf[10] = ip[2]
  buf[11] = ip[3]
  return buf
}

function buildMappingResponse(
  opcode: number,
  internalPort: number,
  externalPort: number,
  lifetime: number,
  resultCode = 0,
  epoch = 12345,
): Uint8Array {
  const buf = new Uint8Array(16)
  const view = new DataView(buf.buffer)
  buf[0] = 0 // version
  buf[1] = opcode | 0x80
  view.setUint16(2, resultCode)
  view.setUint32(4, epoch)
  view.setUint16(8, internalPort)
  view.setUint16(10, externalPort)
  view.setUint32(12, lifetime)
  return buf
}

describe('NAT-PMP Packet Encoding', () => {
  it('encodes external address request', () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.getExternalAddress()

    expect(socket.sentData.length).toBe(1)
    expect(socket.sentData[0].addr).toBe(GATEWAY_IP)
    expect(socket.sentData[0].port).toBe(NATPMP_GATEWAY_PORT)
    const sent = socket.sentData[0].data
    expect(sent.length).toBe(2)
    expect(sent[0]).toBe(0) // version
    expect(sent[1]).toBe(0) // opcode

    // Respond to settle the promise
    socket.emitMessage(buildExternalAddressResponse([203, 0, 113, 5]))
    return promise.then(() => client.close())
  })

  it('encodes TCP mapping request', () => {
    const req = buildMappingRequest(2, 6881, 6881, 3600)
    expect(req.length).toBe(12)
    expect(req[0]).toBe(0) // version
    expect(req[1]).toBe(2) // TCP opcode
    expect(req[2]).toBe(0) // reserved
    expect(req[3]).toBe(0) // reserved
    const view = new DataView(req.buffer)
    expect(view.getUint16(4)).toBe(6881) // internal port
    expect(view.getUint16(6)).toBe(6881) // external port
    expect(view.getUint32(8)).toBe(3600) // lifetime
  })

  it('encodes UDP mapping request', () => {
    const req = buildMappingRequest(1, 6881, 12345, 7200)
    expect(req[1]).toBe(1) // UDP opcode
    const view = new DataView(req.buffer)
    expect(view.getUint16(4)).toBe(6881)
    expect(view.getUint16(6)).toBe(12345)
    expect(view.getUint32(8)).toBe(7200)
  })

  it('encodes delete mapping request (lifetime=0)', () => {
    const req = buildMappingRequest(2, 6881, 0, 0)
    const view = new DataView(req.buffer)
    expect(view.getUint16(6)).toBe(0) // external port = 0
    expect(view.getUint32(8)).toBe(0) // lifetime = 0
  })
})

describe('NAT-PMP Packet Decoding', () => {
  it('decodes external address response', () => {
    const response = buildExternalAddressResponse([203, 0, 113, 5])
    expect(() => checkResponse(response, 0, 12)).not.toThrow()
  })

  it('decodes mapping response', () => {
    const response = buildMappingResponse(2, 6881, 6881, 3600)
    expect(() => checkResponse(response, 2, 16)).not.toThrow()
    const view = new DataView(response.buffer)
    expect(view.getUint16(8)).toBe(6881)
    expect(view.getUint16(10)).toBe(6881)
    expect(view.getUint32(12)).toBe(3600)
  })

  it('rejects wrong response size', () => {
    const response = new Uint8Array(10)
    expect(() => checkResponse(response, 0, 12)).toThrow('Unexpected response size')
  })

  it('rejects unsupported version', () => {
    const response = buildExternalAddressResponse([1, 2, 3, 4])
    response[0] = 1 // bad version
    try {
      checkResponse(response, 0, 12)
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(NatPmpError)
      expect((e as NatPmpError).resultCode).toBe(NatPmpResultCode.UnsupportedVersion)
    }
  })

  it('rejects wrong opcode', () => {
    const response = buildExternalAddressResponse([1, 2, 3, 4])
    response[1] = 0x81 // wrong opcode for external address
    expect(() => checkResponse(response, 0, 12)).toThrow('Unexpected opcode')
  })

  describe('error result codes', () => {
    const codes = [
      [NatPmpResultCode.UnsupportedVersion, 'Unsupported Version'],
      [NatPmpResultCode.NotAuthorized, 'Not Authorized'],
      [NatPmpResultCode.NetworkFailure, 'Network Failure'],
      [NatPmpResultCode.OutOfResources, 'Out of Resources'],
      [NatPmpResultCode.UnsupportedOpcode, 'Unsupported Opcode'],
    ] as const

    for (const [code, name] of codes) {
      it(`rejects result code ${code} (${name})`, () => {
        const response = buildExternalAddressResponse([1, 2, 3, 4], code)
        try {
          checkResponse(response, 0, 12)
          expect.unreachable('should throw')
        } catch (e) {
          expect(e).toBeInstanceOf(NatPmpError)
          expect((e as NatPmpError).resultCode).toBe(code)
          expect((e as NatPmpError).message).toContain(name)
        }
      })
    }
  })
})

describe('NAT-PMP Retry Logic', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('retries with exponential backoff', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.getExternalAddress()

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

    // Respond now
    socket.emitMessage(buildExternalAddressResponse([10, 0, 0, 1]))
    const ip = await promise
    expect(ip).toBe('10.0.0.1')

    client.close()
  })

  it('gives up after max retries', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    // Capture the rejection before advancing timers to prevent unhandled rejection
    const promise = client.getExternalAddress().catch((e) => e)

    // Exhaust all 9 retries: delays are 250, 500, 1000, 2000, 4000, 8000, 16000, 32000, 64000
    for (let i = 0; i < 9; i++) {
      await vi.advanceTimersByTimeAsync(250 * Math.pow(2, i))
    }

    const error = await promise
    expect(error).toBeInstanceOf(NatPmpError)
    expect(error.message).toContain('No response after 9 retries')
    // initial send + 8 retries = 9 sends, then the 10th call rejects without sending
    expect(socket.sentData.length).toBe(9)

    client.close()
  })

  it('all requests go to gateway IP and port 5351', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, '10.0.0.1')

    const promise = client.getExternalAddress()

    // Let a few retries happen
    await vi.advanceTimersByTimeAsync(250)
    await vi.advanceTimersByTimeAsync(500)

    for (const sent of socket.sentData) {
      expect(sent.addr).toBe('10.0.0.1')
      expect(sent.port).toBe(5351)
    }

    // Clean up — close cancels pending timer and rejects
    client.close()
    await promise.catch(() => {})
  })
})

describe('NAT-PMP Happy Path', () => {
  it('gets external address', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.getExternalAddress()

    socket.emitMessage(buildExternalAddressResponse([203, 0, 113, 42]))
    const ip = await promise
    expect(ip).toBe('203.0.113.42')

    client.close()
  })

  it('adds TCP mapping', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    const sent = socket.sentData[0].data
    expect(sent[1]).toBe(2) // TCP opcode

    socket.emitMessage(buildMappingResponse(2, 6881, 6881, 3600))
    const mapping = await promise
    expect(mapping.internalPort).toBe(6881)
    expect(mapping.externalPort).toBe(6881)
    expect(mapping.lifetime).toBe(3600)

    client.close()
  })

  it('adds UDP mapping', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.addMapping(6881, 6881, 'UDP', 3600)

    expect(socket.sentData[0].data[1]).toBe(1) // UDP opcode

    socket.emitMessage(buildMappingResponse(1, 6881, 6881, 3600))
    const mapping = await promise
    expect(mapping.internalPort).toBe(6881)
    expect(mapping.externalPort).toBe(6881)

    client.close()
  })

  it('removes mapping', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.removeMapping(6881, 'TCP')

    const view = new DataView(
      socket.sentData[0].data.buffer,
      socket.sentData[0].data.byteOffset,
      socket.sentData[0].data.byteLength,
    )
    expect(view.getUint16(6)).toBe(0) // external port
    expect(view.getUint32(8)).toBe(0) // lifetime

    socket.emitMessage(buildMappingResponse(2, 6881, 0, 0))
    const result = await promise
    expect(result).toBe(true)

    client.close()
  })
})

describe('NAT-PMP Edge Cases', () => {
  it('handles server granting different port than requested', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    socket.emitMessage(buildMappingResponse(2, 6881, 12345, 3600))
    const mapping = await promise
    expect(mapping.internalPort).toBe(6881)
    expect(mapping.externalPort).toBe(12345)

    client.close()
  })

  it('handles server granting different lifetime than requested', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.addMapping(6881, 6881, 'TCP', 3600)

    socket.emitMessage(buildMappingResponse(2, 6881, 6881, 7200))
    const mapping = await promise
    expect(mapping.lifetime).toBe(7200)

    client.close()
  })

  it('rejects version mismatch in response (for PCP fallback)', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.getExternalAddress()

    // Response with version=2 (PCP) — RPC accepts it (opcode matches),
    // but checkResponse rejects version != 0
    const response = buildExternalAddressResponse([10, 0, 0, 1])
    response[0] = 2 // PCP version
    socket.emitMessage(response)

    await expect(promise).rejects.toThrow('Unsupported protocol version')

    client.close()
  })

  it('error result code UnsupportedVersion (code 1) rejects with code', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.getExternalAddress()
    socket.emitMessage(
      buildExternalAddressResponse([0, 0, 0, 0], NatPmpResultCode.UnsupportedVersion),
    )

    try {
      await promise
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(NatPmpError)
      expect((e as NatPmpError).resultCode).toBe(NatPmpResultCode.UnsupportedVersion)
    }

    client.close()
  })

  it('removeMapping returns false on error', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.removeMapping(6881, 'TCP')
    socket.emitMessage(buildMappingResponse(2, 6881, 0, 0, NatPmpResultCode.NotAuthorized))
    const result = await promise
    expect(result).toBe(false)

    client.close()
  })

  it('close() causes pending RPC to reject', async () => {
    const socket = new MockUdpSocket()
    const client = new NatPmpClient(socket, GATEWAY_IP)

    const promise = client.getExternalAddress()

    // close() immediately cancels the pending timer and rejects
    client.close()

    await expect(promise).rejects.toThrow('Client is closed')
  })
})
