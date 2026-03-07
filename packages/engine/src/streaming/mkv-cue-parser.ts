/**
 * Standalone EBML parser that extracts the Cues element from an MKV file.
 *
 * Returns a coarse keyframe index (timestamp → byte offset) for piece
 * prioritization during streaming. Only reads metadata regions (EBML header,
 * SeekHead, Info, Cues) — never cluster data.
 *
 * This replaces the expensive mediabunny getNextKeyPacket() iteration loop
 * which scans every cluster sequentially. mediabunny is still used for actual
 * demuxing — just not for index building.
 */

export interface MkvCuePoint {
  timestampMs: number
  /** Absolute byte offset of the cluster in the file */
  clusterByteOffset: number
}

/**
 * Parse the Cues element from an MKV/WebM file.
 *
 * @param read - Returns bytes for a given [start, end) range. Should only be
 *   called for small metadata regions, never full clusters.
 * @param fileSize - Total file size in bytes.
 * @returns Array of cue points sorted by timestamp.
 */
export async function parseMkvCues(
  read: (start: number, end: number) => Uint8Array | Promise<Uint8Array>,
  fileSize: number,
): Promise<MkvCuePoint[]> {
  // Step 1: Parse EBML header — verify Matroska/WebM
  let pos = 0
  const headerData = await read(0, Math.min(64, fileSize))
  const headerEl = readElementHeader(headerData, 0)
  if (!headerEl || headerEl.id !== EBML_ID) {
    throw new Error('Not an EBML file')
  }
  // Skip the EBML header element entirely
  pos = headerEl.dataStart + headerEl.dataSize

  // Step 2: Find Segment element
  const segBuf = await read(pos, Math.min(pos + 16, fileSize))
  const segEl = readElementHeader(segBuf, 0)
  if (!segEl || segEl.id !== SEGMENT_ID) {
    throw new Error('Segment element not found')
  }
  const segmentDataStart = pos + segEl.dataStart

  // Step 3: Scan top-level children of Segment for SeekHead + Info.
  // We read in small chunks to avoid fetching cluster data.
  let cuesOffset: number | undefined
  let infoOffset: number | undefined
  let timestampScale = 1_000_000 // default per spec

  // Scan children until we hit cluster data or end of segment
  const scanPos = segmentDataStart
  const segmentEnd = segEl.dataSize === UNKNOWN_SIZE ? fileSize : segmentDataStart + segEl.dataSize

  // Read up to ~4KB of top-level headers to find SeekHead and Info
  const scanLimit = Math.min(segmentEnd, scanPos + 4096)
  const scanBuf = await read(scanPos, Math.min(scanLimit, fileSize))

  let localPos = 0
  while (localPos < scanBuf.length - 2) {
    const el = readElementHeader(scanBuf, localPos)
    if (!el) break

    const absPos = scanPos + localPos
    const id = el.id

    if (id === SEEKHEAD_ID) {
      // Parse SeekHead inline to find Cues and Info offsets
      const seekHeadEnd = localPos + el.dataStart + el.dataSize
      let sp = localPos + el.dataStart
      while (sp < seekHeadEnd && sp < scanBuf.length - 2) {
        const seekEl = readElementHeader(scanBuf, sp)
        if (!seekEl) break
        if (seekEl.id === SEEK_ID) {
          const seekEnd = sp + seekEl.dataStart + seekEl.dataSize
          let seekInner = sp + seekEl.dataStart
          let seekId: number | undefined
          let seekPosition: number | undefined
          while (seekInner < seekEnd && seekInner < scanBuf.length - 2) {
            const innerEl = readElementHeader(scanBuf, seekInner)
            if (!innerEl) break
            if (innerEl.id === SEEKID_ID) {
              seekId = readUint(scanBuf, seekInner + innerEl.dataStart, innerEl.dataSize)
            } else if (innerEl.id === SEEKPOSITION_ID) {
              seekPosition = readUint(scanBuf, seekInner + innerEl.dataStart, innerEl.dataSize)
            }
            seekInner += innerEl.dataStart + innerEl.dataSize
          }
          if (seekId === CUES_ID && seekPosition !== undefined) {
            cuesOffset = segmentDataStart + seekPosition
          }
          if (seekId === INFO_ID && seekPosition !== undefined) {
            infoOffset = segmentDataStart + seekPosition
          }
        }
        sp += seekEl.dataStart + seekEl.dataSize
      }
    } else if (id === INFO_ID) {
      infoOffset = absPos
    } else if (id === CLUSTER_ID) {
      // Stop scanning — clusters are large
      break
    }

    if (el.dataSize === UNKNOWN_SIZE) break
    localPos += el.dataStart + el.dataSize
  }

  // Step 4: Parse Info element to get TimestampScale
  if (infoOffset !== undefined) {
    const infoHdrBuf = await read(infoOffset, Math.min(infoOffset + 256, fileSize))
    const infoEl = readElementHeader(infoHdrBuf, 0)
    if (infoEl && infoEl.id === INFO_ID) {
      const infoEnd = infoEl.dataStart + infoEl.dataSize
      let ip = infoEl.dataStart
      while (ip < infoEnd && ip < infoHdrBuf.length - 2) {
        const child = readElementHeader(infoHdrBuf, ip)
        if (!child) break
        if (child.id === TIMESTAMP_SCALE_ID) {
          timestampScale = readUint(infoHdrBuf, ip + child.dataStart, child.dataSize)
        }
        if (child.dataSize === UNKNOWN_SIZE) break
        ip += child.dataStart + child.dataSize
      }
    }
  }

  // Step 5: Read and parse Cues element
  if (cuesOffset === undefined) {
    // No Cues in SeekHead — file may not have cues
    return []
  }

  // Read Cues header first to get its size
  const cuesHdrBuf = await read(cuesOffset, Math.min(cuesOffset + 16, fileSize))
  const cuesEl = readElementHeader(cuesHdrBuf, 0)
  if (!cuesEl || cuesEl.id !== CUES_ID) {
    return []
  }

  const cuesDataStart = cuesOffset + cuesEl.dataStart
  const cuesDataSize = cuesEl.dataSize === UNKNOWN_SIZE ? fileSize - cuesDataStart : cuesEl.dataSize

  // Read the full Cues element data
  const cuesBuf = await read(cuesDataStart, Math.min(cuesDataStart + cuesDataSize, fileSize))

  const cuePoints: MkvCuePoint[] = []
  let cp = 0
  while (cp < cuesBuf.length - 2) {
    const cpEl = readElementHeader(cuesBuf, cp)
    if (!cpEl) break

    if (cpEl.id === CUEPOINT_ID) {
      let cueTime: number | undefined
      let clusterPosition: number | undefined
      const cpEnd = cp + cpEl.dataStart + cpEl.dataSize
      let inner = cp + cpEl.dataStart
      while (inner < cpEnd && inner < cuesBuf.length - 2) {
        const child = readElementHeader(cuesBuf, inner)
        if (!child) break
        if (child.id === CUETIME_ID) {
          cueTime = readUint(cuesBuf, inner + child.dataStart, child.dataSize)
        } else if (child.id === CUETRACKPOSITIONS_ID) {
          // Parse CueTrackPositions children
          const ctpEnd = inner + child.dataStart + child.dataSize
          let ctpInner = inner + child.dataStart
          while (ctpInner < ctpEnd && ctpInner < cuesBuf.length - 2) {
            const ctpChild = readElementHeader(cuesBuf, ctpInner)
            if (!ctpChild) break
            if (ctpChild.id === CUECLUSTERPOSITION_ID) {
              clusterPosition = readUint(cuesBuf, ctpInner + ctpChild.dataStart, ctpChild.dataSize)
            }
            if (ctpChild.dataSize === UNKNOWN_SIZE) break
            ctpInner += ctpChild.dataStart + ctpChild.dataSize
          }
        }
        if (child.dataSize === UNKNOWN_SIZE) break
        inner += child.dataStart + child.dataSize
      }
      if (cueTime !== undefined && clusterPosition !== undefined) {
        cuePoints.push({
          timestampMs: (cueTime * timestampScale) / 1_000_000,
          clusterByteOffset: segmentDataStart + clusterPosition,
        })
      }
    }

    if (cpEl.dataSize === UNKNOWN_SIZE) break
    cp += cpEl.dataStart + cpEl.dataSize
  }

  return cuePoints
}

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
const CUECLUSTERPOSITION_ID = 0xf1
const CLUSTER_ID = 0x1f43b675

