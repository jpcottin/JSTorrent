import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'path'
import fs from 'fs/promises'
import os from 'os'
import crypto from 'crypto'
import { startDaemon, DaemonHarness } from './helpers/daemon-harness'
import { DaemonFileSystem } from '../../src/adapters/daemon/daemon-filesystem'
import { DaemonConnection } from '../../src/adapters/daemon/daemon-connection'
import {
  supportsVerifiedWrite,
  WriteError,
  WriteErrorType,
} from '../../src/adapters/daemon/daemon-file-handle'

describe('DaemonFileSystem Integration', () => {
  let harness: DaemonHarness
  let connection: DaemonConnection
  let fs1: DaemonFileSystem
  let fs2: DaemonFileSystem
  const rootKey1 = 'root-1'
  const rootKey2 = 'root-2'

  beforeAll(async () => {
    // Create temp directories for roots
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jstorrent-test-roots-'))
    const dataDir1 = path.join(tmpDir, 'data1')
    const dataDir2 = path.join(tmpDir, 'data2')

    harness = await startDaemon({
      roots: [
        { key: rootKey1, path: dataDir1, displayName: 'Root 1' },
        { key: rootKey2, path: dataDir2, displayName: 'Root 2' },
      ],
    })

    connection = new DaemonConnection(harness.port, '127.0.0.1', undefined, harness.token)
    fs1 = new DaemonFileSystem(connection, rootKey1)
    fs2 = new DaemonFileSystem(connection, rootKey2)
  })

  afterAll(async () => {
    await harness.cleanup()
  })

  it('should write and read a file in root 1', async () => {
    const handle = await fs1.open('test.txt', 'w')
    const data = new TextEncoder().encode('Hello World')
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    const readHandle = await fs1.open('test.txt', 'r')
    const buffer = new Uint8Array(data.length)
    const { bytesRead } = await readHandle.read(buffer, 0, data.length, 0)
    expect(bytesRead).toBe(data.length)
    expect(new TextDecoder().decode(buffer)).toBe('Hello World')
    await readHandle.close()
  })

  it('should verify file existence and stat in root 1', async () => {
    expect(await fs1.exists('test.txt')).toBe(true)
    const stats = await fs1.stat('test.txt')
    expect(stats.isFile).toBe(true)
    expect(stats.size).toBe(11)
  })

  it('should list directory in root 1', async () => {
    const files = await fs1.readdir('')
    expect(files).toContain('test.txt')
  })

  it('should write to root 2 and verify isolation', async () => {
    const handle = await fs2.open('root2.txt', 'w')
    const data = new TextEncoder().encode('Root 2 Data')
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    expect(await fs2.exists('root2.txt')).toBe(true)
    expect(await fs1.exists('root2.txt')).toBe(false) // Should not exist in root 1
  })

  it('should delete file in root 1', async () => {
    await fs1.delete('test.txt')
    expect(await fs1.exists('test.txt')).toBe(false)
  })

  it('should truncate file in root 2', async () => {
    const handle = await fs2.open('truncate.txt', 'w')
    const data = new TextEncoder().encode('1234567890')
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    const truncHandle = await fs2.open('truncate.txt', 'r+')
    await truncHandle.truncate(5)
    await truncHandle.close()

    const stats = await fs2.stat('truncate.txt')
    expect(stats.size).toBe(5)
  })

  it('should read large files completely (regression test for short reads)', async () => {
    // This test verifies that large reads return the full requested data.
    // Previously, file.read() in Rust would return partial data for large buffers.
    const size = 8 * 1024 * 1024 // 8MB - typical piece size
    const data = new Uint8Array(size)

    // Fill with a repeating pattern for verification
    for (let i = 0; i < size; i++) {
      data[i] = i % 256
    }

    // Write the large file
    const writeHandle = await fs1.open('large.bin', 'w')
    await writeHandle.write(data, 0, size, 0)
    await writeHandle.close()

    // Read it back
    const readHandle = await fs1.open('large.bin', 'r')
    const readBuffer = new Uint8Array(size)
    const { bytesRead } = await readHandle.read(readBuffer, 0, size, 0)
    await readHandle.close()

    // Verify we got all the data
    expect(bytesRead).toBe(size)

    // Verify content matches
    for (let i = 0; i < size; i++) {
      if (readBuffer[i] !== data[i]) {
        throw new Error(`Mismatch at byte ${i}: expected ${data[i]}, got ${readBuffer[i]}`)
      }
    }
  })

  // ============================================================================
  // New API tests: base64 path encoding and hash verification
  // These test the /read/:root_key and /write/:root_key endpoints
  // ============================================================================

  it('should handle paths with # character (v2 API)', async () => {
    const filename = 'file#with#hashes.txt'
    const data = new TextEncoder().encode('Hash character test')

    const handle = await fs1.open(filename, 'w')
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    // Verify file exists and can be read back
    expect(await fs1.exists(filename)).toBe(true)

    const readHandle = await fs1.open(filename, 'r')
    const buffer = new Uint8Array(data.length)
    const { bytesRead } = await readHandle.read(buffer, 0, data.length, 0)
    await readHandle.close()

    expect(bytesRead).toBe(data.length)
    expect(new TextDecoder().decode(buffer)).toBe('Hash character test')
  })

  it('should handle paths with ? character (v2 API)', async () => {
    const filename = 'file?with?questions.txt'
    const data = new TextEncoder().encode('Question mark test')

    const handle = await fs1.open(filename, 'w')
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    expect(await fs1.exists(filename)).toBe(true)

    const readHandle = await fs1.open(filename, 'r')
    const buffer = new Uint8Array(data.length)
    const { bytesRead } = await readHandle.read(buffer, 0, data.length, 0)
    await readHandle.close()

    expect(bytesRead).toBe(data.length)
    expect(new TextDecoder().decode(buffer)).toBe('Question mark test')
  })

  it('should handle paths with mixed special characters (v2 API)', async () => {
    const filename = 'complex#file?name&with=special.txt'
    const data = new TextEncoder().encode('Mixed special chars')

    const handle = await fs1.open(filename, 'w')
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    expect(await fs1.exists(filename)).toBe(true)

    const readHandle = await fs1.open(filename, 'r')
    const buffer = new Uint8Array(data.length)
    await readHandle.read(buffer, 0, data.length, 0)
    await readHandle.close()

    expect(new TextDecoder().decode(buffer)).toBe('Mixed special chars')
  })

  it('should handle unicode paths (v2 API)', async () => {
    const filename = 'Каталог/файл-привет.txt'
    const data = new TextEncoder().encode('Unicode path test')

    const handle = await fs1.open(filename, 'w')
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    expect(await fs1.exists(filename)).toBe(true)

    const readHandle = await fs1.open(filename, 'r')
    const buffer = new Uint8Array(data.length)
    const { bytesRead } = await readHandle.read(buffer, 0, data.length, 0)
    await readHandle.close()

    expect(bytesRead).toBe(data.length)
    expect(new TextDecoder().decode(buffer)).toBe('Unicode path test')
  })

  it('should verify DaemonFileHandle supports verified writes', async () => {
    const handle = await fs1.open('verify-support.txt', 'w')
    expect(supportsVerifiedWrite(handle)).toBe(true)
    await handle.close()
  })

  it('should succeed with correct hash verification (v2 API)', async () => {
    const data = new TextEncoder().encode('Verified content for hash check')

    // Compute SHA1 hash of the data
    const hash = crypto.createHash('sha1').update(data).digest()

    const handle = await fs1.open('verified-write.bin', 'w')
    if (!supportsVerifiedWrite(handle)) {
      throw new Error('Expected DaemonFileHandle to support verified writes')
    }

    // Set expected hash before write
    handle.setExpectedHashForNextWrite(new Uint8Array(hash))
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    // Verify file was written correctly
    expect(await fs1.exists('verified-write.bin')).toBe(true)
    const stats = await fs1.stat('verified-write.bin')
    expect(stats.size).toBe(data.length)
  })

  it('should throw WriteError with HASH_MISMATCH on incorrect hash (v2 API)', async () => {
    const data = new TextEncoder().encode('Data with wrong hash')

    // Create a wrong hash (all zeros)
    const wrongHash = new Uint8Array(20) // SHA1 is 20 bytes

    const handle = await fs1.open('bad-hash.bin', 'w')
    if (!supportsVerifiedWrite(handle)) {
      throw new Error('Expected DaemonFileHandle to support verified writes')
    }

    // Set wrong expected hash
    handle.setExpectedHashForNextWrite(wrongHash)

    // Write should throw WriteError with HASH_MISMATCH type
    await expect(handle.write(data, 0, data.length, 0)).rejects.toMatchObject({
      name: 'WriteError',
      errorType: WriteErrorType.HASH_MISMATCH,
    })
    await handle.close()
  })

  // ============================================================================
  // listTree tests
  // ============================================================================

  it('should list tree with nested files and sizes', async () => {
    const h1 = await fs1.open('tree_test/file1.txt', 'w')
    const data1 = new TextEncoder().encode('AAAA')
    await h1.write(data1, 0, data1.length, 0)
    await h1.close()

    const h2 = await fs1.open('tree_test/sub/file2.bin', 'w')
    const data2 = new Uint8Array(1024)
    await h2.write(data2, 0, data2.length, 0)
    await h2.close()

    const result = await fs1.listTree('tree_test')

    expect(result).toEqual(
      expect.arrayContaining([
        { path: 'file1.txt', size: 4 },
        { path: 'sub/file2.bin', size: 1024 },
      ]),
    )
    expect(result).toHaveLength(2)
  })

  it('should return empty array for nonexistent tree path', async () => {
    const result = await fs1.listTree('nonexistent_tree_dir')
    expect(result).toEqual([])
  })

  it('should isolate listTree between roots', async () => {
    const h = await fs1.open('isolated_tree/file.txt', 'w')
    const data = new TextEncoder().encode('root1 only')
    await h.write(data, 0, data.length, 0)
    await h.close()

    const r1 = await fs1.listTree('isolated_tree')
    const r2 = await fs2.listTree('isolated_tree')

    expect(r1).toHaveLength(1)
    expect(r2).toEqual([])
  })

  // ============================================================================
  // verifyChunks tests
  // ============================================================================

  it('should verify chunks with correct data', async () => {
    const data = new Uint8Array(12)
    for (let i = 0; i < 12; i++) data[i] = i

    // Write a single file
    const handle = await fs1.open('verify_chunks/file.bin', 'w')
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    // Compute SHA1 hashes for 3 chunks of 4 bytes each
    const chunk0Hash = new Uint8Array(
      crypto.createHash('sha1').update(data.subarray(0, 4)).digest(),
    )
    const chunk1Hash = new Uint8Array(
      crypto.createHash('sha1').update(data.subarray(4, 8)).digest(),
    )
    const chunk2Hash = new Uint8Array(
      crypto.createHash('sha1').update(data.subarray(8, 12)).digest(),
    )
    const hashes = new Uint8Array(60)
    hashes.set(chunk0Hash, 0)
    hashes.set(chunk1Hash, 20)
    hashes.set(chunk2Hash, 40)

    const results = await fs1.verifyChunks({
      files: [{ path: 'verify_chunks/file.bin', length: 12 }],
      chunkSize: 4,
      hashes,
    })

    expect(results).toHaveLength(3)
    expect(results[0]).toBe(0) // MATCH
    expect(results[1]).toBe(0) // MATCH
    expect(results[2]).toBe(0) // MATCH
  })

  it('should detect mismatch via verifyChunks', async () => {
    // Write data that won't match the hashes
    const data = new Uint8Array([0, 0, 0, 0])
    const handle = await fs1.open('verify_chunks/corrupt.bin', 'w')
    await handle.write(data, 0, data.length, 0)
    await handle.close()

    // Hash for different data
    const wrongHash = new Uint8Array(
      crypto
        .createHash('sha1')
        .update(new Uint8Array([1, 2, 3, 4]))
        .digest(),
    )
    const hashes = new Uint8Array(20)
    hashes.set(wrongHash, 0)

    const results = await fs1.verifyChunks({
      files: [{ path: 'verify_chunks/corrupt.bin', length: 4 }],
      chunkSize: 4,
      hashes,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toBe(1) // MISMATCH
  })

  it('should return IO_ERROR for missing file via verifyChunks', async () => {
    const hash = new Uint8Array(crypto.createHash('sha1').update(new Uint8Array(4)).digest())
    const hashes = new Uint8Array(20)
    hashes.set(hash, 0)

    const results = await fs1.verifyChunks({
      files: [{ path: 'verify_chunks/nonexistent.bin', length: 4 }],
      chunkSize: 4,
      hashes,
    })

    expect(results).toHaveLength(1)
    expect(results[0]).toBe(2) // IO_ERROR
  })

  it('should verify chunks spanning multiple files', async () => {
    // f1: 3 bytes, f2: 5 bytes → 8 bytes total, chunkSize=4 → 2 chunks
    const f1Data = new Uint8Array([1, 2, 3])
    const f2Data = new Uint8Array([4, 5, 6, 7, 8])

    const h1 = await fs1.open('verify_chunks/span/f1.bin', 'w')
    await h1.write(f1Data, 0, f1Data.length, 0)
    await h1.close()

    const h2 = await fs1.open('verify_chunks/span/f2.bin', 'w')
    await h2.write(f2Data, 0, f2Data.length, 0)
    await h2.close()

    // Chunk 0: [1,2,3,4], Chunk 1: [5,6,7,8]
    const chunk0Hash = new Uint8Array(
      crypto
        .createHash('sha1')
        .update(new Uint8Array([1, 2, 3, 4]))
        .digest(),
    )
    const chunk1Hash = new Uint8Array(
      crypto
        .createHash('sha1')
        .update(new Uint8Array([5, 6, 7, 8]))
        .digest(),
    )
    const hashes = new Uint8Array(40)
    hashes.set(chunk0Hash, 0)
    hashes.set(chunk1Hash, 20)

    const results = await fs1.verifyChunks({
      files: [
        { path: 'verify_chunks/span/f1.bin', length: 3 },
        { path: 'verify_chunks/span/f2.bin', length: 5 },
      ],
      chunkSize: 4,
      hashes,
    })

    expect(results).toHaveLength(2)
    expect(results[0]).toBe(0) // MATCH
    expect(results[1]).toBe(0) // MATCH
  })

  it('should consume pending hash after one write (v2 API)', async () => {
    const data1 = new TextEncoder().encode('First write')
    const data2 = new TextEncoder().encode('Second write')

    // Compute correct hash for first write
    const hash1 = crypto.createHash('sha1').update(data1).digest()

    const handle = await fs1.open('consume-hash.bin', 'w')
    if (!supportsVerifiedWrite(handle)) {
      throw new Error('Expected DaemonFileHandle to support verified writes')
    }

    // Set hash for first write
    handle.setExpectedHashForNextWrite(new Uint8Array(hash1))
    await handle.write(data1, 0, data1.length, 0)

    // Second write should succeed without hash verification
    // (pending hash was consumed by first write)
    await handle.write(data2, 0, data2.length, data1.length)
    await handle.close()

    // Verify both writes succeeded
    const stats = await fs1.stat('consume-hash.bin')
    expect(stats.size).toBe(data1.length + data2.length)
  })
})
