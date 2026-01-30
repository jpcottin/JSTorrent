export type DiskJobType = 'write' | 'read'
export type DiskJobStatus = 'pending' | 'running'

export interface DiskJob {
  id: number
  type: DiskJobType
  pieceIndex: number
  fileCount: number // How many files this job touches
  size: number // Bytes
  status: DiskJobStatus
  enqueuedAt: number // Timestamp when enqueued
  startedAt?: number // Timestamp when started running
}

export interface DiskQueueSnapshot {
  pending: DiskJob[]
  running: DiskJob[]
  draining: boolean
}

export interface IDiskQueue {
  enqueue(
    job: Omit<DiskJob, 'id' | 'status' | 'enqueuedAt'>,
    execute: () => Promise<void>,
    batchData?: VerifiedWriteBatchData,
  ): Promise<void>
  drain(): Promise<void>
  resume(): void
  getSnapshot(): DiskQueueSnapshot
  /**
   * Clear all pending jobs from the queue (running jobs continue to completion).
   * The promises returned by enqueue() for cleared jobs will reject with an error.
   * Use this when stopping a torrent to prevent stale writes from accumulating.
   */
  clearPending(): void
  /**
   * Flush any pending batched writes.
   * Called at end of tick to send accumulated writes in a single FFI call.
   * Default implementation is no-op (for non-batching queues).
   */
  flushPending?(): void

  /** Total bytes in pending jobs (jobs waiting for a worker) */
  readonly pendingBytes: number

  /** Number of jobs waiting for a worker */
  readonly pendingCount: number

  /**
   * Atomically dequeue pending jobs up to limits for batching.
   * Used by workers to grab additional jobs when there's a backlog.
   * Returns the grabbed PendingJob items so caller can execute them.
   *
   * @param maxBytes Maximum total bytes to grab
   * @param maxCount Maximum number of jobs to grab
   * @param filter Optional filter function - only grab jobs that match
   */
  grabPending(
    maxBytes: number,
    maxCount: number,
    filter?: (job: PendingJob) => boolean,
  ): PendingJob[]
}

// Default concurrent disk workers for TorrentDiskQueue (extension/daemon mode)
const DEFAULT_DISK_WORKERS = 5

export interface DiskQueueConfig {
  maxWorkers: number
}

/**
 * Data needed to batch a verified write with other writes.
 * Stored on PendingJob so batching logic can combine multiple writes into one HTTP request.
 */
export interface VerifiedWriteBatchData {
  /** DaemonFileHandle (or compatible) that supports writeBatch() */
  fileHandle: unknown // typed as unknown to avoid circular dependency; cast to DaemonFileHandle in usage
  /** Offset within the file (not torrent offset) */
  fileRelativeOffset: number
  /** The piece data to write */
  data: Uint8Array
  /** Expected SHA1 hash for verification */
  expectedHash: Uint8Array
  /** Key identifying the file (rootKey:path) for filtering during grab */
  fileKey: string
}

export interface PendingJob {
  job: DiskJob
  execute: () => Promise<void>
  resolve: () => void
  reject: (reason: Error) => void
  /** Optional batch data for verified writes that support batching */
  batchData?: VerifiedWriteBatchData
}

export class TorrentDiskQueue implements IDiskQueue {
  private nextId = 1
  private pending: PendingJob[] = []
  private running: Map<number, DiskJob> = new Map()
  private draining = false
  private drainResolve: (() => void) | null = null
  private config: DiskQueueConfig
  private _pendingBytes = 0

  constructor(config: Partial<DiskQueueConfig> = {}) {
    this.config = {
      maxWorkers: config.maxWorkers ?? DEFAULT_DISK_WORKERS,
    }
  }

  /** Total bytes in pending jobs (jobs waiting for a worker) */
  get pendingBytes(): number {
    return this._pendingBytes
  }

  /** Number of jobs waiting for a worker */
  get pendingCount(): number {
    return this.pending.length
  }

  async enqueue(
    jobData: Omit<DiskJob, 'id' | 'status' | 'enqueuedAt'>,
    execute: () => Promise<void>,
    /** Optional batch data for verified writes that support batching */
    batchData?: VerifiedWriteBatchData,
  ): Promise<void> {
    const job: DiskJob = {
      ...jobData,
      id: this.nextId++,
      status: 'pending',
      enqueuedAt: Date.now(),
    }

    return new Promise((resolve, reject) => {
      this.pending.push({
        job,
        resolve,
        reject,
        batchData,
        execute: async () => {
          try {
            await execute()
            resolve()
          } catch (e) {
            reject(e as Error)
          }
        },
      })
      this._pendingBytes += job.size
      this.schedule()
    })
  }

