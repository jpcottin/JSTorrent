import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { packVerifiedWriteBatch } from '../../../src/adapters/daemon/batch-write-utils'
import {
  DaemonFileHandle,
  type BatchWriteItem,
  getCompanionWriteQueueStats,
} from '../../../src/adapters/daemon/daemon-file-handle'

// Mock DaemonConnection
class MockDaemonConnection {
  ready = true
  lastRequest: {
    method: string
    path: string
    headers: Record<string, string>
    body?: Uint8Array
  } | null = null

  requestWithHeaders = vi.fn(
    async (method: string, path: string, headers: Record<string, string>, body?: Uint8Array) => {
      this.lastRequest = { method, path, headers, body }
      // Return 200 OK for synchronous completion (easier to test)
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => 'OK',
      }
    },
  )

  requestBinaryWithHeaders = vi.fn()
  request = vi.fn()
  frameHandler: ((frame: ArrayBuffer) => void) | null = null
  onFrame = vi.fn((cb: (frame: ArrayBuffer) => void) => {
    this.frameHandler = cb
  })
  getStreamingBaseUrl = vi.fn(() => null)
  getCredentialsCached = vi.fn(async () => ({
    token: 'test-token',
    extensionId: 'test-ext',
    installId: 'test-install',
  }))
}

function makeBatchAckFrame(
  callbackId: string,
  bytesWritten: number,
  resultCode: number,
): ArrayBuffer {
  const encoder = new TextEncoder()
  const callbackBytes = encoder.encode(callbackId)
  const frame = new ArrayBuffer(8 + 1 + callbackBytes.length + 4 + 1)
  const view = new DataView(frame)
  const bytes = new Uint8Array(frame)

  view.setUint8(1, 0x31)
  view.setUint32(4, 0, true)
  bytes[8] = callbackBytes.length
  bytes.set(callbackBytes, 9)
  view.setInt32(9 + callbackBytes.length, bytesWritten, true)
  bytes[9 + callbackBytes.length + 4] = resultCode

  return frame
}

function readCallbackIdsFromPackedRequest(body: Uint8Array): string[] {
  const bytes = new Uint8Array(body.buffer, body.byteOffset, body.byteLength)
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const count = view.getUint32(0, true)
  const callbackIds: string[] = []
  let offset = 4

  for (let i = 0; i < count; i++) {
    const rootKeyLen = bytes[offset]
    offset += 1 + rootKeyLen
    const pathLen = view.getUint16(offset, true)
    offset += 2 + pathLen
    offset += 8 // position
    const dataLen = view.getUint32(offset, true)
    offset += 4 + dataLen
    offset += 40 // hash
    const callbackIdLen = bytes[offset]
    offset += 1
    callbackIds.push(decoder.decode(bytes.subarray(offset, offset + callbackIdLen)))
    offset += callbackIdLen
  }

  return callbackIds
}

