import { BLOCK_SIZE, type ActivePiece } from '../core/active-piece'
import type { ActivePieceManager } from '../core/active-piece-manager'
import { EngineComponent, type ILoggingEngine } from '../logging/logger'
import { WebSeedHttpClient } from './web-seed-http-client'

export interface WebSeedSourceFile {
  path: string
  length: number
  offset: number
}

export interface WebSeedManagerDeps {
  isNetworkActive(): boolean
  isComplete(): boolean
  hasMetadata(): boolean
  getWebSeedUrls(): string[]
  getFiles(): readonly WebSeedSourceFile[]
  isMultiFileTorrent(): boolean
  getPieceCount(): number
  getFirstNeededPiece(): number
  getPieceLength(index: number): number
  getPieceOffset(index: number): number
  shouldRequestPiece(index: number): boolean
  hasPiece(index: number): boolean
  getActivePieces(): ActivePieceManager | undefined
  initActivePieces(): ActivePieceManager
  getMaxConcurrentTransfers(): number
  removePieceFromAllIndices(index: number): void
  reindexPieceForConnectedPeers(index: number): void
  onReceivedBlockFromSource(
    sourceId: string,
    pieceIndex: number,
    blockOffset: number,
    data: Uint8Array,
  ): boolean
}

interface WebSeedSourceState {
  id: string
  url: string
  consecutiveFailures: number
  retryAt: number
}

interface WebSeedFileSpan {
  url: string
  start: number
  endInclusive: number
  length: number
}

interface ReservedPiece {
  sourceId: string
  piece: ActivePiece
  pieceIndex: number
  pieceLength: number
  spans: WebSeedFileSpan[]
}

interface ActiveTransfer {
  sourceId: string
  pieceIndex: number
  controller: AbortController
}

interface PartialBlockState {
  blockIndex: number
  data: Uint8Array
  written: number
}

const WEB_SEED_SOURCE_PREFIX = 'webseed:'
const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 30_000

export class WebSeedManager extends EngineComponent {
  static logName = 'web-seed-manager'

  private readonly sources = new Map<string, WebSeedSourceState>()
  private readonly activeTransfers = new Map<string, ActiveTransfer>()
  private readonly transferPromises = new Map<string, Promise<void>>()

  constructor(
    engine: ILoggingEngine,
    private readonly client: WebSeedHttpClient,
    private readonly deps: WebSeedManagerDeps,
  ) {
    super(engine)
  }

  tick(): void {
    this.syncSources()

    if (!this.deps.isNetworkActive()) return
    if (!this.deps.hasMetadata()) return
    if (this.deps.isComplete()) return

    const files = this.deps.getFiles()
    if (files.length === 0) return

    const capacity = Math.max(1, this.deps.getMaxConcurrentTransfers())
    if (this.transferPromises.size >= capacity) return

    const now = Date.now()
    while (this.transferPromises.size < capacity) {
      const source = this.pickReadySource(now)
      if (!source) return

      const reservation = this.reserveNextPiece(source)
      if (!reservation) return

      this.startTransfer(source, reservation)
    }
  }

  stop(): void {
    for (const transfer of this.activeTransfers.values()) {
      transfer.controller.abort()
    }
  }

  private syncSources(): void {
    const nextUrls = new Set(
      this.deps
        .getWebSeedUrls()
        .map((url) => url.trim())
        .filter((url) => url.length > 0),
    )

    for (const url of nextUrls) {
      const id = getWebSeedSourceId(url)
      if (!this.sources.has(id)) {
        this.sources.set(id, {
          id,
          url,
          consecutiveFailures: 0,
          retryAt: 0,
        })
      }
    }

    for (const [id, source] of this.sources) {
      if (!nextUrls.has(source.url)) {
        this.sources.delete(id)
      }
    }
  }

  private pickReadySource(now: number): WebSeedSourceState | null {
    for (const source of this.sources.values()) {
      if (source.retryAt > now) continue
      if (this.hasActiveTransferForSource(source.id)) continue
      return source
    }
    return null
  }

  private hasActiveTransferForSource(sourceId: string): boolean {
    for (const transfer of this.activeTransfers.values()) {
      if (transfer.sourceId === sourceId) {
        return true
      }
    }
    return false
  }

