import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { WorkerHasher } from '../../../src/adapters/browser/worker-hasher'

describe('WorkerHasher', () => {
  // Mock hash results
  const mockHashResult = new ArrayBuffer(20)
  new Uint8Array(mockHashResult).fill(0xaa)

  // Track posted messages and simulate worker responses
  let postedMessages: Array<{ id: number; data?: ArrayBuffer; batch?: ArrayBuffer[] }> = []
  let _mockWorkerOnMessage: ((e: MessageEvent) => void) | null = null
  let _mockWorkerOnError: ((e: ErrorEvent) => void) | null = null

  // Mock Worker class
  class MockWorker {
    onmessage: ((e: MessageEvent) => void) | null = null
    onerror: ((e: ErrorEvent) => void) | null = null

    constructor(_url: URL, _options?: WorkerOptions) {
      // Store references for test access
      setTimeout(() => {
        _mockWorkerOnMessage = this.onmessage
        _mockWorkerOnError = this.onerror
      }, 0)
    }

    postMessage(
      msg: { id: number; data?: ArrayBuffer; batch?: ArrayBuffer[] },
      _transfer?: Transferable[],
    ) {
      postedMessages.push(msg)

      // Simulate async response
      setTimeout(() => {
        if (this.onmessage) {
          if (msg.batch) {
            const hashes = msg.batch.map(() => {
              const hash = new ArrayBuffer(20)
              new Uint8Array(hash).fill(0xaa)
              return hash
            })
            this.onmessage({ data: { id: msg.id, hashes } } as MessageEvent)
          } else {
            const hash = new ArrayBuffer(20)
            new Uint8Array(hash).fill(0xaa)
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
    _mockWorkerOnMessage = null
    _mockWorkerOnError = null

    // Mock Worker
    vi.stubGlobal('Worker', MockWorker)

    // Mock crypto.subtle for fallback tests
    vi.stubGlobal('crypto', {
      subtle: {
        digest: vi.fn().mockResolvedValue(mockHashResult),
      },
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  describe('sha1()', () => {
    it('hashes via worker', async () => {
      const hasher = new WorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      const result = await hasher.sha1(data)

      expect(result).toBeInstanceOf(Uint8Array)
      expect(result.length).toBe(20)
      expect(postedMessages.length).toBe(1)
      expect(postedMessages[0].data).toBeDefined()
    })

    it('falls back to SubtleCrypto when Worker unavailable', async () => {
      vi.stubGlobal('Worker', undefined)

      const hasher = new WorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      const result = await hasher.sha1(data)

      expect(result).toBeInstanceOf(Uint8Array)
      expect(result.length).toBe(20)
      expect(crypto.subtle.digest).toHaveBeenCalled()
    })

    it('throws when no hashing implementation available', async () => {
      vi.stubGlobal('Worker', undefined)
      vi.stubGlobal('crypto', undefined)

      const hasher = new WorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])

      await expect(hasher.sha1(data)).rejects.toThrow('No hashing implementation available')
    })
  })

  describe('sha1Batch()', () => {
    it('hashes batch via worker', async () => {
      const hasher = new WorkerHasher()
      const inputs = [new Uint8Array([1, 2]), new Uint8Array([3, 4])]

      const results = await hasher.sha1Batch(inputs)

      expect(results).toHaveLength(2)
      expect(results[0]).toBeInstanceOf(Uint8Array)
      expect(results[1]).toBeInstanceOf(Uint8Array)
      expect(postedMessages.length).toBe(1)
      expect(postedMessages[0].batch).toBeDefined()
      expect(postedMessages[0].batch).toHaveLength(2)
    })

    it('handles empty batch', async () => {
      const hasher = new WorkerHasher()

      const results = await hasher.sha1Batch([])

      expect(results).toEqual([])
      expect(postedMessages.length).toBe(0)
    })

    it('handles single-item batch as sha1 call', async () => {
      const hasher = new WorkerHasher()
      const inputs = [new Uint8Array([1, 2])]

      const results = await hasher.sha1Batch(inputs)

      expect(results).toHaveLength(1)
      // Single item batch goes through sha1(), not sha1Batch()
      expect(postedMessages.length).toBe(1)
      expect(postedMessages[0].data).toBeDefined()
      expect(postedMessages[0].batch).toBeUndefined()
    })

    it('falls back to SubtleCrypto for batch when Worker unavailable', async () => {
      vi.stubGlobal('Worker', undefined)

      const hasher = new WorkerHasher()
      const inputs = [new Uint8Array([1, 2]), new Uint8Array([3, 4])]

      const results = await hasher.sha1Batch(inputs)

      expect(results).toHaveLength(2)
      expect(crypto.subtle.digest).toHaveBeenCalledTimes(2)
    })
  })

  describe('buffer handling', () => {
    it('transfers buffer by default (zero-copy)', async () => {
      const hasher = new WorkerHasher()
      const data = new Uint8Array([1, 2, 3, 4])
      const originalBuffer = data.buffer

      await hasher.sha1(data)

      // The buffer should have been transferred (same reference passed to postMessage)
      expect(postedMessages[0].data).toBe(originalBuffer)
    })

    it('copies buffer when copy option is true', async () => {
      const hasher = new WorkerHasher({ copy: true })
      const data = new Uint8Array([1, 2, 3, 4])
      const originalBuffer = data.buffer

      await hasher.sha1(data)

      // The buffer should be a copy (different reference)
      expect(postedMessages[0].data).not.toBe(originalBuffer)
      // But same content
      expect(new Uint8Array(postedMessages[0].data!)).toEqual(data)
    })

    it('slices buffer when data is a view into larger buffer', async () => {
      const hasher = new WorkerHasher()
      const largeBuffer = new ArrayBuffer(100)
      const view = new Uint8Array(largeBuffer, 10, 20) // offset=10, length=20
      view.fill(0x42)

      await hasher.sha1(view)

      // Should slice to get only the view's portion
      expect(postedMessages[0].data!.byteLength).toBe(20)
      expect(new Uint8Array(postedMessages[0].data!)[0]).toBe(0x42)
    })
  })

  describe('error handling', () => {
    it('rejects pending requests on worker error', async () => {
      // Create a worker that will error
      class ErrorWorker {
        onmessage: ((e: MessageEvent) => void) | null = null
        onerror: ((e: ErrorEvent) => void) | null = null

        constructor(_url: URL, _options?: WorkerOptions) {}

        postMessage() {
          setTimeout(() => {
            if (this.onerror) {
              this.onerror({ message: 'Worker failed' } as ErrorEvent)
            }
          }, 0)
        }

        terminate() {}
      }
      vi.stubGlobal('Worker', ErrorWorker)

      const hasher = new WorkerHasher()
      const data = new Uint8Array([1, 2, 3])

      await expect(hasher.sha1(data)).rejects.toThrow('Worker crashed')
    })

    it('falls back to SubtleCrypto after worker failure', async () => {
      let firstCall = true
      class FailOnceWorker {
        onmessage: ((e: MessageEvent) => void) | null = null
        onerror: ((e: ErrorEvent) => void) | null = null

        constructor(_url: URL, _options?: WorkerOptions) {}

        postMessage(msg: { id: number }) {
          if (firstCall) {
            firstCall = false
            setTimeout(() => {
              if (this.onerror) {
                this.onerror({ message: 'First call fails' } as ErrorEvent)
              }
            }, 0)
          } else {
            setTimeout(() => {
              if (this.onmessage) {
                const hash = new ArrayBuffer(20)
                this.onmessage({ data: { id: msg.id, hash } } as MessageEvent)
              }
            }, 0)
          }
        }

        terminate() {}
      }
      vi.stubGlobal('Worker', FailOnceWorker)

      const hasher = new WorkerHasher()

      // First call fails
      await expect(hasher.sha1(new Uint8Array([1]))).rejects.toThrow('Worker crashed')

      // Second call uses fallback
      const result = await hasher.sha1(new Uint8Array([2]))
      expect(result).toBeInstanceOf(Uint8Array)
      expect(crypto.subtle.digest).toHaveBeenCalled()
    })

    it('handles worker throwing during creation', async () => {
      vi.stubGlobal(
        'Worker',
        class {
          constructor() {
            throw new Error('Worker creation failed')
          }
        },
      )

      const hasher = new WorkerHasher()
      const data = new Uint8Array([1, 2, 3])

      // Should fall back to SubtleCrypto
      const result = await hasher.sha1(data)
      expect(result).toBeInstanceOf(Uint8Array)
      expect(crypto.subtle.digest).toHaveBeenCalled()
    })
  })

  describe('destroy()', () => {
    it('terminates worker and clears pending requests', async () => {
      const terminateFn = vi.fn()
      class TrackingWorker extends MockWorker {
        terminate() {
          terminateFn()
        }
      }
      vi.stubGlobal('Worker', TrackingWorker)

      const hasher = new WorkerHasher()
      await hasher.sha1(new Uint8Array([1])) // Init worker

      hasher.destroy()

      expect(terminateFn).toHaveBeenCalled()
    })
  })

  describe('lazy initialization', () => {
    it('does not create worker until first sha1 call', () => {
      const constructorFn = vi.fn()
      class TrackingWorker extends MockWorker {
        constructor(url: URL, options?: WorkerOptions) {
          super(url, options)
          constructorFn()
        }
      }
      vi.stubGlobal('Worker', TrackingWorker)

      // Constructor should not create worker
      new WorkerHasher()
      expect(constructorFn).not.toHaveBeenCalled()
    })

    it('creates worker on first sha1 call', async () => {
      const constructorFn = vi.fn()
      class TrackingWorker extends MockWorker {
        constructor(url: URL, options?: WorkerOptions) {
          super(url, options)
          constructorFn()
        }
      }
      vi.stubGlobal('Worker', TrackingWorker)

      const hasher = new WorkerHasher()
      await hasher.sha1(new Uint8Array([1]))

      expect(constructorFn).toHaveBeenCalledTimes(1)
    })

    it('reuses worker for subsequent calls', async () => {
      const constructorFn = vi.fn()
      class TrackingWorker extends MockWorker {
        constructor(url: URL, options?: WorkerOptions) {
          super(url, options)
          constructorFn()
        }
      }
      vi.stubGlobal('Worker', TrackingWorker)

      const hasher = new WorkerHasher()
      await hasher.sha1(new Uint8Array([1]))
      await hasher.sha1(new Uint8Array([2]))
      await hasher.sha1(new Uint8Array([3]))

      expect(constructorFn).toHaveBeenCalledTimes(1)
    })
  })
})
