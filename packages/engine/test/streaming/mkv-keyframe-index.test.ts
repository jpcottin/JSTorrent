/**
 * Unit tests for buildMkvKeyframeIndex and isMkvFile.
 *
 * Uses a mock Torrent backed by a synthetic MKV buffer — no seeder or
 * fixtures needed.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildMkvKeyframeIndex,
  buildMkvPrebuiltKeyframeIndex,
  isMkvFile,
} from '../../src/streaming/mkv-keyframe-index'
import type { Torrent } from '../../src/core/torrent'

// --- EBML element IDs ---
const EBML_ID = 0x1a45dfa3
const SEGMENT_ID = 0x18538067
const SEEKHEAD_ID = 0x114d9b74
const SEEK_ID = 0x4dbb
const SEEKID_ID = 0x53ab
const SEEKPOSITION_ID = 0x53ac
const INFO_ID = 0x1549a966
const TIMESTAMP_SCALE_ID = 0x2ad7b1
const DURATION_ID = 0x4489
const CUES_ID = 0x1c53bb6b
const CUEPOINT_ID = 0xbb
const CUETIME_ID = 0xb3
const CUETRACKPOSITIONS_ID = 0xb7
const CUETRACK_ID = 0xf7
const CUECLUSTERPOSITION_ID = 0xf1

// --- Helpers (same as mkv-cue-parser.test.ts) ---

function writeElementId(id: number): Uint8Array {
  if (id < 0x100) return new Uint8Array([id])
  if (id < 0x10000) return new Uint8Array([(id >> 8) & 0xff, id & 0xff])
  if (id < 0x1000000) return new Uint8Array([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff])
  return new Uint8Array([(id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff])
}

function writeVarIntSize(size: number): Uint8Array {
  if (size < 0x7f) return new Uint8Array([0x80 | size])
  if (size < 0x3fff) return new Uint8Array([0x40 | (size >> 8), size & 0xff])
  if (size < 0x1fffff) return new Uint8Array([0x20 | (size >> 16), (size >> 8) & 0xff, size & 0xff])
  return new Uint8Array([0x10 | (size >> 24), (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff])
}

function writeUint(value: number, width: number): Uint8Array {
  const buf = new Uint8Array(width)
  for (let i = width - 1; i >= 0; i--) {
    buf[i] = value & 0xff
    value = Math.floor(value / 256)
  }
  return buf
}

function ebmlElement(id: number, data: Uint8Array): Uint8Array {
  const idBytes = writeElementId(id)
  const sizeBytes = writeVarIntSize(data.length)
  const result = new Uint8Array(idBytes.length + sizeBytes.length + data.length)
  result.set(idBytes, 0)
  result.set(sizeBytes, idBytes.length)
  result.set(data, idBytes.length + sizeBytes.length)
  return result
}

function ebmlUintElement(id: number, value: number, width?: number): Uint8Array {
  const w = width ?? (value < 0x100 ? 1 : value < 0x10000 ? 2 : value < 0x1000000 ? 3 : 4)
  return ebmlElement(id, writeUint(value, w))
}

function ebmlFloat64Element(id: number, value: number): Uint8Array {
  const buf = new Uint8Array(8)
  const view = new DataView(buf.buffer)
  view.setFloat64(0, value, false)
  return ebmlElement(id, buf)
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const a of arrays) {
    result.set(a, offset)
    offset += a.length
  }
  return result
}

function buildMkvBuffer(
  cues: Array<{ cueTime: number; track: number; clusterOffset: number }>,
  timestampScale = 1_000_000,
): Uint8Array {
  const docType = new TextEncoder().encode('matroska')
  const ebmlHeader = ebmlElement(
    EBML_ID,
    concat(ebmlUintElement(0x4286, 1), ebmlUintElement(0x42f7, 1), ebmlElement(0x4282, docType)),
  )

  const durationTicks = (cues[cues.length - 1]?.cueTime ?? 0) + 1000
  const infoContent = concat(
    ebmlUintElement(TIMESTAMP_SCALE_ID, timestampScale, 4),
    ebmlFloat64Element(DURATION_ID, durationTicks),
  )
  const infoElement = ebmlElement(INFO_ID, infoContent)

  const cuePointElements = cues.map((c) =>
    ebmlElement(
      CUEPOINT_ID,
      concat(
        ebmlUintElement(CUETIME_ID, c.cueTime),
        ebmlElement(
          CUETRACKPOSITIONS_ID,
          concat(
            ebmlUintElement(CUETRACK_ID, c.track),
            ebmlUintElement(CUECLUSTERPOSITION_ID, c.clusterOffset, 4),
          ),
        ),
      ),
    ),
  )
  const cuesElement = ebmlElement(CUES_ID, concat(...cuePointElements))

  function buildSeekHead(infoPos: number, cuesPos: number): Uint8Array {
    const seekInfo = ebmlElement(
      SEEK_ID,
      concat(
        ebmlElement(SEEKID_ID, writeElementId(INFO_ID)),
        ebmlUintElement(SEEKPOSITION_ID, infoPos, 4),
      ),
    )
    const seekCues = ebmlElement(
      SEEK_ID,
      concat(
        ebmlElement(SEEKID_ID, writeElementId(CUES_ID)),
        ebmlUintElement(SEEKPOSITION_ID, cuesPos, 4),
      ),
    )
    return ebmlElement(SEEKHEAD_ID, concat(seekInfo, seekCues))
  }

  const seekHeadEstimate = buildSeekHead(0, 0)
  const seekHeadSize = seekHeadEstimate.length
  const infoRelOffset = seekHeadSize
  const cuesRelOffset = seekHeadSize + infoElement.length
  const seekHead = buildSeekHead(infoRelOffset, cuesRelOffset)

  const segmentContent = concat(seekHead, infoElement, cuesElement)
  const segment = ebmlElement(SEGMENT_ID, segmentContent)

  return concat(ebmlHeader, segment)
}

/**
 * Create a mock Torrent that serves bytes from a buffer.
 * The mock uses a single file with pieceLength = buffer.length (one piece).
 */
