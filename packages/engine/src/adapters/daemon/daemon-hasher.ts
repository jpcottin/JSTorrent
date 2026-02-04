import { IHasher, Sha1Reason } from '../../interfaces/hasher'
import { DaemonConnection } from './daemon-connection'

/**
 * Hasher that delegates to io-daemon.
 * Works in any context since hashing happens in Rust.
 */
export class DaemonHasher implements IHasher {
  constructor(private connection: DaemonConnection) {}

  async sha1(data: Uint8Array, reason?: Sha1Reason): Promise<Uint8Array> {
    const headers = reason ? { 'X-SHA-Reason': reason } : undefined
    // Returns raw 20 bytes, not hex
    return this.connection.requestBinary('POST', '/hash/sha1', undefined, data, headers)
  }

  async sha1Batch(inputs: Uint8Array[], reason?: Sha1Reason): Promise<Uint8Array[]> {
    if (inputs.length === 0) return []
    if (inputs.length === 1) return [await this.sha1(inputs[0], reason)]

    // Encode length-prefixed format:
    // count (u32 LE), then [len (u32 LE), data] for each input
    let totalSize = 4 // count
    for (const input of inputs) {
      totalSize += 4 + input.length // len + data
    }

    const buffer = new ArrayBuffer(totalSize)
    const view = new DataView(buffer)
    const bytes = new Uint8Array(buffer)

    view.setUint32(0, inputs.length, true) // little-endian count
    let offset = 4

    for (const input of inputs) {
      view.setUint32(offset, input.length, true)
      offset += 4
      bytes.set(input, offset)
      offset += input.length
    }

    const headers = reason ? { 'X-SHA-Reason': reason } : undefined
    const resultBytes = await this.connection.requestBinary(
      'POST',
      '/hash/sha1/batch',
      undefined,
      bytes,
      headers,
    )

    // Parse concatenated 20-byte hashes
    const results: Uint8Array[] = []
    for (let i = 0; i < inputs.length; i++) {
      results.push(resultBytes.slice(i * 20, (i + 1) * 20))
    }

    return results
  }
}
