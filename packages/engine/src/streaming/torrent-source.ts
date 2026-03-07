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
 * Usage (from a consumer that has mediabunny as a dependency):
 *
 *   import { Source, Input, ALL_FORMATS } from 'mediabunny';
 *   import { createTorrentSource } from '@jstorrent/engine/streaming/torrent-source';
 *
 *   const source = createTorrentSource(Source, torrent, fileIndex);
 *   const input = new Input({ formats: ALL_FORMATS, source });
 */

import type { Torrent } from '../core/torrent'

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
 * Create a mediabunny-compatible Source backed by torrent piece data.
 *
 * _read() prioritizes the needed pieces via setStreamingPieces and waits
 * for them to download. Supports AbortSignal for cancellation on seek.
 *
 * @param SourceClass - The mediabunny Source base class (for instanceof compatibility)
 * @param torrent - The torrent to read from
 * @param fileIndex - Index of the file within the torrent
 */
export function createTorrentSource<T extends SourceConstructor>(
  SourceClass: T,
  torrent: Torrent,
  fileIndex: number,
): InstanceType<T> {
  const file = torrent.files[fileIndex]
  if (!file) {
    throw new Error(`Invalid file index: ${fileIndex}`)
  }

  // Create a concrete subclass that implements the abstract methods
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class TorrentSource extends (SourceClass as abstract new () => any) {
    _retrieveSize(): number {
      return file.length
    }

    _read(start: number, end: number, signal?: AbortSignal): Promise<ReadResult> | null {
      const length = end - start

      let pieces: number[]
      try {
        pieces = torrent.fileBytesToPieces(fileIndex, start, length)
      } catch {
        return null
      }

      // Prioritize these pieces for streaming download
      torrent.setStreamingPieces(new Set(pieces))

      // Handle abort: deprioritize on cancellation
      signal?.addEventListener('abort', () => {
        torrent.setStreamingPieces(null)
      })

      // Wait for all pieces, then read the bytes
      return torrent
        .waitForPieces(pieces, signal)
        .then(() => torrent.readFileBytes(fileIndex, start, length))
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
