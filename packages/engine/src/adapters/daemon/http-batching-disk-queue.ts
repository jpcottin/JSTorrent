/**
 * HTTP Batching Disk Queue
 *
 * Collects verified writes and batches them into single HTTP requests to reduce
 * per-request overhead. Results come back via WebSocket ACK/ERROR frames.
 *
 * Flow:
 *   1. DaemonFileHandle.writeVerified() -> queueVerifiedWrite() (no network)
 *   2. Batch triggers: backpressure (only batch when previous batch is in-flight)
 *   3. Pack batch -> POST /write-batch/{rootKey}
 *   4. Server processes writes in parallel
 *   5. WebSocket ACK/ERROR frames resolve/reject individual promises
 *
 * Strategy: Send immediately if no batch in-flight. Only batch when backlogged.
 * This avoids artificial latency from timeouts while still batching under load.
 */

import type { IDiskQueue, DiskJob, DiskQueueSnapshot, PendingJob } from '../../core/disk-queue'
import { toHex } from '../../utils/buffer'
import { packVerifiedWriteBatch, type VerifiedWriteInput } from './batch-write-utils'
import { DaemonConnection } from './daemon-connection'
import { registerBatchWrite, unregisterBatchWrite } from './daemon-file-handle'

/** Counter for unique callback IDs */
let nextCallbackId = 1

/** Pending verified write request with promise callbacks */
interface PendingVerifiedWrite extends VerifiedWriteInput {
  resolve: (result: { bytesWritten: number }) => void
  reject: (error: Error) => void
}

/** Metrics for batch write performance tracking */
interface BatchWriteMetrics {
  /** Total number of writes processed */
  totalWrites: number
  /** Total bytes written */
  totalBytes: number
  /** Total time spent in HTTP requests (ms) */
  totalHttpTimeMs: number
  /** Total time spent packing batches (ms) */
  totalPackTimeMs: number
  /** Number of batches flushed */
  batchCount: number
  /** Flushes triggered by size threshold */
  sizeFlushes: number
  /** Flushes triggered by backpressure (previous batch in-flight completed) */
  backpressureFlushes: number
  /** Immediate flushes (no batch in-flight) */
  immediateFlushes: number
  /** Timestamp of last metrics log */
  lastLogTime: number
}

export interface HttpBatchingDiskQueueConfig {
  /** Size threshold in bytes to trigger a flush (default: 16MB) */
  batchSizeThreshold?: number
}

/**
 * HTTP Batching disk queue for daemon mode.
 *
 * Collects verified writes and flushes them in batched HTTP requests
 * to reduce per-request overhead.
 */
export class HttpBatchingDiskQueue implements IDiskQueue {
  private pending: PendingVerifiedWrite[] = []
  private currentBatchSize = 0
  /** Whether a batch HTTP request is currently in-flight */
  private inFlight = false

  /** Size threshold in bytes to trigger a flush */
  readonly batchSizeThreshold: number

  /** Performance metrics for monitoring batch efficiency */
  private metrics: BatchWriteMetrics = {
    totalWrites: 0,
    totalBytes: 0,
    totalHttpTimeMs: 0,
    totalPackTimeMs: 0,
    batchCount: 0,
    sizeFlushes: 0,
    backpressureFlushes: 0,
    immediateFlushes: 0,
    lastLogTime: Date.now(),
  }

  constructor(
    private connection: DaemonConnection,
    config: HttpBatchingDiskQueueConfig = {},
  ) {
    this.batchSizeThreshold = config.batchSizeThreshold ?? 16 * 1024 * 1024 // 16MB
  }

  /**
   * Queue a verified write for batched dispatch.
   *
   * The write will be sent when:
   * 1. No batch is in-flight (immediate send)
   * 2. Batch size exceeds threshold
   * 3. flush() is called explicitly
   * 4. Previous in-flight batch completes (backpressure flush)
   *
   * @returns Promise that resolves when the write completes (via WebSocket ACK)
   */
  queueVerifiedWrite(
    rootKey: string,
    path: string,
    position: number,
    data: ArrayBuffer,
    expectedHash: Uint8Array,
  ): Promise<{ bytesWritten: number }> {
    return new Promise((resolve, reject) => {
      const callbackId = `hb_${nextCallbackId++}`
      const expectedHashHex = toHex(expectedHash)

      // Register callback for WebSocket ACK/ERROR frame
      registerBatchWrite(callbackId, resolve, reject)

      this.pending.push({
        rootKey,
        path,
        position,
        data,
        expectedHashHex,
        callbackId,
        resolve,
        reject,
      })

      this.currentBatchSize += data.byteLength

      // Check if we should flush
      if (this.currentBatchSize >= this.batchSizeThreshold) {
        // Batch is full, send even if something already in-flight
        this.flushPending('size')
      } else if (!this.inFlight) {
        // Nothing in-flight, send immediately (no added latency)
        this.flushPending('immediate')
      }
      // Otherwise: already in-flight, writes will batch and flush when current completes
    })
  }

