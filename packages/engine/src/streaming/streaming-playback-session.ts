import type { Torrent } from '../core/torrent'
import { toHex } from '../utils/buffer'
import {
  StreamingContainerFormat,
  StreamingPlaybackMode,
  StreamingPieceState,
  type ByteRangeStreamingSession,
  type HlsPlaybackOption,
  type PreparedPlaybackMetadata,
  type StreamingPlaybackCapabilities,
  type StreamingPlaybackOption,
  type StreamingPlayerController,
  type StreamingFilePieceSnapshot,
  type StreamingFileProvider,
  type StreamingVisualization,
} from './streaming-file-provider'

function summarizePieces(pieces: number[]): string {
  if (pieces.length === 0) return 'pieces=0'
  if (pieces.length <= 6) return `pieces=${pieces.join(',')}`
  return `pieces=${pieces[0]}..${pieces[pieces.length - 1]} (${pieces.length})`
}

function getPlaybackContainerFormat(
  filename: string,
): StreamingPlaybackCapabilities['containerFormat'] {
  const lower = filename.toLowerCase()
  if (lower.endsWith('.mkv') || lower.endsWith('.webm')) {
    return StreamingContainerFormat.Matroska
  }
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v') || lower.endsWith('.mov')) {
    return StreamingContainerFormat.Mp4
  }
  return StreamingContainerFormat.Unknown
}

function createDefaultPlaybackCapabilities(): StreamingPlaybackCapabilities {
  return {
    supportedModes: [StreamingPlaybackMode.Hls],
    preferredMode: StreamingPlaybackMode.Hls,
    containerFormat: StreamingContainerFormat.Unknown,
    canPrepareMetadata: false,
  }
}

function createDefaultPlaybackOptions(
  capabilities: StreamingPlaybackCapabilities,
): StreamingPlaybackOption[] {
  const options: StreamingPlaybackOption[] = []
  if (capabilities.supportedModes.includes(StreamingPlaybackMode.Hls)) {
    options.push({ mode: StreamingPlaybackMode.Hls } satisfies HlsPlaybackOption)
  }
  return options
}

function getStreamingPieceState(piece: {
  haveAllBlocks: boolean
  hasUnrequestedBlocks: boolean
}): (typeof StreamingPieceState)[keyof typeof StreamingPieceState] {
  if (piece.haveAllBlocks) {
    return StreamingPieceState.FullyResponded
  }
  if (piece.hasUnrequestedBlocks) {
    return StreamingPieceState.Partial
  }
  return StreamingPieceState.FullyRequested
}

function buildFilePieceSnapshot(
  torrent: Torrent,
  filePieceIndices: number[],
  pieceIndexToRelative: Map<number, number>,
): StreamingFilePieceSnapshot {
  const bytes = new Uint8Array(Math.ceil(filePieceIndices.length / 8))
  let piecesCompleted = 0

  for (let i = 0; i < filePieceIndices.length; i++) {
    if (!torrent.bitfield?.get(filePieceIndices[i])) continue
    bytes[Math.floor(i / 8)] |= 1 << (7 - (i % 8))
    piecesCompleted++
  }

  const activePieces = torrent
    .getActivePieces()
    .map((piece) => {
      const relativeIndex = pieceIndexToRelative.get(piece.index)
      if (relativeIndex === undefined) return null
      return {
        index: relativeIndex,
        state: getStreamingPieceState(piece),
      }
    })
    .filter((piece): piece is NonNullable<typeof piece> => piece !== null)

  return {
    piecesTotal: filePieceIndices.length,
    piecesCompleted,
    bitfieldHex: toHex(bytes),
    activePieces,
  }
}

let nextStreamingDemandId = 0

/**
 * Create a StreamingFileProvider from a Torrent + fileIndex.
 *
 * All methods are structured-clone-friendly (numbers, Uint8Array, Set),
 * making this interface suitable for postMessage proxying.
 */
