import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { NodeFileSystem } from '../../../src/adapters/node/node-filesystem'
import { ScopedNodeFileSystem } from '../../../src/adapters/node/scoped-node-filesystem'
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

describe('NodeFileSystem.verifyChunks', () => {
  let tmpDir: string
  let nodeFs: NodeFileSystem

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'verify-chunks-'))
    nodeFs = new NodeFileSystem()
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('should verify single file with correct data', async () => {
    const data = new Uint8Array([10, 20, 30, 40, 50])
    const filePath = path.join(tmpDir, 'file.bin')
    await fs.writeFile(filePath, data)

    const hashes = concatHashes([sha1(data)])
    const results = await nodeFs.verifyChunks({
      files: [{ path: filePath, length: 5 }],
      chunkSize: 5,
      hashes,
    })

    expect(results).toEqual(new Uint8Array([VerifyChunkResult.MATCH]))
  })

  it('should detect mismatch on corrupted file', async () => {
    const filePath = path.join(tmpDir, 'file.bin')
    await fs.writeFile(filePath, new Uint8Array([0, 0, 0, 0, 0]))

    // Hash for different data
    const hashes = concatHashes([sha1(new Uint8Array([1, 2, 3, 4, 5]))])
    const results = await nodeFs.verifyChunks({
      files: [{ path: filePath, length: 5 }],
      chunkSize: 5,
      hashes,
    })

    expect(results).toEqual(new Uint8Array([VerifyChunkResult.MISMATCH]))
  })

  it('should return IO_ERROR for missing file', async () => {
    const hashes = concatHashes([sha1(new Uint8Array(5))])
    const results = await nodeFs.verifyChunks({
      files: [{ path: path.join(tmpDir, 'missing.bin'), length: 5 }],
      chunkSize: 5,
      hashes,
    })

    expect(results).toEqual(new Uint8Array([VerifyChunkResult.IO_ERROR]))
  })

  it('should verify chunks spanning two files', async () => {
    const file1Data = new Uint8Array([1, 2, 3])
    const file2Data = new Uint8Array([4, 5, 6, 7, 8])
    const file1Path = path.join(tmpDir, 'f1.bin')
    const file2Path = path.join(tmpDir, 'f2.bin')
    await fs.writeFile(file1Path, file1Data)
    await fs.writeFile(file2Path, file2Data)

    // Chunk 0 = [1,2,3,4], Chunk 1 = [5,6,7,8]
    const hashes = concatHashes([
      sha1(new Uint8Array([1, 2, 3, 4])),
      sha1(new Uint8Array([5, 6, 7, 8])),
    ])
    const results = await nodeFs.verifyChunks({
      files: [
        { path: file1Path, length: 3 },
        { path: file2Path, length: 5 },
      ],
      chunkSize: 4,
      hashes,
    })

    expect(results).toEqual(new Uint8Array([VerifyChunkResult.MATCH, VerifyChunkResult.MATCH]))
  })

  it('should work with ScopedNodeFileSystem', async () => {
    const scopedFs = new ScopedNodeFileSystem(tmpDir)
    const data = new Uint8Array([1, 2, 3, 4])
    await fs.writeFile(path.join(tmpDir, 'file.bin'), data)

    const hashes = concatHashes([sha1(data)])
    const results = await scopedFs.verifyChunks({
      files: [{ path: 'file.bin', length: 4 }],
      chunkSize: 4,
      hashes,
    })

    expect(results).toEqual(new Uint8Array([VerifyChunkResult.MATCH]))
  })

  it('should verify subset with startChunk/chunkCount', async () => {
    const data = new Uint8Array(12)
    for (let i = 0; i < 12; i++) data[i] = i
    await fs.writeFile(path.join(tmpDir, 'file.bin'), data)

    const chunk0 = data.subarray(0, 4)
    const chunk1 = data.subarray(4, 8)
    const chunk2 = data.subarray(8, 12)
    const hashes = concatHashes([sha1(chunk0), sha1(chunk1), sha1(chunk2)])

    const results = await nodeFs.verifyChunks({
      files: [{ path: path.join(tmpDir, 'file.bin'), length: 12 }],
      chunkSize: 4,
      hashes,
      startChunk: 1,
      chunkCount: 2,
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toBe(VerifyChunkResult.MATCH) // chunk 1
    expect(results[1]).toBe(VerifyChunkResult.MATCH) // chunk 2
  })

  it('should handle last chunk shorter than chunkSize', async () => {
    // 10 bytes with chunkSize=4 → 3 chunks: [4, 4, 2]
    const data = new Uint8Array(10)
    for (let i = 0; i < 10; i++) data[i] = i + 1
    await fs.writeFile(path.join(tmpDir, 'file.bin'), data)

    const chunk0 = data.subarray(0, 4)
    const chunk1 = data.subarray(4, 8)
    const chunk2 = data.subarray(8, 10) // only 2 bytes

    const hashes = concatHashes([sha1(chunk0), sha1(chunk1), sha1(chunk2)])
    const results = await nodeFs.verifyChunks({
      files: [{ path: path.join(tmpDir, 'file.bin'), length: 10 }],
      chunkSize: 4,
      hashes,
    })

    expect(results).toEqual(
      new Uint8Array([VerifyChunkResult.MATCH, VerifyChunkResult.MATCH, VerifyChunkResult.MATCH]),
    )
  })

  it('should detect corruption in middle file of multi-file torrent', async () => {
    const file1 = new Uint8Array([1, 2, 3, 4])
    const file2Correct = new Uint8Array([5, 6, 7, 8])
    const file3 = new Uint8Array([9, 10, 11, 12])

    await fs.writeFile(path.join(tmpDir, 'f1.bin'), file1)
    await fs.writeFile(path.join(tmpDir, 'f2.bin'), new Uint8Array([0, 0, 0, 0])) // corrupted
    await fs.writeFile(path.join(tmpDir, 'f3.bin'), file3)

    const hashes = concatHashes([sha1(file1), sha1(file2Correct), sha1(file3)])
    const results = await nodeFs.verifyChunks({
      files: [
        { path: path.join(tmpDir, 'f1.bin'), length: 4 },
        { path: path.join(tmpDir, 'f2.bin'), length: 4 },
        { path: path.join(tmpDir, 'f3.bin'), length: 4 },
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

    await fs.writeFile(path.join(tmpDir, 'f1.bin'), file1)
    // f2.bin is missing
    await fs.writeFile(path.join(tmpDir, 'f3.bin'), file3)

    const hashes = concatHashes([sha1(file1), sha1(new Uint8Array([5, 6, 7, 8])), sha1(file3)])
    const results = await nodeFs.verifyChunks({
      files: [
        { path: path.join(tmpDir, 'f1.bin'), length: 4 },
        { path: path.join(tmpDir, 'f2.bin'), length: 4 },
        { path: path.join(tmpDir, 'f3.bin'), length: 4 },
      ],
      chunkSize: 4,
      hashes,
    })

    expect(results).toEqual(
      new Uint8Array([
        VerifyChunkResult.MATCH,
        VerifyChunkResult.IO_ERROR,
        VerifyChunkResult.MATCH,
      ]),
    )
  })
})
