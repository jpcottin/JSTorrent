import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createHash } from 'crypto'
import { BtEngine } from '../../src/core/bt-engine'
import { InMemoryFileSystem } from '../../src/adapters/memory'
import { ISocketFactory } from '../../src/interfaces/socket'
import { Bencode } from '../../src/utils/bencode'

function sha1(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('sha1').update(data).digest())
}

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

/**
 * Create a torrent file with correct SHA1 piece hashes computed from `data`.
 * Returns both the torrent file bytes and the data content.
 */
function createSingleFileTorrentWithData(opts: {
  name: string
  data: Uint8Array
  pieceLength: number
}): Uint8Array {
  const totalSize = opts.data.length
  const piecesCount = Math.ceil(totalSize / opts.pieceLength)

  // Compute real SHA1 piece hashes
  const pieces = new Uint8Array(piecesCount * 20)
  for (let i = 0; i < piecesCount; i++) {
    const start = i * opts.pieceLength
    const end = Math.min(start + opts.pieceLength, totalSize)
    const hash = sha1(opts.data.subarray(start, end))
    pieces.set(hash, i * 20)
  }

  return Bencode.encode({
    announce: 'http://tracker.example.com',
    info: {
      name: opts.name,
      'piece length': opts.pieceLength,
      pieces,
      length: totalSize,
    },
  })
}

function createMultiFileTorrentWithData(opts: {
  name: string
  files: { path: string; data: Uint8Array }[]
  pieceLength: number
}): Uint8Array {
  // Concatenate all file data to compute piece hashes
  const totalSize = opts.files.reduce((sum, f) => sum + f.data.length, 0)
  const concat = new Uint8Array(totalSize)
  let offset = 0
  for (const f of opts.files) {
    concat.set(f.data, offset)
    offset += f.data.length
  }

  const piecesCount = Math.ceil(totalSize / opts.pieceLength)
  const pieces = new Uint8Array(piecesCount * 20)
  for (let i = 0; i < piecesCount; i++) {
    const start = i * opts.pieceLength
    const end = Math.min(start + opts.pieceLength, totalSize)
    const hash = sha1(concat.subarray(start, end))
    pieces.set(hash, i * 20)
  }

  return Bencode.encode({
    announce: 'http://tracker.example.com',
    info: {
      name: opts.name,
      'piece length': opts.pieceLength,
      pieces,
      files: opts.files.map((f) => ({
        length: f.data.length,
        path: f.path.split('/'),
      })),
    },
  })
}

