/**
 * Utilities for batched verified writes to the daemon.
 *
 * The pack format is designed for efficient binary transmission:
 * - All multi-byte integers are little-endian
 * - Strings are length-prefixed (1 or 2 bytes depending on max size)
 * - SHA1 hashes are transmitted as 40-byte hex strings (fixed size)
 */

/** Input for packing a verified write */
export interface VerifiedWriteInput {
  rootKey: string
  path: string
  position: number
  data: ArrayBuffer
  expectedHashHex: string
  callbackId: string
}

/**
 * Pack an array of verified write requests into a binary buffer.
 *
 * Format (all multi-byte integers are little-endian):
 *   [count: u32 LE] then for each write:
 *     [rootKeyLen: u8] [rootKey: UTF-8 bytes]
 *     [pathLen: u16 LE] [path: UTF-8 bytes]
 *     [position: u64 LE]
 *     [dataLen: u32 LE] [data: bytes]
 *     [hashHex: 40 bytes] (fixed size - SHA1 hex is always 40 chars)
 *     [callbackIdLen: u8] [callbackId: UTF-8 bytes]
 */
export function packVerifiedWriteBatch(writes: VerifiedWriteInput[]): ArrayBuffer {
  const textEncoder = new TextEncoder()

  // Pre-encode strings to calculate total size
  const encoded = writes.map((w) => {
    const hashBytes = textEncoder.encode(w.expectedHashHex)
    return {
      rootKey: textEncoder.encode(w.rootKey),
      path: textEncoder.encode(w.path),
      hashHex: hashBytes,
      callbackId: textEncoder.encode(w.callbackId),
      data: w.data,
      position: w.position,
    }
  })

  // Calculate total size
  let totalSize = 4 // count
  for (const e of encoded) {
    totalSize += 1 + e.rootKey.length // rootKeyLen + rootKey
    totalSize += 2 + e.path.length // pathLen + path
    totalSize += 8 // position (u64)
    totalSize += 4 + e.data.byteLength // dataLen + data
    totalSize += 40 // hashHex (fixed 40 bytes)
    totalSize += 1 + e.callbackId.length // callbackIdLen + callbackId
  }

  const buffer = new ArrayBuffer(totalSize)
  const view = new DataView(buffer)
  const bytes = new Uint8Array(buffer)

  let offset = 0

  // Count
  view.setUint32(offset, writes.length, true)
  offset += 4

  for (const e of encoded) {
    // rootKeyLen + rootKey
    bytes[offset] = e.rootKey.length
    offset += 1
    bytes.set(e.rootKey, offset)
    offset += e.rootKey.length

    // pathLen + path
    view.setUint16(offset, e.path.length, true)
    offset += 2
    bytes.set(e.path, offset)
    offset += e.path.length

    // position (u64 LE)
    // JavaScript can't write u64 directly, but positions fit in 52 bits (Number.MAX_SAFE_INTEGER)
    // Write as two u32 values
    view.setUint32(offset, e.position >>> 0, true) // low 32 bits
    view.setUint32(offset + 4, Math.floor(e.position / 0x100000000) >>> 0, true) // high 32 bits
    offset += 8

    // dataLen + data
    view.setUint32(offset, e.data.byteLength, true)
    offset += 4
    bytes.set(new Uint8Array(e.data), offset)
    offset += e.data.byteLength

    // hashHex (40 bytes, fixed size)
    bytes.set(e.hashHex, offset)
    offset += 40

    // callbackIdLen + callbackId
    bytes[offset] = e.callbackId.length
    offset += 1
    bytes.set(e.callbackId, offset)
    offset += e.callbackId.length
  }

  return buffer
}
