/**
 * Lightweight mediabunny Source adapter backed by a ByteRangeStreamingSession.
 *
 * This file is intentionally free of heavy engine imports so that consumers
 * (like the popup video player) can use it without pulling in the full engine.
 */

import type { ByteRangeStreamingSession } from './streaming-file-provider'

export interface ReadResult {
  bytes: Uint8Array
  view: DataView
  offset: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SourceConstructor = abstract new (...args: any[]) => any
type AbortAwareStreamingSession = ByteRangeStreamingSession & {
  setCurrentSignal?(signal: AbortSignal | null): void
}

export function createTorrentSourceFromSession<T extends SourceConstructor>(
  SourceClass: T,
  session: ByteRangeStreamingSession,
): InstanceType<T> {
  let disposed = false
  const abortAwareSession = session as AbortAwareStreamingSession

  // Create a concrete subclass that implements the abstract methods
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  class TorrentSource extends (SourceClass as abstract new () => any) {
    /** Instance-level signal set by the pipeline before each segment. */
    currentSignal: AbortSignal | null = null

    setCurrentSignal(signal: AbortSignal | null): void {
      this.currentSignal = signal
      abortAwareSession.setCurrentSignal?.(signal)
    }

    _retrieveSize(): number {
      return session.fileSize
    }

    _read(start: number, end: number, signal?: AbortSignal): Promise<ReadResult> | null {
      if (disposed) {
        console.log(`[torrent-source] read rejected after dispose start=${start} end=${end}`)
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }

      if (start < 0 || end < start || end > session.fileSize) {
        return null
      }

      const effectiveSignal = signal ?? this.currentSignal ?? undefined
      return session.read(start, end - start, effectiveSignal).then((bytes) => ({
        bytes,
        view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        offset: start,
      }))
    }

    _dispose(): void {
      if (disposed) return
      disposed = true
      session.close()
    }
  }

  return new TorrentSource() as InstanceType<T>
}
