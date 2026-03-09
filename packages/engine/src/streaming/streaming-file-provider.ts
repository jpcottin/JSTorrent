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

export type StreamingHintUrgency = 'metadata' | 'next' | 'now'

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

export interface StreamingVisualization {
  getPieceTimelineSnapshot?(): Promise<StreamingFilePieceSnapshot | null>
}

export interface ByteRangeStreamingSession {
  readonly fileSize: number
  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>
  waitForRange(offset: number, length: number, signal?: AbortSignal): Promise<void>
  close(): void
}

export interface StreamingPlaybackControl {
  buildPrebuiltKeyframeIndex?(): Promise<PrebuiltKeyframeIndex | null>
}

export interface StreamingPlaybackHandle {
  bytes: ByteRangeStreamingSession
  control?: StreamingPlaybackControl
  diagnostics?: StreamingVisualization
}

export interface StreamingFileProvider extends StreamingPlaybackControl, StreamingVisualization {
  readonly fileSize: number
  fileBytesToPieces(offset: number, length: number): number[]
  setStreamingPieces(pieces: Set<number> | null): void
  updateStreamingFileLock?(token: string, enabled: boolean): void
  updateStreamingDemand?(
    token: string,
    pieces: Set<number> | null,
    urgency?: StreamingHintUrgency,
  ): void
  waitForPieces(pieceIndices: number[], signal?: AbortSignal): Promise<void>
  readFileBytes(offset: number, length: number): Promise<Uint8Array>
}
