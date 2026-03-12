import { afterEach, describe, expect, it } from 'vitest'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as http from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { BtEngine } from '../../src/core/bt-engine'
import { TorrentCreator } from '../../src/core/torrent-creator'
import { ScopedNodeFileSystem, NodeSocketFactory, NodeStorageHandle, NodeHasher } from '../../src/adapters/node'
import { MemoryConfigHub } from '../../src/config/memory-config-hub'

describe('node web-seed integration', () => {
  let engine: BtEngine | null = null
  let server: http.Server | null = null
  let tempDir: string | null = null

  afterEach(async () => {
    if (engine) {
      for (const torrent of [...engine.torrents]) {
        await engine.removeTorrent(torrent)
      }
      await engine.destroy()
      engine = null
    }

    if (server) {
      await new Promise<void>((resolve, reject) => {
        server!.close((error) => {
          if (error) reject(error)
          else resolve()
        })
      })
      server = null
    }

    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  }, 30_000)

  it('downloads a torrent from a local BEP 19 web seed using a directory-style single-file url-list', async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jstorrent-web-seed-'))
    const seedDir = path.join(tempDir, 'seed')
    const downloadDir = path.join(tempDir, 'download')
    fs.mkdirSync(seedDir, { recursive: true })
    fs.mkdirSync(downloadDir, { recursive: true })

    const fileName = 'fixture.bin'
    const fileContent = crypto.randomBytes(48 * 1024)
    fs.writeFileSync(path.join(seedDir, fileName), fileContent)

    const requestPaths: string[] = []
    server = http.createServer((req, res) => {
      requestPaths.push(req.url ?? '')

      if (req.method !== 'GET' || req.url !== `/webseed/${fileName}`) {
        res.writeHead(404, { Connection: 'close' })
        res.end()
        return
      }

      const rangeHeader = req.headers.range
      if (typeof rangeHeader !== 'string') {
        res.writeHead(200, {
          'Content-Length': String(fileContent.length),
          Connection: 'close',
        })
        res.end(fileContent)
        return
      }

      const match = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader)
      if (!match) {
        res.writeHead(416, { Connection: 'close' })
        res.end()
        return
      }

      const start = Number.parseInt(match[1], 10)
      const endInclusive = Number.parseInt(match[2], 10)
      const body = fileContent.subarray(start, endInclusive + 1)

      res.writeHead(206, {
        'Content-Length': String(body.length),
        'Content-Range': `bytes ${start}-${endInclusive}/${fileContent.length}`,
        'Accept-Ranges': 'bytes',
        Connection: 'close',
      })
      res.end(body)
    })

    const port = await new Promise<number>((resolve, reject) => {
      server!.once('error', reject)
      server!.listen(0, '127.0.0.1', () => {
        const address = server!.address()
        if (!address || typeof address === 'string') {
          reject(new Error('Failed to determine web-seed server port'))
          return
        }
        resolve(address.port)
      })
    })

    const torrentBuffer = await TorrentCreator.create(
      new NodeStorageHandle('fixture', 'fixture', seedDir),
      fileName,
      new NodeHasher(),
      {
        pieceLength: 16 * 1024,
        urlList: [`http://127.0.0.1:${port}/webseed/`],
      },
    )

    engine = new BtEngine({
      socketFactory: new NodeSocketFactory(),
      fileSystem: new ScopedNodeFileSystem(downloadDir),
      downloadPath: downloadDir,
      port: 0,
      config: new MemoryConfigHub({
        dhtEnabled: false,
        upnpEnabled: false,
      }),
    })

    const { torrent } = await engine.addTorrent(torrentBuffer)
    if (!torrent) {
      throw new Error('Failed to add web-seed torrent')
    }

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for web-seed download'))
      }, 20_000)

      torrent.once('complete', () => {
        clearTimeout(timeout)
        resolve()
      })
      torrent.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })

    expect(fs.readFileSync(path.join(downloadDir, fileName)).equals(fileContent)).toBe(true)
    expect(requestPaths.some((requestPath) => requestPath === `/webseed/${fileName}`)).toBe(true)
  }, 30_000)
})
