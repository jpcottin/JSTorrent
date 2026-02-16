import { describe, it, expect, beforeEach } from 'vitest'
import { createHash } from 'crypto'
import { InMemoryFileSystem } from '../../../src/adapters/memory/memory-filesystem'
import { VerifyChunkResult } from '../../../src/interfaces/filesystem'

function sha1(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha1').update(data).digest())
}

function concatHashes(hashes: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(hashes.length * 20)
  for (let i = 0; i < hashes.length; i++) {
    result.set(hashes[i], i * 20)
  }
  return result
}

describe('InMemoryFileSystem.verifyChunks', () => {
  let fs: InMemoryFileSystem

  beforeEach(() => {
    fs = new InMemoryFileSystem()
  })

  it('should verify single-file single-chunk match', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    fs.files.set('file.bin', data)

    const hashes = concatHashes([sha1(data)])
    const results = await fs.verifyChunks({
      files: [{ path: 'file.bin', length: 5 }],
      chunkSize: 5,
      hashes,
    })

    expect(results).toEqual(new Uint8Array([VerifyChunkResult.MATCH]))
  })

  it('should detect mismatch', async () => {
    const data = new Uint8Array([1, 2, 3, 4, 5])
    fs.files.set('file.bin', data)

    // Wrong hash
    const hashes = concatHashes([sha1(new Uint8Array([9, 9, 9, 9, 9]))])
    const results = await fs.verifyChunks({
      files: [{ path: 'file.bin', length: 5 }],
      chunkSize: 5,
      hashes,
    })

    expect(results).toEqual(new Uint8Array([VerifyChunkResult.MISMATCH]))
  })

  it('should return IO_ERROR for missing file', async () => {
    const hashes = concatHashes([sha1(new Uint8Array(5))])
    const results = await fs.verifyChunks({
      files: [{ path: 'missing.bin', length: 5 }],
      chunkSize: 5,
      hashes,
    })

    expect(results).toEqual(new Uint8Array([VerifyChunkResult.IO_ERROR]))
  })

  it('should verify multiple chunks in single file', async () => {
    const chunk0 = new Uint8Array([10, 20, 30, 40])
    const chunk1 = new Uint8Array([50, 60, 70, 80])
    const chunk2 = new Uint8Array([90, 100]) // last chunk shorter

    const fullData = new Uint8Array(10)
    fullData.set(chunk0, 0)
    fullData.set(chunk1, 4)
    fullData.set(chunk2, 8)
    fs.files.set('file.bin', fullData)

    const hashes = concatHashes([sha1(chunk0), sha1(chunk1), sha1(chunk2)])
    const results = await fs.verifyChunks({
      files: [{ path: 'file.bin', length: 10 }],
      chunkSize: 4,
      hashes,
    })

    expect(results).toEqual(
      new Uint8Array([VerifyChunkResult.MATCH, VerifyChunkResult.MATCH, VerifyChunkResult.MATCH]),
    )
  })

  it('should verify chunks spanning multiple files', async () => {
    // 2 files: [3 bytes] [5 bytes] = 8 bytes total, chunkSize=4 → 2 chunks
    const file1 = new Uint8Array([1, 2, 3])
    const file2 = new Uint8Array([4, 5, 6, 7, 8])
    fs.files.set('f1.bin', file1)
    fs.files.set('f2.bin', file2)

    // Chunk 0: bytes 0-3 = [1,2,3,4] (spans f1 + f2)
    // Chunk 1: bytes 4-7 = [5,6,7,8]
    const chunk0 = new Uint8Array([1, 2, 3, 4])
    const chunk1 = new Uint8Array([5, 6, 7, 8])

    const hashes = concatHashes([sha1(chunk0), sha1(chunk1)])
    const results = await fs.verifyChunks({
      files: [
        { path: 'f1.bin', length: 3 },
        { path: 'f2.bin', length: 5 },
      ],
      chunkSize: 4,
      hashes,
    })

    expect(results).toEqual(new Uint8Array([VerifyChunkResult.MATCH, VerifyChunkResult.MATCH]))
  })

  it('should handle startChunk and chunkCount for subset verification', async () => {
    const data = new Uint8Array(12)
    for (let i = 0; i < 12; i++) data[i] = i
    fs.files.set('file.bin', data)

    // 3 chunks of 4 bytes: [0..3], [4..7], [8..11]
    const chunk0 = data.subarray(0, 4)
    const chunk1 = data.subarray(4, 8)
    const chunk2 = data.subarray(8, 12)
    const hashes = concatHashes([sha1(chunk0), sha1(chunk1), sha1(chunk2)])

    // Only verify chunk 1
    const results = await fs.verifyChunks({
      files: [{ path: 'file.bin', length: 12 }],
      chunkSize: 4,
      hashes,
      startChunk: 1,
      chunkCount: 1,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toBe(VerifyChunkResult.MATCH)
  })

  it('should handle corruption in middle file of multi-file torrent', async () => {
    const file1 = new Uint8Array([1, 2, 3, 4])
    const file2 = new Uint8Array([5, 6, 7, 8]) // will be corrupted
    const file3 = new Uint8Array([9, 10, 11, 12])
    fs.files.set('f1.bin', file1)
    fs.files.set('f2.bin', new Uint8Array([0, 0, 0, 0])) // corrupted
    fs.files.set('f3.bin', file3)

    // Hashes for correct data
    const hashes = concatHashes([sha1(file1), sha1(file2), sha1(file3)])
    const results = await fs.verifyChunks({
      files: [
        { path: 'f1.bin', length: 4 },
        { path: 'f2.bin', length: 4 },
        { path: 'f3.bin', length: 4 },
      ],
      chunkSize: 4,
      hashes,
    })

    expect(results).toEqual(
      new Uint8Array([
        VerifyChunkResult.MATCH,
        VerifyChunkResult.MISMATCH,
        VerifyChunkResult.MATCH,
      ]),
    )
  })

  it('should handle missing middle file in multi-file torrent', async () => {
    const file1 = new Uint8Array([1, 2, 3, 4])
    const file3 = new Uint8Array([9, 10, 11, 12])
    fs.files.set('f1.bin', file1)
    // f2.bin is missing
    fs.files.set('f3.bin', file3)

    const hashes = concatHashes([sha1(file1), sha1(new Uint8Array([5, 6, 7, 8])), sha1(file3)])
    const results = await fs.verifyChunks({
      files: [
        { path: 'f1.bin', length: 4 },
        { path: 'f2.bin', length: 4 },
        { path: 'f3.bin', length: 4 },
      ],
      chunkSize: 4,
      hashes,
    })

    // Chunk 0 = f1 (present, correct) → MATCH
    // Chunk 1 = f2 (missing) → IO_ERROR
    // Chunk 2 = f3 (present, correct) → MATCH
    expect(results).toEqual(
      new Uint8Array([
        VerifyChunkResult.MATCH,
        VerifyChunkResult.IO_ERROR,
        VerifyChunkResult.MATCH,
      ]),
    )
  })

  it('should verify many chunks efficiently', async () => {
    // 1MB file, 16KB chunks → 64 chunks
    const chunkSize = 16 * 1024
    const numChunks = 64
    const totalSize = chunkSize * numChunks
    const data = new Uint8Array(totalSize)
    // Fill with pattern
    for (let i = 0; i < totalSize; i++) {
      data[i] = i & 0xff
    }
    fs.files.set('big.bin', data)

    const hashList: Uint8Array[] = []
    for (let i = 0; i < numChunks; i++) {
      hashList.push(sha1(data.subarray(i * chunkSize, (i + 1) * chunkSize)))
    }
    const hashes = concatHashes(hashList)

    const results = await fs.verifyChunks({
      files: [{ path: 'big.bin', length: totalSize }],
      chunkSize,
      hashes,
    })

    expect(results).toHaveLength(numChunks)
    expect(results.every((r) => r === VerifyChunkResult.MATCH)).toBe(true)
  })
})
