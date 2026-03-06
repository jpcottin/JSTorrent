import { IFileHandle } from '../../interfaces/filesystem'
import { toHex } from '../../utils/buffer'
import {
  WriteError,
  resultCodeToErrorType,
  httpStatusToErrorType,
  classifyError,
} from '../../core/write-error'
import type { DiskWriteQueueStats } from '../../core/disk-queue'
import { packVerifiedWriteBatch } from './batch-write-utils'
import { DaemonConnection } from './daemon-connection'

// Re-export for backwards compatibility and convenience
export { WriteError, WriteErrorType } from '../../core/write-error'

/**
 * Error thrown when hash verification fails during a write operation.
 * @deprecated Use WriteError with WriteErrorType.HASH_MISMATCH instead
 */
export class HashMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HashMismatchError'
  }
}

/**
 * Type guard to check if a file handle supports verified writes.
 */
export function supportsVerifiedWrite(handle: IFileHandle): handle is DaemonFileHandle {
  return 'setExpectedHashForNextWrite' in handle
}

// Protocol constants for batch write ACKs (received via WebSocket after HTTP batch writes)
const OP_FILE_WRITE_ACK = 0x31
const OP_FILE_WRITE_ERROR = 0x32

let nextRequestId = 1
const connectionsWithFrameHandler = new Set<DaemonConnection>()

// Batch writes registry (keyed by callbackId string)
// Used by HttpBatchingDiskQueue (Phase 2) for batch write results
const pendingBatchWrites = new Map<
  string,
  {
    resolve: (v: { bytesWritten: number }) => void
    reject: (e: Error) => void
    bytes: number
  }
>()

// In-flight write tracking for backpressure and monitoring
let totalWritesSent = 0
let totalWritesAcked = 0
let maxInFlight = 0
let totalWriteBytesSent = 0
let totalWriteBytesAcked = 0
let inFlightWriteCount = 0
let inFlightWriteBytes = 0
let maxInFlightWriteBytes = 0

// Histogram for HTTP upload sizes (batch writes)
// Buckets: 0-16KB, 16-64KB, 64-256KB, 256KB-1MB, 1-4MB, 4-16MB, 16MB+
const HISTOGRAM_BUCKETS = [
  16 * 1024,
  64 * 1024,
  256 * 1024,
  1024 * 1024,
  4 * 1024 * 1024,
  16 * 1024 * 1024,
]
const batchSizeHistogram = new Array(HISTOGRAM_BUCKETS.length + 1).fill(0)
const batchCountHistogram = new Array(17).fill(0) // 0-16+ writes per batch
let totalBatchBytes = 0
let totalBatches = 0

function recordBatchSize(bytes: number, writeCount: number): void {
  // Size histogram
  let bucket = HISTOGRAM_BUCKETS.length
  for (let i = 0; i < HISTOGRAM_BUCKETS.length; i++) {
    if (bytes < HISTOGRAM_BUCKETS[i]) {
      bucket = i
      break
    }
  }
  batchSizeHistogram[bucket]++
  totalBatchBytes += bytes
  totalBatches++

  // Count histogram (0-15, then 16+)
  const countBucket = Math.min(writeCount, 16)
  batchCountHistogram[countBucket]++
}

/** Get batch write histogram stats */
export function getBatchWriteHistogram() {
  const bucketLabels = ['0-16KB', '16-64KB', '64-256KB', '256KB-1MB', '1-4MB', '4-16MB', '16MB+']
  const sizeDistribution: Record<string, number> = {}
  for (let i = 0; i < bucketLabels.length; i++) {
    if (batchSizeHistogram[i] > 0) {
      sizeDistribution[bucketLabels[i]] = batchSizeHistogram[i]
    }
  }

  const countDistribution: Record<string, number> = {}
  for (let i = 0; i <= 16; i++) {
    if (batchCountHistogram[i] > 0) {
      countDistribution[i === 16 ? '16+' : String(i)] = batchCountHistogram[i]
    }
  }

  return {
    totalBatches,
    totalBatchBytes,
    avgBatchBytes: totalBatches > 0 ? Math.round(totalBatchBytes / totalBatches) : 0,
    sizeDistribution,
    countDistribution,
  }
}

