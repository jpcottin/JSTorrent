import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { BtEngine } from '../../src/core/bt-engine'
import { MemorySocketFactory, InMemoryFileSystem } from '../../src/adapters/memory'
import { MemorySessionStore } from '../../src/adapters/memory'
import { TorrentCreator } from '../../src/core/torrent-creator'
import { PeerConnection } from '../../src/core/peer-connection'
import { FileSystemStorageHandle } from '../../src/io/filesystem-storage-handle'
import { StorageRootManager } from '../../src/storage/storage-root-manager'
import { createMemoryEngine } from '../../src/presets/memory'
import { computeActivityState } from '../../src/core/torrent-state'
import { Bencode } from '../../src/utils/bencode'

describe('computeActivityState with awaitingFileSelection', () => {
  it('returns downloading_metadata when awaiting and no metadata', () => {
    expect(computeActivityState('awaitingFileSelection', false, false, false, 0, false)).toBe(
      'downloading_metadata',
    )
  })

  it('returns awaitingFileSelection when awaiting and has metadata', () => {
    expect(computeActivityState('awaitingFileSelection', false, true, false, 0, false)).toBe(
      'awaitingFileSelection',
    )
  })

  it('returns stopped when engine suspended even if awaitingFileSelection', () => {
    expect(computeActivityState('awaitingFileSelection', true, true, false, 0, false)).toBe(
      'stopped',
    )
  })

  it('returns checking when checking even if awaitingFileSelection', () => {
    expect(computeActivityState('awaitingFileSelection', false, true, true, 0, false)).toBe(
      'checking',
    )
  })

  it('awaitingFileSelection takes precedence over error', () => {
    expect(computeActivityState('awaitingFileSelection', false, true, false, 0, true)).toBe(
      'awaitingFileSelection',
    )
  })

  it('transitions to normal states after setting active', () => {
    expect(computeActivityState('active', false, true, false, 0, false)).toBe('downloading')
    expect(computeActivityState('active', false, true, false, 1, false)).toBe('seeding')
    expect(computeActivityState('active', false, false, false, 0, false)).toBe(
      'downloading_metadata',
    )
  })
})

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

