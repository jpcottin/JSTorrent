import { Sha1Reason } from '../../interfaces/hasher'

/**
 * Result from TransferringWorkerHasher - includes both hash and data.
 * The data is the original buffer transferred back from the worker.
 */
export interface TransferringHashResult {
  hash: Uint8Array
  data: Uint8Array
}

interface PendingRequest {
  resolve: (result: TransferringHashResult) => void
  reject: (error: Error) => void
}

/**
 * Worker hasher that transfers buffers to/from a Web Worker.
 *
 * Unlike WorkerHasher (which copies data), this class:
 * - Transfers the buffer TO the worker (zero-copy, original becomes invalid)
 * - Worker hashes the data
 * - Transfers the buffer BACK from the worker (zero-copy)
 * - Returns both hash and data
 *
 * The caller MUST use the returned `data` for subsequent operations,
 * as the original buffer passed in becomes invalid after the call.
 *
 * Use this for large payloads (piece verification) where zero-copy
 * transfer provides performance benefits.
 */
export class TransferringWorkerHasher {
  private worker: Worker | null = null
  private workerFailed = false
  private pending = new Map<number, PendingRequest>()
  private nextId = 0

  /**
   * Lazily initialize the worker.
   * Returns true if worker is available, false if unavailable.
   */
  private initWorker(): boolean {
    if (this.workerFailed) return false
    if (this.worker) return true
    if (typeof Worker === 'undefined') {
      this.workerFailed = true
      return false
    }

    try {
      // Use the same hash-worker.ts as WorkerHasher
      this.worker = new Worker(new URL('./hash-worker.ts', import.meta.url), { type: 'module' })

      this.worker.onmessage = (e: MessageEvent) => {
        const { id, hash, data, error } = e.data
        const req = this.pending.get(id)
        if (!req) return
        this.pending.delete(id)

        if (error) {
          req.reject(new Error(error))
        } else if (hash && data) {
          req.resolve({
            hash: new Uint8Array(hash as ArrayBuffer),
            data: new Uint8Array(data as ArrayBuffer),
          })
        } else {
          req.reject(new Error('Worker did not return data'))
        }
      }

      this.worker.onerror = (e: ErrorEvent) => {
        console.error('[TransferringWorkerHasher] Worker error:', e.message)
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
      console.error('[TransferringWorkerHasher] Failed to create worker:', err)
      this.workerFailed = true
      return false
    }
  }

  /**
   * Compute SHA1 hash, transferring the buffer to the worker and back.
   *
   * IMPORTANT: After this call, the original `data` buffer is INVALID.
   * You MUST use the returned `result.data` for any subsequent operations.
   *
   * @param data - Data to hash (will be consumed, original becomes invalid)
   * @param _reason - Optional reason (unused, for API compatibility)
   * @returns Object with hash and the data buffer (transferred back)
   * @throws Error if worker is unavailable
   */
  async sha1(data: Uint8Array, _reason?: Sha1Reason): Promise<TransferringHashResult> {
    if (!this.initWorker() || !this.worker) {
      throw new Error('TransferringWorkerHasher requires Web Worker support')
    }

    const id = this.nextId++

    // Get the buffer to transfer
    // If data is a view into a larger buffer, we must slice to get only our portion
    let buffer: ArrayBuffer
    if (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) {
      buffer = data.buffer as ArrayBuffer
    } else {
      // View into larger buffer - must slice (this is a copy, unavoidable)
      buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
    }

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // Transfer buffer to worker and request it back with returnData: true
      this.worker!.postMessage({ id, data: buffer, returnData: true }, [buffer])
    })
  }

  /**
   * Check if the worker is available.
   */
  get isAvailable(): boolean {
    return !this.workerFailed && typeof Worker !== 'undefined'
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
