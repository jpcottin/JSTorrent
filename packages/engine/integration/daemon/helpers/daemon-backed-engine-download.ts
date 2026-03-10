import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { BtEngine } from '../../../src/core/bt-engine'
import { TorrentCreator } from '../../../src/core/torrent-creator'
import { DaemonBackedEngine } from '../../../src/adapters/daemon/daemon-backed-engine'
import { MemorySessionStore } from '../../../src/adapters/memory/memory-session-store'
import { MemoryConfigHub } from '../../../src/config/memory-config-hub'
import {
  NodeHasher,
  NodeSocketFactory,
  NodeStorageHandle,
  ScopedNodeFileSystem,
} from '../../../src/adapters/node'
import { SimpleTracker } from '../../../test/helpers/simple-tracker'

export interface DaemonDownloadServer {
  port: number
  token: string
  installId: string
  stop(): Promise<void>
}

export interface DaemonDownloadRoot {
  key: string
  label: string
  path: string
}

export interface DaemonBackedEngineDownloadFixture {
  daemon: DaemonDownloadServer
  daemonBackedEngine: DaemonBackedEngine
  seeder: BtEngine
  tracker: SimpleTracker
  tempDir: string
  seedDir: string
  downloadDir: string
  fileName: string
  fileContent: Buffer
  torrentBuffer: Uint8Array
  availableRoot: DaemonDownloadRoot
  cleanup(): Promise<void>
}

export interface DaemonBackedEngineDownloadFixtureOptions {
  startDaemon(downloadDir: string): Promise<DaemonDownloadServer>
}

export async function createDaemonBackedEngineDownloadFixture(
  options: DaemonBackedEngineDownloadFixtureOptions,
): Promise<DaemonBackedEngineDownloadFixture> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-backed-engine-download-'))
  const seedDir = path.join(tempDir, 'seed')
  const downloadDir = path.join(tempDir, 'download')
  fs.mkdirSync(seedDir, { recursive: true })
  fs.mkdirSync(downloadDir, { recursive: true })

  const tracker = new SimpleTracker({ udpPort: 0 })
  const ports = await tracker.start()
  const trackerUrl = `udp://127.0.0.1:${ports.udpPort}`

  const fileName = 'fixture.bin'
  const fileContent = crypto.randomBytes(256 * 1024)
  fs.writeFileSync(path.join(seedDir, fileName), fileContent)

  const torrentBuffer = await TorrentCreator.create(
    new NodeStorageHandle('fixture', 'fixture', seedDir),
    fileName,
    new NodeHasher(),
    {
      announceList: [[trackerUrl]],
      pieceLength: 16 * 1024,
    },
  )

  const seeder = new BtEngine({
    socketFactory: new NodeSocketFactory(),
    fileSystem: new ScopedNodeFileSystem(seedDir),
    downloadPath: seedDir,
    port: 0,
    config: new MemoryConfigHub({
      dhtEnabled: false,
      upnpEnabled: false,
    }),
  })
  const { torrent: seedingTorrent } = await seeder.addTorrent(torrentBuffer)
  if (!seedingTorrent) {
    throw new Error('Failed to add seeding torrent')
  }
  await seedingTorrent.recheckData()
  await seedingTorrent.start()

  const daemon = await options.startDaemon(downloadDir)
  const availableRoot = {
    key: 'root-a',
    label: 'Download Root',
    path: downloadDir,
  }

  const daemonBackedEngine = await DaemonBackedEngine.create({
    daemon: {
      port: daemon.port,
      authToken: daemon.token,
      host: '127.0.0.1',
    },
    contentRoots: [],
    sessionStore: new MemorySessionStore(),
    config: new MemoryConfigHub({
      dhtEnabled: false,
      upnpEnabled: false,
    }),
    port: 0,
  })

  return {
    daemon,
    daemonBackedEngine,
    seeder,
    tracker,
    tempDir,
    seedDir,
    downloadDir,
    fileName,
    fileContent,
    torrentBuffer,
    availableRoot,
    async cleanup(): Promise<void> {
      for (const torrent of [...daemonBackedEngine.engine.torrents]) {
        await daemonBackedEngine.engine.removeTorrent(torrent)
      }
      await daemonBackedEngine.destroy()
      for (const torrent of [...seeder.torrents]) {
        await seeder.removeTorrent(torrent)
      }
      await seeder.destroy()
      await tracker.close()
      await daemon.stop()
      fs.rmSync(tempDir, { recursive: true, force: true })
    },
  }
}