  private reserveNextPiece(source: WebSeedSourceState): ReservedPiece | null {
    const activePieces = this.deps.getActivePieces() ?? this.deps.initActivePieces()
    const pieceCount = this.deps.getPieceCount()
    const startIndex = Math.min(this.deps.getFirstNeededPiece(), Math.max(pieceCount - 1, 0))

    for (const pieceIndex of iteratePieceIndices(pieceCount, startIndex)) {
      if (!this.deps.shouldRequestPiece(pieceIndex)) continue
      if (this.deps.hasPiece(pieceIndex)) continue
      if (activePieces.has(pieceIndex)) continue

      const piece = activePieces.getOrCreate(pieceIndex)
      if (!piece) return null

      const neededBlocks = piece.getNeededBlocks(piece.blocksNeeded)
      if (neededBlocks.length !== piece.blocksNeeded) {
        activePieces.remove(pieceIndex)
        continue
      }

      for (let blockIndex = 0; blockIndex < piece.blocksNeeded; blockIndex++) {
        piece.addRequestFromSource(blockIndex, source.id)
      }
      activePieces.promoteToFullyRequested(pieceIndex)
      this.deps.removePieceFromAllIndices(pieceIndex)

      return {
        sourceId: source.id,
        piece,
        pieceIndex,
        pieceLength: this.deps.getPieceLength(pieceIndex),
        spans: this.planPieceSpans(source.url, pieceIndex),
      }
    }

    return null
  }

  private planPieceSpans(sourceUrl: string, pieceIndex: number): WebSeedFileSpan[] {
    const pieceOffset = this.deps.getPieceOffset(pieceIndex)
    const pieceLength = this.deps.getPieceLength(pieceIndex)
    const pieceEnd = pieceOffset + pieceLength
    const files = this.deps.getFiles()
    const isMultiFile = this.deps.isMultiFileTorrent()
    const spans: WebSeedFileSpan[] = []
    let totalLength = 0

    for (const file of files) {
      const fileEnd = file.offset + file.length
      const overlapStart = Math.max(pieceOffset, file.offset)
      const overlapEnd = Math.min(pieceEnd, fileEnd)
      if (overlapEnd <= overlapStart) continue

      const length = overlapEnd - overlapStart
      spans.push({
        url: buildWebSeedFileUrl(sourceUrl, file.path, isMultiFile),
        start: overlapStart - file.offset,
        endInclusive: overlapEnd - file.offset - 1,
        length,
      })
      totalLength += length
    }

    if (totalLength !== pieceLength) {
      throw new Error(
        `Web seed piece planning mismatch for piece ${pieceIndex}: planned ${totalLength}, expected ${pieceLength}`,
      )
    }

    return spans
  }

  private async runTransfer(
    source: WebSeedSourceState,
    reservation: ReservedPiece,
    signal: AbortSignal,
  ): Promise<void> {
    const cursor = {
      pieceBytesRead: 0,
      partialBlock: null as PartialBlockState | null,
    }

    try {
      for (const span of reservation.spans) {
        const response = await this.client.requestRange({
          url: span.url,
          start: span.start,
          endInclusive: span.endInclusive,
          signal,
        })

        try {
          await this.consumeSpanBody(reservation, response.body, span.length, cursor)
        } catch (error) {
          response.body.cancel('web-seed span failed')
          throw error
        }
      }

      if (cursor.partialBlock !== null) {
        throw new Error(
          `Web seed ended mid-block for piece ${reservation.pieceIndex} at block ${cursor.partialBlock.blockIndex}`,
        )
      }

      if (cursor.pieceBytesRead !== reservation.pieceLength) {
        throw new Error(
          `Web seed piece length mismatch for piece ${reservation.pieceIndex}: received ${cursor.pieceBytesRead}, expected ${reservation.pieceLength}`,
        )
      }

      source.consecutiveFailures = 0
      source.retryAt = 0
    } catch (error) {
      this.releaseReservation(reservation)
      throw error
    }
  }

