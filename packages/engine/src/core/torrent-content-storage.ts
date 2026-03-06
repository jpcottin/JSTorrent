import { IStorageHandle } from '../io/storage-handle'
import { IFileHandle } from '../interfaces/filesystem'
import {
  supportsVerifiedWrite,
  DaemonFileHandle,
  BatchWriteItem,
} from '../adapters/daemon/daemon-file-handle'
import { TorrentFile } from './torrent-file'
import { EngineComponent, ILoggingEngine } from '../logging/logger'
import { IDiskQueue, VerifiedWriteBatchData, PendingJob } from './disk-queue'

// Adaptive batching configuration
// When queue backlog exceeds threshold, workers grab additional jobs and batch them
// Only supported by Android companion app (ChromeOS), not Rust io-daemon (desktop)

// Queue depth (bytes) below which we send single writes for low latency
const LOW_BACKLOG_THRESHOLD = 5 * 1024 * 1024 // 5 MB

// Max bytes to grab for a batch
const MAX_BATCH_BYTES = 16 * 1024 * 1024 // 16 MB

// Max pieces per batch
const MAX_BATCH_COUNT = 64

// Bound total raw data retained by concurrent adaptive batches in the companion
// path. Multiple piece-sized batch bodies in flight can otherwise recreate the
// same memory cliff we saw on Android standalone.
const MAX_IN_FLIGHT_BATCH_BYTES = 32 * 1024 * 1024

// Negative-cache TTL for failed file opens.
// Prevents repeated open spam in hot paths while allowing recovery if files/folders reappear.
const FAILED_OPEN_CACHE_TTL_MS = 10_000

export class TorrentContentStorage extends EngineComponent {
  static logName = 'content-storage'
  private files: TorrentFile[] = []
  /**
   * Cached file handles. For Node.js filesystem, this avoids repeated fs.open() syscalls.
   * For daemon filesystem, handles are stateless so caching is a no-op but harmless.
   */
  private fileHandles: Map<string, IFileHandle> = new Map()
  private openingFiles: Map<string, Promise<IFileHandle>> = new Map()
  /**
   * Paths that failed to open (e.g., missing parent directory), keyed by failure timestamp.
   * This negative cache avoids repeated open attempts in hot paths, but entries
   * expire so external filesystem changes can recover without requiring close().
   */
  private failedPaths: Map<string, number> = new Map()
  private pieceLength: number = 0
  private filePriorities: number[] = []

  private id = Math.random().toString(36).slice(2, 7)

  /** Total raw data bytes currently retained by in-flight adaptive batches */
  private batchBytesInFlight = 0

  constructor(
    engine: ILoggingEngine,
    private storageHandle: IStorageHandle,
    private diskQueue?: IDiskQueue,
    /** Enable adaptive batching. Only supported by Android companion (ChromeOS). */
    private adaptiveBatching: boolean = false,
  ) {
    super(engine)
    this.logger.debug(
      `TorrentContentStorage: Created instance ${this.id} for storage ${storageHandle.name}`,
    )
  }

  async open(files: TorrentFile[], pieceLength: number) {
    this.files = files
    this.pieceLength = pieceLength
    // Initialize all file priorities to 0 (normal/wanted)
    this.filePriorities = new Array(files.length).fill(0)
    this.logger.debug(`DiskManager ${this.id}: Opened with ${files.length} files`)

    // Pre-open files or open on demand? Let's open on demand for now to save resources,
    // but for simplicity in this phase, we might just open them all if the list is small.
    // Let's stick to open-on-demand logic implicitly in read/write.
  }

  /**
   * Update file priorities. Priority 1 = skipped, 0 = normal.
   * Used by boundary piece writes to know which files to skip.
   */
  setFilePriorities(priorities: number[]): void {
    this.filePriorities = priorities.slice()
    this.logger.debug(`DiskManager ${this.id}: Updated file priorities`)
  }

  get filesList(): TorrentFile[] {
    return this.files
  }

