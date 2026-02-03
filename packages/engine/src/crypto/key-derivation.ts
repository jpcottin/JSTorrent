/**
 * MSE/PE key derivation functions
 */
import { RC4 } from './rc4'
import { MSE_REQ1, MSE_REQ2, MSE_REQ3, MSE_KEY_A, MSE_KEY_B } from './constants'

/**
 * Derive raw encryption key bytes from shared secret and info hash.
 * Returns the SHA1-derived key bytes without creating RC4 instances.
 * Use this when you need to create multiple RC4 instances from the same keys
 * (e.g., during VC sync scanning).
 */
export async function deriveEncryptionKeyBytes(
  sharedSecret: Uint8Array,
  infoHash: Uint8Array,
  isInitiator: boolean,
  sha1: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<{ encryptKey: Uint8Array; decryptKey: Uint8Array }> {
  const keyAInput = concat(encode(MSE_KEY_A), sharedSecret, infoHash)
  const keyBInput = concat(encode(MSE_KEY_B), sharedSecret, infoHash)

  const keyA = await sha1(keyAInput)
  const keyB = await sha1(keyBInput)

  // Initiator uses keyA for encrypt, keyB for decrypt
  // Responder uses keyB for encrypt, keyA for decrypt
  return {
    encryptKey: isInitiator ? keyA : keyB,
    decryptKey: isInitiator ? keyB : keyA,
  }
}

/**
 * Create RC4 cipher pair from pre-derived key bytes.
 * Applies RC4-drop1024 to both ciphers.
 */
export function createRC4Pair(
  encryptKey: Uint8Array,
  decryptKey: Uint8Array,
): { encrypt: RC4; decrypt: RC4 } {
  const encrypt = new RC4(encryptKey)
  const decrypt = new RC4(decryptKey)

  // RC4-drop1024: discard first 1024 bytes
  encrypt.drop(1024)
  decrypt.drop(1024)

  return { encrypt, decrypt }
}

/**
 * Derive RC4 encryption keys from shared secret and info hash.
 * Keys are SHA1 hashes with RC4-drop1024.
 */
export async function deriveEncryptionKeys(
  sharedSecret: Uint8Array,
  infoHash: Uint8Array,
  isInitiator: boolean,
  sha1: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<{ encrypt: RC4; decrypt: RC4 }> {
  const { encryptKey, decryptKey } = await deriveEncryptionKeyBytes(
    sharedSecret,
    infoHash,
    isInitiator,
    sha1,
  )
  return createRC4Pair(encryptKey, decryptKey)
}

/**
 * Compute HASH('req1', S) for synchronization
 */
export async function computeReq1Hash(
  sharedSecret: Uint8Array,
  sha1: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  return sha1(concat(encode(MSE_REQ1), sharedSecret))
}

/**
 * Compute HASH('req2', infoHash) for precomputation.
 * This is used for O(1) MSE incoming connection identification.
 */
export async function computeReq2Hash(
  infoHash: Uint8Array,
  sha1: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  return sha1(concat(encode(MSE_REQ2), infoHash))
}

/**
 * Compute HASH('req2', SKEY) XOR HASH('req3', S) for torrent identification
 */
export async function computeReq2Xor3(
  infoHash: Uint8Array,
  sharedSecret: Uint8Array,
  sha1: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array> {
  const req2 = await sha1(concat(encode(MSE_REQ2), infoHash))
  const req3 = await sha1(concat(encode(MSE_REQ3), sharedSecret))
  return xor(req2, req3)
}

/**
 * Recover infoHash from HASH('req2', SKEY) XOR HASH('req3', S)
 * Given the received XOR value and shared secret, and a list of known info hashes.
 *
 * @deprecated Use recoverInfoHashWithMap for O(1) lookup performance
 */
export async function recoverInfoHash(
  xorValue: Uint8Array,
  sharedSecret: Uint8Array,
  knownInfoHashes: Uint8Array[],
  sha1: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
  const req3 = await sha1(concat(encode(MSE_REQ3), sharedSecret))
  const req2Computed = xor(xorValue, req3)

  for (const infoHash of knownInfoHashes) {
    const expected = await sha1(concat(encode(MSE_REQ2), infoHash))
    if (arraysEqual(req2Computed, expected)) {
      return infoHash
    }
  }
  return null
}

/**
 * Recover info hash from MSE XOR value using precomputed req2 map.
 * O(1) lookup instead of O(N) iteration.
 *
 * @param xorValue - The 20-byte XOR value from MSE PE3: HASH('req2', SKEY) XOR HASH('req3', S)
 * @param sharedSecret - The DH shared secret
 * @param req2Map - Map from hex(SHA1('req2' + infoHash)) to infoHash
 * @param sha1 - SHA1 hash function
 * @returns The matching info hash, or null if not found
 */
export async function recoverInfoHashWithMap(
  xorValue: Uint8Array,
  sharedSecret: Uint8Array,
  req2Map: Map<string, Uint8Array>,
  sha1: (data: Uint8Array) => Promise<Uint8Array>,
): Promise<Uint8Array | null> {
  // Compute req3 = SHA1('req3' + sharedSecret)
  const req3 = await sha1(concat(encode(MSE_REQ3), sharedSecret))

  // XOR to recover req2
  const req2Computed = xor(xorValue, req3)

  // O(1) lookup
  return req2Map.get(toHex(req2Computed)) ?? null
}

// Helpers
function encode(str: string): Uint8Array {
  return new TextEncoder().encode(str)
}

/**
 * Convert Uint8Array to hex string
 */
export function toHex(bytes: Uint8Array): string {
  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0')
  }
  return hex
}

export function concat(...arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0)
  const result = new Uint8Array(totalLength)
  let offset = 0
  for (const arr of arrays) {
    result.set(arr, offset)
    offset += arr.length
  }
  return result
}

function xor(a: Uint8Array, b: Uint8Array): Uint8Array {
  const result = new Uint8Array(a.length)
  for (let i = 0; i < a.length; i++) {
    result[i] = a[i] ^ b[i]
  }
  return result
}

export function arraysEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