  private async consumeSpanBody(
    reservation: ReservedPiece,
    body: { read(): Promise<Uint8Array | null> },
    expectedLength: number,
    cursor: {
      pieceBytesRead: number
      partialBlock: PartialBlockState | null
    },
  ): Promise<void> {
    let spanBytesRead = 0

    for (;;) {
      const chunk = await body.read()
      if (chunk === null) break

      if (spanBytesRead >= expectedLength) {
        throw new Error(`Web seed returned extra bytes for piece ${reservation.pieceIndex}`)
      }

      let offset = 0
      while (offset < chunk.length) {
        const remainingInSpan = expectedLength - spanBytesRead
        if (remainingInSpan <= 0) {
          throw new Error(`Web seed returned extra bytes for piece ${reservation.pieceIndex}`)
        }

        const blockIndex = Math.floor(cursor.pieceBytesRead / BLOCK_SIZE)
        const blockOffset = blockIndex * BLOCK_SIZE
        const blockLength = Math.min(BLOCK_SIZE, reservation.pieceLength - blockOffset)
        const offsetInBlock = cursor.pieceBytesRead - blockOffset
        const bytesToCopy = Math.min(blockLength - offsetInBlock, chunk.length - offset)

        if (bytesToCopy > remainingInSpan) {
          throw new Error(`Web seed returned extra bytes for piece ${reservation.pieceIndex}`)
        }

        if (offsetInBlock === 0 && bytesToCopy === blockLength && cursor.partialBlock === null) {
          const block = chunk.subarray(offset, offset + bytesToCopy)
          if (
            !this.deps.onReceivedBlockFromSource(
              reservation.sourceId,
              reservation.pieceIndex,
              blockOffset,
              block,
            )
          ) {
            throw new Error(
              `Torrent rejected web-seed block ${reservation.pieceIndex}:${blockOffset}`,
            )
          }
        } else {
          let partialBlock = cursor.partialBlock
          if (!partialBlock || partialBlock.blockIndex !== blockIndex) {
            partialBlock = {
              blockIndex,
              data: new Uint8Array(blockLength),
              written: 0,
            }
            cursor.partialBlock = partialBlock
          }

          partialBlock.data.set(chunk.subarray(offset, offset + bytesToCopy), offsetInBlock)
          partialBlock.written = offsetInBlock + bytesToCopy

          if (partialBlock.written === blockLength) {
            if (
              !this.deps.onReceivedBlockFromSource(
                reservation.sourceId,
                reservation.pieceIndex,
                blockOffset,
                partialBlock.data,
              )
            ) {
              throw new Error(
                `Torrent rejected web-seed block ${reservation.pieceIndex}:${blockOffset}`,
              )
            }
            cursor.partialBlock = null
          }
        }

        offset += bytesToCopy
        spanBytesRead += bytesToCopy
        cursor.pieceBytesRead += bytesToCopy
      }
    }

    if (spanBytesRead !== expectedLength) {
      throw new Error(
        `Web seed truncated response for piece ${reservation.pieceIndex}: received ${spanBytesRead}, expected ${expectedLength}`,
      )
    }
  }

  private releaseReservation(reservation: ReservedPiece): void {
    const activePieces = this.deps.getActivePieces()
    if (!activePieces) return

    const piece = activePieces.get(reservation.pieceIndex)
    if (!piece) return

    const cleared = piece.clearRequestsForSource(reservation.sourceId)
    if (cleared === 0) return

    if (piece.haveAllBlocks) return

    if (piece.blocksReceived === 0 && piece.outstandingRequests === 0) {
      activePieces.remove(reservation.pieceIndex)
      this.deps.reindexPieceForConnectedPeers(reservation.pieceIndex)
      return
    }

    if (piece.hasUnrequestedBlocks) {
      activePieces.demoteToPartial(reservation.pieceIndex)
    }
  }

  private recordFailure(source: WebSeedSourceState, error: unknown): void {
    source.consecutiveFailures += 1
    const delayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      INITIAL_RETRY_DELAY_MS * 2 ** (source.consecutiveFailures - 1),
    )
    source.retryAt = Date.now() + delayMs

    this.logger.warn(
      `Web-seed request failed for ${source.url}; retrying in ${delayMs}ms`,
      error,
    )
  }

  private startTransfer(source: WebSeedSourceState, reservation: ReservedPiece): void {
    const controller = new AbortController()
    const transferId = `${source.id}:${reservation.pieceIndex}`
    this.activeTransfers.set(transferId, {
      sourceId: source.id,
      pieceIndex: reservation.pieceIndex,
      controller,
    })

    const transferPromise = this.runTransfer(source, reservation, controller.signal)
      .catch((error) => {
        if (controller.signal.aborted) {
          this.logger.debug(
            `Web-seed transfer aborted for piece ${reservation.pieceIndex} from ${source.url}`,
          )
          return
        }

        this.recordFailure(source, error)
      })
      .finally(() => {
        this.activeTransfers.delete(transferId)
        this.transferPromises.delete(transferId)
        this.tick()
      })

    this.transferPromises.set(transferId, transferPromise)
  }
}

function* iteratePieceIndices(pieceCount: number, startIndex: number): Iterable<number> {
  if (pieceCount <= 0) return

  for (let index = startIndex; index < pieceCount; index++) {
    yield index
  }
  for (let index = 0; index < startIndex; index++) {
    yield index
  }
}

function getWebSeedSourceId(url: string): string {
  return `${WEB_SEED_SOURCE_PREFIX}${url}`
}

function buildWebSeedFileUrl(baseUrl: string, filePath: string, isMultiFile: boolean): string {
  if (!isMultiFile && !baseUrl.endsWith('/')) {
    return baseUrl
  }

  const url = new URL(baseUrl)
  const encodedPath = filePath
    .split('/')
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment))
    .join('/')

  const basePath = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`
  url.pathname = `${basePath}${encodedPath}`
  return url.toString()
}
