import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { BtEngine } from '../../src/core/bt-engine'
import { TorrentCreator } from '../../src/core/torrent-creator'
import { fetchDaemonRoots, fetchDaemonStatus } from '../../src/adapters/daemon/daemon-client'
import { DaemonConnection } from '../../src/adapters/daemon/daemon-connection'
import { DaemonBackedEngine } from '../../src/adapters/daemon/daemon-backed-engine'
import { MemorySessionStore } from '../../src/adapters/memory/memory-session-store'
import { MemoryConfigHub } from '../../src/config/memory-config-hub'
import {
  NodeHasher,
  NodeSocketFactory,
  NodeStorageHandle,
  ScopedNodeFileSystem,
} from '../../src/adapters/node'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'
import { SimpleTracker } from '../helpers/simple-tracker'

describe('DaemonBackedEngine', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null
  let seeder: BtEngine | null = null
  let tracker: SimpleTracker | null = null
  let tempDir: string | null = null

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
    if (seeder) {
      for (const torrent of [...seeder.torrents]) {
        await seeder.removeTorrent(torrent)
      }
      await seeder.destroy()
      seeder = null
    }
    if (tracker) {
      await tracker.close()
      tracker = null
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  async function createHarness() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-backed-engine-'))
    fs.writeFileSync(path.join(tempDir, 'fixture.bin'), Buffer.from('fixture-body'))

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      roots: [
        {
          key: 'root-a',
          uri: pathToFileURL(tempDir).toString(),
          display_name: 'Downloads A',
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
    const connection = new DaemonConnection(
      daemon.getStatus().port,
      '127.0.0.1',
      undefined,
      'secret',
      status.ioPort,
    )
    const roots = await fetchDaemonRoots(connection)

    const harness = await DaemonBackedEngine.create({
      connection,
      contentRoots: roots,
      defaultContentRoot: 'root-a',
      sessionStore: new MemorySessionStore(),
      startSuspended: true,
    })

    return { harness }
  }

  async function makeRequest(
    port: number,
    requestPath: string,
    options: {
      method?: string
      headers?: Record<string, string>
      body?: string
    } = {},
  ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: requestPath,
          method: options.method ?? 'GET',
          agent: false,
          headers: {
            Connection: 'close',
            ...options.headers,
          },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            })
          })
        },
      )
      req.on('error', reject)
      req.end(options.body)
    })
  }

  async function createDownloadHarness() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-backed-engine-download-'))
    const seedDir = path.join(tempDir, 'seed')
    const downloadDir = path.join(tempDir, 'download')
    fs.mkdirSync(seedDir, { recursive: true })
    fs.mkdirSync(downloadDir, { recursive: true })

    tracker = new SimpleTracker({ udpPort: 0 })
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

    seeder = new BtEngine({
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
    const connection = new DaemonConnection(
      daemon.getStatus().port,
      '127.0.0.1',
      undefined,
      'secret',
      status.ioPort,
    )
    const roots = await fetchDaemonRoots(connection)

    const harness = await DaemonBackedEngine.create({
      connection,
      contentRoots: roots,
      defaultContentRoot: 'root-a',
      sessionStore: new MemorySessionStore(),
      config: new MemoryConfigHub({
        dhtEnabled: false,
        upnpEnabled: false,
      }),
      port: 0,
    })

    return {
      harness,
      fileName,
      fileContent,
      downloadDir,
      torrentBuffer,
    }
  }

  async function cleanupHarness(harness: DaemonBackedEngine): Promise<void> {
    for (const torrent of [...harness.engine.torrents]) {
      await harness.engine.removeTorrent(torrent)
    }
    await harness.destroy()
  }

  it('initializes a daemon-backed engine harness', async () => {
    const { harness } = await createHarness()

    try {
      expect(harness.engine).toBeTruthy()
      expect(harness.connection.ready).toBe(true)
      expect(harness.engine.isSuspended).toBe(true)
      expect(harness.engine.storageRootManager.getDefaultRoot()).toBe('root-a')
      expect(harness.engine.storageRootManager.getRoots()).toEqual([
        {
          key: 'root-a',
          label: 'Downloads A',
          path: pathToFileURL(tempDir!).toString(),
        },
      ])
    } finally {
      await cleanupHarness(harness)
    }
  })

  it('registers an HTTP stream over the daemon control channel', async () => {
    const { harness } = await createHarness()

    try {
      const response = await harness.registerHttpStream(
        {
          host: '127.0.0.1',
          port: daemon!.getStatus().port,
          token: 'secret',
          extensionId: 'extension-id',
          installId: 'install-id',
        },
        {
          streamToken: 'stream-token',
          torrentId: 'torrent-a',
          fileIndex: 0,
          rootKey: 'root-a',
          path: 'fixture.bin',
          fileSize: Buffer.byteLength('fixture-body'),
          mimeType: 'application/octet-stream',
        },
      )

      expect(response.mediaPort).toBeGreaterThan(0)
      expect(harness.getControlStreamService()).toBeTruthy()
    } finally {
      await cleanupHarness(harness)
    }
  })

  it('downloads a real torrent through the daemon-backed engine harness', async () => {
    const { harness, torrentBuffer, fileName, fileContent, downloadDir } =
      await createDownloadHarness()

    try {
      const { torrent } = await harness.engine.addTorrent(torrentBuffer)
      if (!torrent) {
        throw new Error('Failed to add downloading torrent')
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for daemon-backed download'))
        }, 30_000)

        torrent.once('complete', () => {
          clearTimeout(timeout)
          resolve()
        })
        torrent.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
      })

      const downloadedPath = path.join(downloadDir, fileName)
      const downloadedContent = fs.readFileSync(downloadedPath)
      expect(downloadedContent.equals(fileContent)).toBe(true)

      const daemonRead = await harness.connection.requestBinaryWithHeaders('GET', '/read/root-a', {
        'X-Path-Base64': Buffer.from(fileName, 'utf8').toString('base64'),
        'X-Offset': '0',
        'X-Length': String(fileContent.length),
      })
      expect(Buffer.from(daemonRead).equals(fileContent)).toBe(true)
    } finally {
      await cleanupHarness(harness)
    }
  }, 40_000)

  it('serves a completed file over tokenized HTTP after control-channel registration', async () => {
    const { harness, torrentBuffer, fileName, fileContent } = await createDownloadHarness()

    try {
      const { torrent } = await harness.engine.addTorrent(torrentBuffer)
      if (!torrent) {
        throw new Error('Failed to add downloading torrent')
      }

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('Timeout waiting for daemon-backed download'))
        }, 30_000)

        torrent.once('complete', () => {
          clearTimeout(timeout)
          resolve()
        })
        torrent.once('error', (error) => {
          clearTimeout(timeout)
          reject(error)
        })
      })

      const { mediaPort } = await harness.registerHttpStream(
        {
          host: '127.0.0.1',
          port: daemon!.getStatus().port,
          token: 'secret',
          extensionId: 'extension-id',
          installId: 'install-id',
        },
        {
          streamToken: 'completed-stream-token',
          torrentId: torrent.infoHashStr,
          fileIndex: 0,
          rootKey: 'root-a',
          path: fileName,
          fileSize: fileContent.length,
          mimeType: 'application/octet-stream',
        },
      )

      const response = await makeRequest(mediaPort, '/stream/completed-stream-token', {
        headers: {
          Range: 'bytes=0-31',
        },
      })
      expect(response.statusCode).toBe(206)
      expect(response.headers['content-range']).toBe(`bytes 0-31/${fileContent.length}`)
      expect(response.body.equals(fileContent.subarray(0, 32))).toBe(true)
    } finally {
      await cleanupHarness(harness)
    }
  }, 40_000)
})
