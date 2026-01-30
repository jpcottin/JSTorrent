import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  HttpBatchingDiskQueue,
  packVerifiedWriteBatch,
} from '../../../src/adapters/daemon/http-batching-disk-queue'

// Mock DaemonConnection
class MockDaemonConnection {
  lastRequest: {
    method: string
    path: string
    headers: Record<string, string>
    body?: Uint8Array
  } | null = null

  requestWithHeaders = vi.fn(
    async (method: string, path: string, headers: Record<string, string>, body?: Uint8Array) => {
      this.lastRequest = { method, path, headers, body }
      return {
        ok: true,
        status: 202,
        statusText: 'Accepted',
        text: async () => 'Accepted',
      }
    },
  )
}

// Mock the batch write registration functions
const mockPendingBatchWrites = new Map<
  string,
  { resolve: (v: { bytesWritten: number }) => void; reject: (e: Error) => void }
>()

vi.mock('../../../src/adapters/daemon/daemon-file-handle', () => ({
  registerBatchWrite: vi.fn(
    (
      callbackId: string,
      resolve: (v: { bytesWritten: number }) => void,
      reject: (e: Error) => void,
    ) => {
      mockPendingBatchWrites.set(callbackId, { resolve, reject })
    },
  ),
  unregisterBatchWrite: vi.fn((callbackId: string) => {
    mockPendingBatchWrites.delete(callbackId)
  }),
  HashMismatchError: class HashMismatchError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'HashMismatchError'
    }
  },
}))

