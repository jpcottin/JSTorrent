/**
 * Reasons for SHA1 hashing - used for routing and debugging.
 */
export type Sha1Reason =
  // MSE handshake (small, latency-sensitive)
  | 'mse-init'
  | 'mse-resp'
  | 'mse-resp-req1'
  | 'mse-resp-req2-lookup'
  | 'mse-resp-req3'
  | 'mse-resp-check'
  | 'mse-resp-keys'
  | 'mse-req2'
  // Metadata (small-medium)
  | 'info-hash'
  | 'metadata-verify'
  // Piece operations (large)
  | 'piece-verify'
  | 'piece-upload-verify'
  | 'torrent-create'

/**
 * Reasons that should use local (SubtleCrypto) hashing when available.
 * These are small payloads where HTTP latency would dominate.
 */
export const SUBTLE_CRYPTO_REASONS: ReadonlySet<Sha1Reason> = new Set([
  'mse-init',
  'mse-resp',
  'mse-resp-req1',
  'mse-resp-req2-lookup',
  'mse-resp-req3',
  'mse-resp-check',
  'mse-resp-keys',
  'mse-req2',
  'info-hash',
  'metadata-verify',
])

/**
 * Interface for cryptographic hashing.
 */
export interface IHasher {
  /**
   * Compute SHA1 hash of data.
   * @param data - Data to hash
   * @param reason - Optional reason for the hash (for debugging/tracing)
   * @returns 20-byte hash as Uint8Array
   */
  sha1(data: Uint8Array, reason?: Sha1Reason): Promise<Uint8Array>

  /**
   * Batch SHA1 computation. Optional - falls back to sequential if not implemented.
   * @param inputs - Array of data to hash
   * @param reason - Optional reason for the hash (for debugging/tracing)
   * @returns Array of 20-byte hashes in same order
   */
  sha1Batch?(inputs: Uint8Array[], reason?: Sha1Reason): Promise<Uint8Array[]>

  /**
   * Compute SHA1 hash with zero-copy buffer transfer, processing result in a callback.
   * Optional - only implemented by hashers that support buffer transfer.
   *
   * The callback pattern ensures the original `data` variable is not accidentally used
   * after transfer (it's out of scope inside the callback). This provides compile-time
   * safety against accessing detached buffers.
   *
   * Use this for large payloads (piece verification) where:
   * 1. Zero-copy transfer provides performance benefits
   * 2. You need to use the data after hashing
   *
   * @param data - Data to hash (will be consumed, original becomes invalid after call)
   * @param process - Callback receiving the hash and valid data buffer
   * @param reason - Optional reason for the hash (for debugging/tracing)
   * @returns Result of the process callback
   */
  sha1TransferThen?<T>(
    data: Uint8Array,
    process: (hash: Uint8Array, data: Uint8Array) => T | Promise<T>,
    reason?: Sha1Reason,
  ): Promise<T>
}
