import * as crypto from 'crypto'
import { IHasher, Sha1Reason } from '../../interfaces/hasher'

/**
 * Hasher using Node.js native crypto module.
 * Uses crypto.createHash() for maximum compatibility and performance.
 */
export class NodeHasher implements IHasher {
  async sha1(data: Uint8Array, _reason?: Sha1Reason): Promise<Uint8Array> {
    const hash = crypto.createHash('sha1')
    hash.update(data)
    return new Uint8Array(hash.digest())
  }

  async sha1Batch(inputs: Uint8Array[], _reason?: Sha1Reason): Promise<Uint8Array[]> {
    // Node crypto is synchronous, just map over inputs
    return inputs.map((data) => {
      const hash = crypto.createHash('sha1')
      hash.update(data)
      return new Uint8Array(hash.digest())
    })
  }
}
