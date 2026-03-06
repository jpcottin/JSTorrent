/**
 * TorrentSource — mediabunny Source adapter backed by torrent pieces.
 *
 * Provides a factory that creates a mediabunny-compatible Source from a
 * Torrent + fileIndex. The mediabunny Source base class is passed in as a
 * parameter to avoid adding mediabunny as a dependency of the engine package.
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
 */
interface ReadResult {
  bytes: Uint8Array
  view: DataView
  offset: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SourceConstructor = abstract new (...args: any[]) => any

/**
 * Create a mediabunny-compatible Source backed by torrent piece data.
 *
 * Returns null for byte ranges where pieces haven't been downloaded yet,
 * which mediabunny handles gracefully (parse loops break on null).
 *
 * For reads that MUST succeed (e.g. segment processing), the caller should
 * first call `torrent.waitForPieces()` to ensure data is available.
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

    _read(start: number, end: number): Promise<ReadResult> | null {
      const length = end - start

      // Check if all required pieces are available
      let pieces: number[]
      try {
        pieces = torrent.fileBytesToPieces(fileIndex, start, length)
      } catch {
        return null
      }

      for (const p of pieces) {
        if (!torrent.hasPiece(p)) {
          return null // mediabunny handles null gracefully
        }
      }

      // All pieces available — do the read
      return torrent.readFileBytes(fileIndex, start, length).then((bytes) => ({
        bytes,
        view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        offset: 0,
      }))
    }

    _dispose(): void {
      // Nothing to clean up — torrent lifecycle is managed elsewhere
    }
  }

  return new TorrentSource() as InstanceType<T>
}
