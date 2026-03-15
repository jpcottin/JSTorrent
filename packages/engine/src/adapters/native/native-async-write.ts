/**
 * Native Async Write Queue
 *
 * Collects unverified file writes during a tick and flushes them in a single
 * FFI call.  Same pattern as NativeAsyncReadQueue for reads and
 * NativeBatchingDiskQueue for verified writes.
 *
 * This replaces the synchronous __jstorrent_file_write() calls that blocked
 * the JS thread during boundary-piece writes on Android/iOS.
 *
 * Flow:
 *   1. NativeFileHandle.write() (no pendingHash) -> queueAsyncWrite() (no FFI)
 *   2. End of tick -> flushPendingWrites() -> __jstorrent_file_write_batch (single FFI)
 *   3. Kotlin/Swift dispatches writes to I/O threads in parallel
 *   4. Start of next tick -> __jstorrent_file_flush() -> __jstorrent_file_dispatch_batch
 *   5. Promises resolve with bytesWritten
 *
 * Results are delivered through the SAME __jstorrent_file_dispatch_batch
 * callback used by verified writes — the result format (callbackId +
 * bytesWritten + resultCode) is identical.
 */

import './bindings.d.ts'

globalThis.__jstorrent_file_write_callbacks ??= {}

/** Result codes (must match Kotlin/Swift WriteResultCode) */
const WriteResultCode = {
  SUCCESS: 0,
  IO_ERROR: 2,
  INVALID_ARGS: 3,
  DISK_FULL: 4,
  PERMISSION_DENIED: 5,
} as const

/** Counter for unique write callback IDs */
let nextWriteId = 1

/** Pending async write request */
interface PendingAsyncWrite {
  rootKey: string
  path: string
  position: number
  /** The full backing ArrayBuffer (avoids a JS-side slice/copy). */
  buffer: ArrayBuffer
  /** Byte offset into `buffer` where the write data starts. */
  dataOffset: number
  /** Number of bytes to write starting from `dataOffset`. */
  dataLength: number
  callbackId: string
  resolve: (result: { bytesWritten: number }) => void
  reject: (error: Error) => void
}

/**
 * Pack an array of write requests into a binary buffer.
 *
 * Format (all multi-byte integers are little-endian):
 *   [count: u32 LE] then for each write:
 *     [rootKeyLen: u8] [rootKey: UTF-8 bytes]
 *     [pathLen: u16 LE] [path: UTF-8 bytes]
 *     [position: u64 LE]
 *     [dataLen: u32 LE] [data: bytes]
 *     [callbackIdLen: u8] [callbackId: UTF-8 bytes]
 *
 * This is similar to the verified-write batch format but WITHOUT the 40-byte
 * hash field (unverified writes don't need hash checking).
 */
export function packWriteBatch(writes: PendingAsyncWrite[]): ArrayBuffer {
  const textEncoder = new TextEncoder()

  const encoded = writes.map((w) => ({
    rootKey: textEncoder.encode(w.rootKey),
    path: textEncoder.encode(w.path),
    callbackId: textEncoder.encode(w.callbackId),
    buffer: w.buffer,
    dataOffset: w.dataOffset,
    dataLength: w.dataLength,
    position: w.position,
  }))

  let totalSize = 4 // count
  for (const e of encoded) {
    totalSize += 1 + e.rootKey.length // rootKeyLen + rootKey
    totalSize += 2 + e.path.length // pathLen + path
    totalSize += 8 // position (u64)
    totalSize += 4 + e.dataLength // dataLen + data
    totalSize += 1 + e.callbackId.length // callbackIdLen + callbackId
  }

  const packed = new ArrayBuffer(totalSize)
  const view = new DataView(packed)
  const bytes = new Uint8Array(packed)

  let offset = 0

  // Count
  view.setUint32(offset, writes.length, true)
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

    // dataLen + data (zero-copy: copy from source buffer at dataOffset)
    view.setUint32(offset, e.dataLength, true)
    offset += 4
    bytes.set(new Uint8Array(e.buffer, e.dataOffset, e.dataLength), offset)
    offset += e.dataLength

    // callbackIdLen + callbackId
    bytes[offset] = e.callbackId.length
    offset += 1
    bytes.set(e.callbackId, offset)
    offset += e.callbackId.length
  }

  return packed
}