describe('packVerifiedWriteBatch', () => {
  it('should pack a single write correctly', () => {
    const writes = [
      {
        rootKey: 'root1',
        path: 'path/to/file.txt',
        position: 12345,
        data: new Uint8Array([1, 2, 3, 4, 5]).buffer,
        expectedHashHex: 'a'.repeat(40),
        callbackId: 'hb_1',
        resolve: () => {},
        reject: () => {},
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
    expect(callbackId).toBe('hb_1')
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
        callbackId: 'hb_1',
        resolve: () => {},
        reject: () => {},
      },
      {
        rootKey: 'r2',
        path: 'b.txt',
        position: 200,
        data: new Uint8Array([2, 3]).buffer,
        expectedHashHex: '1'.repeat(40),
        callbackId: 'hb_2',
        resolve: () => {},
        reject: () => {},
      },
    ]

    const packed = packVerifiedWriteBatch(writes)
    const view = new DataView(packed)

    // Count should be 2
    expect(view.getUint32(0, true)).toBe(2)

    // Verify total size is reasonable
    expect(packed.byteLength).toBe(141)
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
        resolve: () => {},
        reject: () => {},
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

describe('HttpBatchingDiskQueue', () => {
  let queue: HttpBatchingDiskQueue
  let mockConnection: MockDaemonConnection

  beforeEach(() => {
    mockConnection = new MockDaemonConnection()
    mockPendingBatchWrites.clear()

    // Small thresholds for testing
    queue = new HttpBatchingDiskQueue(mockConnection as unknown as never, {
      batchSizeThreshold: 1024, // 1KB
    })
  })

  describe('queueVerifiedWrite', () => {
    it('should send immediately when not backed up', () => {
      const hash = new Uint8Array(20).fill(0xab)

      queue.queueVerifiedWrite('root', 'path/file.txt', 100, new ArrayBuffer(10), hash)

      // First write sends immediately (not backed up)
      expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(1)
      expect(queue.pendingCount).toBe(0)
    })

    it('should queue subsequent writes while in-flight', () => {
      const hash = new Uint8Array(20).fill(0)

      // First write sends immediately
      queue.queueVerifiedWrite('r1', 'f1.txt', 0, new ArrayBuffer(5), hash)
      expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(1)

      // Subsequent writes queue up while in-flight
      queue.queueVerifiedWrite('r2', 'f2.txt', 100, new ArrayBuffer(10), hash)
      queue.queueVerifiedWrite('r3', 'f3.txt', 200, new ArrayBuffer(15), hash)

      expect(queue.pendingCount).toBe(2)
      expect(queue.pendingBytes).toBe(25)
      // No additional HTTP requests while in-flight
      expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(1)
    })

    it('should register callbacks for WebSocket ACK', () => {
      const hash = new Uint8Array(20).fill(0)

      queue.queueVerifiedWrite('root', 'file.txt', 0, new ArrayBuffer(5), hash)

      // Callback registered even for immediately-sent writes
      expect(mockPendingBatchWrites.size).toBe(1)
      const keys = [...mockPendingBatchWrites.keys()]
      expect(keys[0]).toMatch(/^hb_\d+$/)
    })

    it('should flush queued writes when size threshold is reached', async () => {
      const hash = new Uint8Array(20).fill(0)

      // First write sends immediately
      queue.queueVerifiedWrite('root', 'file1.txt', 0, new ArrayBuffer(100), hash)
      expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(1)

      // Queue more writes (now in-flight, so these queue up)
      queue.queueVerifiedWrite('root', 'file2.txt', 0, new ArrayBuffer(500), hash)
      expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(1)

      // This write exceeds threshold, triggers additional flush
      queue.queueVerifiedWrite('root', 'file3.txt', 0, new ArrayBuffer(600), hash)

      // Should have triggered a second flush (size threshold)
      expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(2)
      expect(mockConnection.lastRequest?.method).toBe('POST')
      expect(mockConnection.lastRequest?.path).toBe('/write-batch/root')
    })

    it('should resolve promise when ACK is received', async () => {
      const hash = new Uint8Array(20).fill(0)

      const promise = queue.queueVerifiedWrite('root', 'file.txt', 0, new ArrayBuffer(100), hash)

      // Flush the batch
      queue.flushPending()

      // Simulate WebSocket ACK by resolving the callback
      const callbackId = [...mockPendingBatchWrites.keys()][0]
      mockPendingBatchWrites.get(callbackId)!.resolve({ bytesWritten: 100 })

      const result = await promise
      expect(result).toEqual({ bytesWritten: 100 })
    })

    it('should reject promise when ERROR is received', async () => {
      const hash = new Uint8Array(20).fill(0)

      const promise = queue.queueVerifiedWrite('root', 'file.txt', 0, new ArrayBuffer(100), hash)

      // Flush the batch
      queue.flushPending()

      // Simulate WebSocket ERROR by rejecting the callback
      const callbackId = [...mockPendingBatchWrites.keys()][0]
      mockPendingBatchWrites.get(callbackId)!.reject(new Error('Hash mismatch'))

      await expect(promise).rejects.toThrow('Hash mismatch')
    })
  })

  describe('flushPending', () => {
    it('should not send HTTP request if no pending writes', () => {
      queue.flushPending()
      expect(mockConnection.requestWithHeaders).not.toHaveBeenCalled()
    })

    it('should send packed data and clear pending queue', () => {
      const hash = new Uint8Array(20).fill(0xab)

      // First write sends immediately
      queue.queueVerifiedWrite('root', 'file.txt', 100, new ArrayBuffer(10), hash)
      expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(1)

      // Second write queues (in-flight)
      queue.queueVerifiedWrite('root2', 'file2.txt', 200, new ArrayBuffer(20), hash)
      expect(queue.pendingCount).toBe(1)

      // Explicit flush sends queued writes
      queue.flushPending()

      expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(2)
      expect(mockConnection.lastRequest?.body).toBeInstanceOf(Uint8Array)
      expect(queue.pendingCount).toBe(0)
      expect(queue.pendingBytes).toBe(0)
    })

    it('should pack data correctly', () => {
      const hash = new Uint8Array(20).fill(0)

      // First write sends immediately with correct packing
      queue.queueVerifiedWrite('root', 'test.txt', 0, new ArrayBuffer(5), hash)

      const packed = mockConnection.lastRequest?.body
      expect(packed).toBeDefined()

      const view = new DataView(packed!.buffer, packed!.byteOffset, packed!.byteLength)
      expect(view.getUint32(0, true)).toBe(1) // Count
    })
  })

  describe('clearPending', () => {
    it('should clear queued writes and reject their promises', async () => {
      const hash = new Uint8Array(20).fill(0)

      // First write sends immediately (not queued)
      const promise1 = queue.queueVerifiedWrite('root', 'file1.txt', 0, new ArrayBuffer(100), hash)
      // Second and third writes queue (in-flight)
      const promise2 = queue.queueVerifiedWrite('root', 'file2.txt', 0, new ArrayBuffer(100), hash)
      const promise3 = queue.queueVerifiedWrite('root', 'file3.txt', 0, new ArrayBuffer(100), hash)

      expect(queue.pendingCount).toBe(2) // Only queued writes, not in-flight

      queue.clearPending()

      expect(queue.pendingCount).toBe(0)
      expect(queue.pendingBytes).toBe(0)

      // Queued writes should be rejected
      await expect(promise2).rejects.toThrow('Disk queue cleared')
      await expect(promise3).rejects.toThrow('Disk queue cleared')

      // First write was already sent, resolve its ACK
      const callbackId = [...mockPendingBatchWrites.keys()][0]
      mockPendingBatchWrites.get(callbackId)!.resolve({ bytesWritten: 100 })
      await expect(promise1).resolves.toEqual({ bytesWritten: 100 })
    })

    it('should unregister batch write callbacks for cleared writes', async () => {
      const hash = new Uint8Array(20).fill(0)

      // First write sends immediately
      queue.queueVerifiedWrite('root', 'file1.txt', 0, new ArrayBuffer(100), hash)
      // Second write queues
      const promise2 = queue.queueVerifiedWrite('root', 'file2.txt', 0, new ArrayBuffer(100), hash)

      // 2 callbacks registered (one sent, one queued)
      expect(mockPendingBatchWrites.size).toBe(2)

      queue.clearPending()

      // Only the queued write's callback should be unregistered
      // The in-flight write's callback remains (waiting for ACK)
      expect(mockPendingBatchWrites.size).toBe(1)

      await expect(promise2).rejects.toThrow('Disk queue cleared')
    })
  })

  describe('IDiskQueue interface', () => {
    it('should execute enqueue jobs directly', async () => {
      let executed = false

      await queue.enqueue({ type: 'write', pieceIndex: 0, fileCount: 1, size: 100 }, async () => {
        executed = true
      })

      expect(executed).toBe(true)
    })

    it('should flush pending on drain', async () => {
      const hash = new Uint8Array(20).fill(0)

      queue.queueVerifiedWrite('root', 'file.txt', 0, new ArrayBuffer(10), hash)

      await queue.drain()

      expect(mockConnection.requestWithHeaders).toHaveBeenCalledTimes(1)
    })

    it('should return empty snapshot', () => {
      const snapshot = queue.getSnapshot()
      expect(snapshot.pending).toEqual([])
      expect(snapshot.running).toEqual([])
      expect(snapshot.draining).toBe(false)
    })

    it('resume should be a no-op', () => {
      // Should not throw
      queue.resume()
    })
  })

  describe('HTTP error handling', () => {
    it('should reject all pending writes on HTTP failure', async () => {
      const hash = new Uint8Array(20).fill(0)

      // Make HTTP request fail
      mockConnection.requestWithHeaders.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
        text: async () => 'Server error',
      })

      const promise = queue.queueVerifiedWrite('root', 'file.txt', 0, new ArrayBuffer(100), hash)

      queue.flushPending()

      await expect(promise).rejects.toThrow('Batch request failed')
    })
  })
})