  /**
   * Get the storage handle for this content storage.
   */
  get storage(): IStorageHandle {
    return this.storageHandle
  }

  getTotalSize(): number {
    return this.files.reduce((sum, f) => sum + f.length, 0)
  }

  async close() {
    this.logger.debug(`DiskManager ${this.id}: Closing all files`)
    // Wait for any pending opens?
    // Ideally we should wait, but for now just close what we have.
    for (const [path, handle] of this.fileHandles) {
      this.logger.debug(`DiskManager ${this.id}: Closing file ${path}`)
      await handle.close()
    }
    this.fileHandles.clear()
    this.openingFiles.clear()
    // Clear failed paths so re-added files are detected on next recheck
    this.failedPaths.clear()
  }

  /**
   * Get or open a file handle, caching for reuse.
   *
   * Caching is an optimization for Node.js where file descriptors are expensive to open.
   * For daemon filesystem, handles are stateless (each read/write is a separate RPC call),
   * so caching just stores metadata objects with no real benefit.
   */
  private async getFileHandle(path: string): Promise<IFileHandle> {
    // Fast path: recent failure is still within negative-cache TTL.
    const failedAt = this.failedPaths.get(path)
    if (failedAt !== undefined) {
      if (Date.now() - failedAt < FAILED_OPEN_CACHE_TTL_MS) {
        throw new Error(`File open failed (cached): ${path}`)
      }
      // Expired failure cache entry - retry open.
      this.failedPaths.delete(path)
    }

    if (this.fileHandles.has(path)) {
      return this.fileHandles.get(path)!
    }

    if (this.openingFiles.has(path)) {
      // this.logger.debug(`DiskManager ${this.id}: Waiting for pending open '${path}'`)
      return this.openingFiles.get(path)!
    }

    this.logger.debug(
      `DiskManager ${this.id}: Opening file '${path}' (cache miss). Current keys: ${Array.from(this.fileHandles.keys())}`,
    )

    // Important: We must add to openingFiles BEFORE starting the async work,
    // and ensure cleanup happens even if getFileSystem() throws synchronously.
    // Using a wrapper promise that handles both sync and async errors properly.
    const openPromise = (async () => {
      try {
        const fs = this.storageHandle.getFileSystem()
        const handle = await fs.open(path, 'r+')
        this.fileHandles.set(path, handle)
        this.logger.debug(
          `DiskManager ${this.id}: Set handle for '${path}'. Keys now: ${Array.from(this.fileHandles.keys())}`,
        )
        return handle
      } catch (err) {
        // Cache the failure to avoid repeated open attempts for missing files
        this.failedPaths.set(path, Date.now())
        this.logger.debug(`DiskManager ${this.id}: File open failed, caching: '${path}'`)
        throw err
      }
    })()

    this.openingFiles.set(path, openPromise)

    // Clean up openingFiles when done (success or failure)
    // Consume the cleanup chain rejection to avoid unhandled-rejection noise when open fails.
    openPromise
      .finally(() => {
        this.openingFiles.delete(path)
      })
      .catch(() => {})

    return openPromise
  }

  async write(index: number, begin: number, data: Uint8Array): Promise<void> {
    const torrentOffset = index * this.pieceLength + begin
    let remaining = data.length
    let dataOffset = 0
    let currentTorrentOffset = torrentOffset

    // Find the first file that contains this offset
    // Optimization: Could use binary search or keep track of last used file
    for (const file of this.files) {
      const fileEnd = file.offset + file.length

      if (currentTorrentOffset >= file.offset && currentTorrentOffset < fileEnd) {
        // We found the starting file
        const fileRelativeOffset = currentTorrentOffset - file.offset
        const bytesToWrite = Math.min(remaining, file.length - fileRelativeOffset)

        this.logger.debug(
          `DiskManager: Writing to ${file.path}, fileRelOffset=${fileRelativeOffset}, bytes=${bytesToWrite}, dataOffset=${dataOffset}`,
        )

        const handle = await this.getFileHandle(file.path)
        await handle.write(data, dataOffset, bytesToWrite, fileRelativeOffset)

        remaining -= bytesToWrite
        dataOffset += bytesToWrite
        currentTorrentOffset += bytesToWrite

        if (remaining === 0) break
      }
    }

    if (remaining > 0) {
      throw new Error('Write out of bounds')
    }
  }

