/**
 * Build an MKV keyframe index from torrent piece data.
 *
 * Uses parseMkvCues to extract the Cues element, reading only metadata
 * regions (~5% of file) via torrent piece prioritization. This replaces the
 * expensive mediabunny getNextKeyPacket() iteration which scans every cluster.
 */

import type { Torrent } from '../core/torrent'
import { parseMkvCues, type MkvCuePoint } from './mkv-cue-parser'

export type { MkvCuePoint }

/**
 * Check if a filename has an MKV or WebM extension.
 * Both use the Matroska container (EBML) and have Cues elements.
 */
export function isMkvFile(filename: string): boolean {
  const lower = filename.toLowerCase()
  return lower.endsWith('.mkv') || lower.endsWith('.webm')
}

/**
 * Build a keyframe index for an MKV file within a torrent.
 *
 * Creates an async read function backed by torrent piece prioritization,
 * then delegates to parseMkvCues for EBML parsing. Only downloads the
 * small metadata regions needed (EBML header, SeekHead, Info, Cues).
 *
 * @param torrent - The torrent containing the MKV file
 * @param fileIndex - Index of the MKV file within the torrent
 * @param signal - Optional AbortSignal for cancellation
 * @returns Array of cue points sorted by timestamp, or empty array if no Cues
 */
export async function buildMkvKeyframeIndex(
  torrent: Torrent,
  fileIndex: number,
  signal?: AbortSignal,
): Promise<MkvCuePoint[]> {
  const file = torrent.files[fileIndex]
  if (!file) {
    throw new Error(`Invalid file index: ${fileIndex}`)
  }

  const fileSize = file.length

  const read = async (start: number, end: number): Promise<Uint8Array> => {
    const length = end - start
    const pieces = torrent.fileBytesToPieces(fileIndex, start, length)
    torrent.setStreamingPieces(new Set(pieces))
    await torrent.waitForPieces(pieces, signal)
    return torrent.readFileBytes(fileIndex, start, length)
  }

  try {
    return await parseMkvCues(read, fileSize)
  } finally {
    torrent.setStreamingPieces(null)
  }
}
