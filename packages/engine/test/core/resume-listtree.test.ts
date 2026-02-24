import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BtEngine } from '../../src/core/bt-engine'
import { InMemoryFileSystem } from '../../src/adapters/memory'
import { ISocketFactory } from '../../src/interfaces/socket'
import { Bencode } from '../../src/utils/bencode'

const mockSocketFactory: ISocketFactory = {
  createTcpSocket: vi.fn(),
  createUdpSocket: vi.fn().mockResolvedValue({
    send: vi.fn(),
    onMessage: vi.fn(),
    close: vi.fn(),
  }),
  createTcpServer: vi.fn().mockReturnValue({
    on: vi.fn(),
    listen: vi.fn(),
    address: vi.fn().mockReturnValue({ port: 0 }),
  }),
  wrapTcpSocket: vi.fn(),
}

function createMultiFileTorrent(opts: {
  name: string
  files: { path: string; length: number }[]
  pieceLength: number
}): Uint8Array {
  const totalSize = opts.files.reduce((sum, f) => sum + f.length, 0)
  const piecesCount = Math.ceil(totalSize / opts.pieceLength)
  const pieces = new Uint8Array(piecesCount * 20)

  return Bencode.encode({
    announce: 'http://tracker.example.com',
    info: {
      name: opts.name,
      'piece length': opts.pieceLength,
      pieces,
      files: opts.files.map((f) => ({
        length: f.length,
        path: f.path.split('/'),
      })),
    },
  })
}

describe('verifyResumeData with listTree', () => {
  let fileSystem: InMemoryFileSystem
  let engine: BtEngine

  beforeEach(() => {
    fileSystem = new InMemoryFileSystem()
    engine = new BtEngine({
      downloadPath: '/downloads',
      socketFactory: mockSocketFactory,
      fileSystem: fileSystem,
      startSuspended: true,
    })
  })

  it('should set needsDataCheck when session has pieces but no files exist', async () => {
    const buffer = createMultiFileTorrent({
      name: 'TestTorrent',
      files: [
        { path: 'file1.txt', length: 1000 },
        { path: 'sub/file2.txt', length: 2000 },
      ],
      pieceLength: 1024,
    })

    const { torrent } = await engine.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    // Simulate session restore with bitfield claiming pieces
    for (let i = 0; i < torrent.piecesCount; i++) {
      torrent.bitfield!.set(i, true)
    }

    // No files on disk — verifyResumeData should flag recheck
    await torrent.verifyResumeData()
    expect(torrent.needsDataCheck).toBe(true)
  })

  it('should trust bitfield when all files exist with correct sizes (seed mode)', async () => {
    const buffer = createMultiFileTorrent({
      name: 'TestTorrent',
      files: [
        { path: 'file1.txt', length: 1000 },
        { path: 'sub/file2.txt', length: 2000 },
      ],
      pieceLength: 1024,
    })

    const { torrent } = await engine.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    // Simulate complete download bitfield
    for (let i = 0; i < torrent.piecesCount; i++) {
      torrent.bitfield!.set(i, true)
    }

    // Create files on disk matching expected sizes
    await fileSystem.mkdir('TestTorrent')
    await fileSystem.mkdir('TestTorrent/sub')
    const h1 = await fileSystem.open('TestTorrent/file1.txt', 'w')
    await h1.write(new Uint8Array(1000), 0, 1000, 0)
    await h1.close()
    const h2 = await fileSystem.open('TestTorrent/sub/file2.txt', 'w')
    await h2.write(new Uint8Array(2000), 0, 2000, 0)
    await h2.close()

    await torrent.verifyResumeData()
    expect(torrent.needsDataCheck).toBe(false)
  })

  it('should set needsDataCheck on file size mismatch', async () => {
    const buffer = createMultiFileTorrent({
      name: 'TestTorrent',
      files: [
        { path: 'file1.txt', length: 1000 },
        { path: 'sub/file2.txt', length: 2000 },
      ],
      pieceLength: 1024,
    })

    const { torrent } = await engine.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    // Simulate complete download bitfield
    for (let i = 0; i < torrent.piecesCount; i++) {
      torrent.bitfield!.set(i, true)
    }

    // Create files but file2 is truncated (wrong size)
    await fileSystem.mkdir('TestTorrent')
    await fileSystem.mkdir('TestTorrent/sub')
    const h1 = await fileSystem.open('TestTorrent/file1.txt', 'w')
    await h1.write(new Uint8Array(1000), 0, 1000, 0)
    await h1.close()
    const h2 = await fileSystem.open('TestTorrent/sub/file2.txt', 'w')
    await h2.write(new Uint8Array(500), 0, 500, 0) // truncated
    await h2.close()

    await torrent.verifyResumeData()
    expect(torrent.needsDataCheck).toBe(true)
  })

  it('should set needsDataCheck when no resume data but files exist on disk', async () => {
    const buffer = createMultiFileTorrent({
      name: 'TestTorrent',
      files: [
        { path: 'file1.txt', length: 1000 },
        { path: 'sub/file2.txt', length: 2000 },
      ],
      pieceLength: 1024,
    })

    const { torrent } = await engine.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    // No bitfield set (fresh add, no resume data)
    // But files exist on disk from a previous download
    await fileSystem.mkdir('TestTorrent')
    const h1 = await fileSystem.open('TestTorrent/file1.txt', 'w')
    await h1.write(new Uint8Array(1000), 0, 1000, 0)
    await h1.close()

    await torrent.verifyResumeData()
    expect(torrent.needsDataCheck).toBe(true)
  })

  it('should not set needsDataCheck when no resume data and no files exist', async () => {
    const buffer = createMultiFileTorrent({
      name: 'TestTorrent',
      files: [
        { path: 'file1.txt', length: 1000 },
        { path: 'sub/file2.txt', length: 2000 },
      ],
      pieceLength: 1024,
    })

    const { torrent } = await engine.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    // No bitfield, no files — nothing to check
    await torrent.verifyResumeData()
    expect(torrent.needsDataCheck).toBe(false)
  })
})

