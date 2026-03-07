import { IStorageHandle } from '../io/storage-handle'
import { EngineComponent, ILoggingEngine } from '../logging/logger'

/**
 * Manages the .parts file for storing boundary pieces.
 *
 * Boundary pieces span both skipped and non-skipped files.
 * They are stored in the .parts file until all files they touch are un-skipped,
 * at which point they can be materialized to regular files.
 *
 * Format:
 * - Fixed-size header with piece -> slot mapping metadata
 * - Piece-sized slots storing raw payload bytes
 */
export class PartsFile extends EngineComponent {
  static logName = 'parts-file'

  private static readonly MAGIC = new Uint8Array([0x4a, 0x53, 0x50, 0x54]) // "JSPT"
  private static readonly VERSION = 1
  private static readonly FIXED_HEADER_SIZE = 16
  private static readonly ENTRY_SIZE = 8
  private static readonly HEADER_ALIGNMENT = 1024

  private filename: string
  private data: Map<number, Uint8Array> = new Map()
  private slots: Map<number, { slot: number; length: number }> = new Map()
  private freeSlots: number[] = []
  private nextSlot = 0
  private dirtyPieces: Set<number> = new Set()
  private dirtyMetadata = false

  constructor(
    engine: ILoggingEngine,
    private storageHandle: IStorageHandle,
    torrentInfoHash: string,
    private numPieces: number,
    private pieceLength: number,
  ) {
    super(engine)
    this.filename = `${torrentInfoHash}.parts`
    this.instanceLogName = `parts:${torrentInfoHash.slice(0, 6)}`
    if (numPieces <= 0) {
      throw new Error(`Invalid .parts numPieces: ${numPieces}`)
    }
    if (pieceLength <= 0) {
      throw new Error(`Invalid .parts pieceLength: ${pieceLength}`)
    }
  }

  /**
   * Get the set of piece indices currently stored in the .parts file.
   */
  get pieces(): Set<number> {
    return new Set(this.slots.keys())
  }

  /**
   * Check if a piece is stored in .parts.
   */
  hasPiece(index: number): boolean {
    return this.slots.has(index)
  }

  /**
   * Get piece data from .parts.
   */
  getPiece(index: number): Uint8Array | undefined {
    return this.data.get(index)
  }

  /**
   * Add a piece to .parts (in-memory only until flush is called).
   */
  addPiece(index: number, data: Uint8Array): void {
    this.validatePieceIndex(index)
    if (data.length > this.pieceLength) {
      throw new Error(
        `Piece ${index} too large for .parts slot: ${data.length} > ${this.pieceLength}`,
      )
    }

    let slot = this.slots.get(index)?.slot
    if (slot === undefined) {
      slot = this.allocateSlot()
      this.dirtyMetadata = true
    }

    this.data.set(index, data)
    this.slots.set(index, { slot, length: data.length })
    this.dirtyPieces.add(index)
    this.dirtyMetadata = true
    this.logger.debug(`Added piece ${index} to .parts (${data.length} bytes)`)
  }

  /**
   * Remove a piece from .parts (in-memory only until flush is called).
   */
  removePiece(index: number): boolean {
    const entry = this.slots.get(index)
    if (entry) {
      this.data.delete(index)
      this.slots.delete(index)
      this.dirtyPieces.delete(index)
      this.freeSlots.push(entry.slot)
      this.dirtyMetadata = true
      this.logger.debug(`Removed piece ${index} from .parts`)
      return true
    }
    return false
  }