function createMockTorrent(buffer: Uint8Array) {
  const setStreamingPieces = vi.fn()
  const waitForPieces = vi.fn().mockResolvedValue(undefined)
  const readFileBytes = vi.fn((_fileIndex: number, offset: number, length: number) =>
    Promise.resolve(buffer.subarray(offset, offset + length)),
  )
  const fileBytesToPieces = vi.fn((_fileIndex: number, _offset: number, _length: number) => [0])

  const torrent = {
    files: [{ length: buffer.length, path: 'video.mkv', offset: 0 }],
    setStreamingPieces,
    waitForPieces,
    readFileBytes,
    fileBytesToPieces,
  } as unknown as Torrent

  return { torrent, setStreamingPieces, waitForPieces, readFileBytes, fileBytesToPieces }
}

// --- Tests ---

describe('isMkvFile', () => {
  it('returns true for .mkv', () => {
    expect(isMkvFile('video.mkv')).toBe(true)
    expect(isMkvFile('VIDEO.MKV')).toBe(true)
    expect(isMkvFile('path/to/file.mkv')).toBe(true)
  })

  it('returns true for .webm', () => {
    expect(isMkvFile('video.webm')).toBe(true)
    expect(isMkvFile('VIDEO.WEBM')).toBe(true)
  })

  it('returns false for non-MKV extensions', () => {
    expect(isMkvFile('video.mp4')).toBe(false)
    expect(isMkvFile('video.avi')).toBe(false)
    expect(isMkvFile('file.mkv.bak')).toBe(false)
    expect(isMkvFile('mkv')).toBe(false)
  })
})

