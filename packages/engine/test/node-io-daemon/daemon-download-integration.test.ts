import { afterEach, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { BtEngine } from '../../src/core/bt-engine'
import { TorrentCreator } from '../../src/core/torrent-creator'
import { ScopedNodeFileSystem } from '../../src/adapters/node'
import { NodeSocketFactory } from '../../src/adapters/node'
import { NodeStorageHandle } from '../../src/adapters/node'
import { NodeHasher } from '../../src/adapters/node'
import { fetchDaemonRoots, fetchDaemonStatus } from '../../src/adapters/daemon/daemon-client'
import { DaemonConnection } from '../../src/adapters/daemon/daemon-connection'
import { MemorySessionStore } from '../../src/adapters/memory/memory-session-store'
import { MemoryConfigHub } from '../../src/config/memory-config-hub'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'
import { createDaemonEngine } from '../../src/presets/daemon'
import { SimpleTracker } from '../helpers/simple-tracker'

describe('node-io-daemon daemon download integration', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null
  let seeder: BtEngine | null = null
  let leecher: BtEngine | null = null
  let connection: DaemonConnection | null = null
  let tracker: SimpleTracker | null = null
  let tempDir: string | null = null

  afterEach(
    async () => {
      if (leecher) {
        for (const torrent of [...leecher.torrents]) {
          await leecher.removeTorrent(torrent)
        }
        await leecher.destroy()
        leecher = null
      }
    if (connection) {
      connection.close()
      connection = null
    }
      if (seeder) {
        for (const torrent of [...seeder.torrents]) {
          await seeder.removeTorrent(torrent)
        }
        await seeder.destroy()
        seeder = null
      }
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
    if (tracker) {
      await tracker.close()
      tracker = null
    }
      if (tempDir) {
        fs.rmSync(tempDir, { recursive: true, force: true })
        tempDir = null
      }
    },
    30_000,
  )

  it(
    'downloads a real torrent through daemon-backed storage',
    async () => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-download-'))
      const seedDir = path.join(tempDir, 'seed')
      const downloadDir = path.join(tempDir, 'download')
      fs.mkdirSync(seedDir, { recursive: true })
      fs.mkdirSync(downloadDir, { recursive: true })

      const trackerServer = new SimpleTracker({ udpPort: 0 })
      tracker = trackerServer
      const ports = await trackerServer.start()
      const trackerUrl = `udp://127.0.0.1:${ports.udpPort}`

      const socketFactory = new NodeSocketFactory()
      const seederConfig = new MemoryConfigHub({
        dhtEnabled: false,
        upnpEnabled: false,
      })
      const leecherConfig = new MemoryConfigHub({
        dhtEnabled: false,
        upnpEnabled: false,
      })

      const fileName = 'fixture.bin'
      const fileContent = crypto.randomBytes(512 * 1024)
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

      seeder = new BtEngine({
        socketFactory,
        fileSystem: new ScopedNodeFileSystem(seedDir),
        downloadPath: seedDir,
        port: 0,
        config: seederConfig,
      })

      const { torrent: seedingTorrent } = await seeder.addTorrent(torrentBuffer)
      if (!seedingTorrent) {
        throw new Error('Failed to add seeding torrent')
      }
      await seedingTorrent.recheckData()
      await seedingTorrent.start()

      daemon = createNodeIoDaemon({
        host: '127.0.0.1',
        port: 0,
        bootstrapMode: 'realistic',
        authToken: 'secret',
        roots: [
          {
            key: 'root-a',
            uri: pathToFileURL(downloadDir).toString(),
            display_name: 'Download Root',
            removable: true,
            last_stat_ok: true,
            last_checked: Date.now(),
          },
        ],
      })
      await daemon.start()

      const status = await fetchDaemonStatus(
        '127.0.0.1',
        daemon.getStatus().port,
        'secret',
        'extension-id',
        'install-id',
      )
      connection = new DaemonConnection(
        daemon.getStatus().port,
        '127.0.0.1',
        undefined,
        'secret',
        status.ioPort,
      )
      const roots = await fetchDaemonRoots(connection)

      leecher = await createDaemonEngine({
        connection,
        contentRoots: roots,
        defaultContentRoot: 'root-a',
        sessionStore: new MemorySessionStore(),
        config: leecherConfig,
        port: 0,
      })

      const { torrent: downloadingTorrent } = await leecher.addTorrent(torrentBuffer)
      if (!downloadingTorrent) {
        throw new Error('Failed to add downloading torrent')
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for daemon-backed download'))
        }, 30_000)

        downloadingTorrent.once('complete', () => {
          clearTimeout(timeout)
          resolve()
        })
        downloadingTorrent.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
      })

      const downloadedPath = path.join(downloadDir, fileName)
      const downloadedContent = fs.readFileSync(downloadedPath)
      expect(downloadedContent.equals(fileContent)).toBe(true)

      const daemonRead = await connection.requestBinaryWithHeaders('GET', '/read/root-a', {
        'X-Path-Base64': Buffer.from(fileName, 'utf8').toString('base64'),
        'X-Offset': '0',
        'X-Length': String(fileContent.length),
      })
      expect(Buffer.from(daemonRead).equals(fileContent)).toBe(true)
    },
    40_000,
  )
})