/** Get current in-flight write stats */
export function getWriteStats() {
  const inFlight = inFlightWriteCount
  if (inFlight > maxInFlight) maxInFlight = inFlight
  if (inFlightWriteBytes > maxInFlightWriteBytes) {
    maxInFlightWriteBytes = inFlightWriteBytes
  }
  return {
    inFlight,
    maxInFlight,
    inFlightBytes: inFlightWriteBytes,
    maxInFlightBytes: maxInFlightWriteBytes,
    totalSent: totalWritesSent,
    totalAcked: totalWritesAcked,
    totalBytesSent: totalWriteBytesSent,
    totalBytesAcked: totalWriteBytesAcked,
  }
}

/** Reset max in-flight counter (call periodically) */
export function resetWriteStatsMax() {
  maxInFlight = inFlightWriteCount
  maxInFlightWriteBytes = inFlightWriteBytes
}

function registerInFlightWrite(bytes: number): void {
  totalWritesSent++
  totalWriteBytesSent += bytes
  inFlightWriteCount++
  inFlightWriteBytes += bytes
}

function completeInFlightWrite(bytes: number): void {
  inFlightWriteCount = Math.max(0, inFlightWriteCount - 1)
  inFlightWriteBytes = Math.max(0, inFlightWriteBytes - bytes)
  totalWritesAcked++
  totalWriteBytesAcked += bytes
}

function abandonInFlightWrite(bytes: number): void {
  inFlightWriteCount = Math.max(0, inFlightWriteCount - 1)
  inFlightWriteBytes = Math.max(0, inFlightWriteBytes - bytes)
}

/**
 * Get current companion write-queue stats for engine-level backpressure.
 *
 * Companion writes do not have a separate JS-side pending queue once sent, so
 * retained write pressure is represented as in-flight verified writes waiting on
 * the HTTP/write/ACK round trip.
 */
export function getCompanionWriteQueueStats(): DiskWriteQueueStats {
  return {
    pendingWrites: 0,
    pendingBytes: 0,
    inFlightWrites: inFlightWriteCount,
    inFlightBytes: inFlightWriteBytes,
    totalWrites: totalWritesSent,
    totalBytes: totalWriteBytesSent,
  }
}

/**
 * Register a pending batch write by callbackId.
 * Used by HttpBatchingDiskQueue (Phase 2) for batch write tracking.
 * Results come via WebSocket with requestId=0 and callbackId in payload.
 */
export function registerBatchWrite(
  callbackId: string,
  bytes: number,
  resolve: (v: { bytesWritten: number }) => void,
  reject: (e: Error) => void,
): void {
  pendingBatchWrites.set(callbackId, { resolve, reject, bytes })
  registerInFlightWrite(bytes)
}

/**
 * Unregister a pending batch write (e.g., on timeout or cancellation).
 */
export function unregisterBatchWrite(callbackId: string): boolean {
  const pending = pendingBatchWrites.get(callbackId)
  if (!pending) return false
  pendingBatchWrites.delete(callbackId)
  abandonInFlightWrite(pending.bytes)
  return true
}

function completeBatchWrite(callbackId: string): boolean {
  const pending = pendingBatchWrites.get(callbackId)
  if (!pending) return false
  pendingBatchWrites.delete(callbackId)
  completeInFlightWrite(pending.bytes)
  return true
}

/**
 * Register the frame handler for batch write ACKs on a connection.
 * Called once per connection. Handles ACKs for HTTP batch writes that
 * return 202 Accepted (async completion via WebSocket).
 */
function ensureFrameHandler(connection: DaemonConnection): void {
  if (connectionsWithFrameHandler.has(connection)) return
  connectionsWithFrameHandler.add(connection)

  connection.onFrame((frame) => {
    const view = new DataView(frame)
    const opcode = view.getUint8(1)

    if (opcode !== OP_FILE_WRITE_ACK && opcode !== OP_FILE_WRITE_ERROR) {
      return // Not a file write response
    }

    const requestId = view.getUint32(4, true)

    // Batch write results have requestId === 0 with callbackId in payload
    if (requestId !== 0) {
      return // Not a batch write result
    }

    // Batch result format: [envelope:8][callbackIdLen:1][callbackId:bytes][bytesWritten:4 LE][resultCode:1]
    const payload = new Uint8Array(frame, 8)
    if (payload.length < 6) return // Minimum: 1 + 0 + 4 + 1

    const callbackIdLen = payload[0]
    if (payload.length < 1 + callbackIdLen + 4 + 1) return

    const callbackIdBytes = payload.subarray(1, 1 + callbackIdLen)
    const callbackId = new TextDecoder().decode(callbackIdBytes)
    const bytesWritten = view.getInt32(8 + 1 + callbackIdLen, true)
    const resultCode = payload[1 + callbackIdLen + 4]

    const pending = pendingBatchWrites.get(callbackId)
    if (!pending) return // Unknown callbackId (maybe timed out or not ours)

    pendingBatchWrites.delete(callbackId)
    completeInFlightWrite(pending.bytes)

    if (resultCode === 0) {
      pending.resolve({ bytesWritten })
    } else {
      // Result codes: 0=SUCCESS, 1=HASH_MISMATCH, 2=IO_ERROR, 3=INVALID_ARGS, 4=DISK_FULL, 5=PERMISSION_DENIED
      const errorType = resultCodeToErrorType(resultCode)
      const errorMessages: Record<number, string> = {
        1: 'Hash mismatch',
        2: 'I/O error',
        3: 'Invalid arguments',
        4: 'Disk full',
        5: 'Permission denied',
      }
      const message = errorMessages[resultCode] ?? `Unknown error code ${resultCode}`
      pending.reject(new WriteError(`Batch write failed: ${message}`, errorType))
    }
  })
}