/** Global singleton instance */
let globalAsyncWriteQueue: NativeAsyncWriteQueue | null = null

/**
 * Get or create the global async write queue singleton.
 */
export function getGlobalAsyncWriteQueue(): NativeAsyncWriteQueue {
  if (!globalAsyncWriteQueue) {
    globalAsyncWriteQueue = new NativeAsyncWriteQueue()
  }
  return globalAsyncWriteQueue
}

/**
 * Flush all pending async writes.
 * Called by BtEngine at end of engine tick.
 */
export function flushPendingWrites(): void {
  if (globalAsyncWriteQueue) {
    globalAsyncWriteQueue.flushPending()
  }
}

/**
 * Async write queue for Android/iOS native layer.
 *
 * Instead of blocking the JS thread with sync __jstorrent_file_write,
 * this queues writes and sends them to Kotlin/Swift in a single FFI call.
 * Results come back at start of next tick via __jstorrent_file_dispatch_batch
 * (same dispatch path as verified writes).
 */
export class NativeAsyncWriteQueue {
  private pending: PendingAsyncWrite[] = []
  private _pendingBytes = 0

  /**
   * Queue an async write. Returns a Promise that resolves with bytesWritten
   * when the result comes back from the native layer (start of next tick).
   *
   * @param rootKey Storage root key
   * @param path File path relative to root
   * @param position Write position in file
   * @param buffer The backing ArrayBuffer containing the data
   * @param dataOffset Byte offset into buffer where write data starts
   * @param dataLength Number of bytes to write
   */
  queueAsyncWrite(
    rootKey: string,
    path: string,
    position: number,
    buffer: ArrayBuffer,
    dataOffset: number,
    dataLength: number,
  ): Promise<{ bytesWritten: number }> {
    return new Promise((resolve, reject) => {
      const callbackId = `wr_${nextWriteId++}`

      // Register callback — same global store as verified writes
      globalThis.__jstorrent_file_write_callbacks[callbackId] = (
        bytesWrittenStr: string | number,
        resultCodeStr: string | number,
      ) => {
        delete globalThis.__jstorrent_file_write_callbacks[callbackId]

        const bytesWritten = Number(bytesWrittenStr)
        const resultCode = Number(resultCodeStr)

        if (resultCode === WriteResultCode.SUCCESS) {
          resolve({ bytesWritten })
        } else if (resultCode === WriteResultCode.IO_ERROR) {
          reject(new Error(`I/O error writing to ${path}`))
        } else if (resultCode === WriteResultCode.DISK_FULL) {
          reject(new Error(`Disk full writing to ${path}`))
        } else if (resultCode === WriteResultCode.PERMISSION_DENIED) {
          reject(new Error(`Permission denied writing to ${path}`))
        } else {
          reject(new Error(`Write failed with code ${resultCode}`))
        }
      }

      this.pending.push({
        rootKey,
        path,
        position,
        buffer,
        dataOffset,
        dataLength,
        callbackId,
        resolve,
        reject,
      })
      this._pendingBytes += dataLength
    })
  }

  /**
   * Flush all pending writes in a single FFI call.
   * Called at end of tick by the engine.
   */
  flushPending(): void {
    if (this.pending.length === 0) return

    const packed = packWriteBatch(this.pending)
    this._pendingBytes = 0
    this.pending = []

    __jstorrent_file_write_batch(packed)
  }

  /** Number of pending writes. */
  get pendingCount(): number {
    return this.pending.length
  }

  /** Total bytes in pending writes. */
  get pendingBytes(): number {
    return this._pendingBytes
  }

  /**
   * Clear all pending writes, rejecting their promises.
   */
  clearPending(): void {
    for (const item of this.pending) {
      delete globalThis.__jstorrent_file_write_callbacks[item.callbackId]
      item.reject(new Error('Write queue cleared'))
    }
    this.pending = []
    this._pendingBytes = 0
  }
}