  /**
   * Write a complete piece (all data at once).
   * More efficient than multiple write() calls for small blocks.
   */
  async writePiece(pieceIndex: number, data: Uint8Array): Promise<void> {
    await this.write(pieceIndex, 0, data)
  }

  /**
   * Write a piece, but only to files that are not skipped (priority !== 1).
   * Used for boundary pieces to write their wanted portions to disk immediately.
   * Skipped file portions are stored in .parts file separately.
   */
  async writePieceFilteredByPriority(pieceIndex: number, data: Uint8Array): Promise<void> {
    const torrentOffset = pieceIndex * this.pieceLength
    let remaining = data.length
    let dataOffset = 0
    let currentTorrentOffset = torrentOffset

    for (let fileIndex = 0; fileIndex < this.files.length; fileIndex++) {
      const file = this.files[fileIndex]
      const fileEnd = file.offset + file.length

      if (currentTorrentOffset >= file.offset && currentTorrentOffset < fileEnd) {
        const fileRelativeOffset = currentTorrentOffset - file.offset
        const bytesToWrite = Math.min(remaining, file.length - fileRelativeOffset)

        // Skip writing to files that are skipped (priority === 1)
        if (this.filePriorities[fileIndex] !== 1) {
          this.logger.debug(
            `DiskManager: Writing filtered to ${file.path}, fileRelOffset=${fileRelativeOffset}, bytes=${bytesToWrite}`,
          )

          const handle = await this.getFileHandle(file.path)
          await handle.write(data, dataOffset, bytesToWrite, fileRelativeOffset)
        } else {
          this.logger.debug(
            `DiskManager: Skipping write to ${file.path} (file skipped), bytes=${bytesToWrite}`,
          )
        }

        remaining -= bytesToWrite
        dataOffset += bytesToWrite
        currentTorrentOffset += bytesToWrite

        if (remaining === 0) break
      }
    }
  }

  /**
   * Check if a piece fits entirely within a single file.
   * Used to determine if verified write can be used.
   */
  private pieceSpansSingleFile(pieceIndex: number, pieceLength: number): TorrentFile | null {
    const torrentOffset = pieceIndex * this.pieceLength
    const torrentEnd = torrentOffset + pieceLength

    for (const file of this.files) {
      const fileEnd = file.offset + file.length
      // Check if the entire piece is within this file
      if (torrentOffset >= file.offset && torrentEnd <= fileEnd) {
        return file
      }
    }
    return null
  }

  /**
   * Count how many files a write at the given torrent offset and length touches.
   */
  private countFilesTouched(torrentOffset: number, length: number): number {
    let count = 0
    let remaining = length
    let currentOffset = torrentOffset

    for (const file of this.files) {
      const fileEnd = file.offset + file.length
      if (currentOffset >= file.offset && currentOffset < fileEnd) {
        count++
        const bytesInFile = Math.min(remaining, fileEnd - currentOffset)
        remaining -= bytesInFile
        currentOffset += bytesInFile
        if (remaining === 0) break
      }
    }
    return count
  }