describe('packVerifiedWriteBatch (batch-write-utils)', () => {
  it('should pack a single write correctly', () => {
    const writes = [
      {
        rootKey: 'root1',
        path: 'path/to/file.txt',
        position: 12345,
        data: new Uint8Array([1, 2, 3, 4, 5]).buffer,
        expectedHashHex: 'a'.repeat(40),
        callbackId: 'wb_1',
      },
    ]

    const packed = packVerifiedWriteBatch(writes)
    const view = new DataView(packed)
    const bytes = new Uint8Array(packed)
    const textDecoder = new TextDecoder()
    let offset = 0

    // Count
    expect(view.getUint32(offset, true)).toBe(1)
    offset += 4

    // rootKeyLen + rootKey
    const rootKeyLen = bytes[offset]
    offset += 1
    expect(rootKeyLen).toBe(5)
    const rootKey = textDecoder.decode(bytes.subarray(offset, offset + rootKeyLen))
    expect(rootKey).toBe('root1')
    offset += rootKeyLen

    // pathLen + path
    const pathLen = view.getUint16(offset, true)
    offset += 2
    expect(pathLen).toBe(16)
    const path = textDecoder.decode(bytes.subarray(offset, offset + pathLen))
    expect(path).toBe('path/to/file.txt')
    offset += pathLen

    // position (u64 LE)
    const positionLow = view.getUint32(offset, true)
    const positionHigh = view.getUint32(offset + 4, true)
    const position = positionLow + positionHigh * 0x100000000
    expect(position).toBe(12345)
    offset += 8

    // dataLen + data
    const dataLen = view.getUint32(offset, true)
    offset += 4
    expect(dataLen).toBe(5)
    expect([...bytes.subarray(offset, offset + dataLen)]).toEqual([1, 2, 3, 4, 5])
    offset += dataLen

    // hashHex (fixed 40 bytes)
    const hashHex = textDecoder.decode(bytes.subarray(offset, offset + 40))
    expect(hashHex).toBe('a'.repeat(40))
    offset += 40

    // callbackIdLen + callbackId
    const callbackIdLen = bytes[offset]
    offset += 1
    expect(callbackIdLen).toBe(4)
    const callbackId = textDecoder.decode(bytes.subarray(offset, offset + callbackIdLen))
    expect(callbackId).toBe('wb_1')
    offset += callbackIdLen

    // Verify we consumed the entire buffer
    expect(offset).toBe(packed.byteLength)
  })

  it('should pack multiple writes correctly', () => {
    const writes = [
      {
        rootKey: 'r1',
        path: 'a.txt',
        position: 100,
        data: new Uint8Array([1]).buffer,
        expectedHashHex: '0'.repeat(40),
        callbackId: 'wb_1',
      },
      {
        rootKey: 'r2',
        path: 'b.txt',
        position: 200,
        data: new Uint8Array([2, 3]).buffer,
        expectedHashHex: '1'.repeat(40),
        callbackId: 'wb_2',
      },
    ]

    const packed = packVerifiedWriteBatch(writes)
    const view = new DataView(packed)

    // Count should be 2
    expect(view.getUint32(0, true)).toBe(2)
  })

  it('should handle large positions (> 32 bits)', () => {
    const largePosition = 0x1_0000_0001 // 4294967297

    const writes = [
      {
        rootKey: 'r',
        path: 'f',
        position: largePosition,
        data: new ArrayBuffer(0),
        expectedHashHex: 'f'.repeat(40),
        callbackId: 'c',
      },
    ]

    const packed = packVerifiedWriteBatch(writes)
    const view = new DataView(packed)
    let offset = 4 // skip count

    // Skip rootKey
    const rootKeyLen = new Uint8Array(packed)[offset]
    offset += 1 + rootKeyLen

    // Skip path
    const pathLen = view.getUint16(offset, true)
    offset += 2 + pathLen

    // Read position as two u32 values
    const positionLow = view.getUint32(offset, true)
    const positionHigh = view.getUint32(offset + 4, true)
    const position = positionLow + positionHigh * 0x100000000

    expect(position).toBe(largePosition)
  })
})

