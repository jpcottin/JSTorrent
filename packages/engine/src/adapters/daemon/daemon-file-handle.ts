import { IFileHandle } from '../../interfaces/filesystem'
import { toHex } from '../../utils/buffer'
import { packVerifiedWriteBatch } from './batch-write-utils'
import { DaemonConnection } from './daemon-connection'
import type { HttpBatchingDiskQueue } from './http-batching-disk-queue'

/**
 * Error thrown when hash verification fails during a write operation.
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

// Protocol constants
const PROTOCOL_VERSION = 1
const OP_FILE_WRITE = 0x30
const OP_FILE_WRITE_ACK = 0x31
const OP_FILE_WRITE_ERROR = 0x32
const OP_ERROR = 0x7f

// Shared pending writes registry (keyed by requestId)
// We use a module-level map because multiple DaemonFileHandle instances
// share the same DaemonConnection and frame handler.
const pendingWrites = new Map<
  number,
  { resolve: (v: { bytesWritten: number }) => void; reject: (e: Error) => void }
>()
let nextRequestId = 1
const connectionsWithFrameHandler = new Set<DaemonConnection>()

// Batch writes registry (keyed by callbackId string)
// Used by HttpBatchingDiskQueue (Phase 2) for batch write results
const pendingBatchWrites = new Map<
  string,
  { resolve: (v: { bytesWritten: number }) => void; reject: (e: Error) => void }
>()

// PERF TEST: Set true to bypass ACK waiting entirely (fire-and-forget writes)
const FIRE_AND_FORGET_WRITES = false

// In-flight write tracking for backpressure and monitoring
let totalWritesSent = 0
let totalWritesAcked = 0
let maxInFlight = 0

/** Get current in-flight write stats */
export function getWriteStats() {
  const inFlight = pendingWrites.size + pendingBatchWrites.size
  if (inFlight > maxInFlight) maxInFlight = inFlight
  return {
    inFlight,
    maxInFlight,
    totalSent: totalWritesSent,
    totalAcked: totalWritesAcked,
    batchInFlight: pendingBatchWrites.size,
  }
}

/** Reset max in-flight counter (call periodically) */
export function resetWriteStatsMax() {
  maxInFlight = pendingWrites.size + pendingBatchWrites.size
}

/**
 * Register a pending batch write by callbackId.
 * Used by HttpBatchingDiskQueue (Phase 2) for batch write tracking.
 * Results come via WebSocket with requestId=0 and callbackId in payload.
 */
export function registerBatchWrite(
  callbackId: string,
  resolve: (v: { bytesWritten: number }) => void,
  reject: (e: Error) => void,
): void {
  pendingBatchWrites.set(callbackId, { resolve, reject })
  totalWritesSent++
}

/**
 * Unregister a pending batch write (e.g., on timeout or cancellation).
 */
export function unregisterBatchWrite(callbackId: string): boolean {
  return pendingBatchWrites.delete(callbackId)
}

/**
 * Register the frame handler for file write responses on a connection.
 * Called once per connection.
 */
