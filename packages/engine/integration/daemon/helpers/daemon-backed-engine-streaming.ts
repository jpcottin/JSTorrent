import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
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

export interface HttpResponseData {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

export interface StreamingHttpRequest {
  req: http.ClientRequest
  response: Promise<HttpResponseData>
}

export interface DaemonStreamingServer {
  port: number
  token: string
  installId: string
  stop(): Promise<void>
}

export interface DaemonBackedEngineStreamingFixture {
  daemon: DaemonStreamingServer
  daemonBackedEngine: DaemonBackedEngine
  seeder: BtEngine
  tracker: SimpleTracker
  tempDir: string
  seedDir: string
  downloadDir: string
  fileName: string
  fileContent: Buffer
  torrent: Awaited<ReturnType<BtEngine['addTorrent']>>['torrent']
  registerStreamToken(streamToken: string): Promise<number>
  cleanup(): Promise<void>
}

export interface DaemonBackedEngineStreamingFixtureOptions {
  fileSize?: number
  preloadBytes?: number
  startDaemon(downloadDir: string): Promise<DaemonStreamingServer>
}

const DEFAULT_EXTENSION_ID = 'test-extension'

export async function makeRequest(
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

export function startRequest(
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
  return { req, response }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function waitForCondition(
  condition: () => boolean,
  timeoutMs = 5000,
  stepMs = 10,
): Promise<void> {
  const startedAt = Date.now()
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for condition')
    }
    await delay(stepMs)
  }
}

export async function createDaemonBackedEngineStreamingFixture(
  options: DaemonBackedEngineStreamingFixtureOptions,
): Promise<DaemonBackedEngineStreamingFixture> {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-backed-engine-streaming-'))
  const seedDir = path.join(tempDir, 'seed')
  const downloadDir = path.join(tempDir, 'download')
  fs.mkdirSync(seedDir, { recursive: true })
  fs.mkdirSync(downloadDir, { recursive: true })

  const tracker = new SimpleTracker({ udpPort: 0 })
  const ports = await tracker.start()
  const trackerUrl = `udp://127.0.0.1:${ports.udpPort}`

  const fileName = 'fixture.bin'
  const fileContent = crypto.randomBytes(options.fileSize ?? 512 * 1024)
  const downloadPath = path.join(downloadDir, fileName)
  fs.writeFileSync(path.join(seedDir, fileName), fileContent)
  const sparseHandle = fs.openSync(downloadPath, 'w')
  fs.ftruncateSync(sparseHandle, fileContent.length)
  fs.closeSync(sparseHandle)

  if (options.preloadBytes && options.preloadBytes > 0) {
    const preloadLength = Math.min(options.preloadBytes, fileContent.length)
    const preloadHandle = fs.openSync(downloadPath, 'r+')
    fs.writeSync(preloadHandle, fileContent.subarray(0, preloadLength), 0, preloadLength, 0)
    fs.closeSync(preloadHandle)
  }

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

  const daemonBackedEngine = await DaemonBackedEngine.create({
    daemon: {
      port: daemon.port,
      authToken: daemon.token,
      host: '127.0.0.1',
    },
    controlStream: {
      host: '127.0.0.1',
      port: daemon.port,
      token: daemon.token,
      extensionId: DEFAULT_EXTENSION_ID,
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
    daemon,
    daemonBackedEngine,
    seeder,
    tracker,
    tempDir,
    seedDir,
    downloadDir,
    fileName,
    fileContent,
    torrent,
    async registerStreamToken(streamToken: string): Promise<number> {
      const { mediaPort } = await daemonBackedEngine.registerHttpStream(
        {
          host: '127.0.0.1',
          port: daemon.port,
          token: daemon.token,
          extensionId: DEFAULT_EXTENSION_ID,
          installId: daemon.installId,
        },
        {
          streamToken,
          torrentId: torrent.infoHashStr,
          fileIndex: 0,
          rootKey: 'root-a',
          path: fileName,
          fileSize: fileContent.length,
          mimeType: 'application/octet-stream',
        },
      )
      return mediaPort
    },
    async cleanup(): Promise<void> {
      for (const activeTorrent of [...daemonBackedEngine.engine.torrents]) {
        await daemonBackedEngine.engine.removeTorrent(activeTorrent)
      }
      await daemonBackedEngine.destroy()
      for (const activeTorrent of [...seeder.torrents]) {
        await seeder.removeTorrent(activeTorrent)
      }
      await seeder.destroy()
      await tracker.close()
      await daemon.stop()
      fs.rmSync(tempDir, { recursive: true, force: true })
    },
  }
}
