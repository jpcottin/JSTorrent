/**
 * Clean proxy-friendly interface for the Torrent methods that TorrentSource needs.
 *
 * All args and return values are structured-clone-friendly (numbers, Uint8Array, Set),
 * so this interface can be implemented as a direct wrapper around a Torrent object
 * (same thread) or as a postMessage proxy (cross-worker).
 *
 * This is a single-file-scoped view — no fileIndex parameter because it's
 * bound at construction time via createStreamingFileProvider().
 */
export interface PrebuiltKeyframeIndex {
  durationSec: number
  keyframeTimestampsSec: number[]
}

export interface StreamingFileProvider {
  readonly fileSize: number
  fileBytesToPieces(offset: number, length: number): number[]
  setStreamingPieces(pieces: Set<number> | null): void
  waitForPieces(pieceIndices: number[], signal?: AbortSignal): Promise<void>
  readFileBytes(offset: number, length: number): Promise<Uint8Array>
  buildPrebuiltKeyframeIndex?(): Promise<PrebuiltKeyframeIndex | null>
}
