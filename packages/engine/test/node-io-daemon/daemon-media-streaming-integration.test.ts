import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { MemorySocketFactory, MemorySessionStore } from '../../src/adapters/memory'
import { NodeHasher, NodeStorageHandle, ScopedNodeFileSystem } from '../../src/adapters/node'
import { BtEngine } from '../../src/core/bt-engine'
import { PeerConnection } from '../../src/core/peer-connection'
import { Torrent } from '../../src/core/torrent'
import { TorrentCreator } from '../../src/core/torrent-creator'
import { createNodeIoDaemonEngineHttpStreamBridge } from '../../src/node-io-daemon/engine-http-stream-bridge'
import type {
  NodeIoDaemonHttpStreamBridge,
  NodeIoDaemonHttpStreamWaitRequest,
} from '../../src/node-io-daemon/types'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'

interface HttpResponseData {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface StreamingHttpRequest {
  req: http.ClientRequest
  response: Promise<HttpResponseData>
}

interface MediaFixture {
  mediaPort: number
  fileContent: Buffer
  leecherTorrent: Torrent
  seedingTorrent: Torrent
}

interface MediaFixtureOptions {
  fileSize?: number
  bridgeFactory?: (engine: BtEngine) => NodeIoDaemonHttpStreamBridge
}

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
  let settled = false
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
        settled = true
        resolve({
          statusCode: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        })
      })
    })
    req.on('error', (error) => {
      settled = true
      reject(error)
    })
  })

  req.end(options.body)

  return {
    req,
    response,
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitForCondition(
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

describe('node-io-daemon media streaming integration', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null
  let seeder: BtEngine | null = null
  let leecher: BtEngine | null = null
  let tempDir: string | null = null

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
    if (leecher) {
      await leecher.destroy()
      leecher = null
    }
    if (seeder) {
      await seeder.destroy()
      seeder = null
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  const setupMediaFixture = async (options: MediaFixtureOptions = {}): Promise<MediaFixture> => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-media-stream-'))
    const seedDir = path.join(tempDir, 'seed')
    const downloadDir = path.join(tempDir, 'download')
    fs.mkdirSync(seedDir, { recursive: true })
    fs.mkdirSync(downloadDir, { recursive: true })

    const fileName = 'fixture.bin'
    const downloadPath = path.join(downloadDir, fileName)
    const fileSize = options.fileSize ?? 256 * 1024
    const fileContent = Buffer.alloc(fileSize)
    for (let i = 0; i < fileContent.length; i += 1) {
      fileContent[i] = i % 251
    }
    fs.writeFileSync(path.join(seedDir, fileName), fileContent)
    const sparseHandle = fs.openSync(downloadPath, 'w')
    fs.ftruncateSync(sparseHandle, fileContent.length)
    fs.closeSync(sparseHandle)

    const torrentBuffer = await TorrentCreator.create(
      new NodeStorageHandle('fixture', 'fixture', seedDir),
      fileName,
      new NodeHasher(),
      {
        announceList: [['http://tracker.local']],
        pieceLength: 16 * 1024,
      },
    )

    seeder = new BtEngine({
      socketFactory: new MemorySocketFactory(),
      fileSystem: new ScopedNodeFileSystem(seedDir),
      downloadPath: seedDir,
      sessionStore: new MemorySessionStore(),
      hasher: new NodeHasher(),
      port: 0,
      dhtEnabled: false,
    })
    const { torrent: seedingTorrent } = await seeder.addTorrent(torrentBuffer)
    if (!seedingTorrent) {
      throw new Error('Failed to add seeding torrent')
    }
    await seedingTorrent.recheckData()

    leecher = new BtEngine({
      socketFactory: new MemorySocketFactory(),
      fileSystem: new ScopedNodeFileSystem(downloadDir),
      downloadPath: downloadDir,
      sessionStore: new MemorySessionStore(),
      hasher: new NodeHasher(),
      port: 0,
      dhtEnabled: false,
    })
    const { torrent: leecherTorrent } = await leecher.addTorrent(torrentBuffer)
    if (!leecherTorrent) {
      throw new Error('Failed to add leecher torrent')
    }
    const httpStreamBridge = options.bridgeFactory
      ? options.bridgeFactory(leecher)
      : createNodeIoDaemonEngineHttpStreamBridge(leecher)

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      httpStreamBridge,
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

    const registerResponse = await makeRequest(daemon.getStatus().port, '/stream/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-JST-Auth': 'secret',
      },
      body: JSON.stringify({
        streamToken: 'stream-token',
        torrentId: leecherTorrent.infoHashStr,
        fileIndex: 0,
        rootKey: 'root-a',
        path: fileName,
        fileSize: fileContent.length,
        mimeType: 'application/octet-stream',
      }),
    })
    expect(registerResponse.statusCode).toBe(200)

    const mediaPort = (JSON.parse(registerResponse.body.toString('utf8')) as { mediaPort: number })
      .mediaPort

    return {
      mediaPort,
      fileContent,
      leecherTorrent,
      seedingTorrent,
    }
  }

  const connectSeederAndLeecher = (seedingTorrent: Torrent, leecherTorrent: Torrent): void => {
    const [socketSeeder, socketLeecher] = MemorySocketFactory.createPair()
    const seederPeer = new PeerConnection(seeder!, socketSeeder, {
      remoteAddress: '127.0.0.2',
      remotePort: 6882,
    })
    const leecherPeer = new PeerConnection(leecher!, socketLeecher, {
      remoteAddress: '127.0.0.1',
      remotePort: 6881,
    })

    seedingTorrent.addPeer(seederPeer)
    leecherTorrent.addPeer(leecherPeer)
    seederPeer.sendHandshake(seedingTorrent.infoHash, new Uint8Array(20).fill(1))
    leecherPeer.sendHandshake(leecherTorrent.infoHash, new Uint8Array(20).fill(2))
  }

  const waitForPiece = async (torrent: Torrent, pieceIndex: number): Promise<void> => {
    await waitForCondition(() => torrent.hasPiece(pieceIndex))
  }

  it('blocks a tokenized HTTP range until a real torrent piece arrives', async () => {
    const fixture = await setupMediaFixture()

    let settled = false
    const responsePromise = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    }).then((response) => {
      settled = true
      return response
    })

    await delay(50)
    expect(settled).toBe(false)

    connectSeederAndLeecher(fixture.seedingTorrent, fixture.leecherTorrent)

    const response = await responsePromise
    expect(response.statusCode).toBe(206)
    expect(response.headers['content-range']).toBe(`bytes 0-4/${fixture.fileContent.length}`)
    expect(response.body.equals(fixture.fileContent.subarray(0, 5))).toBe(true)
    expect((fixture.leecherTorrent.bitfield?.cardinality() ?? 0) > 0).toBe(true)
  }, 15000)

  it('streams across multiple daemon chunks and torrent-piece waits', async () => {
    const waitCalls: NodeIoDaemonHttpStreamWaitRequest[] = []
    const fixture = await setupMediaFixture({
      fileSize: 2 * 256 * 1024 + 8192,
      bridgeFactory: (engine) => {
        const bridge = createNodeIoDaemonEngineHttpStreamBridge(engine)
        return {
          ...bridge,
          async waitForRange(request) {
            waitCalls.push({ ...request })
            await bridge.waitForRange(request)
          },
        }
      },
    })

    let settled = false
    const responsePromise = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: `bytes=0-${fixture.fileContent.length - 1}`,
      },
    }).then((response) => {
      settled = true
      return response
    })

    await delay(50)
    expect(settled).toBe(false)

    connectSeederAndLeecher(fixture.seedingTorrent, fixture.leecherTorrent)

    const response = await responsePromise
    expect(response.statusCode).toBe(206)
    expect(response.body.equals(fixture.fileContent)).toBe(true)
    expect(waitCalls.map((call) => ({ offset: call.offset, length: call.length }))).toEqual([
      { offset: 0, length: 256 * 1024 },
      { offset: 256 * 1024, length: 256 * 1024 },
      { offset: 2 * 256 * 1024, length: 8192 },
    ])
  }, 20000)

  it('serves two concurrent requests on the same token independently', async () => {
    const fixture = await setupMediaFixture()

    let firstSettled = false
    let secondSettled = false
    const firstResponse = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    }).then((response) => {
      firstSettled = true
      return response
    })
    const secondResponse = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=1-5',
      },
    }).then((response) => {
      secondSettled = true
      return response
    })

    await delay(50)
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)

    connectSeederAndLeecher(fixture.seedingTorrent, fixture.leecherTorrent)

    const [first, second] = await Promise.all([firstResponse, secondResponse])
    expect(first.statusCode).toBe(206)
    expect(first.body.equals(fixture.fileContent.subarray(0, 5))).toBe(true)
    expect(second.statusCode).toBe(206)
    expect(second.body.equals(fixture.fileContent.subarray(1, 6))).toBe(true)
  }, 15000)

  it('canceling one concurrent request does not cancel another on the same token', async () => {
    const fixture = await setupMediaFixture()

    const first = startRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    })
    const second = startRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=1-5',
      },
    })

    await delay(50)
    first.req.destroy()

    await expect(first.response).rejects.toBeInstanceOf(Error)

    connectSeederAndLeecher(fixture.seedingTorrent, fixture.leecherTorrent)

    const secondResponse = await second.response
    expect(secondResponse.statusCode).toBe(206)
    expect(secondResponse.body.equals(fixture.fileContent.subarray(1, 6))).toBe(true)
  }, 15000)

  it('serves already-complete ranges after the torrent is stopped', async () => {
    const fixture = await setupMediaFixture()

    connectSeederAndLeecher(fixture.seedingTorrent, fixture.leecherTorrent)
    await waitForPiece(fixture.leecherTorrent, 0)

    fixture.leecherTorrent.userStop()

    const response = await makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    })
    expect(response.statusCode).toBe(206)
    expect(response.body.equals(fixture.fileContent.subarray(0, 5))).toBe(true)
  }, 15000)

  it('serves already-complete ranges after the file is skipped', async () => {
    const fixture = await setupMediaFixture()

    connectSeederAndLeecher(fixture.seedingTorrent, fixture.leecherTorrent)
    await waitForPiece(fixture.leecherTorrent, 0)
    await fixture.leecherTorrent.setFilePriorityAsync(0, 1)

    const response = await makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    })
    expect(response.statusCode).toBe(206)
    expect(response.body.equals(fixture.fileContent.subarray(0, 5))).toBe(true)
  }, 15000)

  it('rejects incomplete ranges for skipped files without hanging', async () => {
    const fixture = await setupMediaFixture()

    await fixture.leecherTorrent.setFilePriorityAsync(0, 1)

    const response = await makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.body.toString('utf8')).toBe('File is skipped')
  }, 15000)

  it('rejects incomplete ranges after the torrent is stopped without hanging', async () => {
    const fixture = await setupMediaFixture()

    connectSeederAndLeecher(fixture.seedingTorrent, fixture.leecherTorrent)
    await waitForPiece(fixture.leecherTorrent, 0)
    fixture.leecherTorrent.userStop()

    await waitForCondition(() => !fixture.leecherTorrent.hasPiece(15))

    const response = await makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=245760-245764',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.body.toString('utf8')).toBe('Torrent is stopped')
  }, 15000)

  it('rejects incomplete ranges when the torrent is queued', async () => {
    const fixture = await setupMediaFixture()

    fixture.leecherTorrent.gracefulStop(0)

    const response = await makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.body.toString('utf8')).toBe('Torrent is not active')
  }, 15000)

  it('rejects incomplete ranges when the torrent is in an error state', async () => {
    const fixture = await setupMediaFixture()

    fixture.leecherTorrent.errorMessage = 'Simulated playback failure'

    const response = await makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    })
    expect(response.statusCode).toBe(409)
    expect(response.body.toString('utf8')).toBe('Torrent is in an error state')
  }, 15000)

  it('cancels an in-flight blocking wait when the torrent is stopped', async () => {
    const fixture = await setupMediaFixture()

    let settled = false
    const responsePromise = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    }).then((response) => {
      settled = true
      return response
    })

    await delay(50)
    expect(settled).toBe(false)

    fixture.leecherTorrent.userStop()

    const response = await responsePromise
    expect(response.statusCode).toBe(409)
    expect(response.body.toString('utf8')).toBe('Torrent is stopped')
  }, 15000)

  it('fans out torrent stop to multiple concurrent blocking requests on the same token', async () => {
    const fixture = await setupMediaFixture()

    let firstSettled = false
    let secondSettled = false
    const firstResponse = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    }).then((response) => {
      firstSettled = true
      return response
    })
    const secondResponse = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=1-5',
      },
    }).then((response) => {
      secondSettled = true
      return response
    })

    await delay(50)
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)

    fixture.leecherTorrent.userStop()

    const [first, second] = await Promise.all([firstResponse, secondResponse])
    expect(first.statusCode).toBe(409)
    expect(first.body.toString('utf8')).toBe('Torrent is stopped')
    expect(second.statusCode).toBe(409)
    expect(second.body.toString('utf8')).toBe('Torrent is stopped')
  }, 15000)

  it('serves complete ranges while rejecting incomplete ranges concurrently after the torrent is stopped', async () => {
    const fixture = await setupMediaFixture()

    connectSeederAndLeecher(fixture.seedingTorrent, fixture.leecherTorrent)
    await waitForPiece(fixture.leecherTorrent, 0)
    fixture.leecherTorrent.userStop()

    const [completeResponse, incompleteResponse] = await Promise.all([
      makeRequest(fixture.mediaPort, '/stream/stream-token', {
        headers: {
          Range: 'bytes=0-4',
        },
      }),
      makeRequest(fixture.mediaPort, '/stream/stream-token', {
        headers: {
          Range: 'bytes=245760-245764',
        },
      }),
    ])

    expect(completeResponse.statusCode).toBe(206)
    expect(completeResponse.body.equals(fixture.fileContent.subarray(0, 5))).toBe(true)
    expect(incompleteResponse.statusCode).toBe(409)
    expect(incompleteResponse.body.toString('utf8')).toBe('Torrent is stopped')
  }, 15000)

  it('serves complete ranges while rejecting incomplete ranges concurrently after the file is skipped', async () => {
    const fixture = await setupMediaFixture()

    connectSeederAndLeecher(fixture.seedingTorrent, fixture.leecherTorrent)
    await waitForPiece(fixture.leecherTorrent, 0)
    await fixture.leecherTorrent.setFilePriorityAsync(0, 1)

    const [completeResponse, incompleteResponse] = await Promise.all([
      makeRequest(fixture.mediaPort, '/stream/stream-token', {
        headers: {
          Range: 'bytes=0-4',
        },
      }),
      makeRequest(fixture.mediaPort, '/stream/stream-token', {
        headers: {
          Range: 'bytes=245760-245764',
        },
      }),
    ])

    expect(completeResponse.statusCode).toBe(206)
    expect(completeResponse.body.equals(fixture.fileContent.subarray(0, 5))).toBe(true)
    expect(incompleteResponse.statusCode).toBe(409)
    expect(incompleteResponse.body.toString('utf8')).toBe('File is skipped')
  }, 15000)

  it('fans out torrent removal to multiple concurrent blocking requests on the same token', async () => {
    const fixture = await setupMediaFixture()

    let firstSettled = false
    let secondSettled = false
    const firstResponse = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    }).then((response) => {
      firstSettled = true
      return response
    })
    const secondResponse = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=1-5',
      },
    }).then((response) => {
      secondSettled = true
      return response
    })

    await delay(50)
    expect(firstSettled).toBe(false)
    expect(secondSettled).toBe(false)

    await leecher!.removeTorrentByHash(fixture.leecherTorrent.infoHashStr)

    const [first, second] = await Promise.all([firstResponse, secondResponse])
    expect(first.statusCode).toBe(404)
    expect(second.statusCode).toBe(404)

    const retryResponse = await makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    })
    expect(retryResponse.statusCode).toBe(404)
  }, 15000)

  it('revokes the token and cancels an in-flight wait when the torrent is removed', async () => {
    const fixture = await setupMediaFixture()

    let settled = false
    const responsePromise = makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    }).then((response) => {
      settled = true
      return response
    })

    await delay(50)
    expect(settled).toBe(false)

    await leecher!.removeTorrentByHash(fixture.leecherTorrent.infoHashStr)

    const response = await responsePromise
    expect(response.statusCode).toBe(404)

    const retryResponse = await makeRequest(fixture.mediaPort, '/stream/stream-token', {
      headers: {
        Range: 'bytes=0-4',
      },
    })
    expect(retryResponse.statusCode).toBe(404)
  }, 15000)
})