  /**
   * Write a complete piece with optional hash verification.
   * If a disk queue is configured, the write is queued for concurrency control.
   * If expectedHash is provided and the piece fits in a single file with a handle
   * that supports verified writes, the hash verification happens atomically
   * in the io-daemon.
   *
   * When adaptive batching is enabled (USE_ADAPTIVE_BATCHING=1), workers check
   * queue depth and batch multiple writes together when there's a backlog.
   *
   * @param pieceIndex The piece index
   * @param data The piece data
   * @param expectedHash Optional SHA1 hash to verify (raw bytes, not hex)
   * @returns true if verified write was used, false if caller should verify
   */
  async writePieceVerified(
    pieceIndex: number,
    data: Uint8Array,
    expectedHash?: Uint8Array,
  ): Promise<boolean> {
    const torrentOffset = pieceIndex * this.pieceLength
    const fileCount = this.countFilesTouched(torrentOffset, data.length)

    // Check if this piece can use verified write (single file + DaemonFileHandle)
    let canBatch = false
    let singleFile: TorrentFile | null = null
    let handle: IFileHandle | null = null
    let fileRelativeOffset = 0

    if (expectedHash) {
      singleFile = this.pieceSpansSingleFile(pieceIndex, data.length)
      if (singleFile) {
        handle = await this.getFileHandle(singleFile.path)
        if (supportsVerifiedWrite(handle)) {
          fileRelativeOffset = torrentOffset - singleFile.offset
          canBatch = this.adaptiveBatching
        }
      }
    }

    // The actual write logic (used when not batching or as fallback)
    const doWrite = async (): Promise<boolean> => {
      // Check if we can use verified write
      if (expectedHash && singleFile && handle && supportsVerifiedWrite(handle)) {
        this.logger.debug(
          `Piece ${pieceIndex}: singleFile=${singleFile.path}, supportsVerifiedWrite=true`,
        )
        // Use verified write - hash check happens in native layer
        handle.setExpectedHashForNextWrite(expectedHash)
        await handle.write(data, 0, data.length, fileRelativeOffset)
        return true // Verified write was used
      }

      if (expectedHash && !singleFile) {
        this.logger.debug(`Piece ${pieceIndex}: spans multiple files, using sync write`)
      }

      // Fall back to regular write (caller should verify hash)
      await this.write(pieceIndex, 0, data)
      return false
    }

    // If no queue configured, execute directly
    if (!this.diskQueue) {
      return doWrite()
    }

    // Create batch data if batching is possible
    let batchData: VerifiedWriteBatchData | undefined
    if (canBatch && handle && expectedHash) {
      const daemonHandle = handle as DaemonFileHandle
      batchData = {
        fileHandle: daemonHandle,
        fileRelativeOffset,
        // Copy the data now to avoid race with buffer pool recycling.
        // The original piece buffer may be released back to the pool after
        // writePieceVerified returns, but before the batch write executes.
        // This copy has byteOffset=0 and buffer.byteLength===data.length,
        // so writeBatch can use .buffer directly without slicing.
        data: data.slice(),
        expectedHash,
        fileKey: `${singleFile!.path}`, // Unique key for this file
      }
    }

    // Log batching setup (once per 100 pieces to avoid spam)
    if (this.adaptiveBatching && pieceIndex % 100 === 0) {
      this.logger.info(
        `[Batch] piece=${pieceIndex}: canBatch=${canBatch}, batchData=${!!batchData}, expectedHash=${!!expectedHash}, singleFile=${!!singleFile}, supportsVerified=${handle ? supportsVerifiedWrite(handle) : 'no-handle'}`,
      )
    }

    // Queue the write for concurrency control
    let result = false
    await this.diskQueue.enqueue(
      {
        type: 'write',
        pieceIndex,
        fileCount,
        size: data.length,
      },
      async () => {
        // If batching is enabled, there's a backlog, and we have capacity, try to batch
        if (
          batchData &&
          this.batchBytesInFlight + batchData.data.byteLength <= MAX_IN_FLIGHT_BATCH_BYTES
        ) {
          const pendingBytes = this.diskQueue!.pendingBytes
          if (pendingBytes > LOW_BACKLOG_THRESHOLD) {
            const batched = await this.tryBatchWrite(batchData)
            if (batched) {
              result = true
              return
            }
            // tryBatchWrite returned false (no extras found), fall through to single write
          }
        }

        // Fall back to single write
        result = await doWrite()
      },
      batchData,
    )
    return result
  }

