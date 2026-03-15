/**
 * Native File Handle
 *
 * Implements IFileHandle using stateless native bindings.
 * Each read/write is a complete operation - no persistent file handle is maintained.
 *
 * Supports verified writes: when setExpectedHashForNextWrite() is called,
 * the next write() uses async verified write (hash + write on background thread).
 */

import type { IFileHandle } from '../../interfaces/filesystem'
import { getGlobalBatchingQueue } from './native-batching-disk-queue'
import { getGlobalAsyncReadQueue } from './native-async-read'
import { getGlobalAsyncWriteQueue } from './native-async-write'
import './bindings.d.ts'

/**
 * Error thrown when hash verification fails during a verified write.
 */
export class HashMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HashMismatchError'
  }
}

export class NativeFileHandle implements IFileHandle {
  private closed = false
  private pendingHash: Uint8Array | null = null

  constructor(
    private readonly rootKey: string,
    private readonly path: string,
  ) {}

  /**
   * Set expected SHA1 hash for the next write operation.
   * If the hash mismatches, the write will throw HashMismatchError.
   * The hash is consumed after one write operation.
   *
   * When set, write() uses async verified write (background thread).
   */
  setExpectedHashForNextWrite(sha1: Uint8Array): void {
    this.pendingHash = sha1
  }

  /**
   * Read data from the file at a specific position.
   *
   * Uses async read batch when available (Android): queues the read for
   * background I/O dispatch, result arrives at start of next tick.
   * Falls back to sync __jstorrent_file_read when async batch is not available.
   */
  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    if (this.closed) {
      throw new Error('File handle is closed')
    }

    if (NativeFileHandle.useAsyncReads) {
      // Async path: queue read, resolved when Kotlin I/O thread completes
      const data = await getGlobalAsyncReadQueue().queueAsyncRead(
        this.rootKey,
        this.path,
        position,
        length,
      )

      if (data.length === 0) {
        return { bytesRead: 0 }
      }

      const bytesToCopy = Math.min(data.length, buffer.length - offset)
      buffer.set(data.subarray(0, bytesToCopy), offset)
      return { bytesRead: bytesToCopy }
    }

    // Sync fallback: blocks JS thread
    const result = __jstorrent_file_read(this.rootKey, this.path, position, length)

    if (!result || result.byteLength === 0) {
      return { bytesRead: 0 }
    }

    const data = new Uint8Array(result)
    const bytesToCopy = Math.min(data.length, buffer.length - offset)
    buffer.set(data.subarray(0, bytesToCopy), offset)

    return { bytesRead: bytesToCopy }
  }

  /** Whether to use async read batch (set by native preset) */
  static useAsyncReads = false

  /** Whether to use async writes for unverified writes (set by native preset) */
  static useAsyncWrites = false

  /**
   * Write data to the file at a specific position.
   *
   * If setExpectedHashForNextWrite() was called, uses async verified write:
   * - Hashing and I/O run on background thread
   * - Returns Promise that resolves when complete
   * - Throws HashMismatchError if hash doesn't match
   *
   * If useAsyncWrites is enabled (Android/iOS), unverified writes are also
   * async — queued to NativeAsyncWriteQueue with zero-copy (offset+length
   * into the original ArrayBuffer, no JS-side .slice()).
   *
   * Otherwise falls back to synchronous __jstorrent_file_write (blocks JS thread).
   */
  async write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }> {
    if (this.closed) {
      throw new Error('File handle is closed')
    }

    // Check if we have a pending hash for verified write
    if (this.pendingHash) {
      const expectedHash = this.pendingHash
      this.pendingHash = null // Consume it

      // Verified writes need a standalone ArrayBuffer (packed into batch with hash)
      const data = buffer.subarray(offset, offset + length)
      const arrayBuffer = data.buffer.slice(
        data.byteOffset,
        data.byteOffset + data.byteLength,
      ) as ArrayBuffer

      return this.writeVerified(arrayBuffer, position, expectedHash)
    }

    // Async unverified write — zero-copy: pass original buffer + offset/length
    if (NativeFileHandle.useAsyncWrites) {
      const dataOffset = buffer.byteOffset + offset
      return getGlobalAsyncWriteQueue().queueAsyncWrite(
        this.rootKey,
        this.path,
        position,
        buffer.buffer as ArrayBuffer,
        dataOffset,
        length,
      )
    }

    // Sync fallback: slice + blocking FFI
    const data = buffer.subarray(offset, offset + length)
    const arrayBuffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer
    const bytesWritten = __jstorrent_file_write(this.rootKey, this.path, position, arrayBuffer)

    if (bytesWritten < 0) {
      throw new Error('Write failed')
    }

    return { bytesWritten }
  }

  /**
   * Async verified write - queues to batching disk queue for efficient FFI.
   * The actual write happens when flushBatchedWrites() is called at end of tick.
   */
  private writeVerified(
    data: ArrayBuffer,
    position: number,
    expectedHash: Uint8Array,
  ): Promise<{ bytesWritten: number }> {
    // Queue to the global batching queue instead of direct FFI call.
    // All queued writes are sent in a single FFI call at end of tick.
    return getGlobalBatchingQueue().queueVerifiedWrite(
      this.rootKey,
      this.path,
      position,
      data,
      expectedHash,
    )
  }

  /**
   * Truncate the file to a specific size.
   * Not supported in stateless mode - can be added later if needed.
   */
  async truncate(_len: number): Promise<void> {
    throw new Error('Truncate not supported in stateless mode')
  }

  /**
   * Flush changes to storage.
   * No-op - each write already syncs to storage.
   */
  async sync(): Promise<void> {
    // No-op - each write is already synced
  }

  /**
   * Close the file handle.
   * No-op - there's no actual handle to close. Just marks as closed.
   */
  async close(): Promise<void> {
    this.closed = true
  }
}
