import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { RoutingHasher } from '../../../src/adapters/browser/routing-hasher'
import { TransferringWorkerHasher } from '../../../src/adapters/browser/transferring-worker-hasher'
import type { IHasher, Sha1Reason } from '../../../src/interfaces/hasher'

describe('RoutingHasher', () => {
  const mockDelegate: IHasher & { sha1Batch: ReturnType<typeof vi.fn> } = {
    sha1: vi.fn(),
    sha1Batch: vi.fn(),
  }

  // Mock SubtleCrypto hash result
  const subtleHashResult = new Uint8Array(20).fill(0xaa)
  const delegateHashResult = new Uint8Array(20).fill(0xbb)

  // Mock digest function
  const mockDigest = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockDelegate.sha1.mockResolvedValue(delegateHashResult)
    mockDelegate.sha1Batch.mockResolvedValue([delegateHashResult])

    // Mock crypto.subtle.digest using stubGlobal
    mockDigest.mockResolvedValue(subtleHashResult.buffer.slice(0))
    vi.stubGlobal('crypto', {
      subtle: {
        digest: mockDigest,
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('sha1()', () => {
    it('routes small payloads to SubtleCrypto', async () => {
      const hasher = new RoutingHasher(mockDelegate)
      const smallData = new Uint8Array([1, 2, 3, 4])

      const result = await hasher.sha1(smallData)

      expect(result).toEqual(subtleHashResult)
      expect(mockDelegate.sha1).not.toHaveBeenCalled()
    })

    it('routes large payloads to delegate', async () => {
      const hasher = new RoutingHasher(mockDelegate)
      const largeData = new Uint8Array(100 * 1024) // 100KB

      const result = await hasher.sha1(largeData)

      expect(result).toEqual(delegateHashResult)
      expect(mockDelegate.sha1).toHaveBeenCalledWith(largeData, undefined)
    })

    it('routes MSE reasons to SubtleCrypto regardless of size', async () => {
      const hasher = new RoutingHasher(mockDelegate)
      const data = new Uint8Array([1, 2, 3])

      const mseReasons: Sha1Reason[] = [
        'mse-init',
        'mse-resp',
        'mse-resp-req1',
        'mse-resp-req2-lookup',
        'mse-resp-req3',
        'mse-resp-check',
        'mse-resp-keys',
        'mse-req2',
      ]

      for (const reason of mseReasons) {
        vi.clearAllMocks()
        const result = await hasher.sha1(data, reason)
        expect(result).toEqual(subtleHashResult)
        expect(mockDelegate.sha1).not.toHaveBeenCalled()
      }
    })

    it('routes metadata reasons to SubtleCrypto', async () => {
      const hasher = new RoutingHasher(mockDelegate)
      const data = new Uint8Array([1, 2, 3])

      const metadataReasons: Sha1Reason[] = ['info-hash', 'metadata-verify']

      for (const reason of metadataReasons) {
        vi.clearAllMocks()
        const result = await hasher.sha1(data, reason)
        expect(result).toEqual(subtleHashResult)
        expect(mockDelegate.sha1).not.toHaveBeenCalled()
      }
    })

    it('routes piece operations to delegate', async () => {
      const hasher = new RoutingHasher(mockDelegate)
      const data = new Uint8Array(100 * 1024) // 100KB piece

      const pieceReasons: Sha1Reason[] = ['piece-verify', 'piece-upload-verify', 'torrent-create']

      for (const reason of pieceReasons) {
        vi.clearAllMocks()
        const result = await hasher.sha1(data, reason)
        expect(result).toEqual(delegateHashResult)
        expect(mockDelegate.sha1).toHaveBeenCalledWith(data, reason)
      }
    })

    it('uses delegate when SubtleCrypto is unavailable', async () => {
      // Remove SubtleCrypto by stubbing with undefined
      vi.stubGlobal('crypto', undefined)

      const hasher = new RoutingHasher(mockDelegate)
      const smallData = new Uint8Array([1, 2, 3, 4])

      const result = await hasher.sha1(smallData, 'mse-init')

      expect(result).toEqual(delegateHashResult)
      expect(mockDelegate.sha1).toHaveBeenCalledWith(smallData, 'mse-init')
    })

    it('uses SubtleCrypto for small unknown-reason payloads', async () => {
      const hasher = new RoutingHasher(mockDelegate)
      const smallData = new Uint8Array(1000) // 1KB

      const result = await hasher.sha1(smallData)

      expect(result).toEqual(subtleHashResult)
      expect(mockDelegate.sha1).not.toHaveBeenCalled()
    })

    it('uses delegate for large unknown-reason payloads', async () => {
      const hasher = new RoutingHasher(mockDelegate)
      const largeData = new Uint8Array(100 * 1024) // 100KB, over 64KB threshold

      const result = await hasher.sha1(largeData)

      expect(result).toEqual(delegateHashResult)
      expect(mockDelegate.sha1).toHaveBeenCalledWith(largeData, undefined)
    })
  })

  describe('sha1Batch()', () => {
    it('routes MSE batch to SubtleCrypto', async () => {
      const hasher = new RoutingHasher(mockDelegate)
      const inputs = [new Uint8Array([1, 2]), new Uint8Array([3, 4])]

      const result = await hasher.sha1Batch(inputs, 'mse-init')

      expect(result).toHaveLength(2)
      expect(result[0]).toEqual(subtleHashResult)
      expect(result[1]).toEqual(subtleHashResult)
      expect(mockDelegate.sha1Batch).not.toHaveBeenCalled()
      expect(mockDelegate.sha1).not.toHaveBeenCalled()
    })

    it('routes non-MSE batch to delegate sha1Batch', async () => {
      const batchResult = [new Uint8Array(20).fill(0xcc), new Uint8Array(20).fill(0xdd)]
      mockDelegate.sha1Batch.mockResolvedValue(batchResult)

      const hasher = new RoutingHasher(mockDelegate)
      const inputs = [new Uint8Array(100 * 1024), new Uint8Array(100 * 1024)]

      const result = await hasher.sha1Batch(inputs, 'piece-verify')

      expect(result).toEqual(batchResult)
      expect(mockDelegate.sha1Batch).toHaveBeenCalledWith(inputs, 'piece-verify')
    })

    it('falls back to individual sha1 calls when delegate has no sha1Batch', async () => {
      const delegateWithoutBatch: IHasher = {
        sha1: vi.fn().mockResolvedValue(delegateHashResult),
      }

      const hasher = new RoutingHasher(delegateWithoutBatch)
      const inputs = [new Uint8Array(100 * 1024), new Uint8Array(100 * 1024)]

      const result = await hasher.sha1Batch(inputs, 'piece-verify')

      expect(result).toHaveLength(2)
      expect(delegateWithoutBatch.sha1).toHaveBeenCalledTimes(2)
    })

    it('uses delegate when SubtleCrypto unavailable for MSE batch', async () => {
      vi.stubGlobal('crypto', undefined)
      const batchResult = [new Uint8Array(20).fill(0xee)]
      mockDelegate.sha1Batch.mockResolvedValue(batchResult)

      const hasher = new RoutingHasher(mockDelegate)
      const inputs = [new Uint8Array([1, 2])]

      const result = await hasher.sha1Batch(inputs, 'mse-init')

      expect(result).toEqual(batchResult)
      expect(mockDelegate.sha1Batch).toHaveBeenCalledWith(inputs, 'mse-init')
    })
  })

  describe('sha1Transfer()', () => {
    it('uses transferring hasher when provided', async () => {
      const mockTransferringHasher = {
        sha1: vi.fn().mockResolvedValue({
          hash: new Uint8Array(20).fill(0xcc),
          data: new Uint8Array([1, 2, 3, 4]),
        }),
        isAvailable: true,
        destroy: vi.fn(),
      } as unknown as TransferringWorkerHasher

      const hasher = new RoutingHasher(mockDelegate, mockTransferringHasher)
      const data = new Uint8Array([1, 2, 3, 4])

      const result = await hasher.sha1Transfer(data, 'piece-verify')

      expect(result.hash).toEqual(new Uint8Array(20).fill(0xcc))
      expect(result.data).toEqual(new Uint8Array([1, 2, 3, 4]))
      expect(mockTransferringHasher.sha1).toHaveBeenCalledWith(data, 'piece-verify')
    })

    it('falls back to copying when no transferring hasher provided', async () => {
      const hasher = new RoutingHasher(mockDelegate) // No transferring hasher

      const data = new Uint8Array([1, 2, 3, 4])

      const result = await hasher.sha1Transfer(data, 'piece-verify')

      // Should have used SubtleCrypto for small data (fallback path copies first)
      expect(result.hash).toEqual(subtleHashResult)
      expect(result.data).toEqual(data)
      // Data should be a copy, not the same reference
      expect(result.data).not.toBe(data)
    })

    it('returned data is usable after call (fallback path)', async () => {
      const hasher = new RoutingHasher(mockDelegate)
      const data = new Uint8Array([0x11, 0x22, 0x33, 0x44])

      const result = await hasher.sha1Transfer(data)

      // Returned data should be valid and usable
      expect(result.data[0]).toBe(0x11)
      expect(result.data[3]).toBe(0x44)
      expect(result.data.buffer.byteLength).toBe(4)

      // Should be able to copy it
      const copy = result.data.slice()
      expect(copy).toEqual(data)
    })

    it('uses delegate for large payloads in fallback path', async () => {
      const hasher = new RoutingHasher(mockDelegate) // No transferring hasher
      const largeData = new Uint8Array(100 * 1024) // 100KB
      largeData.fill(0x42)

      const result = await hasher.sha1Transfer(largeData, 'piece-verify')

      // Should use delegate for large payloads
      expect(result.hash).toEqual(delegateHashResult)
      // Data should be a copy
      expect(result.data).not.toBe(largeData)
      expect(result.data[0]).toBe(0x42)
    })
  })
})