const UNKNOWN_SIZE = -1

// --- Minimal EBML parsing helpers ---

interface ElementHeader {
  id: number
  /** Offset from the element start to where data begins (after ID + size fields) */
  dataStart: number
  /** Size of the data, or UNKNOWN_SIZE (-1) for unknown/streaming size */
  dataSize: number
}

/**
 * Read an EBML element header (ID + size) from a buffer at the given offset.
 * Returns null if there aren't enough bytes.
 */
function readElementHeader(buf: Uint8Array, offset: number): ElementHeader | null {
  if (offset >= buf.length) return null

  // Read element ID (variable-length, 1-4 bytes)
  const idResult = readVarIntRaw(buf, offset)
  if (!idResult) return null
  const id = idResult.value
  let pos = offset + idResult.width

  // Read element size (variable-length, 1-8 bytes)
  if (pos >= buf.length) return null
  const sizeResult = readVarInt(buf, pos)
  if (!sizeResult) return null
  pos += sizeResult.width

  return {
    id,
    dataStart: pos - offset,
    dataSize: sizeResult.value,
  }
}

/**
 * Read a VINT (variable-length integer) preserving the leading bits (for element IDs).
 * Element IDs include the VINT_MARKER bit as part of the value.
 */
function readVarIntRaw(buf: Uint8Array, offset: number): { value: number; width: number } | null {
  if (offset >= buf.length) return null
  const first = buf[offset]
  if (first === 0) return null

  let width = 1
  let mask = 0x80
  while ((first & mask) === 0) {
    width++
    mask >>= 1
  }

  if (offset + width > buf.length) return null

  // For element IDs, keep the marker bit — read raw bytes as big-endian
  let value = first
  for (let i = 1; i < width; i++) {
    value = value * 256 + buf[offset + i]
  }
  return { value, width }
}

