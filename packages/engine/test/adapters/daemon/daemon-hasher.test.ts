/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { DaemonHasher } from '../../../src/adapters/daemon/daemon-hasher'

describe('DaemonHasher', () => {
  const mockConnection = {
    requestBinary: vi.fn(),
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sha1() sends POST to /hash/sha1 and returns raw bytes', async () => {
    const testData = new Uint8Array([1, 2, 3, 4])
    const mockHash = new Uint8Array(20).fill(0xab) // 20 bytes

    mockConnection.requestBinary.mockResolvedValue(mockHash)

    const hasher = new DaemonHasher(mockConnection as any)
    const result = await hasher.sha1(testData)

    expect(mockConnection.requestBinary).toHaveBeenCalledWith(
      'POST',
      '/hash/sha1',
      undefined,
      testData,
      undefined,
    )
    expect(result).toBeInstanceOf(Uint8Array)
    expect(result.length).toBe(20)
    expect(result).toEqual(mockHash)
  })

  it('sha1() returns correct hash for empty data', async () => {
    const testData = new Uint8Array(0)
    // SHA1 of empty string: da39a3ee5e6b4b0d3255bfef95601890afd80709
    const mockHash = new Uint8Array([
      0xda, 0x39, 0xa3, 0xee, 0x5e, 0x6b, 0x4b, 0x0d, 0x32, 0x55, 0xbf, 0xef, 0x95, 0x60, 0x18,
      0x90, 0xaf, 0xd8, 0x07, 0x09,
    ])

    mockConnection.requestBinary.mockResolvedValue(mockHash)

    const hasher = new DaemonHasher(mockConnection as any)
    const result = await hasher.sha1(testData)

    expect(mockConnection.requestBinary).toHaveBeenCalledWith(
      'POST',
      '/hash/sha1',
      undefined,
      testData,
      undefined,
    )
    expect(result).toEqual(mockHash)
  })

  it('sha1() propagates errors from connection', async () => {
    const testData = new Uint8Array([1, 2, 3, 4])
    const error = new Error('Connection failed')

    mockConnection.requestBinary.mockRejectedValue(error)

    const hasher = new DaemonHasher(mockConnection as any)

    await expect(hasher.sha1(testData)).rejects.toThrow('Connection failed')
  })

  it('sha1() passes reason as X-Reason header', async () => {
    const testData = new Uint8Array([1, 2, 3, 4])
    const mockHash = new Uint8Array(20).fill(0xab)

    mockConnection.requestBinary.mockResolvedValue(mockHash)

    const hasher = new DaemonHasher(mockConnection as any)
    await hasher.sha1(testData, 'piece-verify')

    expect(mockConnection.requestBinary).toHaveBeenCalledWith(
      'POST',
      '/hash/sha1',
      undefined,
      testData,
      { 'X-SHA-Reason': 'piece-verify' },
    )
  })

  describe('sha1Batch()', () => {
    it('returns empty array for empty input', async () => {
      const hasher = new DaemonHasher(mockConnection as any)
      const result = await hasher.sha1Batch([])

      expect(result).toEqual([])
      expect(mockConnection.requestBinary).not.toHaveBeenCalled()
    })

    it('falls back to sha1() for single input', async () => {
      const testData = new Uint8Array([1, 2, 3, 4])
      const mockHash = new Uint8Array(20).fill(0xab)

      mockConnection.requestBinary.mockResolvedValue(mockHash)

      const hasher = new DaemonHasher(mockConnection as any)
      const result = await hasher.sha1Batch([testData])

      // Should call single sha1 endpoint, not batch
      expect(mockConnection.requestBinary).toHaveBeenCalledWith(
        'POST',
        '/hash/sha1',
        undefined,
        testData,
        undefined,
      )
      expect(result).toHaveLength(1)
      expect(result[0]).toEqual(mockHash)
    })

    it('encodes batch request correctly', async () => {
      const input1 = new Uint8Array([1, 2, 3])
      const input2 = new Uint8Array([4, 5])
      const hash1 = new Uint8Array(20).fill(0xaa)
      const hash2 = new Uint8Array(20).fill(0xbb)

      // Mock response: concatenated hashes
      const mockResponse = new Uint8Array(40)
      mockResponse.set(hash1, 0)
      mockResponse.set(hash2, 20)

      mockConnection.requestBinary.mockResolvedValue(mockResponse)

      const hasher = new DaemonHasher(mockConnection as any)
      const result = await hasher.sha1Batch([input1, input2])

      // Verify batch endpoint was called
      expect(mockConnection.requestBinary).toHaveBeenCalledWith(
        'POST',
        '/hash/sha1/batch',
        undefined,
        expect.any(Uint8Array),
        undefined,
      )

      // Verify encoding format: count (4) + len1 (4) + data1 (3) + len2 (4) + data2 (2) = 17 bytes
      const sentData = mockConnection.requestBinary.mock.calls[0][3] as Uint8Array
      expect(sentData.length).toBe(17)

      // Check count (little-endian u32)
      const view = new DataView(sentData.buffer, sentData.byteOffset)
      expect(view.getUint32(0, true)).toBe(2) // count = 2

      // Check first item: len=3, data=[1,2,3]
      expect(view.getUint32(4, true)).toBe(3)
      expect(sentData.slice(8, 11)).toEqual(input1)

      // Check second item: len=2, data=[4,5]
      expect(view.getUint32(11, true)).toBe(2)
      expect(sentData.slice(15, 17)).toEqual(input2)

      // Verify response parsing
      expect(result).toHaveLength(2)
      expect(result[0]).toEqual(hash1)
      expect(result[1]).toEqual(hash2)
    })

    it('propagates errors from connection', async () => {
      const error = new Error('Batch failed')
      mockConnection.requestBinary.mockRejectedValue(error)

      const hasher = new DaemonHasher(mockConnection as any)
      await expect(hasher.sha1Batch([new Uint8Array([1]), new Uint8Array([2])])).rejects.toThrow(
        'Batch failed',
      )
    })

    it('passes reason as X-Reason header', async () => {
      const input1 = new Uint8Array([1, 2, 3])
      const input2 = new Uint8Array([4, 5])
      const mockResponse = new Uint8Array(40).fill(0xcc)

      mockConnection.requestBinary.mockResolvedValue(mockResponse)

      const hasher = new DaemonHasher(mockConnection as any)
      await hasher.sha1Batch([input1, input2], 'mse-init')

      expect(mockConnection.requestBinary).toHaveBeenCalledWith(
        'POST',
        '/hash/sha1/batch',
        undefined,
        expect.any(Uint8Array),
        { 'X-SHA-Reason': 'mse-init' },
      )
    })
  })
})
