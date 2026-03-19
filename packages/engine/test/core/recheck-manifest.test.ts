import { describe, it, expect, vi } from 'vitest'
import { createHash } from 'crypto'
import { BtEngine } from '../../src/core/bt-engine'
import { InMemoryFileSystem } from '../../src/adapters/memory'
import { ISocketFactory } from '../../src/interfaces/socket'
import { Bencode } from '../../src/utils/bencode'
import { MemoryConfigHub } from '../../src/config/memory-config-hub'
import type { ManifestJson } from '../../src/core/manifest-writer'

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

function createSingleFileTorrent(opts: {
  name: string
  data: Uint8Array
  pieceLength: number
}): Uint8Array {
  const piecesCount = Math.ceil(opts.data.length / opts.pieceLength)
  const pieces = new Uint8Array(piecesCount * 20)
  for (let i = 0; i < piecesCount; i++) {
    const start = i * opts.pieceLength
    const end = Math.min(start + opts.pieceLength, opts.data.length)
    pieces.set(sha1(opts.data.subarray(start, end)), i * 20)
  }

  return Bencode.encode({
    announce: 'http://tracker.example.com',
    info: {
      name: opts.name,
      'piece length': opts.pieceLength,
      pieces,
      length: opts.data.length,
    },
  })
}

describe('recheck persists download manifest', () => {
  it('should write manifest with complete=true after recheckData verifies all pieces', async () => {
    const fileSystem = new InMemoryFileSystem()
    const config = new MemoryConfigHub({ downloadManifest: true })
    const engine = new BtEngine({
      downloadPath: '/downloads',
      socketFactory: mockSocketFactory,
      fileSystem,
      startSuspended: true,
      config,
    })

    const data = new Uint8Array(400)
    for (let i = 0; i < 400; i++) data[i] = i & 0xff

    const torrentBuf = createSingleFileTorrent({
      name: 'test.bin',
      data,
      pieceLength: 100,
    })

    const { torrent } = await engine.addTorrent(torrentBuf)
    if (!torrent) throw new Error('Torrent is null')

    // Flush manifest written on metadata-available
    await engine.manifestWriter!.flushPendingSaves()

    const manifestPath = `.${torrent.infoHashStr}.jstorrent.json`
    const initialRaw = fileSystem.files.get(manifestPath)
    expect(initialRaw).toBeDefined()
    const initial = JSON.parse(new TextDecoder().decode(initialRaw!)) as ManifestJson
    expect(initial.files['test.bin'].complete).toBe(false)

    // Write file data so recheck finds it
    const fh = await fileSystem.open('test.bin', 'w')
    await fh.write(data, 0, data.length, 0)
    await fh.close()

    await torrent.recheckData()
    expect(torrent.bitfield?.cardinality()).toBe(torrent.piecesCount)

    // Flush the debounced manifest write triggered by recheck
    await engine.manifestWriter!.flushPendingSaves()

    const updatedRaw = fileSystem.files.get(manifestPath)
    expect(updatedRaw).toBeDefined()
    const updated = JSON.parse(new TextDecoder().decode(updatedRaw!)) as ManifestJson
    expect(updated.infohash).toBe(torrent.infoHashStr)
    expect(updated.files['test.bin'].complete).toBe(true)
  })
})
