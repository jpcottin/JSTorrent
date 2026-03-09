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
export const StreamingPlaybackMode = {
  DirectBytes: 'direct-bytes',
  Hls: 'hls',
} as const

export type StreamingPlaybackMode =
  (typeof StreamingPlaybackMode)[keyof typeof StreamingPlaybackMode]

export const StreamingContainerFormat = {
  Matroska: 'matroska',
  Mp4: 'mp4',
  Unknown: 'unknown',
} as const

export type StreamingContainerFormat =
  (typeof StreamingContainerFormat)[keyof typeof StreamingContainerFormat]

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

export interface PreparedPlaybackMetadata {
  capabilities?: StreamingPlaybackCapabilities
}

export interface DirectBytePlaybackOption {
  mode: typeof StreamingPlaybackMode.DirectBytes
  url: string
  mimeType?: string | null
}

export interface HlsPlaybackOption {
  mode: typeof StreamingPlaybackMode.Hls
}

export type StreamingPlaybackOption = DirectBytePlaybackOption | HlsPlaybackOption

export interface StreamingPlaybackCapabilities {
  supportedModes: StreamingPlaybackMode[]
  preferredMode: StreamingPlaybackMode
  containerFormat: StreamingContainerFormat
  canPrepareMetadata: boolean
}

export interface StreamingPlayerController {
  getPlaybackCapabilities?(): Promise<StreamingPlaybackCapabilities | null>
  getPlaybackOptions?(): Promise<StreamingPlaybackOption[] | null>
  preparePlaybackMetadata?(): Promise<PreparedPlaybackMetadata | null>
  getPreparedPlaybackMetadata?(): Promise<PreparedPlaybackMetadata | null>
}

export interface StreamingPlaybackHandle {
  bytes: ByteRangeStreamingSession
  controller?: StreamingPlayerController
  diagnostics?: StreamingVisualization
}

export interface StreamingFileProvider extends StreamingVisualization {
  readonly fileSize: number
  getPlaybackCapabilities?(): StreamingPlaybackCapabilities | Promise<StreamingPlaybackCapabilities>
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