  /**
   * Load the .parts file from disk.
   * Call this on startup before using the PartsFile.
   */
  async load(): Promise<void> {
    this.resetState()

    try {
      const fs = this.storageHandle.getFileSystem()

      const exists = await fs.exists(this.filename)
      if (!exists) {
        this.logger.debug(`.parts file does not exist, starting fresh`)
        return
      }

      const stat = await fs.stat(this.filename)
      let discardReason: string | null = null

      const handle = await fs.open(this.filename, 'r')
      try {
        if (stat.size < PartsFile.FIXED_HEADER_SIZE) {
          discardReason = '.parts file too short'
        } else {
          const fixedHeader = new Uint8Array(PartsFile.FIXED_HEADER_SIZE)
          const fixedRead = await handle.read(
            fixedHeader,
            0,
            PartsFile.FIXED_HEADER_SIZE,
            0,
          )
          if (fixedRead.bytesRead !== PartsFile.FIXED_HEADER_SIZE) {
            discardReason = '.parts fixed header truncated'
          } else if (!this.hasMagic(fixedHeader)) {
            discardReason = 'Discarding legacy or unknown .parts format'
          } else if (fixedHeader[4] !== PartsFile.VERSION) {
            discardReason = `Unsupported .parts version ${fixedHeader[4]}`
          } else {
            const fixedView = new DataView(
              fixedHeader.buffer,
              fixedHeader.byteOffset,
              fixedHeader.byteLength,
            )
            const fileNumPieces = fixedView.getUint32(8, true)
            const filePieceLength = fixedView.getUint32(12, true)
            if (fileNumPieces !== this.numPieces || filePieceLength !== this.pieceLength) {
              discardReason =
                '.parts metadata does not match torrent layout, discarding file'
            } else {
              const header = new Uint8Array(this.headerSize)
              const headerRead = await handle.read(header, 0, this.headerSize, 0)
              if (headerRead.bytesRead !== this.headerSize) {
                discardReason = '.parts header truncated'
              } else {
                const headerView = new DataView(
                  header.buffer,
                  header.byteOffset,
                  header.byteLength,
                )
                const usedSlots = new Set<number>()
                let maxSlot = -1

                for (let index = 0; index < this.numPieces; index++) {
                  const offset = PartsFile.FIXED_HEADER_SIZE + index * PartsFile.ENTRY_SIZE
                  const slot = headerView.getInt32(offset, true)
                  const length = headerView.getUint32(offset + 4, true)
                  if (slot === -1) {
                    if (length !== 0) {
                      discardReason = `.parts header invalid for piece ${index}`
                    }
                    continue
                  }
                  if (slot < 0 || length === 0 || length > this.pieceLength) {
                    discardReason = `.parts entry invalid for piece ${index}`
                    break
                  }
                  if (usedSlots.has(slot)) {
                    discardReason = `.parts slot ${slot} is duplicated`
                    break
                  }
                  if (this.slotOffset(slot) + length > stat.size) {
                    discardReason = `.parts payload truncated for piece ${index}`
                    break
                  }

                  usedSlots.add(slot)
                  this.slots.set(index, { slot, length })
                  if (slot > maxSlot) maxSlot = slot
                }

                if (!discardReason) {
                  this.nextSlot = maxSlot + 1
                  for (let slot = 0; slot < this.nextSlot; slot++) {
                    if (!usedSlots.has(slot)) this.freeSlots.push(slot)
                  }

                  for (const [index, entry] of this.slots) {
                    const pieceData = new Uint8Array(entry.length)
                    const read = await handle.read(
                      pieceData,
                      0,
                      entry.length,
                      this.slotOffset(entry.slot),
                    )
                    if (read.bytesRead !== entry.length) {
                      discardReason = `.parts payload truncated while reading piece ${index}`
                      break
                    }
                    this.data.set(index, pieceData)
                  }
                }
              }
            }
          }
        }
      } finally {
        await handle.close()
      }

      if (discardReason) {
        this.logger.warn(discardReason)
        await this.discardFile()
        return
      }

      this.logger.info(`Loaded ${this.data.size} pieces from .parts file`)
    } catch (e) {
      this.logger.warn(`.parts file load failed, discarding: ${e instanceof Error ? e.message : String(e)}`)
      await this.discardFile()
    }
  }