describe('DaemonFileHandle.writeBatch', () => {
  let fileHandle: DaemonFileHandle
  let mockConnection: MockDaemonConnection

  beforeEach(() => {
    mockConnection = new MockDaemonConnection()

    fileHandle = new DaemonFileHandle(
      mockConnection as unknown as never,
      'test/file.txt',
      'testRootKey',
      false, // nullStorage
    )
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('should return immediately for empty writes array', async () => {
    await fileHandle.writeBatch([])

    expect(mockConnection.requestWithHeaders).not.toHaveBeenCalled()
  })

  it('should send single HTTP request for multiple writes', async () => {
    const writes: BatchWriteItem[] = [
      {
        offset: 0,
        data: new Uint8Array([1, 2, 3]),
        expectedHash: new Uint8Array(20).fill(0xaa),
      },
      {
        offset: 1000,
        data: new Uint8Array([4, 5, 6]),
        expectedHash: new Uint8Array(20).fill(0xbb),
      },
    ]

    // Note: This will timeout after 30s in tests because we're not simulating ACKs
    // But we can verify the HTTP request was made correctly
    const batchPromise = fileHandle.writeBatch(writes)

    // Should have sent exactly one HTTP request
    expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(1)
    expect(mockConnection.lastRequest?.method).toBe('POST')
    expect(mockConnection.lastRequest?.path).toBe('/write-batch/testRootKey')
    expect(mockConnection.lastRequest?.headers['Content-Type']).toBe('application/octet-stream')

    // Verify packed data has count = 2
    const packedData = mockConnection.lastRequest?.body
    expect(packedData).toBeDefined()
    const view = new DataView(packedData!.buffer, packedData!.byteOffset, packedData!.byteLength)
    expect(view.getUint32(0, true)).toBe(2) // 2 writes

    // Wait for the promise (will resolve because we return 200 OK, not 202)
    await batchPromise
  })

  it('tracks companion write queue bytes while waiting for batch ACKs', async () => {
    mockConnection.requestWithHeaders.mockImplementationOnce(
      async (method: string, path: string, headers: Record<string, string>, body?: Uint8Array) => {
        mockConnection.lastRequest = { method, path, headers, body }
        return {
          ok: true,
          status: 202,
          statusText: 'Accepted',
          text: async () => 'Accepted',
        }
      },
    )

    const writes: BatchWriteItem[] = [
      {
        offset: 0,
        data: new Uint8Array(4),
        expectedHash: new Uint8Array(20).fill(0xaa),
      },
      {
        offset: 128,
        data: new Uint8Array(6),
        expectedHash: new Uint8Array(20).fill(0xbb),
      },
    ]

    const baseline = getCompanionWriteQueueStats()
    const batchPromise = fileHandle.writeBatch(writes)
    await vi.waitFor(() => expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(1))

    const callbackIds = readCallbackIdsFromPackedRequest(mockConnection.lastRequest!.body!)
    const during = getCompanionWriteQueueStats()
    expect(during.pendingWrites).toBe(0)
    expect(during.pendingBytes).toBe(0)
    expect(during.inFlightWrites - baseline.inFlightWrites).toBe(2)
    expect(during.inFlightBytes - baseline.inFlightBytes).toBe(10)

    expect(mockConnection.frameHandler).toBeTruthy()
    mockConnection.frameHandler!(makeBatchAckFrame(callbackIds[0], 4, 0))
    mockConnection.frameHandler!(makeBatchAckFrame(callbackIds[1], 6, 0))
    await batchPromise

    const after = getCompanionWriteQueueStats()
    expect(after.inFlightBytes).toBe(baseline.inFlightBytes)
    expect(after.inFlightWrites).toBe(baseline.inFlightWrites)
  })

  it('tracks single verified writes in companion write queue stats until HTTP completes', async () => {
    let resolveResponse:
      | ((value: {
          ok: boolean
          status: number
          statusText: string
          text: () => Promise<string>
        }) => void)
      | undefined
    mockConnection.requestWithHeaders.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveResponse = resolve
        }),
    )

    const baseline = getCompanionWriteQueueStats()
    fileHandle.setExpectedHashForNextWrite(new Uint8Array(20).fill(0xaa))
    const writePromise = fileHandle.write(new Uint8Array(8), 0, 8, 0)

    await vi.waitFor(() =>
      expect(getCompanionWriteQueueStats().inFlightBytes - baseline.inFlightBytes).toBe(8),
    )
    expect(getCompanionWriteQueueStats().inFlightWrites - baseline.inFlightWrites).toBe(1)

    resolveResponse!({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => 'OK',
    })
    await writePromise

    expect(getCompanionWriteQueueStats().inFlightBytes).toBe(baseline.inFlightBytes)
    expect(getCompanionWriteQueueStats().inFlightWrites).toBe(baseline.inFlightWrites)
  })

  it('should reject all writes on HTTP error', async () => {
    // Make HTTP request fail
    mockConnection.requestWithHeaders.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'Server error',
    })

    const writes: BatchWriteItem[] = [
      {
        offset: 0,
        data: new Uint8Array([1, 2, 3]),
        expectedHash: new Uint8Array(20).fill(0xaa),
      },
    ]

    await expect(fileHandle.writeBatch(writes)).rejects.toThrow('Batch write failed')
  })

  it('should skip network request in null storage mode', async () => {
    const nullStorageHandle = new DaemonFileHandle(
      mockConnection as unknown as never,
      'test/file.txt',
      'testRootKey',
      true, // nullStorage = true
    )

    const writes: BatchWriteItem[] = [
      {
        offset: 0,
        data: new Uint8Array([1, 2, 3]),
        expectedHash: new Uint8Array(20).fill(0xaa),
      },
    ]

    await nullStorageHandle.writeBatch(writes)

    expect(mockConnection.requestWithHeaders).not.toHaveBeenCalled()
  })

  it('should use correct rootKey and path in packed data', async () => {
    const writes: BatchWriteItem[] = [
      {
        offset: 12345,
        data: new Uint8Array([1, 2, 3]),
        expectedHash: new Uint8Array(20).fill(0xaa),
      },
    ]

    await fileHandle.writeBatch(writes)

    // Verify the packed data contains our rootKey and path
    const packedData = mockConnection.lastRequest?.body
    expect(packedData).toBeDefined()

    // Unpack and verify
    const bytes = new Uint8Array(packedData!.buffer, packedData!.byteOffset, packedData!.byteLength)
    const textDecoder = new TextDecoder()
    let offset = 4 // skip count

    // rootKeyLen + rootKey
    const rootKeyLen = bytes[offset]
    offset += 1
    const rootKey = textDecoder.decode(bytes.subarray(offset, offset + rootKeyLen))
    expect(rootKey).toBe('testRootKey')
    offset += rootKeyLen

    // pathLen + path
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const pathLen = view.getUint16(offset, true)
    offset += 2
    const path = textDecoder.decode(bytes.subarray(offset, offset + pathLen))
    expect(path).toBe('test/file.txt')
  })

  it('should include correct offset in packed data', async () => {
    const writes: BatchWriteItem[] = [
      {
        offset: 98765,
        data: new Uint8Array([1, 2, 3]),
        expectedHash: new Uint8Array(20).fill(0xaa),
      },
    ]

    await fileHandle.writeBatch(writes)

    const packedData = mockConnection.lastRequest?.body
    expect(packedData).toBeDefined()

    const bytes = new Uint8Array(packedData!.buffer, packedData!.byteOffset, packedData!.byteLength)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    // Navigate to position field
    let offset = 4 // count
    const rootKeyLen = bytes[offset]
    offset += 1 + rootKeyLen
    const pathLen = view.getUint16(offset, true)
    offset += 2 + pathLen

    // Read position
    const positionLow = view.getUint32(offset, true)
    const positionHigh = view.getUint32(offset + 4, true)
    const position = positionLow + positionHigh * 0x100000000

    expect(position).toBe(98765)
  })

  it('should include correct hash hex in packed data', async () => {
    const hash = new Uint8Array(20)
    for (let i = 0; i < 20; i++) hash[i] = i

    const writes: BatchWriteItem[] = [
      {
        offset: 0,
        data: new Uint8Array([1, 2, 3]),
        expectedHash: hash,
      },
    ]

    await fileHandle.writeBatch(writes)

    const packedData = mockConnection.lastRequest?.body
    expect(packedData).toBeDefined()

    const bytes = new Uint8Array(packedData!.buffer, packedData!.byteOffset, packedData!.byteLength)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const textDecoder = new TextDecoder()

    // Navigate to hash field
    let offset = 4 // count
    const rootKeyLen = bytes[offset]
    offset += 1 + rootKeyLen
    const pathLen = view.getUint16(offset, true)
    offset += 2 + pathLen
    offset += 8 // position
    const dataLen = view.getUint32(offset, true)
    offset += 4 + dataLen

    // Read hash hex (40 bytes)
    const hashHex = textDecoder.decode(bytes.subarray(offset, offset + 40))
    expect(hashHex).toBe('000102030405060708090a0b0c0d0e0f10111213')
  })

  it('should include data in packed buffer', async () => {
    const testData = new Uint8Array([10, 20, 30, 40, 50])

    const writes: BatchWriteItem[] = [
      {
        offset: 0,
        data: testData,
        expectedHash: new Uint8Array(20).fill(0xaa),
      },
    ]

    await fileHandle.writeBatch(writes)

    const packedData = mockConnection.lastRequest?.body
    expect(packedData).toBeDefined()

    const bytes = new Uint8Array(packedData!.buffer, packedData!.byteOffset, packedData!.byteLength)
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

    // Navigate to data field
    let offset = 4 // count
    const rootKeyLen = bytes[offset]
    offset += 1 + rootKeyLen
    const pathLen = view.getUint16(offset, true)
    offset += 2 + pathLen
    offset += 8 // position

    // Read data length and data
    const dataLen = view.getUint32(offset, true)
    expect(dataLen).toBe(5)
    offset += 4

    const data = bytes.subarray(offset, offset + dataLen)
    expect([...data]).toEqual([10, 20, 30, 40, 50])
  })
})