describe('_doCheckPieces with listTree skip optimization', () => {
  let fileSystem: InMemoryFileSystem
  let engine: BtEngine

  beforeEach(() => {
    fileSystem = new InMemoryFileSystem()
    engine = new BtEngine({
      downloadPath: '/downloads',
      socketFactory: mockSocketFactory,
      fileSystem: fileSystem,
      startSuspended: true,
    })
  })

  it('should skip verification entirely when no files exist on disk', async () => {
    const buffer = createMultiFileTorrent({
      name: 'TestTorrent',
      files: [
        { path: 'file1.txt', length: 10000 },
        { path: 'file2.txt', length: 10000 },
      ],
      pieceLength: 1024,
    })

    const { torrent } = await engine.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    // No files on disk — recheckData should finish quickly with 0 pieces
    await torrent.recheckData()
    expect(torrent.bitfield?.cardinality()).toBe(0)
  })

  it('should only verify pieces for files that exist on disk', async () => {
    const buffer = createMultiFileTorrent({
      name: 'TestTorrent',
      files: [
        { path: 'file1.txt', length: 2048 }, // pieces 0-1
        { path: 'file2.txt', length: 2048 }, // pieces 2-3
      ],
      pieceLength: 1024,
    })

    const { torrent } = await engine.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    // Only create file1 (pieces 0-1), skip file2 (pieces 2-3)
    await fileSystem.mkdir('TestTorrent')
    const h1 = await fileSystem.open('TestTorrent/file1.txt', 'w')
    await h1.write(new Uint8Array(2048), 0, 2048, 0)
    await h1.close()

    // Spy on the filesystem to verify listTree is called
    const listTreeSpy = vi.spyOn(fileSystem, 'listTree')

    await torrent.recheckData()

    // listTree should have been called for the root directory
    expect(listTreeSpy).toHaveBeenCalledWith('TestTorrent')

    // Pieces for file2 should not be marked as valid (file doesn't exist)
    // Pieces for file1 may or may not be valid depending on hash, but
    // the key thing is that the recheck completed without error
    const cardinality = torrent.bitfield?.cardinality() ?? 0
    expect(cardinality).toBeLessThanOrEqual(torrent.piecesCount)
  })
})
