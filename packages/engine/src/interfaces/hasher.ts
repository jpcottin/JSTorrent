/**
 * Interface for cryptographic hashing.
 */
export interface IHasher {
  /**
   * Compute SHA1 hash of data.
   * @param data - Data to hash
   * @returns 20-byte hash as Uint8Array
   */
  sha1(data: Uint8Array): Promise<Uint8Array>

  /**
   * Batch SHA1 computation. Optional - falls back to sequential if not implemented.
   * @param inputs - Array of data to hash
   * @returns Array of 20-byte hashes in same order
   */
  sha1Batch?(inputs: Uint8Array[]): Promise<Uint8Array[]>
}