/**
 * Read a VINT (variable-length integer) with the VINT_MARKER cleared (for sizes).
 * Returns UNKNOWN_SIZE (-1) if all value bits are 1 (reserved "unknown size").
 */
function readVarInt(buf: Uint8Array, offset: number): { value: number; width: number } | null {
  if (offset >= buf.length) return null
  const first = buf[offset]
  if (first === 0) return null

  let width = 1
  let mask = 0x80
  while ((first & mask) === 0) {
    width++
    mask >>= 1
  }

  if (offset + width > buf.length) return null

  // Check for "all ones" = unknown size
  // For 1-byte: 0xFF → value bits = 0x7F (all 1s)
  // For 2-byte: 0x7FFF → value bits = 0x3FFF (all 1s), etc.
  let allOnes = true
  if ((first & (mask - 1)) !== mask - 1) allOnes = false
  if (allOnes) {
    for (let i = 1; i < width; i++) {
      if (buf[offset + i] !== 0xff) {
        allOnes = false
        break
      }
    }
  }
  if (allOnes) return { value: UNKNOWN_SIZE, width }

  // Clear the marker bit and read the value
  let value = first & (mask - 1)
  for (let i = 1; i < width; i++) {
    value = value * 256 + buf[offset + i]
  }
  return { value, width }
}

/** Read a big-endian unsigned integer of the given byte width. */
function readUint(buf: Uint8Array, offset: number, width: number): number {
  let value = 0
  for (let i = 0; i < width; i++) {
    value = value * 256 + buf[offset + i]
  }
  return value
}
