/**
 * TorrentSource — mediabunny Source adapter backed by torrent pieces.
 *
 * Provides a factory that creates a mediabunny-compatible Source from a
 * Torrent + fileIndex. The mediabunny Source base class is passed in as a
 * parameter to avoid adding mediabunny as a dependency of the engine package.
 *
 * _read() is blocking: it returns a Promise that waits for missing pieces
 * instead of returning null. mediabunny has no read timeouts — it awaits
 * indefinitely. This means mediabunny drives the parsing; we just fulfill
 * reads as pieces arrive. Supports AbortSignal for seek cancellation.
 *
 * Implements AbortableSource: the pipeline calls setCurrentSignal() before
 * each segment so _read() can abort in-flight piece downloads on seek.
 * mediabunny's Source._read(start, end) doesn't pass AbortSignal, so
 * currentSignal is the mechanism for threading abort to this Source.
 *
 * Usage (from a consumer that has mediabunny as a dependency):
 *
 *   import { Source, Input, ALL_FORMATS } from 'mediabunny';
 *   import { createTorrentSource } from '@jstorrent/engine/streaming/torrent-source';
 *
 *   const source = createTorrentSource(Source, torrent, fileIndex);
 *   source.setCurrentSignal(controller.signal); // optional: for abort support
 *   const input = new Input({ formats: ALL_FORMATS, source });
 */

import type { Torrent } from '../core/torrent'
import { toHex } from '../utils/buffer'
import { buildMkvPrebuiltKeyframeIndex, isMkvFile } from './mkv-keyframe-index'
import {
  StreamingPieceState,
  type StreamingFilePieceSnapshot,
  type StreamingFileProvider,
} from './streaming-file-provider'

/**
 * The shape of mediabunny's ReadResult (not importing to avoid dependency).
 *
 * offset = the file byte position at which `bytes` begins. mediabunny uses
 * this to compute `bufferPos = requestedStart - offset` inside FileSlice.
 * For torrent reads, offset must equal the requested start position so that
 * bufferPos starts at 0 (the beginning of our returned buffer).
 */
