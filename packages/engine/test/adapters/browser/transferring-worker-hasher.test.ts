import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TransferringWorkerHasher } from '../../../src/adapters/browser/transferring-worker-hasher'

describe('TransferringWorkerHasher', () => {
  // Track posted messages
  let postedMessages: Array<{
    id: number
    data?: ArrayBuffer
    returnData?: boolean
    batch?: ArrayBuffer[]
  }> = []

  // Mock Worker class that simulates transfer-back behavior
  class MockWorker {
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: ErrorEvent) => void) | null = null

    constructor(_url: URL, _options?: WorkerOptions) {}

    postMessage(
      msg: { id: number; data?: ArrayBuffer; returnData?: boolean; batch?: ArrayBuffer[] },
      _transfer?: Transferable[],
    ) {
      postedMessages.push(msg)

      // Simulate async response with both hash and data returned
      setTimeout(() => {
        if (this.onmessage && msg.data) {
          const hash = new ArrayBuffer(20)
          new Uint8Array(hash).fill(0xab)

          if (msg.returnData) {
            // Return both hash and original data (simulating transfer back)
            this.onmessage({ data: { id: msg.id, hash, data: msg.data } } as MessageEvent)
          } else {
            this.onmessage({ data: { id: msg.id, hash } } as MessageEvent)
          }
        }
      }, 0)
    }

    terminate() {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
    postedMessages = []
    vi.stubGlobal('Worker', MockWorker)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('sha1()', () => {
    it('returns both hash and data', async () => {
      const hasher = new TransferringWorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      const result = await hasher.sha1(data)

      expect(result.hash).toBeInstanceOf(Uint8Array)
      expect(result.hash.length).toBe(20)
      expect(result.data).toBeInstanceOf(Uint8Array)
      expect(result.data.length).toBe(4)
    })

    it('sends returnData flag to worker', async () => {
      const hasher = new TransferringWorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      await hasher.sha1(data)

      expect(postedMessages[0].returnData).toBe(true)
    })

    it('returned data contains correct content', async () => {
      const hasher = new TransferringWorkerHasher()
      const data = new Uint8Array([0x11, 0x22, 0x33, 0x44])

      const result = await hasher.sha1(data)

      // The returned data should have the same content as the original
      expect(Array.from(result.data)).toEqual([0x11, 0x22, 0x33, 0x44])
    })

    it('returned data is usable for subsequent operations', async () => {
      const hasher = new TransferringWorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      const result = await hasher.sha1(data)

      // Should be able to read from the returned data
      expect(result.data[0]).toBe(1)
      expect(result.data[3]).toBe(4)

      // Should be able to create a copy
      const copy = result.data.slice()
      expect(copy.length).toBe(4)

      // Should be able to access the buffer
      expect(result.data.buffer.byteLength).toBe(4)
    })

    it('transfers buffer directly when data is clean', async () => {
      const hasher = new TransferringWorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])
      const originalBuffer = data.buffer

      await hasher.sha1(data)

      // Clean buffer (byteOffset=0, byteLength=buffer.byteLength) should be transferred directly
      expect(postedMessages[0].data).toBe(originalBuffer)
    })

    it('slices buffer when data is a view into larger buffer', async () => {
      const hasher = new TransferringWorkerHasher()
      const largeBuffer = new ArrayBuffer(100)
      const view = new Uint8Array(largeBuffer, 10, 20) // offset=10, length=20
      view.fill(0x42)

      await hasher.sha1(view)

      // Should slice to get only the view's portion
      expect(postedMessages[0].data!.byteLength).toBe(20)
      expect(new Uint8Array(postedMessages[0].data!)[0]).toBe(0x42)
      // Should NOT be the original large buffer
      expect(postedMessages[0].data).not.toBe(largeBuffer)
    })
  })

  describe('error handling', () => {
    it('throws when Worker API unavailable', async () => {
      vi.stubGlobal('Worker', undefined)

      const hasher = new TransferringWorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      await expect(hasher.sha1(data)).rejects.toThrow(
        'TransferringWorkerHasher requires Web Worker support',
      )
    })

    it('throws when worker does not return data', async () => {
      // Mock worker that doesn't return data
      class BadWorker {
        onmessage: ((e: MessageEvent) => void) | null = null
        onerror: ((e: ErrorEvent) => void) | null = null

        constructor(_url: URL, _options?: WorkerOptions) {}

        postMessage(msg: { id: number; data?: ArrayBuffer }, _transfer?: Transferable[]) {
          setTimeout(() => {
            if (this.onmessage) {
              // Only return hash, no data
              const hash = new ArrayBuffer(20)
              this.onmessage({ data: { id: msg.id, hash } } as MessageEvent)
            }
          }, 0)
        }

        terminate() {}
      }

      vi.stubGlobal('Worker', BadWorker)

      const hasher = new TransferringWorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      await expect(hasher.sha1(data)).rejects.toThrow('Worker did not return data')
    })

    it('propagates worker errors', async () => {
      class ErrorWorker {
        onmessage: ((e: MessageEvent) => void) | null = null
        onerror: ((e: ErrorEvent) => void) | null = null

        constructor(_url: URL, _options?: WorkerOptions) {}

        postMessage(msg: { id: number }, _transfer?: Transferable[]) {
          setTimeout(() => {
            if (this.onmessage) {
              this.onmessage({
                data: { id: msg.id, error: 'Hash computation failed' },
              } as MessageEvent)
            }
          }, 0)
        }

        terminate() {}
      }

      vi.stubGlobal('Worker', ErrorWorker)

      const hasher = new TransferringWorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      await expect(hasher.sha1(data)).rejects.toThrow('Hash computation failed')
    })
  })

  describe('isAvailable', () => {
    it('returns true when Worker is available', () => {
      const hasher = new TransferringWorkerHasher()
      expect(hasher.isAvailable).toBe(true)
    })

    it('returns false when Worker is unavailable', () => {
      vi.stubGlobal('Worker', undefined)
      const hasher = new TransferringWorkerHasher()
      expect(hasher.isAvailable).toBe(false)
    })
  })

  describe('destroy()', () => {
    it('terminates worker and clears pending requests', async () => {
      const hasher = new TransferringWorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      // Start a hash to initialize the worker
      const promise = hasher.sha1(data)
      await promise

      // Should not throw
      hasher.destroy()
    })
  })
})
