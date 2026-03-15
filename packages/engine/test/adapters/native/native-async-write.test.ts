import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  NativeAsyncWriteQueue,
  packWriteBatch,
} from '../../../src/adapters/native/native-async-write'

// Mock the native bindings
vi.stubGlobal('__jstorrent_file_write_batch', vi.fn())
vi.stubGlobal('__jstorrent_file_write_callbacks', {})

describe('packWriteBatch', () => {
  it('should pack a single write correctly', () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])

    const writes = [
      {
        rootKey: 'root1',
        path: 'path/to/file.txt',
        position: 12345,
        buffer: data.buffer as ArrayBuffer,
        dataOffset: 0,
        dataLength: 5,
        callbackId: 'wr_1',
        resolve: () => {},
        reject: () => {},
      },
    ]

    const packed = packWriteBatch(writes)
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
    expect(textDecoder.decode(bytes.subarray(offset, offset + rootKeyLen))).toBe('root1')
    offset += rootKeyLen

    // pathLen + path
    const pathLen = view.getUint16(offset, true)
    offset += 2
    expect(pathLen).toBe(16)
    expect(textDecoder.decode(bytes.subarray(offset, offset + pathLen))).toBe('path/to/file.txt')
    offset += pathLen

    // position (u64 LE)
    const positionLow = view.getUint32(offset, true)
    const positionHigh = view.getUint32(offset + 4, true)
    expect(positionLow + positionHigh * 0x100000000).toBe(12345)
    offset += 8

    // dataLen + data (no hash field — that's the key difference from verified writes)
    const dataLen = view.getUint32(offset, true)
    offset += 4
    expect(dataLen).toBe(5)
    expect([...bytes.subarray(offset, offset + dataLen)]).toEqual([1, 2, 3, 4, 5])
    offset += dataLen

    // callbackIdLen + callbackId
    const callbackIdLen = bytes[offset]
    offset += 1
    expect(callbackIdLen).toBe(4)
    expect(textDecoder.decode(bytes.subarray(offset, offset + callbackIdLen))).toBe('wr_1')
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
        buffer: new Uint8Array([1]).buffer as ArrayBuffer,
        dataOffset: 0,
        dataLength: 1,
        callbackId: 'wr_1',
        resolve: () => {},
        reject: () => {},
      },
      {
        rootKey: 'r2',
        path: 'b.txt',
        position: 200,
        buffer: new Uint8Array([2, 3]).buffer as ArrayBuffer,
        dataOffset: 0,
        dataLength: 2,
        callbackId: 'wr_2',
        resolve: () => {},
        reject: () => {},
      },
    ]

    const packed = packWriteBatch(writes)
    const view = new DataView(packed)

    // Count should be 2
    expect(view.getUint32(0, true)).toBe(2)

    // Each write: rootKeyLen(1) + rootKey + pathLen(2) + path + position(8) + dataLen(4) + data + callbackIdLen(1) + callbackId
    // Write 1: 1+2 + 2+5 + 8 + 4+1 + 1+4 = 28
    // Write 2: 1+2 + 2+5 + 8 + 4+2 + 1+4 = 29
    // Total: 4 (count) + 28 + 29 = 61
    expect(packed.byteLength).toBe(61)
  })

  it('should handle large positions (> 32 bits)', () => {
    const largePosition = 0x1_0000_0001 // 4294967297

    const writes = [
      {
        rootKey: 'r',
        path: 'f',
        position: largePosition,
        buffer: new ArrayBuffer(0),
        dataOffset: 0,
        dataLength: 0,
        callbackId: 'c',
        resolve: () => {},
        reject: () => {},
      },
    ]

    const packed = packWriteBatch(writes)
    const view = new DataView(packed)
    let offset = 4 // skip count

    // Skip rootKey
    const rootKeyLen = new Uint8Array(packed)[offset]
    offset += 1 + rootKeyLen

    // Skip path
    const pathLen = view.getUint16(offset, true)
    offset += 2 + pathLen

    // Read position
    const positionLow = view.getUint32(offset, true)
    const positionHigh = view.getUint32(offset + 4, true)
    expect(positionLow + positionHigh * 0x100000000).toBe(largePosition)
  })

  it('should handle empty data', () => {
    const writes = [
      {
        rootKey: 'r',
        path: 'f',
        position: 0,
        buffer: new ArrayBuffer(0),
        dataOffset: 0,
        dataLength: 0,
        callbackId: 'c',
        resolve: () => {},
        reject: () => {},
      },
    ]

    const packed = packWriteBatch(writes)
    expect(packed.byteLength).toBeGreaterThan(0)
    expect(new DataView(packed).getUint32(0, true)).toBe(1)
  })

  it('should handle unicode paths', () => {
    const writes = [
      {
        rootKey: 'root',
        path: '文件/テスト.txt',
        position: 0,
        buffer: new ArrayBuffer(0),
        dataOffset: 0,
        dataLength: 0,
        callbackId: 'wr_1',
        resolve: () => {},
        reject: () => {},
      },
    ]

    const packed = packWriteBatch(writes)
    const bytes = new Uint8Array(packed)
    const view = new DataView(packed)
    const textDecoder = new TextDecoder()
    let offset = 4 // skip count

    // Skip rootKey
    const rootKeyLen = bytes[offset]
    offset += 1 + rootKeyLen

    // Read path
    const pathLen = view.getUint16(offset, true)
    offset += 2
    expect(textDecoder.decode(bytes.subarray(offset, offset + pathLen))).toBe('文件/テスト.txt')
  })

  it('should support offset into larger buffer (zero-copy)', () => {
    // Simulate a Uint8Array that's a view into a larger buffer
    const bigBuffer = new ArrayBuffer(100)
    const view = new Uint8Array(bigBuffer)
    view[10] = 0xaa
    view[11] = 0xbb
    view[12] = 0xcc

    const writes = [
      {
        rootKey: 'r',
        path: 'f',
        position: 0,
        buffer: bigBuffer,
        dataOffset: 10,
        dataLength: 3,
        callbackId: 'c',
        resolve: () => {},
        reject: () => {},
      },
    ]

    const packed = packWriteBatch(writes)
    const packedBytes = new Uint8Array(packed)
    const packedView = new DataView(packed)
    let offset = 4 // skip count

    // Skip rootKey
    offset += 1 + packedBytes[offset]
    // Skip path
    offset += 2 + packedView.getUint16(offset, true)
    // Skip position
    offset += 8

    // dataLen should be 3
    const dataLen = packedView.getUint32(offset, true)
    offset += 4
    expect(dataLen).toBe(3)

    // Data should be [0xaa, 0xbb, 0xcc]
    expect([...packedBytes.subarray(offset, offset + 3)]).toEqual([0xaa, 0xbb, 0xcc])
  })
})