export function createStreamingFileProvider(
  torrent: Torrent,
  fileIndex: number,
): StreamingFileProvider {
  const file = torrent.files[fileIndex]
  if (!file) {
    throw new Error(`Invalid file index: ${fileIndex}`)
  }
  const filePieceIndices =
    file.length > 0 ? torrent.fileBytesToPieces(fileIndex, 0, file.length) : []
  const pieceIndexToRelative = new Map<number, number>()
  for (let i = 0; i < filePieceIndices.length; i++) {
    pieceIndexToRelative.set(filePieceIndices[i], i)
  }
  const containerFormat = getPlaybackContainerFormat(file.path)
  const playbackCapabilities: StreamingPlaybackCapabilities = {
    supportedModes: [StreamingPlaybackMode.Hls],
    preferredMode: StreamingPlaybackMode.Hls,
    containerFormat,
    canPrepareMetadata: false,
  }

  return {
    get fileSize() {
      return file.length
    },
    getPlaybackCapabilities: () => playbackCapabilities,
    fileBytesToPieces: (offset, length) => torrent.fileBytesToPieces(fileIndex, offset, length),
    setStreamingPieces: (pieces) => torrent.setStreamingPieces(pieces),
    updateStreamingFileLock:
      'updateStreamingFileLock' in torrent
        ? (token, enabled) => torrent.updateStreamingFileLock(token, enabled ? fileIndex : null)
        : undefined,
    updateStreamingDemand:
      'updateStreamingDemand' in torrent
        ? (token, pieces, urgency) => torrent.updateStreamingDemand(token, pieces, urgency)
        : undefined,
    waitForPieces: (indices, signal) => torrent.waitForPieces(indices, signal),
    readFileBytes: (offset, length) => torrent.readFileBytes(fileIndex, offset, length),
    getPieceTimelineSnapshot: () =>
      Promise.resolve(buildFilePieceSnapshot(torrent, filePieceIndices, pieceIndexToRelative)),
  }
}

interface SignalDemandScope {
  token: string
  pieces: Set<number>
  abortListener: () => void
}

function createAbortController(): AbortController | null {
  return typeof AbortController !== 'undefined' ? new AbortController() : null
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Aborted', 'AbortError')
  }
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

export interface StreamingPlaybackSessionOptions {
  tokenPrefix?: string
  logPrefix?: string
}

export function createStreamingPlaybackSession(
  provider: StreamingFileProvider,
  options: StreamingPlaybackSessionOptions = {},
): StreamingPlaybackSession {
  return new StreamingPlaybackSession(provider, options)
}

/**
 * Shared streaming-session state machine used by both desktop and Android playback.
 *
 * Owns file locking, now/next demand windows, fallback demand accumulation for
 * startup reads, and abort/dispose cleanup.
 */
