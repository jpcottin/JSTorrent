import { IHasher, Sha1Reason } from '../../interfaces/hasher'
import { SubtleCryptoHasher } from './subtle-crypto-hasher'

interface PendingRequest {
  resolve: (result: Uint8Array | Uint8Array[]) => void
  reject: (error: Error) => void
  isBatch: boolean
}

/**
 * Hasher that offloads SHA1 to a dedicated Web Worker.
 *
 * Benefits:
 * - Main thread stays responsive during large hashes
 * - Parallelization for batch operations
 *
 * This hasher COPIES data before sending to the worker, so the original
 * buffer remains valid after sha1() returns. For zero-copy transfer
 * (where the caller must use returned data), use TransferringWorkerHasher.
 *
 * Falls back to SubtleCryptoHasher if Worker API unavailable.
 */
export class WorkerHasher implements IHasher {
  private worker: Worker | null = null
  private workerFailed = false
  private pending = new Map<number, PendingRequest>()
  private nextId = 0
  private fallback: SubtleCryptoHasher | null = null

  constructor() {
    if (typeof crypto !== 'undefined' && crypto.subtle) {
      this.fallback = new SubtleCryptoHasher()
    }
  }

  /**
   * Lazily initialize the worker.
   * Returns true if worker is available, false if should use fallback.
   */
  private initWorker(): boolean {
    if (this.workerFailed) return false
    if (this.worker) return true
    if (typeof Worker === 'undefined') {
      this.workerFailed = true
      return false
    }

    try {
      // Standard API - Vite compiles the TS file automatically
      this.worker = new Worker(new URL('./hash-worker.ts', import.meta.url), { type: 'module' })

      this.worker.onmessage = (e: MessageEvent) => {
        const { id, hash, hashes, error } = e.data
        const req = this.pending.get(id)
        if (!req) return
        this.pending.delete(id)

        if (error) {
          req.reject(new Error(error))
        } else if (req.isBatch) {
          req.resolve((hashes as ArrayBuffer[]).map((h) => new Uint8Array(h)))
        } else {
          req.resolve(new Uint8Array(hash as ArrayBuffer))
        }
      }

      this.worker.onerror = (e: ErrorEvent) => {
        console.error('[WorkerHasher] Worker error:', e.message)
        this.workerFailed = true
        for (const [, req] of this.pending) {
          req.reject(new Error('Worker crashed'))
        }
        this.pending.clear()
        this.worker?.terminate()
        this.worker = null
      }

      return true
    } catch (err) {
      console.error('[WorkerHasher] Failed to create worker:', err)
      this.workerFailed = true
      return false
    }
  }

  async sha1(data: Uint8Array, _reason?: Sha1Reason): Promise<Uint8Array> {
    if (this.initWorker() && this.worker) {
      return this.hashViaWorker(data)
    }
    if (this.fallback) {
      return this.fallback.sha1(data, _reason)
    }
    throw new Error('No hashing implementation available')
  }

  async sha1Batch(inputs: Uint8Array[], _reason?: Sha1Reason): Promise<Uint8Array[]> {
    if (inputs.length === 0) return []
    if (inputs.length === 1) return [await this.sha1(inputs[0], _reason)]

    if (this.initWorker() && this.worker) {
      return this.batchViaWorker(inputs)
    }
    if (this.fallback) {
      return Promise.all(inputs.map((i) => this.fallback!.sha1(i, _reason)))
    }
    throw new Error('No hashing implementation available')
  }

  /**
   * Copy buffer for transfer to worker.
   * Always copies so the original buffer remains valid after sha1() returns.
   */
  private copyBufferForTransfer(data: Uint8Array): ArrayBuffer {
    return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  }

  private hashViaWorker(data: Uint8Array): Promise<Uint8Array> {
    const id = this.nextId++
    const buffer = this.copyBufferForTransfer(data)
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (r: Uint8Array | Uint8Array[]) => void,
        reject,
        isBatch: false,
      })
      this.worker!.postMessage({ id, data: buffer }, [buffer])
    })
  }

  private batchViaWorker(inputs: Uint8Array[]): Promise<Uint8Array[]> {
    const id = this.nextId++
    const buffers = inputs.map((data) => this.copyBufferForTransfer(data))
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (r: Uint8Array | Uint8Array[]) => void,
        reject,
        isBatch: true,
      })
      this.worker!.postMessage({ id, batch: buffers }, buffers)
    })
  }

  /**
   * Clean up worker resources.
   */
  destroy(): void {
    this.worker?.terminate()
    this.worker = null
    this.pending.clear()
  }
}
