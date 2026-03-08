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

export const StreamingPieceState = {
  Missing: 0,
  Partial: 1,
  FullyRequested: 2,
  FullyResponded: 3,
  Completed: 4,
} as const

export type StreamingPieceState = (typeof StreamingPieceState)[keyof typeof StreamingPieceState]

export interface StreamingActivePieceInfo {
  /** File-relative piece index (0..piecesTotal-1). */
  index: number
  state: StreamingPieceState
}

export interface StreamingFilePieceSnapshot {
  piecesTotal: number
  piecesCompleted: number
  /** Hex-encoded file-relative bitfield. */
  bitfieldHex: string
  activePieces: StreamingActivePieceInfo[]
}

export interface StreamingFileProvider {
  readonly fileSize: number
  fileBytesToPieces(offset: number, length: number): number[]
  setStreamingPieces(pieces: Set<number> | null): void
  updateStreamingDemand?(
    token: string,
    pieces: Set<number> | null,
    urgency?: 'metadata' | 'next' | 'now',
  ): void
  waitForPieces(pieceIndices: number[], signal?: AbortSignal): Promise<void>
  readFileBytes(offset: number, length: number): Promise<Uint8Array>
  buildPrebuiltKeyframeIndex?(): Promise<PrebuiltKeyframeIndex | null>
  getPieceTimelineSnapshot?(): Promise<StreamingFilePieceSnapshot | null>
}