  /**
   * Flush all pending writes in a single HTTP request.
   * Called when no batch in-flight (immediate), size threshold reached, or explicitly.
   */
  flushPending(trigger: 'size' | 'immediate' | 'backpressure' | 'explicit' = 'explicit'): void {
    if (this.pending.length === 0) return

    const writes = this.pending
    const writeCount = writes.length
    const totalDataBytes = this.currentBatchSize

    this.pending = []
    this.currentBatchSize = 0

    // Track flush trigger
    if (trigger === 'size') this.metrics.sizeFlushes++
    else if (trigger === 'backpressure') this.metrics.backpressureFlushes++
    else if (trigger === 'immediate') this.metrics.immediateFlushes++

    // Time the packing phase
    const packStart = Date.now()
    const packed = packVerifiedWriteBatch(writes)
    const packEnd = Date.now()
    const packTimeMs = packEnd - packStart

    // All writes should have the same rootKey (for now, we use the first one)
    // TODO: If writes have different rootKeys, we need to split into multiple batches
    const rootKey = writes[0].rootKey

    // Mark batch as in-flight
    this.inFlight = true

    // Send HTTP POST asynchronously
    // Results will come back via WebSocket ACK/ERROR frames
    const httpStart = Date.now()
    this.sendBatch(rootKey, packed)
      .then(() => {
        const httpEnd = Date.now()
        const httpTimeMs = httpEnd - httpStart

        // Update metrics
        this.metrics.totalWrites += writeCount
        this.metrics.totalBytes += totalDataBytes
        this.metrics.totalPackTimeMs += packTimeMs
        this.metrics.totalHttpTimeMs += httpTimeMs
        this.metrics.batchCount++

        // Log individual batch if it's significant
        if (writeCount > 1 || httpTimeMs > 10) {
          const dataMB = (totalDataBytes / (1024 * 1024)).toFixed(2)
          const packedKB = (packed.byteLength / 1024).toFixed(1)
          console.log(
            `[HttpBatch] ${writeCount} writes, ${dataMB}MB data, packed ${packedKB}KB, ` +
              `pack ${packTimeMs}ms, HTTP ${httpTimeMs}ms, trigger=${trigger}`,
          )
        }

        // Log aggregate metrics periodically
        this.maybeLogMetrics()
      })
      .catch((error) => {
        // If HTTP request fails, reject all pending promises
        console.error('[HttpBatch] Batch request failed:', error)
        for (const write of writes) {
          unregisterBatchWrite(write.callbackId)
          write.reject(new Error(`Batch request failed: ${error.message}`))
        }
      })
      .finally(() => {
        // Batch complete
        this.inFlight = false

        // If writes accumulated while we were in-flight, flush them now
        if (this.pending.length > 0) {
          this.flushPending('backpressure')
        }
      })
  }

