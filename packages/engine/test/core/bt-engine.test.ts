import { describe, it, expect, vi, beforeEach } from 'vitest'
import { BtEngine } from '../../src/core/bt-engine'
import { InMemoryFileSystem } from '../../src/adapters/memory'
import { ISocketFactory } from '../../src/interfaces/socket'
import { Bencode } from '../../src/utils/bencode'

// Mock dependencies
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

describe('BtEngine', () => {
  let fileSystem: InMemoryFileSystem
  let client: BtEngine

  beforeEach(() => {
    fileSystem = new InMemoryFileSystem()
    client = new BtEngine({
      downloadPath: '/downloads',
      socketFactory: mockSocketFactory,
      fileSystem: fileSystem,
    })
  })

  it('should add a torrent from a buffer', async () => {
    // Create a mock torrent file buffer
    const info = {
      name: 'test-torrent',
      'piece length': 16384,
      pieces: new Uint8Array(20), // One piece (SHA1 hash length)
      length: 1000,
    }

    const torrentDict = {
      announce: 'http://tracker.example.com',
      info: info,
    }

    const buffer = Bencode.encode(torrentDict)

    const { torrent } = await client.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    expect(torrent).toBeDefined()
    expect(client.torrents).toContain(torrent)
    expect(torrent.hasMetadata).toBe(true)
    expect(torrent.piecesCount).toBe(1)
    expect(torrent.contentStorage).toBeDefined()
    expect(torrent.infoHash).toBeDefined()
    expect(torrent.infoHash.length).toBe(20)
  })

  it('should throw on invalid buffer', async () => {
    const buffer = new Uint8Array([0, 1, 2, 3]) // Not bencoded
    await expect(client.addTorrent(buffer)).rejects.toThrow()
  })

  it('should add a torrent from a magnet link', async () => {
    const magnetLink =
      'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Test+Torrent&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce'
    const { torrent } = await client.addTorrent(magnetLink)
    if (!torrent) throw new Error('Torrent is null')

    expect(torrent).toBeDefined()
    expect(client.torrents).toContain(torrent)
    expect(Buffer.from(torrent.infoHash).toString('hex')).toBe(
      'c12fe1c06bba254a9dc9f519b335aa7c1367a88a',
    )
    expect(torrent.announce).toContain('udp://tracker.opentrackr.org:1337/announce')
    expect(torrent.hasMetadata).toBe(false)
    expect(torrent.contentStorage).toBeUndefined()
  }, 10000)

  it('should get a torrent by infoHash', async () => {
    const info = {
      name: 'test-torrent-2',
      'piece length': 16384,
      pieces: new Uint8Array(20),
      length: 1000,
    }
    const buffer = Bencode.encode({
      announce: 'http://tracker.example.com',
      info,
    })

    const { torrent } = await client.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    const hex = Buffer.from(torrent.infoHash).toString('hex')
    const found = client.getTorrent(hex)
    expect(found).toBe(torrent)
  })

  it('should remove a torrent', async () => {
    const info = {
      name: 'test-torrent-3',
      'piece length': 16384,
      pieces: new Uint8Array(20),
      length: 1000,
    }
    const buffer = Bencode.encode({
      announce: 'http://tracker.example.com',
      info,
    })

    const { torrent } = await client.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    // Mock destroy method
    const originalDestroy = torrent.destroy
    torrent.destroy = vi.fn().mockImplementation(originalDestroy)

    await client.removeTorrent(torrent)
    expect(client.torrents).not.toContain(torrent)
    expect(torrent.destroy).toHaveBeenCalled()
  })

  it('should destroy client and destroy all torrents', async () => {
    const info1 = {
      name: 'test-torrent-4',
      'piece length': 16384,
      pieces: new Uint8Array(20),
      length: 1000,
    }
    const buffer1 = Bencode.encode({ info: info1 })

    const info2 = {
      name: 'test-torrent-5',
      'piece length': 16384,
      pieces: new Uint8Array(20),
      length: 1000,
    }
    const buffer2 = Bencode.encode({ info: info2 })

    const { torrent: t1 } = await client.addTorrent(buffer1)
    const { torrent: t2 } = await client.addTorrent(buffer2)

    if (!t1 || !t2) throw new Error('Failed to create torrents')

    const destroy1 = vi.spyOn(t1, 'destroy')
    const destroy2 = vi.spyOn(t2, 'destroy')

    await client.destroy()
    expect(client.torrents.length).toBe(0)
    expect(destroy1).toHaveBeenCalled()
    expect(destroy2).toHaveBeenCalled()
  })

  it('should preserve trackers when resetting torrent from torrent file', async () => {
    const info = {
      name: 'test-reset',
      'piece length': 16384,
      pieces: new Uint8Array(20),
      length: 1000,
    }
    const buffer = Bencode.encode({
      announce: 'http://localhost:9999/announce',
      'announce-list': [['http://localhost:9998/announce'], ['http://localhost:9997/announce']],
      info,
    })

    const { torrent } = await client.addTorrent(buffer)
    if (!torrent) throw new Error('Torrent is null')

    expect(torrent.announce).toContain('http://localhost:9998/announce')
    expect(torrent.announce).toContain('http://localhost:9997/announce')

    await client.resetTorrent(torrent)

    // Get the new torrent (reset creates a new object)
    const hex = Buffer.from(torrent.infoHash).toString('hex')
    const resetTorrent = client.getTorrent(hex)
    if (!resetTorrent) throw new Error('Reset torrent not found')

    // Trackers should be preserved
    expect(resetTorrent.announce).toContain('http://localhost:9998/announce')
    expect(resetTorrent.announce).toContain('http://localhost:9997/announce')
  })

  it('should preserve trackers when resetting torrent from magnet link', async () => {
    const magnetLink =
      'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Test&tr=udp%3A%2F%2Flocalhost%3A9998&tr=udp%3A%2F%2Flocalhost%3A9997'

    const { torrent } = await client.addTorrent(magnetLink)
    if (!torrent) throw new Error('Torrent is null')

    expect(torrent.announce).toContain('udp://localhost:9998')
    expect(torrent.announce).toContain('udp://localhost:9997')

    await client.resetTorrent(torrent)

    const resetTorrent = client.getTorrent('c12fe1c06bba254a9dc9f519b335aa7c1367a88a')
    if (!resetTorrent) throw new Error('Reset torrent not found')

    // Trackers should be preserved
    expect(resetTorrent.announce).toContain('udp://localhost:9998')
    expect(resetTorrent.announce).toContain('udp://localhost:9997')

    // Clean up to avoid timeout from tracker connections
    await client.destroy()
  }, 15000)

  describe('removeTorrentWithData', () => {
    it('should delete single-file torrent content from disk', async () => {
      const info = {
        name: 'test-file.txt',
        'piece length': 16384,
        pieces: new Uint8Array(20),
        length: 1000,
      }
      const buffer = Bencode.encode({ info })

      const { torrent } = await client.addTorrent(buffer)
      if (!torrent) throw new Error('Torrent is null')

      // Create the file on the in-memory filesystem
      const handle = await fileSystem.open('test-file.txt', 'w')
      await handle.write(new Uint8Array(1000), 0, 1000, 0)
      await handle.close()
      expect(await fileSystem.exists('test-file.txt')).toBe(true)

      const result = await client.removeTorrentWithData(torrent)
      expect(result.success).toBe(true)
      expect(result.errors).toEqual([])
      expect(await fileSystem.exists('test-file.txt')).toBe(false)
    })

    it('should delete multi-file torrent content from disk', async () => {
      const info = {
        name: 'Movie',
        'piece length': 16384,
        pieces: new Uint8Array(20),
        files: [
          { length: 500, path: ['movie.mkv'] },
          { length: 300, path: ['extras', 'trailer.mkv'] },
          { length: 200, path: ['subs', 'en.srt'] },
        ],
      }
      const buffer = Bencode.encode({ info })

      const { torrent } = await client.addTorrent(buffer)
      if (!torrent) throw new Error('Torrent is null')

      // Create directories and files on the in-memory filesystem
      await fileSystem.mkdir('Movie')
      await fileSystem.mkdir('Movie/extras')
      await fileSystem.mkdir('Movie/subs')
      for (const path of ['Movie/movie.mkv', 'Movie/extras/trailer.mkv', 'Movie/subs/en.srt']) {
        const h = await fileSystem.open(path, 'w')
        await h.write(new Uint8Array(100), 0, 100, 0)
        await h.close()
      }
      expect(await fileSystem.exists('Movie/movie.mkv')).toBe(true)
      expect(await fileSystem.exists('Movie/extras/trailer.mkv')).toBe(true)

      const result = await client.removeTorrentWithData(torrent)
      expect(result.success).toBe(true)
      expect(result.errors).toEqual([])
      expect(await fileSystem.exists('Movie/movie.mkv')).toBe(false)
      expect(await fileSystem.exists('Movie/extras/trailer.mkv')).toBe(false)
      expect(await fileSystem.exists('Movie/subs/en.srt')).toBe(false)
    })

    it('should delete content even when exists() throws', async () => {
      const info = {
        name: 'test-exists-throw.txt',
        'piece length': 16384,
        pieces: new Uint8Array(20),
        length: 1000,
      }
      const buffer = Bencode.encode({ info })

      const { torrent } = await client.addTorrent(buffer)
      if (!torrent) throw new Error('Torrent is null')

      // Create the file
      const handle = await fileSystem.open('test-exists-throw.txt', 'w')
      await handle.write(new Uint8Array(1000), 0, 1000, 0)
      await handle.close()

      // Make exists() throw
      const origExists = fileSystem.exists.bind(fileSystem)
      fileSystem.exists = vi.fn().mockRejectedValue(new Error('exists failed'))

      const result = await client.removeTorrentWithData(torrent)
      // Should still attempt deletion despite exists() throwing
      expect(await origExists('test-exists-throw.txt')).toBe(false)
    })
  })
})