describe('buildMkvKeyframeIndex', () => {
  it('returns cue points from a torrent-backed MKV file', async () => {
    const buffer = buildMkvBuffer([
      { cueTime: 0, track: 1, clusterOffset: 1000 },
      { cueTime: 1000, track: 1, clusterOffset: 50000 },
      { cueTime: 2000, track: 1, clusterOffset: 100000 },
    ])
    const { torrent } = createMockTorrent(buffer)

    const cues = await buildMkvKeyframeIndex(torrent, 0)

    expect(cues).toHaveLength(3)
    expect(cues[0].timestampMs).toBe(0)
    expect(cues[1].timestampMs).toBe(1000)
    expect(cues[2].timestampMs).toBe(2000)
    expect(cues[0].clusterByteOffset).toBeGreaterThan(0)
  })

  it('calls setStreamingPieces during reads and clears after', async () => {
    const buffer = buildMkvBuffer([{ cueTime: 0, track: 1, clusterOffset: 1000 }])
    const { torrent, setStreamingPieces } = createMockTorrent(buffer)

    await buildMkvKeyframeIndex(torrent, 0)

    // Called during reads (with piece sets) and cleared after (with null)
    const calls = setStreamingPieces.mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(2)

    // Intermediate calls pass Set<number>
    for (let i = 0; i < calls.length - 1; i++) {
      expect(calls[i][0]).toBeInstanceOf(Set)
    }

    // Final call clears priorities
    expect(calls[calls.length - 1][0]).toBeNull()
  })

  it('clears streaming priority on error', async () => {
    const buffer = buildMkvBuffer([{ cueTime: 0, track: 1, clusterOffset: 1000 }])
    const { torrent, setStreamingPieces, waitForPieces } = createMockTorrent(buffer)

    // Fail on the second waitForPieces call
    let callCount = 0
    waitForPieces.mockImplementation(() => {
      callCount++
      if (callCount > 1) return Promise.reject(new Error('piece download failed'))
      return Promise.resolve()
    })

    await expect(buildMkvKeyframeIndex(torrent, 0)).rejects.toThrow('piece download failed')

    // setStreamingPieces(null) should still be called in finally
    const lastCall = setStreamingPieces.mock.calls[setStreamingPieces.mock.calls.length - 1]
    expect(lastCall[0]).toBeNull()
  })

  it('supports cancellation via AbortSignal', async () => {
    const buffer = buildMkvBuffer([{ cueTime: 0, track: 1, clusterOffset: 1000 }])
    const { torrent, waitForPieces } = createMockTorrent(buffer)

    const controller = new AbortController()
    controller.abort()

    waitForPieces.mockImplementation((_pieces: number[], signal?: AbortSignal) => {
      if (signal?.aborted) {
        return Promise.reject(new DOMException('Aborted', 'AbortError'))
      }
      return Promise.resolve()
    })

    await expect(buildMkvKeyframeIndex(torrent, 0, controller.signal)).rejects.toThrow('Aborted')
  })

  it('throws for invalid file index', async () => {
    const buffer = buildMkvBuffer([{ cueTime: 0, track: 1, clusterOffset: 1000 }])
    const { torrent } = createMockTorrent(buffer)

    await expect(buildMkvKeyframeIndex(torrent, 5)).rejects.toThrow('Invalid file index')
  })

  it('calls waitForPieces and readFileBytes for each read', async () => {
    const buffer = buildMkvBuffer([
      { cueTime: 0, track: 1, clusterOffset: 1000 },
      { cueTime: 5000, track: 1, clusterOffset: 50000 },
    ])
    const { torrent, waitForPieces, readFileBytes, fileBytesToPieces } = createMockTorrent(buffer)

    await buildMkvKeyframeIndex(torrent, 0)

    // parseMkvCues makes 6 reads: header, segment header, seekhead scan, info, cues header, cues data
    expect(waitForPieces.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(readFileBytes.mock.calls.length).toBeGreaterThanOrEqual(3)
    expect(fileBytesToPieces.mock.calls.length).toBeGreaterThanOrEqual(3)
  })

  it('builds a prebuilt keyframe index with duration and timestamps', async () => {
    const buffer = buildMkvBuffer([
      { cueTime: 0, track: 1, clusterOffset: 1000 },
      { cueTime: 1000, track: 1, clusterOffset: 50000 },
      { cueTime: 2000, track: 1, clusterOffset: 100000 },
    ])
    const { torrent } = createMockTorrent(buffer)

    const index = await buildMkvPrebuiltKeyframeIndex(torrent, 0)

    expect(index).toEqual({
      durationSec: 3,
      keyframeTimestampsSec: [0, 1, 2],
    })
  })
})