export class StreamingPlaybackSession
  implements ByteRangeStreamingSession, StreamingPlayerController, StreamingVisualization
{
  private readonly disposeController = createAbortController()
  private readonly tokenPrefix: string
  private readonly logPrefix: string
  private readonly fileLockToken: string
  private readonly aheadDemandToken: string
  private readonly filePieceIndices: number[]
  private readonly firstFilePiece: number
  private readonly lastFilePiece: number
  private readonly signalDemandScopes = new Map<AbortSignal, SignalDemandScope>()
  private currentSignal: AbortSignal | null = null
  private closed = false
  private fileLockActive = false
  private aheadDemandStartPiece: number | null = null
  private fallbackDemandScope: { token: string; pieces: Set<number> } | null = null
  private playbackCapabilities: StreamingPlaybackCapabilities | null = null
  private preparedPlaybackMetadataReady = false
  private preparedPlaybackMetadata: PreparedPlaybackMetadata | null = null
  private preparingPlaybackMetadata: Promise<PreparedPlaybackMetadata | null> | null = null

  constructor(
    private readonly provider: StreamingFileProvider,
    options: StreamingPlaybackSessionOptions = {},
  ) {
    this.tokenPrefix = options.tokenPrefix ?? 'streaming-session'
    this.logPrefix = options.logPrefix ?? `[${this.tokenPrefix}]`
    this.fileLockToken = this.createToken('file')
    this.aheadDemandToken = this.createToken('next')
    this.filePieceIndices =
      provider.fileSize > 0 ? provider.fileBytesToPieces(0, provider.fileSize) : []
    this.firstFilePiece = this.filePieceIndices[0] ?? 0
    this.lastFilePiece = this.filePieceIndices[this.filePieceIndices.length - 1] ?? -1
  }

  get fileSize(): number {
    return this.provider.fileSize
  }

  open(): { fileSize: number } {
    this.ensureFileLock()
    return { fileSize: this.provider.fileSize }
  }

  getPlaybackCapabilities(): Promise<StreamingPlaybackCapabilities> {
    if (this.playbackCapabilities) {
      return Promise.resolve(this.playbackCapabilities)
    }

    const nextCapabilities = this.provider.getPlaybackCapabilities
      ? this.provider.getPlaybackCapabilities()
      : createDefaultPlaybackCapabilities()

    return Promise.resolve(nextCapabilities).then((capabilities) => {
      this.playbackCapabilities = capabilities
      return capabilities
    })
  }

  getPlaybackOptions(): Promise<StreamingPlaybackOption[]> {
    return this.getPlaybackCapabilities().then((capabilities) =>
      createDefaultPlaybackOptions(capabilities),
    )
  }

  setCurrentSignal(signal: AbortSignal | null): void {
    if (this.currentSignal === signal) return
    this.clearSignalDemandScope(this.currentSignal)
    if (signal) {
      this.clearFallbackDemandScope()
    }
    this.currentSignal = signal
  }

  read(start: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.closed) {
      this.log('read rejected after close start=%d end=%d', start, start + length)
      return Promise.reject(createAbortError())
    }

    const effectiveSignal = signal ?? this.currentSignal

    if (length === 0) {
      return Promise.resolve(new Uint8Array(0))
    }

    const pieces = this.getPiecesForRange(start, length)

    this.log(
      'read start=%d end=%d len=%d %s',
      start,
      start + length,
      length,
      summarizePieces(pieces),
    )

    this.ensureFileLock()

    const signalDemandScope =
      this.provider.updateStreamingDemand && effectiveSignal
        ? this.getSignalDemandScope(effectiveSignal)
        : null
    const demandPieces = new Set(pieces)

    this.updateAheadDemand(pieces[0] ?? null)

    if (this.provider.updateStreamingDemand && !effectiveSignal && !this.fallbackDemandScope) {
      this.fallbackDemandScope = {
        token: this.createToken(),
        pieces: new Set<number>(),
      }
    }

    const demandToken =
      signalDemandScope?.token ?? this.fallbackDemandScope?.token ?? this.createToken()

    if (signalDemandScope) {
      for (const piece of demandPieces) {
        signalDemandScope.pieces.add(piece)
      }
      this.provider.updateStreamingDemand!(demandToken, new Set(signalDemandScope.pieces), 'now')
    } else if (this.fallbackDemandScope && this.provider.updateStreamingDemand) {
      for (const piece of demandPieces) {
        this.fallbackDemandScope.pieces.add(piece)
      }
      this.provider.updateStreamingDemand(
        demandToken,
        new Set(this.fallbackDemandScope.pieces),
        'now',
      )
    } else if (this.provider.updateStreamingDemand) {
      this.provider.updateStreamingDemand(demandToken, demandPieces, 'now')
    } else {
      this.provider.setStreamingPieces(demandPieces)
    }

    const readController = createAbortController()
    const readSignal = readController?.signal
    const abortRead = () => {
      this.log(
        'abort start=%d end=%d len=%d %s',
        start,
        start + length,
        length,
        summarizePieces(pieces),
      )
      if (!signalDemandScope && !this.fallbackDemandScope && this.provider.updateStreamingDemand) {
        this.provider.updateStreamingDemand(demandToken, null, 'now')
      } else if (!this.provider.updateStreamingDemand) {
        this.provider.setStreamingPieces(null)
      }
      readController?.abort()
    }

    effectiveSignal?.addEventListener('abort', abortRead, { once: true })
    this.disposeController?.signal.addEventListener('abort', abortRead, { once: true })

    if (effectiveSignal?.aborted || this.disposeController?.signal.aborted) {
      abortRead()
    }

    const waitStartedAt = Date.now()
    return this.provider
      .waitForPieces(pieces, readSignal)
      .then(() => {
        if (readSignal?.aborted) {
          throw createAbortError()
        }
        this.log(
          'ready start=%d end=%d waited_ms=%d %s',
          start,
          start + length,
          Date.now() - waitStartedAt,
          summarizePieces(pieces),
        )
        return this.provider.readFileBytes(start, length)
      })
      .then((bytes) => {
        this.log('read complete start=%d end=%d bytes=%d', start, start + length, bytes.byteLength)
        return bytes
      })
      .finally(() => {
        effectiveSignal?.removeEventListener('abort', abortRead)
        this.disposeController?.signal.removeEventListener('abort', abortRead)
        if (!readSignal?.aborted && !signalDemandScope && !this.fallbackDemandScope) {
          if (this.provider.updateStreamingDemand) {
            this.provider.updateStreamingDemand(demandToken, null, 'now')
          }
        }
      })
  }

  waitForRange(start: number, length: number, signal?: AbortSignal): Promise<void> {
    if (this.closed) {
      this.log('wait rejected after close start=%d end=%d', start, start + length)
      return Promise.reject(createAbortError())
    }

    if (length === 0) {
      return Promise.resolve()
    }

    const effectiveSignal = signal ?? this.currentSignal
    const pieces = this.getPiecesForRange(start, length)

    this.log(
      'wait start=%d end=%d len=%d %s',
      start,
      start + length,
      length,
      summarizePieces(pieces),
    )

    this.ensureFileLock()

    const waitController = createAbortController()
    const waitSignal = waitController?.signal
    const abortWait = () => {
      this.log(
        'wait abort start=%d end=%d len=%d %s',
        start,
        start + length,
        length,
        summarizePieces(pieces),
      )
      waitController?.abort()
    }

    effectiveSignal?.addEventListener('abort', abortWait, { once: true })
    this.disposeController?.signal.addEventListener('abort', abortWait, { once: true })

    if (effectiveSignal?.aborted || this.disposeController?.signal.aborted) {
      abortWait()
    }

    const waitStartedAt = Date.now()
    return this.provider
      .waitForPieces(pieces, waitSignal)
      .then(() => {
        if (waitSignal?.aborted) {
          throw createAbortError()
        }
        this.log(
          'wait ready start=%d end=%d waited_ms=%d %s',
          start,
          start + length,
          Date.now() - waitStartedAt,
          summarizePieces(pieces),
        )
      })
      .finally(() => {
        effectiveSignal?.removeEventListener('abort', abortWait)
        this.disposeController?.signal.removeEventListener('abort', abortWait)
      })
  }

  preparePlaybackMetadata(): Promise<PreparedPlaybackMetadata | null> {
    if (this.preparingPlaybackMetadata) {
      return this.preparingPlaybackMetadata
    }
    if (this.preparedPlaybackMetadataReady) {
      return Promise.resolve(this.preparedPlaybackMetadata)
    }

    const preparePromise = this.loadPreparedPlaybackMetadata().then((metadata) => {
      this.preparedPlaybackMetadata = metadata
      this.preparedPlaybackMetadataReady = true
      return metadata
    })

    const trackedPreparePromise = preparePromise.finally(() => {
      if (this.preparingPlaybackMetadata === trackedPreparePromise) {
        this.preparingPlaybackMetadata = null
      }
    })
    this.preparingPlaybackMetadata = trackedPreparePromise

    return trackedPreparePromise
  }

  getPreparedPlaybackMetadata(): Promise<PreparedPlaybackMetadata | null> {
    if (this.preparingPlaybackMetadata) {
      return this.preparingPlaybackMetadata
    }
    return Promise.resolve(
      this.preparedPlaybackMetadataReady ? this.preparedPlaybackMetadata : null,
    )
  }

  getPieceTimelineSnapshot(): Promise<StreamingFilePieceSnapshot | null> {
    return this.provider.getPieceTimelineSnapshot
      ? this.provider.getPieceTimelineSnapshot()
      : Promise.resolve(null)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.log('dispose')
    if (this.provider.updateStreamingFileLock && this.fileLockActive) {
      this.provider.updateStreamingFileLock(this.fileLockToken, false)
      this.fileLockActive = false
    }
    for (const signal of this.signalDemandScopes.keys()) {
      this.clearSignalDemandScope(signal)
    }
    this.clearFallbackDemandScope()
    this.updateAheadDemand(null)
    this.provider.setStreamingPieces(null)
    this.disposeController?.abort()
  }

  private ensureFileLock(): void {
    if (this.fileLockActive || !this.provider.updateStreamingFileLock) return
    this.provider.updateStreamingFileLock(this.fileLockToken, true)
    this.fileLockActive = true
  }

  private clearFallbackDemandScope(): void {
    if (!this.fallbackDemandScope) return
    this.provider.updateStreamingDemand?.(this.fallbackDemandScope.token, null, 'now')
    this.fallbackDemandScope = null
  }

  private updateAheadDemand(startPiece: number | null): void {
    if (!this.provider.updateStreamingDemand) return

    if (
      startPiece === null ||
      this.filePieceIndices.length === 0 ||
      this.lastFilePiece < this.firstFilePiece ||
      startPiece > this.lastFilePiece
    ) {
      if (this.aheadDemandStartPiece === null) return
      this.provider.updateStreamingDemand(this.aheadDemandToken, null, 'next')
      this.aheadDemandStartPiece = null
      return
    }

    const clampedStartPiece = Math.max(this.firstFilePiece, startPiece)
    if (this.aheadDemandStartPiece === clampedStartPiece) return

    const aheadPieces = new Set<number>()
    for (let piece = clampedStartPiece; piece <= this.lastFilePiece; piece++) {
      aheadPieces.add(piece)
    }

    this.provider.updateStreamingDemand(this.aheadDemandToken, aheadPieces, 'next')
    this.aheadDemandStartPiece = clampedStartPiece
  }

  private clearSignalDemandScope(signal: AbortSignal | null | undefined): void {
    if (!signal) return
    const scope = this.signalDemandScopes.get(signal)
    if (!scope) return
    signal.removeEventListener('abort', scope.abortListener)
    this.signalDemandScopes.delete(signal)
    this.provider.updateStreamingDemand?.(scope.token, null, 'now')
  }

  private getSignalDemandScope(signal: AbortSignal): SignalDemandScope | null {
    if (signal.aborted) return null

    const existing = this.signalDemandScopes.get(signal)
    if (existing) return existing

    const token = this.createToken()
    const abortListener = () => {
      this.clearSignalDemandScope(signal)
    }
    const scope: SignalDemandScope = {
      token,
      pieces: new Set<number>(),
      abortListener,
    }
    signal.addEventListener('abort', abortListener, { once: true })
    this.signalDemandScopes.set(signal, scope)
    return scope
  }

  private getPiecesForRange(offset: number, length: number): number[] {
    if (!Number.isFinite(offset) || !Number.isFinite(length) || offset < 0 || length < 0) {
      throw new RangeError(`Invalid range: offset=${offset} length=${length}`)
    }
    if (offset > this.fileSize || offset + length > this.fileSize) {
      throw new RangeError(`Invalid range: offset=${offset} length=${length}`)
    }
    if (length === 0) {
      return []
    }

    try {
      return this.provider.fileBytesToPieces(offset, length)
    } catch {
      this.warn('fileBytesToPieces failed start=%d end=%d', offset, offset + length)
      throw new RangeError(`Invalid range: offset=${offset} length=${length}`)
    }
  }

  private createToken(kind?: 'file' | 'next'): string {
    const id = nextStreamingDemandId++
    if (kind === 'file') return `${this.tokenPrefix}-file:${id}`
    if (kind === 'next') return `${this.tokenPrefix}-next:${id}`
    return `${this.tokenPrefix}:${id}`
  }

  private log(message: string, ...args: Array<number | string>): void {
    console.log(`${this.logPrefix} ${this.format(message, args)}`)
  }

  private warn(message: string, ...args: Array<number | string>): void {
    console.warn(`${this.logPrefix} ${this.format(message, args)}`)
  }

  private format(message: string, args: Array<number | string>): string {
    let i = 0
    return message.replace(/%[ds]/g, () => String(args[i++]))
  }

  private loadPreparedPlaybackMetadata(): Promise<PreparedPlaybackMetadata | null> {
    return this.getPlaybackCapabilities().then((capabilities) => ({
      capabilities,
    }))
  }
}