describe('NativeAsyncWriteQueue', () => {
  let queue: NativeAsyncWriteQueue
  let mockBatchFn: ReturnType<typeof vi.fn>

  beforeEach(() => {
    queue = new NativeAsyncWriteQueue()
    mockBatchFn = vi.fn()
    vi.stubGlobal('__jstorrent_file_write_batch', mockBatchFn)
    vi.stubGlobal('__jstorrent_file_write_callbacks', {})
  })

  describe('queueAsyncWrite', () => {
    it('should add writes to pending queue without calling FFI', () => {
      queue.queueAsyncWrite('root', 'path/file.txt', 100, new ArrayBuffer(10), 0, 10)

      expect(mockBatchFn).not.toHaveBeenCalled()
      expect(queue.pendingCount).toBe(1)
      expect(queue.pendingBytes).toBe(10)
    })

    it('should queue multiple writes', () => {
      queue.queueAsyncWrite('r1', 'f1.txt', 0, new ArrayBuffer(5), 0, 5)
      queue.queueAsyncWrite('r2', 'f2.txt', 100, new ArrayBuffer(10), 0, 10)
      queue.queueAsyncWrite('r3', 'f3.txt', 200, new ArrayBuffer(15), 0, 15)

      expect(queue.pendingCount).toBe(3)
      expect(queue.pendingBytes).toBe(30)
      expect(mockBatchFn).not.toHaveBeenCalled()
    })

    it('should register callbacks in global object', () => {
      const callbacks = globalThis.__jstorrent_file_write_callbacks

      queue.queueAsyncWrite('root', 'file.txt', 0, new ArrayBuffer(5), 0, 5)

      const keys = Object.keys(callbacks)
      expect(keys.length).toBe(1)
      expect(keys[0]).toMatch(/^wr_\d+$/)
    })

    it('should return a promise that resolves on success', async () => {
      const callbacks = globalThis.__jstorrent_file_write_callbacks

      const promise = queue.queueAsyncWrite('root', 'file.txt', 0, new ArrayBuffer(100), 0, 100)

      const callbackId = Object.keys(callbacks)[0]

      // Simulate success callback (bytesWritten=100, resultCode=0)
      callbacks[callbackId](100, 0)

      const result = await promise
      expect(result).toEqual({ bytesWritten: 100 })
      expect(globalThis.__jstorrent_file_write_callbacks[callbackId]).toBeUndefined()
    })

    it('should return a promise that rejects on IO error', async () => {
      const callbacks = globalThis.__jstorrent_file_write_callbacks

      const promise = queue.queueAsyncWrite('root', 'file.txt', 0, new ArrayBuffer(100), 0, 100)

      const callbackId = Object.keys(callbacks)[0]
      callbacks[callbackId](-1, 2) // resultCode=2 (IO_ERROR)

      await expect(promise).rejects.toThrow('I/O error')
    })

    it('should return a promise that rejects on disk full', async () => {
      const callbacks = globalThis.__jstorrent_file_write_callbacks

      const promise = queue.queueAsyncWrite('root', 'file.txt', 0, new ArrayBuffer(100), 0, 100)

      const callbackId = Object.keys(callbacks)[0]
      callbacks[callbackId](-1, 4) // resultCode=4 (DISK_FULL)

      await expect(promise).rejects.toThrow('Disk full')
    })

    it('should return a promise that rejects on permission denied', async () => {
      const callbacks = globalThis.__jstorrent_file_write_callbacks

      const promise = queue.queueAsyncWrite('root', 'file.txt', 0, new ArrayBuffer(100), 0, 100)

      const callbackId = Object.keys(callbacks)[0]
      callbacks[callbackId](-1, 5) // resultCode=5 (PERMISSION_DENIED)

      await expect(promise).rejects.toThrow('Permission denied')
    })
  })

  describe('flushPending', () => {
    it('should not call FFI if no pending writes', () => {
      queue.flushPending()
      expect(mockBatchFn).not.toHaveBeenCalled()
    })

    it('should call FFI with packed data and clear pending queue', () => {
      queue.queueAsyncWrite('root', 'file.txt', 100, new ArrayBuffer(10), 0, 10)
      queue.queueAsyncWrite('root2', 'file2.txt', 200, new ArrayBuffer(20), 0, 20)

      expect(queue.pendingCount).toBe(2)

      queue.flushPending()

      expect(mockBatchFn).toHaveBeenCalledTimes(1)
      expect(mockBatchFn.mock.calls[0][0]).toBeInstanceOf(ArrayBuffer)
      expect(queue.pendingCount).toBe(0)
      expect(queue.pendingBytes).toBe(0)
    })

    it('should pack data correctly', () => {
      queue.queueAsyncWrite('root', 'test.txt', 0, new ArrayBuffer(5), 0, 5)
      queue.flushPending()

      const packed = mockBatchFn.mock.calls[0][0] as ArrayBuffer
      const view = new DataView(packed)

      // Verify count is 1
      expect(view.getUint32(0, true)).toBe(1)
    })
  })

  describe('clearPending', () => {
    it('should reject all pending promises and clear the queue', async () => {
      const promise1 = queue.queueAsyncWrite('root', 'f1.txt', 0, new ArrayBuffer(10), 0, 10)
      const promise2 = queue.queueAsyncWrite('root', 'f2.txt', 0, new ArrayBuffer(20), 0, 20)

      queue.clearPending()

      await expect(promise1).rejects.toThrow('Write queue cleared')
      await expect(promise2).rejects.toThrow('Write queue cleared')

      expect(queue.pendingCount).toBe(0)
      expect(queue.pendingBytes).toBe(0)
      expect(Object.keys(globalThis.__jstorrent_file_write_callbacks)).toHaveLength(0)
    })
  })
})
