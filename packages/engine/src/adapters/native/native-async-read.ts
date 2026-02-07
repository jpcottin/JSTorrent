/**
 * Native Async Read Queue
 *
 * Collects file reads during a tick and flushes them in a single FFI call.
 * Same pattern as NativeBatchingDiskQueue for verified writes.
 *
 * Flow:
 *   1. NativeFileHandle.read() -> queueAsyncRead() (no FFI, returns Promise)
 *   2. End of tick -> flushPendingReads() -> __jstorrent_file_read_batch (single FFI)
 *   3. Kotlin dispatches reads to Dispatchers.IO in parallel
 *   4. Start of next tick -> __jstorrent_file_flush() -> __jstorrent_file_dispatch_read_batch
 *   5. Promises resolve with read data
 */

import './bindings.d.ts'

/** Result codes from native async read (must match Kotlin ReadResultCode) */
const ReadResultCode = {
  SUCCESS: 0,
  IO_ERROR: 2,
  INVALID_ARGS: 3,
} as const

/** Counter for unique read callback IDs */
let nextReadId = 1

/** Pending async read request */
interface PendingAsyncRead {
  rootKey: string
  path: string
  position: number
  length: number
  callbackId: string
  resolve: (data: Uint8Array) => void
  reject: (error: Error) => void
}

/**
 * Pack an array of read requests into a binary buffer.
 *
 * Format (all multi-byte integers are little-endian):
 *   [count: u32 LE] then for each read:
 *     [rootKeyLen: u8] [rootKey: UTF-8 bytes]
 *     [pathLen: u16 LE] [path: UTF-8 bytes]
 *     [position: u64 LE]
 *     [length: u32 LE]
 *     [callbackIdLen: u8] [callbackId: UTF-8 bytes]
 */
function packReadBatch(reads: PendingAsyncRead[]): ArrayBuffer {
  const textEncoder = new TextEncoder()

  const encoded = reads.map((r) => ({
    rootKey: textEncoder.encode(r.rootKey),
    path: textEncoder.encode(r.path),
    callbackId: textEncoder.encode(r.callbackId),
    position: r.position,
    length: r.length,
  }))

  let totalSize = 4 // count
  for (const e of encoded) {
    totalSize += 1 + e.rootKey.length // rootKeyLen + rootKey
    totalSize += 2 + e.path.length // pathLen + path
    totalSize += 8 // position (u64)
    totalSize += 4 // length
    totalSize += 1 + e.callbackId.length // callbackIdLen + callbackId
  }

  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  let offset = 0

  // Count
  view.setUint32(offset, reads.length, true)
  offset += 4

  for (const e of encoded) {
    // rootKeyLen + rootKey
    bytes[offset] = e.rootKey.length
    offset += 1
    bytes.set(e.rootKey, offset)
    offset += e.rootKey.length

    // pathLen + path
    view.setUint16(offset, e.path.length, true)
    offset += 2
    bytes.set(e.path, offset)
    offset += e.path.length

    // position (u64 LE)
    view.setUint32(offset, e.position >>> 0, true)
    view.setUint32(offset + 4, Math.floor(e.position / 0x100000000) >>> 0, true)
    offset += 8

    // length
    view.setUint32(offset, e.length, true)
    offset += 4

    // callbackIdLen + callbackId
    bytes[offset] = e.callbackId.length
    offset += 1
    bytes.set(e.callbackId, offset)
    offset += e.callbackId.length
  }

  return buffer
}

/** Global singleton instance */
let globalAsyncReadQueue: NativeAsyncReadQueue | null = null

/**
 * Get or create the global async read queue singleton.
 */
export function getGlobalAsyncReadQueue(): NativeAsyncReadQueue {
  if (!globalAsyncReadQueue) {
    globalAsyncReadQueue = new NativeAsyncReadQueue()
  }
  return globalAsyncReadQueue
}

/**
 * Flush all pending async reads.
 * Called by BtEngine at end of engine tick to send accumulated reads
 * in a single FFI call. No-op if no reads are pending.
 */
export function flushPendingReads(): void {
  if (globalAsyncReadQueue) {
    globalAsyncReadQueue.flushPending()
  }
}

/**
 * Async read queue for Android native layer.
 *
 * Instead of blocking the JS thread with sync __jstorrent_file_read,
 * this queues reads and sends them to Kotlin in a single FFI call.
 * Results come back at start of next tick via __jstorrent_file_dispatch_read_batch.
 */
export class NativeAsyncReadQueue {
  private pending: PendingAsyncRead[] = []

  /**
   * Queue an async read. Returns a Promise that resolves with the read data
   * when the result comes back from Kotlin (start of next tick).
   */
  queueAsyncRead(
    rootKey: string,
    path: string,
    position: number,
    length: number,
  ): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
      const callbackId = `rd_${nextReadId++}`

      // Register callback for when result comes back from Kotlin
      globalThis.__jstorrent_file_read_callbacks[callbackId] = (
        resultCode: number,
        data: ArrayBuffer,
      ) => {
        if (resultCode === ReadResultCode.SUCCESS) {
          resolve(new Uint8Array(data))
        } else if (resultCode === ReadResultCode.IO_ERROR) {
          reject(new Error(`I/O error reading ${path}`))
        } else {
          reject(new Error(`Read failed with code ${resultCode}`))
        }
      }

      this.pending.push({
        rootKey,
        path,
        position,
        length,
        callbackId,
        resolve,
        reject,
      })
    })
  }

  /**
   * Flush all pending reads in a single FFI call.
   * Called at end of tick by the engine.
   */
  flushPending(): void {
    if (this.pending.length === 0) return

    const packed = packReadBatch(this.pending)
    __jstorrent_file_read_batch(packed)

    this.pending = []
  }

  /**
   * Get count of pending reads (for debugging/metrics).
   */
  get pendingCount(): number {
    return this.pending.length
  }

  /**
   * Clear all pending reads, rejecting their promises.
   */
  clearPending(): void {
    for (const item of this.pending) {
      delete globalThis.__jstorrent_file_read_callbacks[item.callbackId]
      item.reject(new Error('Read queue cleared'))
    }
    this.pending = []
  }
}
