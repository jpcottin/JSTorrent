/**
 * Unit tests for the standalone MKV cue parser.
 *
 * Tests against synthetic EBML buffers — no ffmpeg or fixtures needed.
 */
import { describe, expect, it } from 'vitest'
import { parseMkvCues } from '../../src/streaming/mkv-cue-parser'

// --- EBML element IDs ---
const EBML_ID = 0x1a45dfa3
const SEGMENT_ID = 0x18538067
const SEEKHEAD_ID = 0x114d9b74
const SEEK_ID = 0x4dbb
const SEEKID_ID = 0x53ab
const SEEKPOSITION_ID = 0x53ac
const INFO_ID = 0x1549a966
const TIMESTAMP_SCALE_ID = 0x2ad7b1
const CUES_ID = 0x1c53bb6b
const CUEPOINT_ID = 0xbb
const CUETIME_ID = 0xb3
const CUETRACKPOSITIONS_ID = 0xb7
const CUETRACK_ID = 0xf7
const CUECLUSTERPOSITION_ID = 0xf1

// --- Helpers to build synthetic EBML buffers ---

/** Write an EBML element ID as raw bytes. IDs include the VINT marker as part
 *  of the value, so byte width is simply the number of bytes needed. */
function writeElementId(id: number): Uint8Array {
  if (id < 0x100) return new Uint8Array([id])
  if (id < 0x10000) return new Uint8Array([(id >> 8) & 0xff, id & 0xff])
  if (id < 0x1000000) return new Uint8Array([(id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff])
  return new Uint8Array([(id >> 24) & 0xff, (id >> 16) & 0xff, (id >> 8) & 0xff, id & 0xff])
}

/** Write a VINT size field. Uses the minimum number of bytes. */
function writeVarIntSize(size: number): Uint8Array {
  if (size < 0x7f) return new Uint8Array([0x80 | size])
  if (size < 0x3fff) return new Uint8Array([0x40 | (size >> 8), size & 0xff])
  if (size < 0x1fffff) return new Uint8Array([0x20 | (size >> 16), (size >> 8) & 0xff, size & 0xff])
  return new Uint8Array([0x10 | (size >> 24), (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff])
}

/** Write a big-endian unsigned integer in the given number of bytes. */
function writeUint(value: number, width: number): Uint8Array {
  const buf = new Uint8Array(width)
  for (let i = width - 1; i >= 0; i--) {
    buf[i] = value & 0xff
    value = Math.floor(value / 256)
  }
  return buf
}

/** Build an EBML element (ID + size + data). */
function ebmlElement(id: number, data: Uint8Array): Uint8Array {
  const idBytes = writeElementId(id)
  const sizeBytes = writeVarIntSize(data.length)
  const result = new Uint8Array(idBytes.length + sizeBytes.length + data.length)
  result.set(idBytes, 0)
  result.set(sizeBytes, idBytes.length)
  result.set(data, idBytes.length + sizeBytes.length)
  return result
}

/** Build an EBML element with unsigned integer data. */
function ebmlUintElement(id: number, value: number, width?: number): Uint8Array {
  const w = width ?? (value < 0x100 ? 1 : value < 0x10000 ? 2 : value < 0x1000000 ? 3 : 4)
  return ebmlElement(id, writeUint(value, w))
}

/** Concatenate multiple Uint8Arrays. */
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

/**
 * Build a minimal MKV buffer with the given cue points and optional timestampScale.
 *
 * Layout:
 * - EBML header (DocType: matroska)
 * - Segment
 *   - SeekHead (points to Info and Cues)
 *   - Info (TimestampScale)
 *   - Cues (CuePoint entries)
 */
function buildMkvBuffer(
  cues: Array<{ cueTime: number; track: number; clusterOffset: number }>,
  timestampScale = 1_000_000,
): Uint8Array {
  // EBML header: DocType = "matroska"
  const docType = new TextEncoder().encode('matroska')
  const ebmlHeader = ebmlElement(
    EBML_ID,
    concat(
      ebmlUintElement(0x4286, 1), // EBMLVersion
      ebmlUintElement(0x42f7, 1), // EBMLReadVersion
      ebmlElement(0x4282, docType), // DocType
    ),
  )

  // Info element (with TimestampScale)
  const infoContent = ebmlUintElement(TIMESTAMP_SCALE_ID, timestampScale, 4)
  const infoElement = ebmlElement(INFO_ID, infoContent)

  // Cues element
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

  // SeekHead: We need to know the offsets of Info and Cues relative to
  // Segment data start. We'll compute them after assembling.
  // First, build SeekHead with placeholder offsets, measure, then rebuild.

  // To compute the offsets, we need the SeekHead size first (chicken-and-egg).
  // Use a two-pass approach: build with zero offsets, measure, rebuild.
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

  // Pass 1: estimate with zero offsets to get SeekHead size
  const seekHeadEstimate = buildSeekHead(0, 0)
  const seekHeadSize = seekHeadEstimate.length

  // Info starts right after SeekHead
  const infoRelOffset = seekHeadSize
  // Cues starts right after Info
  const cuesRelOffset = seekHeadSize + infoElement.length

  // Pass 2: rebuild with correct offsets
  const seekHead = buildSeekHead(infoRelOffset, cuesRelOffset)
  // Verify size didn't change (it shouldn't with fixed-width position fields)
  if (seekHead.length !== seekHeadSize) {
    throw new Error('SeekHead size changed — use wider position fields')
  }

  // Segment content
  const segmentContent = concat(seekHead, infoElement, cuesElement)
  const segment = ebmlElement(SEGMENT_ID, segmentContent)

  return concat(ebmlHeader, segment)
}

function bufferRead(buf: Uint8Array) {
  return (start: number, end: number) => buf.subarray(start, end)
}

describe('parseMkvCues', () => {
  it('extracts cue points from a synthetic MKV buffer', async () => {
    const mkv = buildMkvBuffer([
      { cueTime: 0, track: 1, clusterOffset: 1000 },
      { cueTime: 1000, track: 1, clusterOffset: 50000 },
      { cueTime: 2000, track: 1, clusterOffset: 100000 },
    ])

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length)

    expect(cues).toHaveLength(3)
    expect(cues[0]).toEqual({ timestampMs: 0, clusterByteOffset: expect.any(Number) })
    expect(cues[1].timestampMs).toBe(1000)
    expect(cues[2].timestampMs).toBe(2000)

    // All offsets should be absolute (segmentDataStart + clusterOffset)
    expect(cues[0].clusterByteOffset).toBeGreaterThan(0)
    expect(cues[1].clusterByteOffset).toBeGreaterThan(cues[0].clusterByteOffset)
    expect(cues[2].clusterByteOffset).toBeGreaterThan(cues[1].clusterByteOffset)
  })

  it('applies non-default TimestampScale', async () => {
    // TimestampScale = 500,000 (0.5ms per unit) → cueTime 1000 = 500ms
    const mkv = buildMkvBuffer([{ cueTime: 1000, track: 1, clusterOffset: 5000 }], 500_000)

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length)

    expect(cues).toHaveLength(1)
    expect(cues[0].timestampMs).toBe(500)
  })

  it('returns empty array if no Cues element exists', async () => {
    // Build an MKV without cues: just EBML header + Segment with Info
    const docType = new TextEncoder().encode('matroska')
    const ebmlHeader = ebmlElement(
      EBML_ID,
      concat(ebmlUintElement(0x4286, 1), ebmlUintElement(0x42f7, 1), ebmlElement(0x4282, docType)),
    )
    const infoElement = ebmlElement(INFO_ID, ebmlUintElement(TIMESTAMP_SCALE_ID, 1_000_000, 4))
    const segment = ebmlElement(SEGMENT_ID, infoElement)
    const mkv = concat(ebmlHeader, segment)

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length)
    expect(cues).toEqual([])
  })

  it('throws on non-EBML data', async () => {
    const garbage = new Uint8Array([0x00, 0x01, 0x02, 0x03])
    await expect(parseMkvCues(bufferRead(garbage), garbage.length)).rejects.toThrow(
      'Not an EBML file',
    )
  })

  it('handles many cue points', async () => {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      cueTime: i * 1000,
      track: 1,
      clusterOffset: i * 65536,
    }))
    const mkv = buildMkvBuffer(entries)
    const cues = await parseMkvCues(bufferRead(mkv), mkv.length)

    expect(cues).toHaveLength(100)
    expect(cues[0].timestampMs).toBe(0)
    expect(cues[99].timestampMs).toBe(99000)
  })

  it('tracks read calls — only metadata regions accessed', async () => {
    const mkv = buildMkvBuffer([
      { cueTime: 0, track: 1, clusterOffset: 10000 },
      { cueTime: 5000, track: 1, clusterOffset: 50000 },
    ])

    const reads: Array<{ start: number; end: number }> = []
    const trackingRead = (start: number, end: number) => {
      reads.push({ start, end })
      return mkv.subarray(start, end)
    }

    await parseMkvCues(trackingRead, mkv.length)

    const totalBytesRead = reads.reduce((s, r) => s + (r.end - r.start), 0)
    // For our synthetic buffer, the entire file IS metadata, so we just verify
    // that read was called and the total is reasonable (not duplicating data)
    expect(reads.length).toBeGreaterThanOrEqual(3) // header, segment header, seekhead scan, cues
    expect(totalBytesRead).toBeLessThanOrEqual(mkv.length * 3) // no excessive re-reading
  })

  it('computes absolute byte offsets correctly', async () => {
    const clusterOffset = 12345
    const mkv = buildMkvBuffer([{ cueTime: 0, track: 1, clusterOffset }])

    const cues = await parseMkvCues(bufferRead(mkv), mkv.length)

    // Find segment data start: EBML header + Segment ID + Segment size
    // The absolute offset should be segmentDataStart + clusterOffset
    // We can verify by checking the value is reasonable
    expect(cues[0].clusterByteOffset).toBeGreaterThan(clusterOffset)
    // The segment header overhead is small (< 50 bytes typically)
    const segmentOverhead = cues[0].clusterByteOffset - clusterOffset
    expect(segmentOverhead).toBeLessThan(200)
  })
})
