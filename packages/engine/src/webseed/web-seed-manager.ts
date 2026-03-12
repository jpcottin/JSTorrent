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
  isDownloadRateLimited(): boolean
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
  getMaxTransferBytes(): number
  tryConsumeDownloadBandwidth(bytes: number): boolean
  waitForDownloadBandwidth(bytes: number, signal: AbortSignal): Promise<void>
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
  failedTransfers: number
  successfulTransfers: number
  downloadedBytes: number
  averageTransferRateBps: number
  lastSuccessAt: number
  lastFailureAt: number
  retryAt: number
}

interface WebSeedFileSpan {
  url: string
  start: number
  endInclusive: number
  length: number
}

interface ReservedPiece {
  rangeStart: number
  sourceId: string
  piece: ActivePiece
  pieceIndex: number
  pieceLength: number
}

interface ReservedRange {
  sourceId: string
  startPieceIndex: number
  totalLength: number
  pieces: ReservedPiece[]
  spans: WebSeedFileSpan[]
}

interface ActiveTransfer {
  sourceId: string
  pieceIndex: number
  controller: AbortController
}

interface PartialBlockState {
  pieceIndex: number
  blockIndex: number
  data: Uint8Array
  written: number
}

const WEB_SEED_SOURCE_PREFIX = 'webseed:'
const INITIAL_RETRY_DELAY_MS = 1_000
const MAX_RETRY_DELAY_MS = 30_000
export const DEFAULT_MAX_WEB_SEED_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_RATE_LIMIT_SLICE_BYTES = BLOCK_SIZE

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

      const reservation = this.reserveNextRange(source)
      if (!reservation) return

      this.startTransfer(source, reservation)
    }
  }

  stop(): void {
    for (const transfer of this.activeTransfers.values()) {
      transfer.controller.abort()
    }
    this.client.close()
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
          failedTransfers: 0,
          successfulTransfers: 0,
          downloadedBytes: 0,
          averageTransferRateBps: 0,
          lastSuccessAt: 0,
          lastFailureAt: 0,
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
    const readySources: WebSeedSourceState[] = []
    for (const source of this.sources.values()) {
      if (source.retryAt > now) continue
      if (this.hasActiveTransferForSource(source.id)) continue
      readySources.push(source)
    }

    readySources.sort(compareWebSeedSources)
    return readySources[0] ?? null
  }

  private hasActiveTransferForSource(sourceId: string): boolean {
    for (const transfer of this.activeTransfers.values()) {
      if (transfer.sourceId === sourceId) {
        return true
      }
    }
    return false
  }

  private reserveNextRange(source: WebSeedSourceState): ReservedRange | null {
    const activePieces = this.deps.getActivePieces() ?? this.deps.initActivePieces()
    const pieceCount = this.deps.getPieceCount()
    const startIndex = Math.min(this.deps.getFirstNeededPiece(), Math.max(pieceCount - 1, 0))
    const maxTransferBytes = Math.max(BLOCK_SIZE, this.deps.getMaxTransferBytes())

    for (const pieceIndex of iteratePieceIndices(pieceCount, startIndex)) {
      const firstPiece = this.tryReservePiece(activePieces, pieceIndex, source.id)
      if (!firstPiece) continue

      const pieces: ReservedPiece[] = [
        {
          ...firstPiece,
          rangeStart: 0,
          sourceId: source.id,
        },
      ]
      let totalLength = firstPiece.pieceLength

      for (
        let nextPieceIndex = pieceIndex + 1;
        nextPieceIndex < pieceCount && totalLength < maxTransferBytes;
        nextPieceIndex++
      ) {
        const nextPieceLength = this.deps.getPieceLength(nextPieceIndex)
        if (totalLength + nextPieceLength > maxTransferBytes) break

        const nextPiece = this.tryReservePiece(activePieces, nextPieceIndex, source.id)
        if (!nextPiece) break

        pieces.push({
          ...nextPiece,
          rangeStart: totalLength,
          sourceId: source.id,
        })
        totalLength += nextPiece.pieceLength
      }

      return {
        sourceId: source.id,
        startPieceIndex: pieceIndex,
        totalLength,
        pieces,
        spans: this.planRangeSpans(
          source.url,
          this.deps.getPieceOffset(pieceIndex),
          totalLength,
        ),
      }
    }

    return null
  }

  private tryReservePiece(
    activePieces: ActivePieceManager,
    pieceIndex: number,
    sourceId: string,
  ): Omit<ReservedPiece, 'rangeStart' | 'sourceId'> | null {
    if (!this.deps.shouldRequestPiece(pieceIndex)) return null
    if (this.deps.hasPiece(pieceIndex)) return null
    if (activePieces.has(pieceIndex)) return null

    const piece = activePieces.getOrCreate(pieceIndex)
    if (!piece) return null

    const neededBlocks = piece.getNeededBlocks(piece.blocksNeeded)
    if (neededBlocks.length !== piece.blocksNeeded) {
      activePieces.remove(pieceIndex)
      return null
    }

    for (let blockIndex = 0; blockIndex < piece.blocksNeeded; blockIndex++) {
      piece.addRequestFromSource(blockIndex, sourceId)
    }
    activePieces.promoteToFullyRequested(pieceIndex)
    this.deps.removePieceFromAllIndices(pieceIndex)

    return {
      piece,
      pieceIndex,
      pieceLength: this.deps.getPieceLength(pieceIndex),
    }
  }

  private planRangeSpans(sourceUrl: string, rangeOffset: number, rangeLength: number): WebSeedFileSpan[] {
    const rangeEnd = rangeOffset + rangeLength
    const files = this.deps.getFiles()
    const isMultiFile = this.deps.isMultiFileTorrent()
    const spans: WebSeedFileSpan[] = []
    let totalLength = 0

    for (const file of files) {
      const fileEnd = file.offset + file.length
      const overlapStart = Math.max(rangeOffset, file.offset)
      const overlapEnd = Math.min(rangeEnd, fileEnd)
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

    if (totalLength !== rangeLength) {
      throw new Error(`Web seed range planning mismatch: planned ${totalLength}, expected ${rangeLength}`)
    }

    return spans
  }

  private async runTransfer(
    source: WebSeedSourceState,
    reservation: ReservedRange,
    signal: AbortSignal,
  ): Promise<void> {
    const startedAt = Date.now()
    const cursor = {
      reservationBytesRead: 0,
      pieceCursorIndex: 0,
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
          await this.consumeSpanBody(reservation, response.body, span.length, cursor, signal)
        } catch (error) {
          response.body.cancel('web-seed span failed')
          throw error
        }
      }

      if (cursor.partialBlock !== null) {
        throw new Error(
          `Web seed ended mid-block for piece ${cursor.partialBlock.pieceIndex} at block ${cursor.partialBlock.blockIndex}`,
        )
      }

      if (cursor.reservationBytesRead !== reservation.totalLength) {
        throw new Error(
          `Web seed transfer length mismatch for piece ${reservation.startPieceIndex}: received ${cursor.reservationBytesRead}, expected ${reservation.totalLength}`,
        )
      }

      this.recordSuccess(source, cursor.reservationBytesRead, Date.now() - startedAt)
    } catch (error) {
      this.releaseReservation(reservation)
      throw error
    }
  }

  private async consumeSpanBody(
    reservation: ReservedRange,
    body: { read(): Promise<Uint8Array | null> },
    expectedLength: number,
    cursor: {
      reservationBytesRead: number
      pieceCursorIndex: number
      partialBlock: PartialBlockState | null
    },
    signal: AbortSignal,
  ): Promise<void> {
    let spanBytesRead = 0

    for (;;) {
      const chunk = await body.read()
      if (chunk === null) break

      if (spanBytesRead >= expectedLength) {
        throw new Error(
          `Web seed returned extra bytes for transfer starting at piece ${reservation.startPieceIndex}`,
        )
      }

      let offset = 0
      while (offset < chunk.length) {
        const remainingInSpan = expectedLength - spanBytesRead
        if (remainingInSpan <= 0) {
          throw new Error(
            `Web seed returned extra bytes for transfer starting at piece ${reservation.startPieceIndex}`,
          )
        }

        const reservedPiece = getReservedPieceForOffset(reservation, cursor)
        const pieceOffset = cursor.reservationBytesRead - reservedPiece.rangeStart
        const blockIndex = Math.floor(pieceOffset / BLOCK_SIZE)
        const blockOffset = blockIndex * BLOCK_SIZE
        const blockLength = Math.min(BLOCK_SIZE, reservedPiece.pieceLength - blockOffset)
        const offsetInBlock = pieceOffset - blockOffset
        const bytesAvailable = Math.min(blockLength - offsetInBlock, chunk.length - offset)
        const bytesToCopy = await this.consumeDownloadBandwidth(bytesAvailable, signal)

        if (bytesToCopy > remainingInSpan) {
          throw new Error(
            `Web seed returned extra bytes for transfer starting at piece ${reservation.startPieceIndex}`,
          )
        }

        if (offsetInBlock === 0 && bytesToCopy === blockLength && cursor.partialBlock === null) {
          const block = chunk.subarray(offset, offset + bytesToCopy)
          if (
            !this.deps.onReceivedBlockFromSource(
              reservation.sourceId,
              reservedPiece.pieceIndex,
              blockOffset,
              block,
            )
          ) {
            throw new Error(
              `Torrent rejected web-seed block ${reservedPiece.pieceIndex}:${blockOffset}`,
            )
          }
        } else {
          let partialBlock = cursor.partialBlock
          if (
            !partialBlock ||
            partialBlock.pieceIndex !== reservedPiece.pieceIndex ||
            partialBlock.blockIndex !== blockIndex
          ) {
            partialBlock = {
              pieceIndex: reservedPiece.pieceIndex,
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
                reservedPiece.pieceIndex,
                blockOffset,
                partialBlock.data,
              )
            ) {
              throw new Error(
                `Torrent rejected web-seed block ${reservedPiece.pieceIndex}:${blockOffset}`,
              )
            }
            cursor.partialBlock = null
          }
        }

        offset += bytesToCopy
        spanBytesRead += bytesToCopy
        cursor.reservationBytesRead += bytesToCopy
      }
    }

    if (spanBytesRead !== expectedLength) {
      throw new Error(
        `Web seed truncated response for transfer starting at piece ${reservation.startPieceIndex}: received ${spanBytesRead}, expected ${expectedLength}`,
      )
    }
  }

  private async consumeDownloadBandwidth(bytesWanted: number, signal: AbortSignal): Promise<number> {
    if (!this.deps.isDownloadRateLimited()) {
      return bytesWanted
    }

    const boundedBytes = Math.min(bytesWanted, MAX_RATE_LIMIT_SLICE_BYTES)
    let attempt = boundedBytes

    for (;;) {
      if (this.deps.tryConsumeDownloadBandwidth(attempt)) {
        return attempt
      }

      if (attempt > 1) {
        attempt = Math.max(1, Math.floor(attempt / 2))
        continue
      }

      await this.deps.waitForDownloadBandwidth(1, signal)
      attempt = boundedBytes
    }
  }

  private releaseReservation(reservation: ReservedRange): void {
    const activePieces = this.deps.getActivePieces()
    if (!activePieces) return

    for (const reservedPiece of reservation.pieces) {
      const piece = activePieces.get(reservedPiece.pieceIndex)
      if (!piece) continue

      const cleared = piece.clearRequestsForSource(reservation.sourceId)
      if (cleared === 0) continue

      if (piece.haveAllBlocks) continue

      if (piece.blocksReceived === 0 && piece.outstandingRequests === 0) {
        activePieces.remove(reservedPiece.pieceIndex)
        this.deps.reindexPieceForConnectedPeers(reservedPiece.pieceIndex)
        continue
      }

      if (piece.hasUnrequestedBlocks) {
        activePieces.demoteToPartial(reservedPiece.pieceIndex)
      }
    }
  }

  private recordFailure(source: WebSeedSourceState, error: unknown): void {
    source.consecutiveFailures += 1
    source.failedTransfers += 1
    source.lastFailureAt = Date.now()
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

  private recordSuccess(
    source: WebSeedSourceState,
    bytesDownloaded: number,
    transferDurationMs: number,
  ): void {
    source.consecutiveFailures = 0
    source.retryAt = 0
    source.successfulTransfers += 1
    source.downloadedBytes += bytesDownloaded
    source.lastSuccessAt = Date.now()

    const durationMs = Math.max(transferDurationMs, 1)
    const instantRateBps = Math.round((bytesDownloaded * 1000) / durationMs)
    source.averageTransferRateBps =
      source.averageTransferRateBps === 0
        ? instantRateBps
        : Math.round(source.averageTransferRateBps * 0.7 + instantRateBps * 0.3)
  }

  private startTransfer(source: WebSeedSourceState, reservation: ReservedRange): void {
    const controller = new AbortController()
    const transferId = `${source.id}:${reservation.startPieceIndex}`
    this.activeTransfers.set(transferId, {
      sourceId: source.id,
      pieceIndex: reservation.startPieceIndex,
      controller,
    })

    const transferPromise = this.runTransfer(source, reservation, controller.signal)
      .catch((error) => {
        if (controller.signal.aborted) {
          this.logger.debug(
            `Web-seed transfer aborted for piece ${reservation.startPieceIndex} from ${source.url}`,
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

function getReservedPieceForOffset(
  reservation: ReservedRange,
  cursor: { reservationBytesRead: number; pieceCursorIndex: number },
): ReservedPiece {
  while (cursor.pieceCursorIndex < reservation.pieces.length) {
    const piece = reservation.pieces[cursor.pieceCursorIndex]
    if (cursor.reservationBytesRead < piece.rangeStart + piece.pieceLength) {
      return piece
    }
    cursor.pieceCursorIndex += 1
  }

  throw new Error(
    `Web seed cursor exceeded reserved range starting at piece ${reservation.startPieceIndex}`,
  )
}

function compareWebSeedSources(left: WebSeedSourceState, right: WebSeedSourceState): number {
  if (left.consecutiveFailures !== right.consecutiveFailures) {
    return left.consecutiveFailures - right.consecutiveFailures
  }

  if (left.averageTransferRateBps !== right.averageTransferRateBps) {
    return right.averageTransferRateBps - left.averageTransferRateBps
  }

  if (left.successfulTransfers !== right.successfulTransfers) {
    return right.successfulTransfers - left.successfulTransfers
  }

  if (left.lastSuccessAt !== right.lastSuccessAt) {
    return right.lastSuccessAt - left.lastSuccessAt
  }

  if (left.downloadedBytes !== right.downloadedBytes) {
    return right.downloadedBytes - left.downloadedBytes
  }

  return left.url.localeCompare(right.url)
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