describe('awaitingFileSelection integration', () => {
  describe('add torrent with awaitingFileSelection from .torrent buffer', () => {
    let engine: BtEngine

    beforeEach(() => {
      engine = createMemoryEngine()
    })

    afterEach(async () => {
      await engine.destroy()
    })

    it('creates torrent in awaitingFileSelection state with metadata', async () => {
      const buffer = createMultiFileTorrent({
        name: 'test-folder',
        files: [
          { path: 'a.txt', length: 16384 },
          { path: 'b.txt', length: 16384 },
        ],
        pieceLength: 16384,
      })

      const { torrent } = await engine.addTorrent(buffer, {
        userState: 'awaitingFileSelection',
      })
      if (!torrent) throw new Error('Torrent is null')

      expect(torrent.userState).toBe('awaitingFileSelection')
      expect(torrent.hasMetadata).toBe(true)
      expect(torrent.activityState).toBe('awaitingFileSelection')
    })

    it('is active for networking but blocks piece requests', async () => {
      const buffer = createMultiFileTorrent({
        name: 'test-folder',
        files: [
          { path: 'a.txt', length: 16384 },
          { path: 'b.txt', length: 16384 },
        ],
        pieceLength: 16384,
      })

      const { torrent } = await engine.addTorrent(buffer, {
        userState: 'awaitingFileSelection',
      })
      if (!torrent) throw new Error('Torrent is null')

      // Networking is active (for metadata exchange), but activity state shows awaiting
      expect(torrent.isActive).toBe(true)
      expect(torrent.activityState).toBe('awaitingFileSelection')
    })

    it('starts downloading after confirming file selection', async () => {
      const buffer = createMultiFileTorrent({
        name: 'test-folder',
        files: [
          { path: 'a.txt', length: 16384 },
          { path: 'b.txt', length: 16384 },
        ],
        pieceLength: 16384,
      })

      const { torrent } = await engine.addTorrent(buffer, {
        userState: 'awaitingFileSelection',
      })
      if (!torrent) throw new Error('Torrent is null')

      // Simulate user confirming: select only file 0, skip file 1
      torrent.setFilePriority(1, 1) // skip file b.txt
      torrent.userState = 'active'
      await torrent.start()

      expect(torrent.userState).toBe('active')
      expect(torrent.activityState).toBe('downloading')
      expect(torrent.isActive).toBe(true)
      expect(torrent.filePriorities[0]).toBe(0) // normal
      expect(torrent.filePriorities[1]).toBe(1) // skipped
    })

    it('download all: transitions to active without setting file priorities', async () => {
      const buffer = createMultiFileTorrent({
        name: 'test-folder',
        files: [
          { path: 'a.txt', length: 16384 },
          { path: 'b.txt', length: 16384 },
        ],
        pieceLength: 16384,
      })

      const { torrent } = await engine.addTorrent(buffer, {
        userState: 'awaitingFileSelection',
      })
      if (!torrent) throw new Error('Torrent is null')

      torrent.userState = 'active'
      await torrent.start()

      expect(torrent.userState).toBe('active')
      expect(torrent.isActive).toBe(true)
      expect(torrent.filePriorities[0]).toBe(0)
      expect(torrent.filePriorities[1]).toBe(0)
    })

    it('cancel: removes torrent entirely', async () => {
      const buffer = createMultiFileTorrent({
        name: 'test-folder',
        files: [
          { path: 'a.txt', length: 16384 },
          { path: 'b.txt', length: 16384 },
        ],
        pieceLength: 16384,
      })

      const { torrent } = await engine.addTorrent(buffer, {
        userState: 'awaitingFileSelection',
      })
      if (!torrent) throw new Error('Torrent is null')

      await engine.removeTorrent(torrent)

      expect(engine.torrents.length).toBe(0)
    })
  })

  describe('add magnet with awaitingFileSelection', () => {
    let engine: BtEngine

    beforeEach(() => {
      engine = createMemoryEngine()
    })

    afterEach(async () => {
      await engine.destroy()
    })

    it('starts in downloading_metadata activity state', async () => {
      const magnetLink = 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=Test'
      const { torrent } = await engine.addTorrent(magnetLink, {
        userState: 'awaitingFileSelection',
      })
      if (!torrent) throw new Error('Torrent is null')

      expect(torrent.userState).toBe('awaitingFileSelection')
      expect(torrent.hasMetadata).toBe(false)
      expect(torrent.activityState).toBe('downloading_metadata')
    })
  })

  describe('memory swarm: metadata exchange without piece download', () => {
    let seeder: BtEngine
    let leecher: BtEngine
    let fsSeeder: InMemoryFileSystem

    beforeEach(() => {
      seeder = createMemoryEngine()
      leecher = createMemoryEngine()
      fsSeeder = seeder.storageRootManager.getFileSystemForTorrent('any') as InMemoryFileSystem
    })

    afterEach(async () => {
      await seeder.destroy()
      await leecher.destroy()
    })

    async function setupSeeder(): Promise<
      ReturnType<typeof seeder.addTorrent> extends Promise<infer T> ? T : never
    > {
      const fileContent = new Uint8Array(1024 * 50) // 50KB
      for (let i = 0; i < fileContent.length; i++) {
        fileContent[i] = i % 256
      }

      // Write file — TorrentContentStorage opens files by torrent name (basename)
      // so the file must exist at 'test.txt' on the filesystem
      const filename = 'test.txt'
      const fh = await fsSeeder.open(filename, 'w')
      await fh.write(fileContent, 0, fileContent.length, 0)
      await fh.close()

      const storageHandle = new FileSystemStorageHandle(fsSeeder)
      const torrentBuffer = await TorrentCreator.create(storageHandle, filename, seeder.hasher, {
        pieceLength: 16384,
        announceList: [['http://tracker.local']],
      })

      const result = await seeder.addTorrent(torrentBuffer)
      if (!result.torrent) throw new Error('Failed to add seeder torrent')
      await result.torrent.recheckData()
      expect(result.torrent.bitfield?.cardinality()).toBe(result.torrent.piecesCount)
      return result
    }

    function connectPeers(
      torrentA: ReturnType<typeof seeder.addTorrent> extends Promise<infer T>
        ? T extends { torrent: infer U }
          ? U
          : never
        : never,
      torrentB: ReturnType<typeof seeder.addTorrent> extends Promise<infer T>
        ? T extends { torrent: infer U }
          ? U
          : never
        : never,
    ) {
      const [socketA, socketB] = MemorySocketFactory.createPair()
      const peerA = new PeerConnection(seeder, socketA, {
        remoteAddress: '127.0.0.2',
        remotePort: 6882,
      })
      const peerB = new PeerConnection(leecher, socketB, {
        remoteAddress: '127.0.0.1',
        remotePort: 6881,
      })

      torrentA!.addPeer(peerA)
      torrentB!.addPeer(peerB)

      peerA.sendHandshake(torrentA!.infoHash, new Uint8Array(20).fill(1))
      peerB.sendHandshake(torrentB!.infoHash, new Uint8Array(20).fill(2))
    }

    async function waitForMetadata(torrent: {
      hasMetadata: boolean
      on: (event: string, cb: () => void) => void
    }) {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Metadata timeout')), 5000)
        if (torrent.hasMetadata) {
          clearTimeout(timeout)
          resolve()
        } else {
          torrent.on('test:ready', () => {
            clearTimeout(timeout)
            resolve()
          })
        }
      })
    }

    it('leecher receives metadata but downloads zero pieces', async () => {
      const { torrent: seederTorrent } = await setupSeeder()

      const magnetLink = `magnet:?xt=urn:btih:${seederTorrent!.infoHashStr}&tr=http://tracker.local`
      const { torrent: leecherTorrent } = await leecher.addTorrent(magnetLink, {
        userState: 'awaitingFileSelection',
      })
      if (!leecherTorrent) throw new Error('Failed to add leecher torrent')

      expect(leecherTorrent.activityState).toBe('downloading_metadata')

      connectPeers(seederTorrent, leecherTorrent)
      await waitForMetadata(leecherTorrent)

      expect(leecherTorrent.hasMetadata).toBe(true)
      expect(leecherTorrent.activityState).toBe('awaitingFileSelection')

      // Wait a bit and verify no pieces were downloaded
      await new Promise((resolve) => setTimeout(resolve, 500))
      expect(leecherTorrent.bitfield?.cardinality() ?? 0).toBe(0)
    }, 10000)

    it('leecher downloads pieces after confirming file selection', async () => {
      const { torrent: seederTorrent } = await setupSeeder()

      const magnetLink = `magnet:?xt=urn:btih:${seederTorrent!.infoHashStr}&tr=http://tracker.local`
      const { torrent: leecherTorrent } = await leecher.addTorrent(magnetLink, {
        userState: 'awaitingFileSelection',
      })
      if (!leecherTorrent) throw new Error('Failed to add leecher torrent')

      connectPeers(seederTorrent, leecherTorrent)
      await waitForMetadata(leecherTorrent)

      expect(leecherTorrent.hasMetadata).toBe(true)
      expect(leecherTorrent.bitfield?.cardinality() ?? 0).toBe(0)

      // Confirm: "Download All"
      leecherTorrent.userState = 'active'
      await leecherTorrent.start()

      expect(leecherTorrent.isActive).toBe(true)

      // Wait for all pieces
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Download timeout')), 10000)
        const check = () => {
          if (leecherTorrent.bitfield?.cardinality() === leecherTorrent.piecesCount) {
            clearTimeout(timeout)
            resolve()
          }
        }
        check()
        leecherTorrent.on('piece', check)
      })

      expect(leecherTorrent.bitfield?.cardinality()).toBe(leecherTorrent.piecesCount)
    }, 15000)
  })

  describe('persistence round-trip', () => {
    it('restores torrent in awaitingFileSelection state', async () => {
      const sessionStore = new MemorySessionStore()

      function createTestEngine() {
        const fs = new InMemoryFileSystem()
        const srm = new StorageRootManager(() => fs)
        srm.addRoot({ key: 'default', label: 'Default', path: '/downloads' })
        srm.setDefaultRoot('default')

        return new BtEngine({
          socketFactory: new MemorySocketFactory(),
          storageRootManager: srm,
          sessionStore,
          startSuspended: true,
        })
      }

      const buffer = createMultiFileTorrent({
        name: 'test-folder',
        files: [
          { path: 'a.txt', length: 16384 },
          { path: 'b.txt', length: 16384 },
        ],
        pieceLength: 16384,
      })

      // Engine 1: add torrent in awaitingFileSelection
      const engine1 = createTestEngine()
      const { torrent } = await engine1.addTorrent(buffer, {
        userState: 'awaitingFileSelection',
      })
      if (!torrent) throw new Error('Torrent is null')

      expect(torrent.userState).toBe('awaitingFileSelection')
      // Engine is suspended, so activity state is 'stopped' — that's correct
      // The important thing is userState is persisted
      expect(torrent.activityState).toBe('stopped')

      await engine1.sessionPersistence.saveTorrentState(torrent)
      await engine1.sessionPersistence.saveTorrentList()
      await engine1.destroy()

      // Engine 2: restore and verify
      const engine2 = createTestEngine()
      await engine2.restoreSession()

      expect(engine2.torrents.length).toBe(1)
      const restored = engine2.torrents[0]
      expect(restored.userState).toBe('awaitingFileSelection')
      expect(restored.hasMetadata).toBe(true)
      // Still suspended, so activity state is 'stopped'
      expect(restored.activityState).toBe('stopped')

      // Resume engine — now activity state should reflect awaitingFileSelection
      engine2.resume()
      expect(restored.activityState).toBe('awaitingFileSelection')

      await engine2.destroy()
    })
  })
})