describe('_doCheckPieces batch verification via verifyChunks', () => {
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

  it('should verify all pieces as valid when data matches hashes', async () => {
    const data = new Uint8Array(400)
    for (let i = 0; i < 400; i++) data[i] = i & 0xff

    const torrentBuf = createSingleFileTorrentWithData({
      name: 'test.bin',
      data,
      pieceLength: 100,
    })

    const { torrent } = await engine.addTorrent(torrentBuf)
    if (!torrent) throw new Error('Torrent is null')

    // Write the file data to the in-memory filesystem
    const h = await fileSystem.open('test.bin', 'w')
    await h.write(data, 0, data.length, 0)
    await h.close()

    // Spy on verifyChunks to confirm it's called
    const verifyChunksSpy = vi.spyOn(fileSystem, 'verifyChunks')

    await torrent.recheckData()

    // verifyChunks should have been called (batch path)
    expect(verifyChunksSpy).toHaveBeenCalled()

    // All 4 pieces should be valid
    expect(torrent.piecesCount).toBe(4)
    expect(torrent.bitfield?.cardinality()).toBe(4)
  })

  it('should detect corrupted pieces via verifyChunks', async () => {
    const data = new Uint8Array(400)
    for (let i = 0; i < 400; i++) data[i] = i & 0xff

    const torrentBuf = createSingleFileTorrentWithData({
      name: 'test.bin',
      data,
      pieceLength: 100,
    })

    const { torrent } = await engine.addTorrent(torrentBuf)
    if (!torrent) throw new Error('Torrent is null')

    // Write data but corrupt piece 2 (bytes 200-299)
    const corruptData = new Uint8Array(data)
    corruptData[200] = 0xff
    corruptData[201] = 0xff

    const h = await fileSystem.open('test.bin', 'w')
    await h.write(corruptData, 0, corruptData.length, 0)
    await h.close()

    await torrent.recheckData()

    // 3 pieces valid, piece 2 corrupt
    expect(torrent.piecesCount).toBe(4)
    expect(torrent.bitfield?.cardinality()).toBe(3)
    expect(torrent.hasPiece(0)).toBe(true)
    expect(torrent.hasPiece(1)).toBe(true)
    expect(torrent.hasPiece(2)).toBe(false)
    expect(torrent.hasPiece(3)).toBe(true)
  })

  it('should handle multi-file torrent with correct data', async () => {
    const file1Data = new Uint8Array(150)
    for (let i = 0; i < 150; i++) file1Data[i] = i & 0xff
    const file2Data = new Uint8Array(250)
    for (let i = 0; i < 250; i++) file2Data[i] = (i + 150) & 0xff

    const torrentBuf = createMultiFileTorrentWithData({
      name: 'TestTorrent',
      files: [
        { path: 'file1.bin', data: file1Data },
        { path: 'file2.bin', data: file2Data },
      ],
      pieceLength: 100,
    })

    const { torrent } = await engine.addTorrent(torrentBuf)
    if (!torrent) throw new Error('Torrent is null')

    // Write files to in-memory filesystem
    const h1 = await fileSystem.open('TestTorrent/file1.bin', 'w')
    await h1.write(file1Data, 0, file1Data.length, 0)
    await h1.close()
    const h2 = await fileSystem.open('TestTorrent/file2.bin', 'w')
    await h2.write(file2Data, 0, file2Data.length, 0)
    await h2.close()

    await torrent.recheckData()

    // 400 bytes / 100 = 4 pieces, all should be valid
    expect(torrent.piecesCount).toBe(4)
    expect(torrent.bitfield?.cardinality()).toBe(4)
  })

  it('should handle missing files (pieces with no file on disk)', async () => {
    const file1Data = new Uint8Array(200)
    for (let i = 0; i < 200; i++) file1Data[i] = i & 0xff
    const file2Data = new Uint8Array(200)
    for (let i = 0; i < 200; i++) file2Data[i] = (i + 200) & 0xff

    const torrentBuf = createMultiFileTorrentWithData({
      name: 'TestTorrent',
      files: [
        { path: 'file1.bin', data: file1Data },
        { path: 'file2.bin', data: file2Data },
      ],
      pieceLength: 100,
    })

    const { torrent } = await engine.addTorrent(torrentBuf)
    if (!torrent) throw new Error('Torrent is null')

    // Only write file1, file2 is missing
    const h1 = await fileSystem.open('TestTorrent/file1.bin', 'w')
    await h1.write(file1Data, 0, file1Data.length, 0)
    await h1.close()

    await torrent.recheckData()

    // Pieces 0-1 span file1 (present), pieces 2-3 span file2 (missing)
    expect(torrent.piecesCount).toBe(4)
    expect(torrent.hasPiece(0)).toBe(true)
    expect(torrent.hasPiece(1)).toBe(true)
    expect(torrent.hasPiece(2)).toBe(false)
    expect(torrent.hasPiece(3)).toBe(false)
  })

  it('should fall back to per-piece verification when verifyChunks throws', async () => {
    const data = new Uint8Array(200)
    for (let i = 0; i < 200; i++) data[i] = i & 0xff

    const torrentBuf = createSingleFileTorrentWithData({
      name: 'test.bin',
      data,
      pieceLength: 100,
    })

    const { torrent } = await engine.addTorrent(torrentBuf)
    if (!torrent) throw new Error('Torrent is null')

    // Write correct data
    const h = await fileSystem.open('test.bin', 'w')
    await h.write(data, 0, data.length, 0)
    await h.close()

    // Make verifyChunks throw to trigger fallback
    vi.spyOn(fileSystem, 'verifyChunks').mockRejectedValue(new Error('Not supported'))

    await torrent.recheckData()

    // Fallback should still verify pieces correctly
    expect(torrent.piecesCount).toBe(2)
    expect(torrent.bitfield?.cardinality()).toBe(2)
  })

  it('should skip verification when no files exist on disk', async () => {
    const data = new Uint8Array(200)
    for (let i = 0; i < 200; i++) data[i] = i & 0xff

    const torrentBuf = createSingleFileTorrentWithData({
      name: 'test.bin',
      data,
      pieceLength: 100,
    })

    const { torrent } = await engine.addTorrent(torrentBuf)
    if (!torrent) throw new Error('Torrent is null')

    // No files on disk at all
    const verifyChunksSpy = vi.spyOn(fileSystem, 'verifyChunks')

    await torrent.recheckData()

    // verifyChunks should NOT be called when there are no files
    expect(verifyChunksSpy).not.toHaveBeenCalled()
    expect(torrent.bitfield?.cardinality()).toBe(0)
  })

  it('should handle last piece being shorter than pieceLength', async () => {
    // 350 bytes with pieceLength=100 → 4 pieces, last is 50 bytes
    const data = new Uint8Array(350)
    for (let i = 0; i < 350; i++) data[i] = i & 0xff

    const torrentBuf = createSingleFileTorrentWithData({
      name: 'test.bin',
      data,
      pieceLength: 100,
    })

    const { torrent } = await engine.addTorrent(torrentBuf)
    if (!torrent) throw new Error('Torrent is null')

    const h = await fileSystem.open('test.bin', 'w')
    await h.write(data, 0, data.length, 0)
    await h.close()

    await torrent.recheckData()

    expect(torrent.piecesCount).toBe(4)
    expect(torrent.bitfield?.cardinality()).toBe(4)
  })
})
