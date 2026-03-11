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
import {
  createStreamingFileProvider,
  createStreamingPlaybackSession,
} from './streaming-playback-session'
import type { StreamingFileProvider } from './streaming-file-provider'
import { createTorrentSourceFromSession } from './torrent-source-session'

export type { ReadResult } from './torrent-source-session'
export { createTorrentSourceFromSession } from './torrent-source-session'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SourceConstructor = abstract new (...args: any[]) => any

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
  const session = createStreamingPlaybackSession(provider, {
    tokenPrefix: 'torrent-source',
    logPrefix: '[torrent-source]',
  })
  return createTorrentSourceFromSession(SourceClass, session)
}