function ensureFrameHandler(connection: DaemonConnection): void {
  if (connectionsWithFrameHandler.has(connection)) return
  connectionsWithFrameHandler.add(connection)

  connection.onFrame((frame) => {
    const view = new DataView(frame)
    const opcode = view.getUint8(1)

    // Handle generic protocol errors (e.g., unsupported opcode)
    if (opcode === OP_ERROR) {
      const requestId = view.getUint32(4, true)
      if (requestId === 0) return
      const pending = pendingWrites.get(requestId)
      if (!pending) return
      pendingWrites.delete(requestId)
      const message = new TextDecoder().decode(new Uint8Array(frame, 8))
      pending.reject(new Error(`Write failed: ${message}`))
      return
    }

    if (opcode !== OP_FILE_WRITE_ACK && opcode !== OP_FILE_WRITE_ERROR) {
      return // Not a file write response
    }

    const requestId = view.getUint32(4, true)

    // requestId === 0 indicates a batch write result with callbackId in payload
    if (requestId === 0) {
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
      totalWritesAcked++

      if (resultCode === 0) {
        pending.resolve({ bytesWritten })
      } else {
        // Result codes: 0=SUCCESS, 1=HASH_MISMATCH, 2=IO_ERROR, 3=INVALID_ARGS
        const errorMessages: Record<number, string> = {
          1: 'Hash mismatch',
          2: 'I/O error',
          3: 'Invalid arguments',
        }
        const message = errorMessages[resultCode] ?? `Unknown error code ${resultCode}`
        if (resultCode === 1) {
          pending.reject(new HashMismatchError(message))
        } else {
          pending.reject(new Error(`Batch write failed: ${message}`))
        }
      }
      return
    }

    // Regular single-write response (requestId > 0)
    const pending = pendingWrites.get(requestId)
    if (!pending) return // Unknown requestId (maybe already timed out)

    pendingWrites.delete(requestId)

    if (opcode === OP_FILE_WRITE_ACK) {
      // Success - payload has status at the end, but we just resolve
      totalWritesAcked++
      pending.resolve({ bytesWritten: -1 }) // We don't track actual bytes in response
    } else {
      // Error - parse message from payload
      // Payload: [root_key_len:1][root_key:N][offset:8 LE][error_code:4 LE][message:M]
      const payload = new Uint8Array(frame, 8)
      const rootKeyLen = payload[0]
      // Skip root_key, offset (8), error_code (4) to get to message
      const messageOffset = 1 + rootKeyLen + 8 + 4
      const message = new TextDecoder().decode(payload.subarray(messageOffset))

      // Check if it's a hash mismatch (error message contains "Hash mismatch")
      if (message.includes('Hash mismatch')) {
        pending.reject(new HashMismatchError(message))
      } else {
        pending.reject(new Error(`Write failed: ${message}`))
      }
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
    private useWebSocketWrites: boolean = true,
    private writeConnection?: DaemonConnection,
    /** Optional batching queue for HTTP batched writes. When set, verified writes are batched. */
    private batchingQueue?: HttpBatchingDiskQueue,
  ) {
    // Register the shared frame handler on the connection that will receive write ACKs
    // (needed for both WebSocket writes and batched HTTP writes which ACK via WebSocket)
    if (useWebSocketWrites || batchingQueue) {
      const ackConnection = writeConnection ?? connection
      ensureFrameHandler(ackConnection)
    }
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

    // Use batched HTTP writes if enabled and we have a pending hash
    // (batching is only for verified writes - reduces HTTP overhead)
    if (this.batchingQueue && this.pendingHash) {
      return this.writeViaBatch(data, position)
    }

    // Use WebSocket write path if enabled and connection is ready
    if (this.useWebSocketWrites && this.connection.ready) {
      return this.writeViaWebSocket(data, position)
    }

    // Fallback to HTTP path
    return this.writeViaHttp(data, position)
  }

  /**
   * Write via batched HTTP with WebSocket ACK.
   * Queues the write to the batching queue for efficient batch dispatch.
   * Results come back via WebSocket ACK/ERROR frames.
   */
  private writeViaBatch(data: Uint8Array, position: number): Promise<{ bytesWritten: number }> {
    const expectedHash = this.pendingHash!
    this.pendingHash = null // Consume it

    // Convert to ArrayBuffer for the batching queue
    const arrayBuffer = data.buffer.slice(
      data.byteOffset,
      data.byteOffset + data.byteLength,
    ) as ArrayBuffer

    return this.batchingQueue!.queueVerifiedWrite(
      this.rootKey,
      this.path,
      position,
      arrayBuffer,
      expectedHash,
    )
  }

  /**
   * Write via WebSocket with ACK/ERROR handling.
   * Frame format: [envelope:8][root_key_len:1][root_key:N][path_len:2 LE][path:M][offset:8 LE][flags:1][optional sha1:20][data:K]
   *
   * Uses non-zero requestId to receive acknowledgment or error response.
   * Throws HashMismatchError if hash verification fails on the server.
   */
  private writeViaWebSocket(data: Uint8Array, position: number): Promise<{ bytesWritten: number }> {
    const encoder = new TextEncoder()
    const rootKeyBytes = encoder.encode(this.rootKey)
    const pathBytes = encoder.encode(this.path)

    const hasHash = this.pendingHash !== null
    const flags = hasHash ? 1 : 0
    const hashSize = hasHash ? 20 : 0

    // Generate unique requestId for this write (0 = fire-and-forget, no ACK expected)
    const requestId = FIRE_AND_FORGET_WRITES ? 0 : nextRequestId++
    if (nextRequestId > 0x7fffffff) nextRequestId = 1 // Wrap around, avoid 0

    // Calculate total frame size
    const payloadSize =
      1 + // root_key_len
      rootKeyBytes.length + // root_key
      2 + // path_len
      pathBytes.length + // path
      8 + // offset
      1 + // flags
      hashSize + // optional sha1
      data.length // data

    const frameSize = 8 + payloadSize // envelope + payload

    const frame = new ArrayBuffer(frameSize)
    const view = new DataView(frame)
    const bytes = new Uint8Array(frame)

    let idx = 0

    // Envelope (8 bytes)
    view.setUint8(idx++, PROTOCOL_VERSION)
    view.setUint8(idx++, OP_FILE_WRITE)
    view.setUint16(idx, 0, true) // flags
    idx += 2
    view.setUint32(idx, requestId, true) // non-zero requestId for ACK/ERROR response
    idx += 4

    // root_key_len (1 byte)
    view.setUint8(idx++, rootKeyBytes.length)
    // root_key
    bytes.set(rootKeyBytes, idx)
    idx += rootKeyBytes.length

    // path_len (2 bytes, little-endian)
    view.setUint16(idx, pathBytes.length, true)
    idx += 2
    // path
    bytes.set(pathBytes, idx)
    idx += pathBytes.length

    // offset (8 bytes, little-endian)
    // JavaScript doesn't have native 64-bit int support, so write as two 32-bit values
    view.setUint32(idx, position >>> 0, true) // low 32 bits
    view.setUint32(idx + 4, Math.floor(position / 0x100000000), true) // high 32 bits
    idx += 8

    // flags (1 byte)
    view.setUint8(idx++, flags)

    // optional sha1 (20 bytes)
    if (this.pendingHash) {
      bytes.set(this.pendingHash, idx)
      idx += 20
      this.pendingHash = null // Consume it
    }

    // data
    bytes.set(data, idx)

    // Use write connection if available and ready, otherwise fall back to main connection
    const targetConnection = this.writeConnection?.ready ? this.writeConnection : this.connection

    // Fire-and-forget mode: send frame and immediately resolve (no ACK wait)
    if (FIRE_AND_FORGET_WRITES) {
      totalWritesSent++
      targetConnection.sendFrame(frame)
      return Promise.resolve({ bytesWritten: data.length })
    }

    // Create promise that will be resolved/rejected by frame handler
    return new Promise((resolve, reject) => {
      // Register pending write
      pendingWrites.set(requestId, {
        resolve: () => resolve({ bytesWritten: data.length }),
        reject,
      })

      // Send the frame
      totalWritesSent++
      targetConnection.sendFrame(frame)

      // Timeout after 30 seconds (disk operations can be slow)
      setTimeout(() => {
        if (pendingWrites.has(requestId)) {
          pendingWrites.delete(requestId)
          reject(new Error('Write timed out waiting for server response'))
        }
      }, 30000)
    })
  }

  /**
   * Write via HTTP (original path).
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

    // Attach pending hash if set
    if (this.pendingHash) {
      headers['X-Expected-SHA1'] = toHex(this.pendingHash)
      this.pendingHash = null // Consume it
    }

    const response = await this.connection.requestWithHeaders(
      'POST',
      `/write/${this.rootKey}`,
      headers,
      data,
    )

    if (response.status === 409) {
      throw new HashMismatchError(await response.text())
    }

    if (!response.ok) {
      const errorDetail = await response.text()
      throw new Error(`Write failed: ${response.status} ${response.statusText}: ${errorDetail}`)
    }

    return { bytesWritten: data.length }
  }

  /**
   * Write multiple data chunks to the file in a single HTTP request.
   * All writes share the same rootKey and path (this file handle).
   * Results come back via WebSocket ACK/ERROR frames.
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

    // Generate callback IDs and create pending write entries
    const pendingPromises: Array<Promise<{ bytesWritten: number }>> = []

    const packedWrites = writes.map((w) => {
      const callbackId = `wb_${nextRequestId++}`
      if (nextRequestId > 0x7fffffff) nextRequestId = 1

      // Create promise for this write's ACK
      const promise = new Promise<{ bytesWritten: number }>((resolve, reject) => {
        registerBatchWrite(callbackId, resolve, reject)

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
        data: w.data.buffer.slice(
          w.data.byteOffset,
          w.data.byteOffset + w.data.byteLength,
        ) as ArrayBuffer,
        expectedHashHex: toHex(w.expectedHash),
        callbackId,
      }
    })

    // Pack all writes into a single binary buffer
    const packed = packVerifiedWriteBatch(packedWrites)

    // Send single HTTP POST
    const response = await this.connection.requestWithHeaders(
      'POST',
      `/write-batch/${this.rootKey}`,
      {
        'Content-Type': 'application/octet-stream',
      },
      new Uint8Array(packed),
    )

    if (response.status === 202) {
      // Accepted - wait for all ACKs via WebSocket
      await Promise.all(pendingPromises)
      return
    }

    // For non-202 responses, unregister callbacks (no WebSocket ACKs expected)
    for (const w of packedWrites) {
      unregisterBatchWrite(w.callbackId)
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`Batch write failed: ${response.status} ${response.statusText}: ${errorText}`)
    }

    // 200 OK - writes completed synchronously, no need to wait for ACKs
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