  /**
   * Try to batch the current write with other pending writes to the same file.
   * Returns true if batching was performed, false if caller should fall back to single write.
   */
  private async tryBatchWrite(currentBatchData: VerifiedWriteBatchData): Promise<boolean> {
    if (!this.diskQueue) return false

    const fileKey = currentBatchData.fileKey
    const daemonHandle = currentBatchData.fileHandle as DaemonFileHandle
    const currentBytes = currentBatchData.data.byteLength
    const budgetRemaining = MAX_IN_FLIGHT_BATCH_BYTES - this.batchBytesInFlight

    if (budgetRemaining <= currentBytes) {
      return false
    }

    // Grab additional pending jobs for the same file
    const extras = this.diskQueue.grabPending(
      Math.min(MAX_BATCH_BYTES - currentBytes, budgetRemaining - currentBytes),
      MAX_BATCH_COUNT - 1, // Reserve one slot for current write
      (job: PendingJob) => job.batchData?.fileKey === fileKey,
    )

    // If no extras, don't batch (single write is more efficient)
    if (extras.length === 0) {
      return false
    }

    this.logger.info(
      `[Batch] Adaptive batching: combining 1 + ${extras.length} writes for file ${fileKey}`,
    )

    // Build batch write items: current + extras
    const writes: BatchWriteItem[] = [
      {
        offset: currentBatchData.fileRelativeOffset,
        data: currentBatchData.data,
        expectedHash: currentBatchData.expectedHash,
      },
    ]

    // Debug: log first write's position and hash
    const firstHashHex = Array.from(currentBatchData.expectedHash)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
    this.logger.debug(
      `[Batch] First write: offset=${currentBatchData.fileRelativeOffset}, hash=${firstHashHex.slice(0, 8)}..., dataLen=${currentBatchData.data.length}`,
    )

    for (const extra of extras) {
      if (extra.batchData) {
        writes.push({
          offset: extra.batchData.fileRelativeOffset,
          data: extra.batchData.data,
          expectedHash: extra.batchData.expectedHash,
        })

        // Debug: log each extra's position and hash
        const extraHashHex = Array.from(extra.batchData.expectedHash)
          .map((b) => b.toString(16).padStart(2, '0'))
          .join('')
        this.logger.debug(
          `[Batch] Extra write: offset=${extra.batchData.fileRelativeOffset}, hash=${extraHashHex.slice(0, 8)}..., dataLen=${extra.batchData.data.length}`,
        )
      }
    }

    const batchBytes = writes.reduce((sum, write) => sum + write.data.byteLength, 0)
    this.batchBytesInFlight += batchBytes
    try {
      // Send all writes in a single HTTP request
      await daemonHandle.writeBatch(writes)

      // Resolve all extra jobs (current job is resolved by enqueue wrapper)
      for (const extra of extras) {
        extra.resolve()
      }

      return true
    } catch (error) {
      // On error, reject all extra jobs
      for (const extra of extras) {
        extra.reject(error as Error)
      }
      // Re-throw so current job also fails
      throw error
    } finally {
      this.batchBytesInFlight = Math.max(0, this.batchBytesInFlight - batchBytes)
    }
  }

  async read(index: number, begin: number, length: number): Promise<Uint8Array> {
    const buffer = new Uint8Array(length)
    const torrentOffset = index * this.pieceLength + begin
    let remaining = length
    let bufferOffset = 0
    let currentTorrentOffset = torrentOffset

    for (const file of this.files) {
      const fileEnd = file.offset + file.length

      if (currentTorrentOffset >= file.offset && currentTorrentOffset < fileEnd) {
        const fileRelativeOffset = currentTorrentOffset - file.offset
        const bytesToRead = Math.min(remaining, file.length - fileRelativeOffset)

        const handle = await this.getFileHandle(file.path)
        await handle.read(buffer, bufferOffset, bytesToRead, fileRelativeOffset)

        remaining -= bytesToRead
        bufferOffset += bytesToRead
        currentTorrentOffset += bytesToRead

        if (remaining === 0) break
      }
    }

    if (remaining > 0) {
      throw new Error('Read out of bounds')
    }

    return buffer
  }
}
