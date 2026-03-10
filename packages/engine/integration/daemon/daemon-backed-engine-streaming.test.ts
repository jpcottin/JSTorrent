import { afterEach, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { BtEngine } from '../../src/core/bt-engine'
import { TorrentCreator } from '../../src/core/torrent-creator'
import { DaemonBackedEngine } from '../../src/adapters/daemon/daemon-backed-engine'
import { MemorySessionStore } from '../../src/adapters/memory/memory-session-store'
import { MemoryConfigHub } from '../../src/config/memory-config-hub'
import { NodeHasher, NodeSocketFactory, NodeStorageHandle, ScopedNodeFileSystem } from '../../src/adapters/node'
import { SimpleTracker } from '../../test/helpers/simple-tracker'
import { startDaemon, type DaemonHarness } from './helpers/daemon-harness'

interface HttpResponseData {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface StreamingHttpRequest {
  response: Promise<HttpResponseData>
}

describe('DaemonBackedEngine with Rust daemon streaming', () => {
  let daemon: DaemonHarness | null = null
  let seeder: BtEngine | null = null
  let daemonBackedEngine: DaemonBackedEngine | null = null
  let tracker: SimpleTracker | null = null
  let tempDir: string | null = null

  async function makeRequest(
    port: number,
    requestPath: string,
    options: {
      method?: string
      headers?: Record<string, string>
      body?: string
    } = {},
  ): Promise<HttpResponseData> {
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

  function startRequest(
    port: number,
    requestPath: string,
    options: {
      method?: string
      headers?: Record<string, string>
      body?: string
    } = {},
  ): StreamingHttpRequest {
    const req = http.request({
      host: '127.0.0.1',
      port,
      path: requestPath,
      method: options.method ?? 'GET',
      agent: false,
      headers: {
        Connection: 'close',
        ...options.headers,
      },
    })

    const response = new Promise<HttpResponseData>((resolve, reject) => {
      req.on('response', (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        })
      })
      req.on('error', reject)
    })

    req.end(options.body)
    return { response }
  }

  function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  async function cleanupDaemonBackedEngine(): Promise<void> {
    if (!daemonBackedEngine) return
    for (const torrent of [...daemonBackedEngine.engine.torrents]) {
      await daemonBackedEngine.engine.removeTorrent(torrent)
    }
    await daemonBackedEngine.destroy()
    daemonBackedEngine = null
  }

  async function createStreamingFixture() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rust-daemon-streaming-'))
    const seedDir = path.join(tempDir, 'seed')
    const downloadDir = path.join(tempDir, 'download')
    fs.mkdirSync(seedDir, { recursive: true })
    fs.mkdirSync(downloadDir, { recursive: true })

    tracker = new SimpleTracker({ udpPort: 0 })
    const ports = await tracker.start()
    const trackerUrl = `udp://127.0.0.1:${ports.udpPort}`

    const fileName = 'fixture.bin'
    const fileContent = crypto.randomBytes(512 * 1024)
    const downloadPath = path.join(downloadDir, fileName)
    fs.writeFileSync(path.join(seedDir, fileName), fileContent)
    const sparseHandle = fs.openSync(downloadPath, 'w')
    fs.ftruncateSync(sparseHandle, fileContent.length)
    fs.closeSync(sparseHandle)

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

    daemon = await startDaemon({
      roots: [{ key: 'root-a', path: downloadDir, displayName: 'Download Root' }],
    })

    daemonBackedEngine = await DaemonBackedEngine.create({
      daemon: {
        port: daemon.port,
        authToken: daemon.token,
        host: '127.0.0.1',
      },
      controlStream: {
        host: '127.0.0.1',
        port: daemon.port,
        token: daemon.token,
        extensionId: 'test-extension',
        installId: daemon.installId,
      },
      contentRoots: [
        {
          key: 'root-a',
          label: 'Download Root',
          path: downloadDir,
        },
      ],
      defaultContentRoot: 'root-a',
      sessionStore: new MemorySessionStore(),
      config: new MemoryConfigHub({
        dhtEnabled: false,
        upnpEnabled: false,
      }),
      port: 0,
    })

    const { torrent } = await daemonBackedEngine.engine.addTorrent(torrentBuffer)
    if (!torrent) {
      throw new Error('Failed to add daemon-backed torrent')
    }

    return {
      fileName,
      fileContent,
      torrent,
    }
  }

  afterEach(async () => {
    await cleanupDaemonBackedEngine()
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
    if (daemon) {
      await daemon.cleanup()
      daemon = null
    }
  })

  it(
    'blocks a tokenized HTTP range until torrent bytes are available through the Rust daemon',
    async () => {
      const fixture = await createStreamingFixture()

      const { mediaPort } = await daemonBackedEngine!.registerHttpStream(
        {
          host: '127.0.0.1',
          port: daemon.port,
          token: daemon.token,
          extensionId: 'test-extension',
          installId: daemon.installId,
        },
        {
          streamToken: 'blocking-stream-token',
          torrentId: fixture.torrent.infoHashStr,
          fileIndex: 0,
          rootKey: 'root-a',
          path: fixture.fileName,
          fileSize: fixture.fileContent.length,
          mimeType: 'application/octet-stream',
        },
      )

      let settled = false
      const responsePromise = startRequest(mediaPort, '/stream/blocking-stream-token', {
        headers: {
          Range: 'bytes=393216-393231',
        },
      }).response.then((response) => {
        settled = true
        return response
      })

      await delay(100)
      expect(settled).toBe(false)

      const response = await responsePromise
      expect(response.statusCode).toBe(206)
      expect(response.headers['content-range']).toBe(
        `bytes 393216-393231/${fixture.fileContent.length}`,
      )
      expect(response.body.equals(fixture.fileContent.subarray(393216, 393232))).toBe(true)
    },
    40_000,
  )

  it('returns 409 for an incomplete range after the torrent is stopped', async () => {
    const fixture = await createStreamingFixture()

    await fixture.torrent.userStop()

    const { mediaPort } = await daemonBackedEngine!.registerHttpStream(
      {
        host: '127.0.0.1',
        port: daemon.port,
        token: daemon.token,
        extensionId: 'test-extension',
        installId: daemon.installId,
      },
      {
        streamToken: 'stopped-stream-token',
        torrentId: fixture.torrent.infoHashStr,
        fileIndex: 0,
        rootKey: 'root-a',
        path: fixture.fileName,
        fileSize: fixture.fileContent.length,
        mimeType: 'application/octet-stream',
      },
    )

    const response = await makeRequest(mediaPort, '/stream/stopped-stream-token', {
      headers: {
        Range: 'bytes=393216-393231',
      },
    })

    expect(response.statusCode).toBe(409)
    expect(response.body.toString('utf8')).toContain('stopped')
  })

  it('returns 404 after torrent removal revokes the registered token', async () => {
    const fixture = await createStreamingFixture()

    const { mediaPort } = await daemonBackedEngine!.registerHttpStream(
      {
        host: '127.0.0.1',
        port: daemon.port,
        token: daemon.token,
        extensionId: 'test-extension',
        installId: daemon.installId,
      },
      {
        streamToken: 'removed-stream-token',
        torrentId: fixture.torrent.infoHashStr,
        fileIndex: 0,
        rootKey: 'root-a',
        path: fixture.fileName,
        fileSize: fixture.fileContent.length,
        mimeType: 'application/octet-stream',
      },
    )

    await daemonBackedEngine!.engine.removeTorrent(fixture.torrent)
    await delay(50)

    const response = await makeRequest(mediaPort, '/stream/removed-stream-token', {
      headers: {
        Range: 'bytes=0-15',
      },
    })

    expect(response.statusCode).toBe(404)
  })
})
