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
import type { StreamingFileProvider } from './streaming-file-provider'

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

  return {
    get fileSize() {
      return file.length
    },
    fileBytesToPieces: (offset, length) => torrent.fileBytesToPieces(fileIndex, offset, length),
    setStreamingPieces: (pieces) => torrent.setStreamingPieces(pieces),
    waitForPieces: (indices, signal) => torrent.waitForPieces(indices, signal),
    readFileBytes: (offset, length) => torrent.readFileBytes(fileIndex, offset, length),
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
  // Create a concrete subclass that implements the abstract methods
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class TorrentSource extends (SourceClass as abstract new () => any) {
    /** Instance-level signal set by the pipeline before each segment. */
    currentSignal: AbortSignal | null = null

    setCurrentSignal(signal: AbortSignal | null): void {
      this.currentSignal = signal
    }

    _retrieveSize(): number {
      return provider.fileSize
    }

    _read(start: number, end: number, signal?: AbortSignal): Promise<ReadResult> | null {
      // Use explicit signal param if provided (future mediabunny support),
      // otherwise fall back to instance-level signal from pipeline
      const effectiveSignal = signal ?? this.currentSignal
      const length = end - start

      let pieces: number[]
      try {
        pieces = provider.fileBytesToPieces(start, length)
      } catch {
        return null
      }

      // Prioritize these pieces for streaming download
      provider.setStreamingPieces(new Set(pieces))

      // Handle abort: deprioritize on cancellation
      effectiveSignal?.addEventListener('abort', () => {
        provider.setStreamingPieces(null)
      })

      // Wait for all pieces, then read the bytes
      return provider
        .waitForPieces(pieces, effectiveSignal ?? undefined)
        .then(() => provider.readFileBytes(start, length))
        .then((bytes) => ({
          bytes,
          view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
          offset: start,
        }))
    }

    _dispose(): void {
      // Nothing to clean up — torrent lifecycle is managed elsewhere
    }
  }

  return new TorrentSource() as InstanceType<T>
}