/** A single write in a batch for writeBatch() */
export interface BatchWriteItem {
  offset: number
  data: Uint8Array
  expectedHash: Uint8Array
}

export class DaemonFileHandle implements IFileHandle {
  private pendingHash: Uint8Array | null = null

  constructor(
    private connection: DaemonConnection,
    private path: string,
    private rootKey: string,
    private nullStorage: boolean = false,
  ) {
    // Register the shared frame handler for batch write ACKs (used by adaptive batching)
    ensureFrameHandler(connection)
  }

  /**
   * Set expected SHA1 hash for the next write operation.
   * If the hash mismatches, the write will throw HashMismatchError.
   * The hash is consumed after one write operation.
   */
  setExpectedHashForNextWrite(sha1: Uint8Array): void {
    this.pendingHash = sha1
  }

  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    const pathB64 = btoa(this.path)

    const data = await this.connection.requestBinaryWithHeaders('GET', `/read/${this.rootKey}`, {
      'X-Path-Base64': pathB64,
      'X-Offset': String(position),
      'X-Length': String(length),
    })

    if (data.length !== length) {
      throw new Error(
        `Short read from daemon: requested ${length} bytes at position ${position}, got ${data.length}`,
      )
    }

    buffer.set(data, offset)
    return { bytesRead: data.length }
  }

  async write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }> {
    // Null storage mode: skip request, pretend write succeeded
    if (this.nullStorage) {
      this.pendingHash = null // Consume pending hash if set
      return { bytesWritten: length }
    }

    const data = buffer.subarray(offset, offset + length)
    return this.writeViaHttp(data, position)
  }

  /**
   * Write via HTTP with optional hash verification.
   */
  private async writeViaHttp(
    data: Uint8Array,
    position: number,
  ): Promise<{ bytesWritten: number }> {
    const pathB64 = btoa(this.path)

    const headers: Record<string, string> = {
      'X-Path-Base64': pathB64,
      'X-Offset': String(position),
    }

    const expectedHash = this.pendingHash
    if (expectedHash) {
      headers['X-Expected-SHA1'] = toHex(expectedHash)
      this.pendingHash = null // Consume it
    }

    // Record as a single-write "batch" for histogram tracking
    recordBatchSize(data.length, 1)

    if (expectedHash) {
      registerInFlightWrite(data.length)
    }

    let response: Response
    try {
      response = await this.connection.requestWithHeaders(
        'POST',
        `/write/${this.rootKey}`,
        headers,
        data,
      )
    } catch (error) {
      if (expectedHash) {
        abandonInFlightWrite(data.length)
      }
      throw classifyError(error, this.path)
    }

    if (!response.ok) {
      if (expectedHash) {
        abandonInFlightWrite(data.length)
      }
      const errorDetail = await response.text()
      const errorType = httpStatusToErrorType(response.status)
      throw new WriteError(
        `Write failed: ${response.status} ${response.statusText}: ${errorDetail}`,
        errorType,
        this.path,
      )
    }

    if (expectedHash) {
      completeInFlightWrite(data.length)
    }

    return { bytesWritten: data.length }
  }

  /**
   * Write multiple data chunks to the file in a single HTTP request.
   * All writes share the same rootKey and path (this file handle).
   * Results come back via WebSocket ACK/ERROR frames.
   *
   * If a streaming port is available, uses the streaming server which:
   * - Doesn't buffer the entire request in memory
   * - Processes pieces as they stream in
   * - Better for high-throughput/concurrent batch writes
   *
   * @param writes Array of writes, each with offset, data, and expectedHash
   * @returns Promise that resolves when all writes are acknowledged
   * @throws HashMismatchError if any write fails hash verification
   */
  async writeBatch(writes: BatchWriteItem[]): Promise<void> {
    if (writes.length === 0) return

    // Null storage mode: skip request, pretend writes succeeded
    if (this.nullStorage) {
      return
    }

    // Ensure frame handler is registered on the connection for receiving ACKs.
    // This is needed because writeBatch may be called even when the handle was
    // created without useWebSocketWrites/batchingQueue (e.g., adaptive batching).
    ensureFrameHandler(this.connection)

    // Generate callback IDs and create pending write entries
    const pendingPromises: Array<Promise<{ bytesWritten: number }>> = []

    const packedWrites = writes.map((w) => {
      const callbackId = `wb_${nextRequestId++}`
      if (nextRequestId > 0x7fffffff) nextRequestId = 1
      const bytes = w.data.byteLength

      // Create promise for this write's ACK
      const promise = new Promise<{ bytesWritten: number }>((resolve, reject) => {
        registerBatchWrite(callbackId, bytes, resolve, reject)

        // Timeout after 30 seconds
        setTimeout(() => {
          if (unregisterBatchWrite(callbackId)) {
            reject(new Error('Batch write timed out waiting for server response'))
          }
        }, 30000)
      })
      pendingPromises.push(promise)

      return {
        rootKey: this.rootKey,
        path: this.path,
        position: w.offset,
        // Use buffer directly - batchData.data is already a copy with byteOffset=0
        // and buffer.byteLength matching data.length (copied in writePieceVerified)
        data: w.data.buffer as ArrayBuffer,
        expectedHashHex: toHex(w.expectedHash),
        callbackId,
      }
    })

    // Pack all writes into a single binary buffer
    const packed = packVerifiedWriteBatch(packedWrites)

    // Record histogram stats
    recordBatchSize(packed.byteLength, writes.length)

    // Try streaming server if available (better memory efficiency)
    const streamingBaseUrl = this.connection.getStreamingBaseUrl()

    let response: Response
    try {
      if (streamingBaseUrl) {
        // Send to streaming server
        const credentials = await this.connection.getCredentialsCached()
        response = await fetch(`${streamingBaseUrl}/write-batch/${this.rootKey}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-JST-Auth': credentials.token,
            'X-JST-ExtensionId': credentials.extensionId,
            'X-JST-InstallId': credentials.installId,
          },
          body: new Uint8Array(packed),
        })
      } else {
        // Fall back to main HTTP server
        response = await this.connection.requestWithHeaders(
          'POST',
          `/write-batch/${this.rootKey}`,
          {
            'Content-Type': 'application/octet-stream',
          },
          new Uint8Array(packed),
        )
      }
    } catch (error) {
      // Network error (fetch failed) - clean up pending writes and rethrow as WriteError
      for (const w of packedWrites) {
        unregisterBatchWrite(w.callbackId)
      }
      throw classifyError(error, this.path)
    }

    if (response.status === 202) {
      // Accepted - wait for all ACKs via WebSocket
      await Promise.all(pendingPromises)
      return
    }

    if (!response.ok) {
      // No WebSocket ACKs expected on immediate HTTP error.
      for (const w of packedWrites) {
        unregisterBatchWrite(w.callbackId)
      }
      const errorText = await response.text()
      const errorType = httpStatusToErrorType(response.status)
      throw new WriteError(
        `Batch write failed: ${response.status} ${response.statusText}: ${errorText}`,
        errorType,
        this.path,
      )
    }

    // 200 OK - writes completed synchronously, no need to wait for ACKs.
    for (const w of packedWrites) {
      completeBatchWrite(w.callbackId)
    }
  }

  async truncate(len: number): Promise<void> {
    await this.connection.request('POST', '/ops/truncate', undefined, {
      path: this.path,
      root_key: this.rootKey,
      length: len,
    })
  }

  async sync(): Promise<void> {
    // io-daemon doesn't expose explicit sync yet, but writes are likely flushed or OS-managed.
    // We can treat this as a no-op or add a sync endpoint later.
  }

  async close(): Promise<void> {
    // Stateless handle, nothing to close on the daemon side.
  }
}