export interface ReadResult {
  bytes: Uint8Array
  view: DataView
  offset: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SourceConstructor = abstract new (...args: any[]) => any

function summarizePieces(pieces: number[]): string {
  if (pieces.length === 0) return 'pieces=0'
  if (pieces.length <= 6) return `pieces=${pieces.join(',')}`
  return `pieces=${pieces[0]}..${pieces[pieces.length - 1]} (${pieces.length})`
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

  return {
    get fileSize() {
      return file.length
    },
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
    buildPrebuiltKeyframeIndex: () => {
      if (!isMkvFile(file.path)) {
        return Promise.resolve(null)
      }
      return buildMkvPrebuiltKeyframeIndex(torrent, fileIndex)
    },
    getPieceTimelineSnapshot: () =>
      Promise.resolve(buildFilePieceSnapshot(torrent, filePieceIndices, pieceIndexToRelative)),
  }
}

/**
 * Create a mediabunny-compatible Source backed by torrent piece data.
 *
 * _read() prioritizes the needed pieces via setStreamingPieces and waits
 * for them to download. Supports AbortSignal for cancellation on seek.
 *
 * @param SourceClass - The mediabunny Source base class (for instanceof compatibility)
 * @param torrent - The torrent to read from (or a StreamingFileProvider)
 * @param fileIndex - Index of the file within the torrent (ignored if provider passed)
 */
export function createTorrentSource<T extends SourceConstructor>(
  SourceClass: T,
  torrent: Torrent,
  fileIndex: number,
): InstanceType<T> {
  const provider = createStreamingFileProvider(torrent, fileIndex)
  return createTorrentSourceFromProvider(SourceClass, provider)
}

/**
 * Create a mediabunny-compatible Source from a StreamingFileProvider.
 *
 * This is the lower-level factory — use when you have a pre-built provider
 * (e.g., a postMessage proxy).
 */
export function createTorrentSourceFromProvider<T extends SourceConstructor>(
  SourceClass: T,
  provider: StreamingFileProvider,
): InstanceType<T> {
  const disposeController = new AbortController()
  let disposed = false
  const fileLockToken = `torrent-source-file:${nextStreamingDemandId++}`
  const aheadDemandToken = `torrent-source-next:${nextStreamingDemandId++}`
  let fileLockActive = false
  let aheadDemandStartPiece: number | null = null
  const filePieceIndices =
    provider.fileSize > 0 ? provider.fileBytesToPieces(0, provider.fileSize) : []
  const firstFilePiece = filePieceIndices[0] ?? 0
  const lastFilePiece = filePieceIndices[filePieceIndices.length - 1] ?? -1
  const expandDemandPieces = (pieces: number[]): Set<number> => new Set(pieces)

  interface SignalDemandScope {
    token: string
    pieces: Set<number>
    abortListener: () => void
  }

  const signalDemandScopes = new Map<AbortSignal, SignalDemandScope>()
  let fallbackDemandScope: { token: string; pieces: Set<number> } | null = null

  const clearFallbackDemandScope = (): void => {
    if (!fallbackDemandScope) return
    provider.updateStreamingDemand?.(fallbackDemandScope.token, null, 'now')
    fallbackDemandScope = null
  }

  const updateAheadDemand = (startPiece: number | null): void => {
    if (!provider.updateStreamingDemand) return

    if (
      startPiece === null ||
      filePieceIndices.length === 0 ||
      lastFilePiece < firstFilePiece ||
      startPiece > lastFilePiece
    ) {
      if (aheadDemandStartPiece === null) return
      provider.updateStreamingDemand(aheadDemandToken, null, 'next')
      aheadDemandStartPiece = null
      return
    }

    const clampedStartPiece = Math.max(firstFilePiece, startPiece)
    if (aheadDemandStartPiece === clampedStartPiece) return

    const aheadPieces = new Set<number>()
    for (let piece = clampedStartPiece; piece <= lastFilePiece; piece++) {
      aheadPieces.add(piece)
    }

    provider.updateStreamingDemand(aheadDemandToken, aheadPieces, 'next')
    aheadDemandStartPiece = clampedStartPiece
  }

  const clearSignalDemandScope = (signal: AbortSignal | null | undefined): void => {
    if (!signal) return
    const scope = signalDemandScopes.get(signal)
    if (!scope) return
    signal.removeEventListener('abort', scope.abortListener)
    signalDemandScopes.delete(signal)
    provider.updateStreamingDemand?.(scope.token, null, 'now')
  }

  const getSignalDemandScope = (signal: AbortSignal): SignalDemandScope | null => {
    if (signal.aborted) return null

    const existing = signalDemandScopes.get(signal)
    if (existing) return existing

    const token = `torrent-source:${nextStreamingDemandId++}`
    const abortListener = () => {
      clearSignalDemandScope(signal)
    }
    const scope: SignalDemandScope = {
      token,
      pieces: new Set<number>(),
      abortListener,
    }
    signal.addEventListener('abort', abortListener, { once: true })
    signalDemandScopes.set(signal, scope)
    return scope
  }

  // Create a concrete subclass that implements the abstract methods
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class TorrentSource extends (SourceClass as abstract new () => any) {
    /** Instance-level signal set by the pipeline before each segment. */
    currentSignal: AbortSignal | null = null

    setCurrentSignal(signal: AbortSignal | null): void {
      if (this.currentSignal === signal) return
      clearSignalDemandScope(this.currentSignal)
      if (signal) {
        clearFallbackDemandScope()
      }
      this.currentSignal = signal
    }

    _retrieveSize(): number {
      return provider.fileSize
    }

    _read(start: number, end: number, signal?: AbortSignal): Promise<ReadResult> | null {
      if (disposed) {
        console.log(`[torrent-source] read rejected after dispose start=${start} end=${end}`)
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }

      // Use explicit signal param if provided (future mediabunny support),
      // otherwise fall back to instance-level signal from pipeline
      const effectiveSignal = signal ?? this.currentSignal
      const length = end - start

      let pieces: number[]
      try {
        pieces = provider.fileBytesToPieces(start, length)
      } catch {
        console.warn(`[torrent-source] fileBytesToPieces failed start=${start} end=${end}`)
        return null
      }

      console.log(
        `[torrent-source] read start=${start} end=${end} len=${length} ${summarizePieces(pieces)}`,
      )

      if (provider.updateStreamingFileLock && !fileLockActive) {
        provider.updateStreamingFileLock(fileLockToken, true)
        fileLockActive = true
      }

      const signalDemandScope =
        provider.updateStreamingDemand && effectiveSignal
          ? getSignalDemandScope(effectiveSignal)
          : null
      const demandPieces = expandDemandPieces(pieces)
      updateAheadDemand(pieces[0] ?? null)
      if (provider.updateStreamingDemand && !effectiveSignal && !fallbackDemandScope) {
        fallbackDemandScope = {
          token: `torrent-source:${nextStreamingDemandId++}`,
          pieces: new Set<number>(),
        }
      }
      const demandToken =
        signalDemandScope?.token ??
        fallbackDemandScope?.token ??
        `torrent-source:${nextStreamingDemandId++}`
      if (signalDemandScope) {
        for (const piece of demandPieces) {
          signalDemandScope.pieces.add(piece)
        }
        provider.updateStreamingDemand(demandToken, new Set(signalDemandScope.pieces), 'now')
      } else if (fallbackDemandScope && provider.updateStreamingDemand) {
        for (const piece of demandPieces) {
          fallbackDemandScope.pieces.add(piece)
        }
        provider.updateStreamingDemand(demandToken, new Set(fallbackDemandScope.pieces), 'now')
      } else if (provider.updateStreamingDemand) {
        provider.updateStreamingDemand(demandToken, demandPieces, 'now')
      } else {
        provider.setStreamingPieces(demandPieces)
      }

      const readController = new AbortController()
      const abortRead = () => {
        console.log(
          `[torrent-source] abort start=${start} end=${end} len=${length} ${summarizePieces(pieces)}`,
        )
        if (!signalDemandScope && !fallbackDemandScope && provider.updateStreamingDemand) {
          provider.updateStreamingDemand(demandToken, null, 'now')
        } else if (!provider.updateStreamingDemand) {
          provider.setStreamingPieces(null)
        }
        readController.abort()
      }

      // Handle abort and teardown by deprioritizing/canceling the active read.
      effectiveSignal?.addEventListener('abort', abortRead, { once: true })
      disposeController.signal.addEventListener('abort', abortRead, { once: true })

      if (effectiveSignal?.aborted || disposeController.signal.aborted) {
        abortRead()
      }

      // Wait for all pieces, then read the bytes
      const waitStartedAt = Date.now()
      return provider
        .waitForPieces(pieces, readController.signal)
        .then(() => {
          if (readController.signal.aborted) {
            throw new DOMException('Aborted', 'AbortError')
          }
          console.log(
            `[torrent-source] ready start=${start} end=${end} waited_ms=${Date.now() - waitStartedAt} ${summarizePieces(pieces)}`,
          )
          return provider.readFileBytes(start, length)
        })
        .then((bytes) => {
          console.log(
            `[torrent-source] read complete start=${start} end=${end} bytes=${bytes.byteLength}`,
          )
          return {
            bytes,
            view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
            offset: start,
          }
        })
        .finally(() => {
          effectiveSignal?.removeEventListener('abort', abortRead)
          disposeController.signal.removeEventListener('abort', abortRead)
          if (!readController.signal.aborted && !signalDemandScope && !fallbackDemandScope) {
            if (provider.updateStreamingDemand) {
              provider.updateStreamingDemand(demandToken, null, 'now')
            }
          }
        })
    }

    _dispose(): void {
      if (disposed) return
      disposed = true
      console.log('[torrent-source] dispose')
      if (provider.updateStreamingFileLock && fileLockActive) {
        provider.updateStreamingFileLock(fileLockToken, false)
        fileLockActive = false
      }
      for (const signal of signalDemandScopes.keys()) {
        clearSignalDemandScope(signal)
      }
      clearFallbackDemandScope()
      updateAheadDemand(null)
      provider.setStreamingPieces(null)
      disposeController.abort()
    }
  }

  return new TorrentSource() as InstanceType<T>
}