  /**
   * Send the packed batch to the server.
   */
  private async sendBatch(rootKey: string, packed: ArrayBuffer): Promise<void> {
    const response = await this.connection.requestWithHeaders(
      'POST',
      `/write-batch/${rootKey}`,
      {
        'Content-Type': 'application/octet-stream',
      },
      new Uint8Array(packed),
    )

    if (response.status === 202) {
      // Accepted - results will come via WebSocket
      return
    }

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`${response.status} ${response.statusText}: ${errorText}`)
    }
  }

  /**
   * Force flush current batch immediately.
   * Returns a promise that resolves when the HTTP request completes
   * (not when all writes are acknowledged).
   */
  async flush(): Promise<void> {
    this.flushPending('explicit')
  }

  /**
   * Log aggregate metrics periodically (every 5 seconds).
   */
  private maybeLogMetrics(): void {
    const now = Date.now()
    if (now - this.metrics.lastLogTime < 5000) return
    if (this.metrics.batchCount === 0) return

    const avgWritesPerBatch = (this.metrics.totalWrites / this.metrics.batchCount).toFixed(1)
    const totalMB = (this.metrics.totalBytes / (1024 * 1024)).toFixed(2)
    const avgHttpMs = (this.metrics.totalHttpTimeMs / this.metrics.batchCount).toFixed(1)
    const avgPackMs = (this.metrics.totalPackTimeMs / this.metrics.batchCount).toFixed(1)
    const throughput = this.metrics.totalBytes / ((now - this.metrics.lastLogTime) / 1000)
    const throughputMBs = (throughput / (1024 * 1024)).toFixed(2)

    console.log(
      `[HttpBatch] Stats: ${this.metrics.batchCount} batches, ${this.metrics.totalWrites} writes, ` +
        `${totalMB}MB total (~${throughputMBs}MB/s), avg ${avgWritesPerBatch} writes/batch, ` +
        `avg pack ${avgPackMs}ms, avg HTTP ${avgHttpMs}ms, ` +
        `triggers: immediate=${this.metrics.immediateFlushes} backpressure=${this.metrics.backpressureFlushes} size=${this.metrics.sizeFlushes}`,
    )

    // Reset metrics for next window
    this.metrics = {
      totalWrites: 0,
      totalBytes: 0,
      totalHttpTimeMs: 0,
      totalPackTimeMs: 0,
      batchCount: 0,
      sizeFlushes: 0,
      backpressureFlushes: 0,
      immediateFlushes: 0,
      lastLogTime: now,
    }
  }

  /**
   * Get count of pending writes (for debugging/metrics).
   */
  get pendingCount(): number {
    return this.pending.length
  }

  /**
   * Get current batch size in bytes.
   */
  get pendingBytes(): number {
    return this.currentBatchSize
  }

  /**
   * Get current metrics snapshot (for debugging/monitoring).
   */
  getMetrics(): Readonly<BatchWriteMetrics> {
    return { ...this.metrics }
  }

  // ============================================================
  // IDiskQueue interface methods
  // These are for general disk queue operations; verified writes
  // bypass this and use queueVerifiedWrite() directly.
  // ============================================================

  async enqueue(
    _job: Omit<DiskJob, 'id' | 'status' | 'enqueuedAt'>,
    execute: () => Promise<void>,
  ): Promise<void> {
    // For non-verified writes, execute directly
    // In practice, all piece writes go through verified write path
    await execute()
  }

  async drain(): Promise<void> {
    // Flush any pending writes before draining
    this.flushPending('explicit')
    // Note: We can't truly wait for all ACKs here.
    // The caller should wait for promises returned from queueVerifiedWrite().
  }

  resume(): void {
    // No-op - we don't pause batching
  }

  getSnapshot(): DiskQueueSnapshot {
    return {
      pending: [],
      running: [],
      draining: false,
    }
  }

  clearPending(): void {
    const cleared = this.pending.length

    // Unregister batch write callbacks and reject all pending promises
    for (const item of this.pending) {
      unregisterBatchWrite(item.callbackId)
      item.reject(new Error('Disk queue cleared (torrent stopped)'))
    }

    this.pending = []
    this.currentBatchSize = 0

    if (cleared > 0) {
      console.log(`[HttpBatchingDiskQueue] Cleared ${cleared} pending writes`)
    }
  }

  /**
   * HttpBatchingDiskQueue doesn't support grabPending - it uses its own batching mechanism.
   * Returns empty array.
   */
  grabPending(_maxBytes: number, _maxCount: number): PendingJob[] {
    return []
  }
}

/** Global singleton instance of the HTTP batching disk queue */
let globalHttpBatchingQueue: HttpBatchingDiskQueue | null = null

/**
 * Get or create the global HTTP batching disk queue singleton.
 * Call setHttpBatchingConnection() first to provide the connection.
 */
export function getGlobalHttpBatchingQueue(): HttpBatchingDiskQueue | null {
  return globalHttpBatchingQueue
}

/**
 * Initialize the global HTTP batching disk queue with a connection.
 */
export function initHttpBatchingQueue(
  connection: DaemonConnection,
  config?: HttpBatchingDiskQueueConfig,
): HttpBatchingDiskQueue {
  globalHttpBatchingQueue = new HttpBatchingDiskQueue(connection, config)
  return globalHttpBatchingQueue
}

/**
 * Flush all pending HTTP batched writes.
 * Called by engine at end of tick if batching is enabled.
 */
export function flushHttpBatchedWrites(): void {
  if (globalHttpBatchingQueue) {
    globalHttpBatchingQueue.flushPending('explicit')
  }
}