  /**
   * Flush changes to disk.
   * Writes directly to the .parts file with fsync for durability.
   *
   * If the .parts file becomes empty, it is deleted.
   */
  async flush(): Promise<void> {
    if (!this.dirtyMetadata && this.dirtyPieces.size === 0) return

    const fs = this.storageHandle.getFileSystem()

    if (this.slots.size === 0) {
      try {
        await fs.delete(this.filename)
        this.logger.info(`Deleted empty .parts file`)
      } catch {
        // File may not exist, that's fine.
      }
      this.dirtyMetadata = false
      this.dirtyPieces.clear()
      return
    }

    const exists = await fs.exists(this.filename)
    const handle = await fs.open(this.filename, exists ? 'r+' : 'w')
    try {
      for (const index of this.dirtyPieces) {
        const entry = this.slots.get(index)
        const pieceData = this.data.get(index)
        if (!entry || !pieceData) continue
        await handle.write(pieceData, 0, pieceData.length, this.slotOffset(entry.slot))
      }

      if (this.dirtyMetadata || !exists) {
        const header = this.encodeHeader()
        await handle.write(header, 0, header.length, 0)
      }

      await handle.sync()
    } finally {
      await handle.close()
    }

    this.dirtyMetadata = false
    this.dirtyPieces.clear()
    this.logger.debug(
      `Flushed ${this.data.size} pieces to .parts file (${this.nextSlot} slots allocated)`,
    )
  }

  /**
   * Add a piece and immediately flush to disk.
   * This is the safe way to add pieces during download.
   */
  async addPieceAndFlush(index: number, data: Uint8Array): Promise<void> {
    this.addPiece(index, data)
    await this.flush()
  }

  /**
   * Remove a piece and immediately flush to disk.
   */
  async removePieceAndFlush(index: number): Promise<boolean> {
    const removed = this.removePiece(index)
    if (removed) {
      await this.flush()
    }
    return removed
  }

  /**
   * Get piece count.
   */
  get count(): number {
    return this.slots.size
  }

  /**
   * Check if there are any pieces stored.
   */
  get isEmpty(): boolean {
    return this.slots.size === 0
  }

  private get headerSize(): number {
    const rawSize = PartsFile.FIXED_HEADER_SIZE + this.numPieces * PartsFile.ENTRY_SIZE
    return this.alignUp(rawSize, PartsFile.HEADER_ALIGNMENT)
  }

  private alignUp(value: number, alignment: number): number {
    return Math.ceil(value / alignment) * alignment
  }

  private allocateSlot(): number {
    const reused = this.freeSlots.pop()
    if (reused !== undefined) return reused
    return this.nextSlot++
  }

  private encodeHeader(): Uint8Array {
    const header = new Uint8Array(this.headerSize)
    header.set(PartsFile.MAGIC, 0)
    header[4] = PartsFile.VERSION

    const view = new DataView(header.buffer, header.byteOffset, header.byteLength)
    view.setUint32(8, this.numPieces, true)
    view.setUint32(12, this.pieceLength, true)

    for (let index = 0; index < this.numPieces; index++) {
      const offset = PartsFile.FIXED_HEADER_SIZE + index * PartsFile.ENTRY_SIZE
      const entry = this.slots.get(index)
      view.setInt32(offset, entry?.slot ?? -1, true)
      view.setUint32(offset + 4, entry?.length ?? 0, true)
    }

    return header
  }

  private hasMagic(buffer: Uint8Array): boolean {
    return PartsFile.MAGIC.every((byte, index) => buffer[index] === byte)
  }

  private slotOffset(slot: number): number {
    return this.headerSize + slot * this.pieceLength
  }

  private validatePieceIndex(index: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= this.numPieces) {
      throw new Error(`Invalid .parts piece index: ${index}`)
    }
  }

  private resetState(): void {
    this.data.clear()
    this.slots.clear()
    this.freeSlots = []
    this.nextSlot = 0
    this.dirtyPieces.clear()
    this.dirtyMetadata = false
  }

  private async discardFile(): Promise<void> {
    this.resetState()
    try {
      await this.storageHandle.getFileSystem().delete(this.filename)
    } catch {
      // File may already be gone.
    }
  }
}
