import { describe, it, expect } from 'vitest'
import {
  deriveEncryptionKeys,
  computeReq1Hash,
  computeReq2Hash,
  computeReq2Xor3,
  recoverInfoHash,
  recoverInfoHashWithMap,
  concat,
  arraysEqual,
  toHex,
} from '../../src/crypto/key-derivation'

// Helper to create SHA1 using SubtleCrypto
async function sha1(data: Uint8Array): Promise<Uint8Array> {
  const hash = await crypto.subtle.digest('SHA-1', data as BufferSource)
  return new Uint8Array(hash)
}

function getRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return bytes
}

describe('key-derivation', () => {
  describe('concat', () => {
    it('should concatenate multiple arrays', () => {
      const a = new Uint8Array([1, 2, 3])
      const b = new Uint8Array([4, 5])
      const c = new Uint8Array([6, 7, 8, 9])

      const result = concat(a, b, c)

      expect(result).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))
    })

    it('should handle empty arrays', () => {
      const a = new Uint8Array([1, 2])
      const b = new Uint8Array(0)
      const c = new Uint8Array([3])

      const result = concat(a, b, c)

      expect(result).toEqual(new Uint8Array([1, 2, 3]))
    })
  })

  describe('arraysEqual', () => {
    it('should return true for equal arrays', () => {
      const a = new Uint8Array([1, 2, 3])
      const b = new Uint8Array([1, 2, 3])

      expect(arraysEqual(a, b)).toBe(true)
    })

    it('should return false for different arrays', () => {
      const a = new Uint8Array([1, 2, 3])
      const b = new Uint8Array([1, 2, 4])

      expect(arraysEqual(a, b)).toBe(false)
    })

    it('should return false for different lengths', () => {
      const a = new Uint8Array([1, 2, 3])
      const b = new Uint8Array([1, 2])

      expect(arraysEqual(a, b)).toBe(false)
    })
  })

  describe('deriveEncryptionKeys', () => {
    it('should derive different keys for initiator and responder', async () => {
      const sharedSecret = getRandomBytes(96)
      const infoHash = getRandomBytes(20)

      const initiatorKeys = await deriveEncryptionKeys(sharedSecret, infoHash, true, sha1)
      const responderKeys = await deriveEncryptionKeys(sharedSecret, infoHash, false, sha1)

      // Initiator's encrypt should match responder's decrypt
      const testData = getRandomBytes(32)
      const encrypted = initiatorKeys.encrypt.process(testData.slice())
      const decrypted = responderKeys.decrypt.process(encrypted)

      expect(decrypted).toEqual(testData)
    })

    it('should produce deterministic results', async () => {
      const sharedSecret = getRandomBytes(96)
      const infoHash = getRandomBytes(20)

      const keys1 = await deriveEncryptionKeys(sharedSecret, infoHash, true, sha1)
      const keys2 = await deriveEncryptionKeys(sharedSecret, infoHash, true, sha1)

      // Process same data with both
      const testData = new Uint8Array([1, 2, 3, 4, 5])
      const out1 = keys1.encrypt.process(testData.slice())
      const out2 = keys2.encrypt.process(testData.slice())

      expect(out1).toEqual(out2)
    })
  })

  describe('computeReq1Hash', () => {
    it('should produce 20-byte hash', async () => {
      const sharedSecret = getRandomBytes(96)

      const hash = await computeReq1Hash(sharedSecret, sha1)

      expect(hash.length).toBe(20)
    })

    it('should be deterministic', async () => {
      const sharedSecret = getRandomBytes(96)

      const hash1 = await computeReq1Hash(sharedSecret, sha1)
      const hash2 = await computeReq1Hash(sharedSecret, sha1)

      expect(hash1).toEqual(hash2)
    })
  })

  describe('computeReq2Xor3', () => {
    it('should produce 20-byte result', async () => {
      const infoHash = getRandomBytes(20)
      const sharedSecret = getRandomBytes(96)

      const result = await computeReq2Xor3(infoHash, sharedSecret, sha1)

      expect(result.length).toBe(20)
    })
  })

  describe('recoverInfoHash', () => {
    it('should recover known info hash', async () => {
      const infoHash = getRandomBytes(20)
      const sharedSecret = getRandomBytes(96)
      const otherInfoHash = getRandomBytes(20)

      // Compute XOR value as initiator would send
      const xorValue = await computeReq2Xor3(infoHash, sharedSecret, sha1)

      // Responder tries to recover
      const recovered = await recoverInfoHash(
        xorValue,
        sharedSecret,
        [otherInfoHash, infoHash],
        sha1,
      )

      expect(recovered).toEqual(infoHash)
    })

    it('should return null for unknown info hash', async () => {
      const infoHash = getRandomBytes(20)
      const sharedSecret = getRandomBytes(96)
      const otherInfoHash = getRandomBytes(20)

      const xorValue = await computeReq2Xor3(infoHash, sharedSecret, sha1)

      // Responder doesn't have the correct info hash
      const recovered = await recoverInfoHash(xorValue, sharedSecret, [otherInfoHash], sha1)

      expect(recovered).toBeNull()
    })

    it('should work with empty known hashes list', async () => {
      const infoHash = getRandomBytes(20)
      const sharedSecret = getRandomBytes(96)

      const xorValue = await computeReq2Xor3(infoHash, sharedSecret, sha1)

      const recovered = await recoverInfoHash(xorValue, sharedSecret, [], sha1)

      expect(recovered).toBeNull()
    })
  })

  describe('toHex', () => {
    it('should convert bytes to hex string', () => {
      const bytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef])
      expect(toHex(bytes)).toBe('deadbeef')
    })

    it('should pad single digit hex values', () => {
      const bytes = new Uint8Array([0x01, 0x02, 0x0f])
      expect(toHex(bytes)).toBe('01020f')
    })

    it('should handle empty array', () => {
      expect(toHex(new Uint8Array(0))).toBe('')
    })
  })

  describe('recoverInfoHashWithMap', () => {
    it('should recover info hash using map lookup (O(1))', async () => {
      const infoHash = getRandomBytes(20)
      const sharedSecret = getRandomBytes(96)

      // Precompute req2 hash and build map (what BtEngine does at startup)
      const req2Hash = await computeReq2Hash(infoHash, sha1)
      const req2Map = new Map([[toHex(req2Hash), infoHash]])

      // Compute XOR value as initiator would send
      const xorValue = await computeReq2Xor3(infoHash, sharedSecret, sha1)

      // Responder recovers using map lookup
      const recovered = await recoverInfoHashWithMap(xorValue, sharedSecret, req2Map, sha1)

      expect(recovered).toEqual(infoHash)
    })

    it('should find correct hash among multiple torrents', async () => {
      const infoHashes = [getRandomBytes(20), getRandomBytes(20), getRandomBytes(20)]
      const sharedSecret = getRandomBytes(96)
      const targetIndex = 1 // The one we want to find

      // Build req2Map from all info hashes
      const req2Map = new Map<string, Uint8Array>()
      for (const ih of infoHashes) {
        const req2Hash = await computeReq2Hash(ih, sha1)
        req2Map.set(toHex(req2Hash), ih)
      }

      // Compute XOR value for the target
      const xorValue = await computeReq2Xor3(infoHashes[targetIndex], sharedSecret, sha1)

      // Should find the correct one
      const recovered = await recoverInfoHashWithMap(xorValue, sharedSecret, req2Map, sha1)

      expect(recovered).toEqual(infoHashes[targetIndex])
    })

    it('should return null for unknown info hash', async () => {
      const knownInfoHash = getRandomBytes(20)
      const unknownInfoHash = getRandomBytes(20)
      const sharedSecret = getRandomBytes(96)

      // Map only contains knownInfoHash
      const req2Hash = await computeReq2Hash(knownInfoHash, sha1)
      const req2Map = new Map([[toHex(req2Hash), knownInfoHash]])

      // XOR value is for unknownInfoHash
      const xorValue = await computeReq2Xor3(unknownInfoHash, sharedSecret, sha1)

      const recovered = await recoverInfoHashWithMap(xorValue, sharedSecret, req2Map, sha1)

      expect(recovered).toBeNull()
    })

    it('should return null for empty map', async () => {
      const infoHash = getRandomBytes(20)
      const sharedSecret = getRandomBytes(96)
      const req2Map = new Map<string, Uint8Array>()

      const xorValue = await computeReq2Xor3(infoHash, sharedSecret, sha1)

      const recovered = await recoverInfoHashWithMap(xorValue, sharedSecret, req2Map, sha1)

      expect(recovered).toBeNull()
    })

    it('should produce same result as legacy recoverInfoHash', async () => {
      const infoHashes = [getRandomBytes(20), getRandomBytes(20), getRandomBytes(20)]
      const sharedSecret = getRandomBytes(96)
      const targetIndex = 2

      // Build req2Map
      const req2Map = new Map<string, Uint8Array>()
      for (const ih of infoHashes) {
        const req2Hash = await computeReq2Hash(ih, sha1)
        req2Map.set(toHex(req2Hash), ih)
      }

      const xorValue = await computeReq2Xor3(infoHashes[targetIndex], sharedSecret, sha1)

      // Both methods should return the same result
      const recoveredLegacy = await recoverInfoHash(xorValue, sharedSecret, infoHashes, sha1)
      const recoveredMap = await recoverInfoHashWithMap(xorValue, sharedSecret, req2Map, sha1)

      expect(recoveredMap).toEqual(recoveredLegacy)
      expect(recoveredMap).toEqual(infoHashes[targetIndex])
    })
  })
})
