import { IHasher, Sha1Reason, SUBTLE_CRYPTO_REASONS } from '../../interfaces/hasher'
import { SubtleCryptoHasher } from './subtle-crypto-hasher'
import { TransferringWorkerHasher } from './transferring-worker-hasher'

/**
 * Routes SHA1 calls based on reason/size:
 * - Small/latency-sensitive operations -> SubtleCrypto (local, fast)
 * - Large payloads -> delegate hasher (Daemon or Worker)
 * - sha1Transfer (zero-copy with data return) -> TransferringWorkerHasher
 *
 * This is particularly useful on ChromeOS where the daemon runs in the Android
 * VM, adding ~10-50ms latency per HTTP request. MSE handshakes require 5+ hashes
 * per peer connection, so local hashing eliminates significant overhead.
 */
export class RoutingHasher implements IHasher {
  private subtleHasher: SubtleCryptoHasher | null
  private delegateHasher: IHasher
  private transferringHasher: TransferringWorkerHasher | null

  // Size threshold for unknown reasons - payloads under this use SubtleCrypto
  private static readonly SIZE_THRESHOLD = 64 * 1024 // 64KB

  constructor(delegateHasher: IHasher, transferringHasher?: TransferringWorkerHasher) {
    this.delegateHasher = delegateHasher
    this.transferringHasher = transferringHasher ?? null
    // Check if SubtleCrypto is available (requires secure context)
    this.subtleHasher =
      typeof crypto !== 'undefined' && crypto?.subtle ? new SubtleCryptoHasher() : null
  }

  async sha1(data: Uint8Array, reason?: Sha1Reason): Promise<Uint8Array> {
    if (this.shouldUseSubtle(data.length, reason)) {
      return this.subtleHasher!.sha1(data, reason)
    }
    return this.delegateHasher.sha1(data, reason)
  }

  async sha1Batch(inputs: Uint8Array[], reason?: Sha1Reason): Promise<Uint8Array[]> {
    // MSE batches are always small - use SubtleCrypto
    if (this.subtleHasher && reason?.startsWith('mse')) {
      return Promise.all(inputs.map((i) => this.subtleHasher!.sha1(i, reason)))
    }
    // Large batches or piece operations - use delegate
    if (this.delegateHasher.sha1Batch) {
      return this.delegateHasher.sha1Batch(inputs, reason)
    }
    return Promise.all(inputs.map((i) => this.delegateHasher.sha1(i, reason)))
  }

  private shouldUseSubtle(size: number, reason?: Sha1Reason): boolean {
    if (!this.subtleHasher) return false
    // Use SubtleCrypto for known latency-sensitive reasons
    if (reason && SUBTLE_CRYPTO_REASONS.has(reason)) return true
    // Use SubtleCrypto for small payloads even without a known reason
    return size < RoutingHasher.SIZE_THRESHOLD
  }

  /**
   * Compute SHA1 hash with zero-copy buffer transfer.
   * Uses TransferringWorkerHasher if available, otherwise falls back to
   * copying the data and using regular sha1.
   *
   * IMPORTANT: After this call, the original `data` buffer is INVALID.
   * You MUST use the returned `data` for any subsequent operations.
   *
   * @param data - Data to hash (will be consumed, original becomes invalid)
   * @param reason - Optional reason for the hash
   * @returns Object with hash and data (valid for use after call)
   */
  async sha1Transfer(
    data: Uint8Array,
    reason?: Sha1Reason,
  ): Promise<{ hash: Uint8Array; data: Uint8Array }> {
    if (this.transferringHasher) {
      return this.transferringHasher.sha1(data, reason)
    }
    // Fallback: copy data before hashing so original remains valid
    const dataCopy = data.slice()
    const hash = await this.sha1(dataCopy, reason)
    return { hash, data: dataCopy }
  }
}
