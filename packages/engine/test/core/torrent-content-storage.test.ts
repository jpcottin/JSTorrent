import { describe, it, expect, beforeEach, vi } from 'vitest'
import { TorrentContentStorage } from '../../src/core/torrent-content-storage'
import { InMemoryFileSystem } from '../../src/adapters/memory'
import { TorrentFile } from '../../src/core/torrent-file'
import { MockEngine } from '../utils/mock-engine'
import type { IDiskQueue, VerifiedWriteBatchData } from '../../src/core/disk-queue'

describe('TorrentContentStorage', () => {
  let fileSystem: InMemoryFileSystem
  let contentStorage: TorrentContentStorage
  const pieceLength = 10
  const mockEngine = new MockEngine()

  beforeEach(() => {
    fileSystem = new InMemoryFileSystem()
    const mockStorageHandle = {
      id: 'test',
      name: 'test',
      getFileSystem: () => fileSystem,
    }
    contentStorage = new TorrentContentStorage(mockEngine, mockStorageHandle)
  })

  it('should write and read from a single file', async () => {
    await contentStorage.open([{ path: 'file1.txt', length: 10, offset: 0 }], pieceLength)
    const data = new Uint8Array([1, 2, 3, 4, 5])
    await contentStorage.write(0, 0, data)

    const read = await contentStorage.read(0, 0, 5)
    expect(read).toEqual(data)

    // Verify file system
    const stat = await fileSystem.stat('file1.txt')
    expect(stat.size).toBe(5)
  })

  it('should handle writes spanning multiple files', async () => {
    const files: TorrentFile[] = [
      { path: 'part1', length: 5, offset: 0 },
      { path: 'part2', length: 5, offset: 5 },
    ]
    await contentStorage.open(files, pieceLength)

    const data = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
    await contentStorage.write(0, 0, data)

    const part1Stat = await fileSystem.stat('part1')
    const part2Stat = await fileSystem.stat('part2')

    expect(part1Stat.size).toBe(5)
    expect(part2Stat.size).toBe(5)

    const read = await contentStorage.read(0, 0, 10)
    expect(read).toEqual(data)
  })

  it('should handle reads/writes with offsets', async () => {
    const files: TorrentFile[] = [{ path: 'file1', length: 20, offset: 0 }]
    await contentStorage.open(files, pieceLength)

    const data = new Uint8Array([1, 2])
    // Write to piece 1 (offset 10), begin 2 -> total offset 12
    await contentStorage.write(1, 2, data)

    const read = await contentStorage.read(1, 2, 2)
    expect(read).toEqual(data)

    const stat = await fileSystem.stat('file1')
    expect(stat.size).toBe(14) // 12 padding + 2 bytes
  })

  it('should expire cached failed opens so recreated folders can recover', async () => {
    vi.useFakeTimers()
    try {
      const t0 = new Date('2026-01-01T00:00:00.000Z')
      vi.setSystemTime(t0)

      await contentStorage.open(
        [{ path: 'missing-dir/file.bin', length: 10, offset: 0 }],
        pieceLength,
      )

      const data = new Uint8Array([7])

      // Initial failure caches the path.
      await expect(contentStorage.write(0, 0, data)).rejects.toThrow(
        'parent directory does not exist',
      )

      // Immediate retry should hit the negative cache.
      await expect(contentStorage.write(0, 0, data)).rejects.toThrow(
        'File open failed (cached): missing-dir/file.bin',
      )

      // Recreate the missing parent directory, but cache should still block until TTL expiry.
      await fileSystem.mkdir('missing-dir')
      await expect(contentStorage.write(0, 0, data)).rejects.toThrow(
        'File open failed (cached): missing-dir/file.bin',
      )

      // Advance beyond failed-open cache TTL and verify write now succeeds.
      vi.setSystemTime(new Date(t0.getTime() + 60_000))
      await contentStorage.write(0, 0, data)
      await expect(contentStorage.read(0, 0, 1)).resolves.toEqual(data)
    } finally {
      vi.useRealTimers()
    }
  })

  it('respects in-flight adaptive batch byte budget', async () => {
    const writeBatch = vi.fn(async () => {})
    const mockHandle = { writeBatch }
    const mockDiskQueue: IDiskQueue = {
      enqueue: vi.fn(),
      drain: vi.fn(),
      resume: vi.fn(),
      getSnapshot: vi.fn(() => ({ pending: [], running: [], draining: false })),
      clearPending: vi.fn(),
      pendingBytes: 20 * 1024 * 1024,
      pendingCount: 1,
      grabPending: vi.fn(() => []),
    }

    const mockStorageHandle = {
      id: 'test',
      name: 'test',
      getFileSystem: () => fileSystem,
    }
    const adaptiveStorage = new TorrentContentStorage(
      mockEngine,
      mockStorageHandle,
      mockDiskQueue,
      true,
    )

    const batchData: VerifiedWriteBatchData = {
      fileHandle: mockHandle,
      fileRelativeOffset: 0,
      data: new Uint8Array(16 * 1024 * 1024),
      expectedHash: new Uint8Array(20),
      fileKey: 'file.bin',
    }

    ;(adaptiveStorage as unknown as { batchBytesInFlight: number }).batchBytesInFlight =
      24 * 1024 * 1024

    const batched = await (
      adaptiveStorage as unknown as {
        tryBatchWrite: (data: VerifiedWriteBatchData) => Promise<boolean>
      }
    ).tryBatchWrite(batchData)

    expect(batched).toBe(false)
    expect(mockDiskQueue.grabPending).not.toHaveBeenCalled()
    expect(writeBatch).not.toHaveBeenCalled()
  })
})