  private schedule(): void {
    if (this.draining) return

    const beforeRunning = this.running.size
    const beforePending = this.pending.length
    let started = 0

    while (this.running.size < this.config.maxWorkers && this.pending.length > 0) {
      const item = this.pending.shift()!
      this._pendingBytes -= item.job.size
      this.startJob(item.job, item.execute)
      started++
    }

    if (started > 0 || beforePending > 0) {
      console.log(
        `[DiskQueue] schedule: started=${started}, running=${beforeRunning}->${this.running.size}, pending=${beforePending}->${this.pending.length}`,
      )
    }
  }

  private startJob(job: DiskJob, execute: () => Promise<void>): void {
    job.status = 'running'
    job.startedAt = Date.now()
    this.running.set(job.id, job)

    execute().finally(() => {
      this.running.delete(job.id)

      // Check if drain is waiting
      if (this.draining && this.running.size === 0) {
        this.drainResolve?.()
      }

      this.schedule()
    })
  }

  async drain(): Promise<void> {
    this.draining = true

    if (this.running.size === 0) {
      return
    }

    return new Promise((resolve) => {
      this.drainResolve = resolve
    })
  }

  resume(): void {
    this.draining = false
    this.drainResolve = null
    this.schedule()
  }

  getSnapshot(): DiskQueueSnapshot {
    return {
      pending: this.pending.map((p) => ({ ...p.job })),
      running: [...this.running.values()].map((j) => ({ ...j })),
      draining: this.draining,
    }
  }

  clearPending(): void {
    const cleared = this.pending.length
    // Reject all pending job promises
    for (const item of this.pending) {
      item.reject(new Error('Disk queue cleared (torrent stopped)'))
    }
    this.pending = []
    this._pendingBytes = 0
    // Also reset draining state to clean state
    this.draining = false
    this.drainResolve = null
    if (cleared > 0) {
      console.log(`[DiskQueue] Cleared ${cleared} pending jobs`)
    }
  }

  /**
   * Atomically grab pending jobs up to limits for batching.
   * Used by workers to grab additional jobs when there's a backlog.
   * Returns the grabbed PendingJob items so caller can execute them.
   *
   * @param maxBytes Maximum total bytes to grab
   * @param maxCount Maximum number of jobs to grab
   * @param filter Optional filter function - only grab jobs that match
   */
  grabPending(
    maxBytes: number,
    maxCount: number,
    filter?: (job: PendingJob) => boolean,
  ): PendingJob[] {
    const grabbed: PendingJob[] = []
    let grabbedBytes = 0

    if (!filter) {
      // Fast path: no filter, grab from front
      while (this.pending.length > 0 && grabbed.length < maxCount && grabbedBytes < maxBytes) {
        const item = this.pending.shift()!
        this._pendingBytes -= item.job.size
        grabbedBytes += item.job.size
        grabbed.push(item)
      }
    } else {
      // Filter path: scan for matching jobs
      const remaining: PendingJob[] = []
      for (const item of this.pending) {
        if (grabbed.length < maxCount && grabbedBytes < maxBytes && filter(item)) {
          this._pendingBytes -= item.job.size
          grabbedBytes += item.job.size
          grabbed.push(item)
        } else {
          remaining.push(item)
        }
      }
      this.pending = remaining
    }

    return grabbed
  }
}

/**
 * Passthrough disk queue for Android/QuickJS.
 *
 * Immediately executes writes without JS-side queuing. The actual batching
 * happens in NativeBatchingDiskQueue which collects writes during a tick
 * and flushes them in a single FFI call at end of tick.
 *
 * Use this instead of TorrentDiskQueue for Android where:
 * - Writes go through NativeFileHandle → NativeBatchingDiskQueue
 * - Batching happens at the FFI layer, not in JS
 * - Concurrency is controlled by active pieces limit, not worker pool
 */
export class PassthroughDiskQueue implements IDiskQueue {
  async enqueue(
    _job: Omit<DiskJob, 'id' | 'status' | 'enqueuedAt'>,
    execute: () => Promise<void>,
    _batchData?: VerifiedWriteBatchData,
  ): Promise<void> {
    // Execute immediately - batching happens in NativeBatchingDiskQueue
    await execute()
  }

  async drain(): Promise<void> {
    // No-op - nothing queued on JS side
  }

  resume(): void {
    // No-op
  }

  getSnapshot(): DiskQueueSnapshot {
    return { pending: [], running: [], draining: false }
  }

  clearPending(): void {
    // No-op - nothing queued on JS side
  }

  // PassthroughDiskQueue has no pending jobs - batching happens at NativeBatchingDiskQueue layer
  get pendingBytes(): number {
    return 0
  }

  get pendingCount(): number {
    return 0
  }

  grabPending(
    _maxBytes: number,
    _maxCount: number,
    _filter?: (job: PendingJob) => boolean,
  ): PendingJob[] {
    return []
  }
}
