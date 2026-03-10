import * as http from 'http'
import { EngineController } from './controller'

interface HttpByteRange {
  start: number
  endInclusive: number
  totalSize: number
  partial: boolean
}

function getContentLength(range: HttpByteRange): number {
  return range.endInclusive < range.start ? 0 : range.endInclusive - range.start + 1
}

function getContentRangeHeader(range: HttpByteRange): string {
  return `bytes ${range.start}-${range.endInclusive}/${range.totalSize}`
}

function resolveHttpByteRange(
  rangeHeader: string | string[] | undefined,
  totalSize: number,
): HttpByteRange | null {
  if (!Number.isFinite(totalSize) || totalSize < 0) {
    return null
  }

  if (rangeHeader === undefined) {
    return {
      start: 0,
      endInclusive: totalSize === 0 ? -1 : totalSize - 1,
      totalSize,
      partial: false,
    }
  }

  if (Array.isArray(rangeHeader)) {
    return null
  }

  if (!rangeHeader.startsWith('bytes=') || totalSize === 0) {
    return null
  }

  const spec = rangeHeader.slice('bytes='.length).trim()
  if (!spec || spec.includes(',')) {
    return null
  }

  const parts = spec.split('-', 2)
  if (parts.length !== 2) {
    return null
  }

  const startPart = parts[0].trim()
  const endPart = parts[1].trim()

  if (!startPart) {
    const suffixLength = Number.parseInt(endPart, 10)
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return null
    }
    const start = Math.max(totalSize - suffixLength, 0)
    return {
      start,
      endInclusive: totalSize - 1,
      totalSize,
      partial: true,
    }
  }

  const start = Number.parseInt(startPart, 10)
  if (!Number.isFinite(start) || start < 0 || start >= totalSize) {
    return null
  }

  const end = endPart
    ? Math.min(Number.parseInt(endPart, 10), totalSize - 1)
    : totalSize - 1
  if (!Number.isFinite(end) || end < start) {
    return null
  }

  return {
    start,
    endInclusive: end,
    totalSize,
    partial: true,
  }
}

export class HttpRpcServer {
  private server: http.Server
  private controller: EngineController
  private port: number
  private actualPort: number = 0

  constructor(port: number = 0, controller: EngineController = new EngineController()) {
    this.port = port
    this.controller = controller
    this.server = http.createServer((req, res) => this.handleRequest(req, res))
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        const addr = this.server.address()
        this.actualPort = typeof addr === 'object' && addr ? addr.port : this.port
        // Output in a parseable format for the Python test harness
        console.log(`RPC_PORT=${this.actualPort}`)
        console.log(`HTTP RPC Server listening on port ${this.actualPort}`)
        resolve(this.actualPort)
      })
    })
  }

  getPort(): number {
    return this.actualPort
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const { method, url } = req

    // Enable CORS for local dev
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    try {
      const pathname = new URL(url ?? '/', 'http://127.0.0.1').pathname
      const contentMatch = pathname.match(/^\/torrent\/([^/]+)\/files\/(\d+)\/content$/)

      if (contentMatch && (method === 'GET' || method === 'HEAD')) {
        await this.handleTorrentFileContent(req, res, decodeURIComponent(contentMatch[1]), contentMatch[2])
      } else if (url === '/engine/start' && method === 'POST') {
        const body = await this.readBody(req)
        this.controller.startEngine(body.config)
        this.sendJson(res, { ok: true })
      } else if (url === '/engine/stop' && method === 'POST') {
        await this.controller.stopEngine()
        this.sendJson(res, { ok: true })
      } else if (url === '/engine/status' && method === 'GET') {
        const status = this.controller.getEngineStatus()
        this.sendJson(res, status)
      } else if (url === '/shutdown' && method === 'POST') {
        // Stop engine if running
        try {
          await this.controller.stopEngine()
        } catch (_e) {
          // ignore if not running
        }
        this.sendJson(res, { ok: true })
        // Close server and exit process
        setTimeout(() => {
          this.stop().then(() => process.exit(0))
        }, 100)
      } else if (url === '/torrent/add' && method === 'POST') {
        const body = await this.readBody(req)
        const result = await this.controller.addTorrent(body)
        this.sendJson(res, result)
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/status') && method === 'GET') {
        const id = url.split('/')[2]
        const status = this.controller.getTorrentStatus(id)
        this.sendJson(res, status)
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/pause') && method === 'POST') {
        const id = url.split('/')[2]
        this.controller.pauseTorrent(id)
        this.sendJson(res, { ok: true })
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/resume') && method === 'POST') {
        const id = url.split('/')[2]
        this.controller.resumeTorrent(id)
        this.sendJson(res, { ok: true })
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/remove') && method === 'POST') {
        const id = url.split('/')[2]
        this.controller.removeTorrent(id)
        this.sendJson(res, { ok: true })
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/add-peer') && method === 'POST') {
        const id = url.split('/')[2]
        const body = await this.readBody(req)
        await this.controller.addPeer(id, body.ip, body.port)
        this.sendJson(res, { ok: true })
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/recheck') && method === 'POST') {
        const id = url.split('/')[2]
        await this.controller.recheckTorrent(id)
        this.sendJson(res, { ok: true })
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/peers') && method === 'GET') {
        const id = url.split('/')[2]
        const result = this.controller.getPeerInfo(id)
        this.sendJson(res, result)
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/settings') && method === 'POST') {
        const id = url.split('/')[2]
        const body = await this.readBody(req)
        const result = this.controller.setTorrentSettings(id, body)
        this.sendJson(res, result)
      } else if (
        url?.startsWith('/torrent/') &&
        url?.endsWith('/disconnect-peer') &&
        method === 'POST'
      ) {
        const id = url.split('/')[2]
        const body = await this.readBody(req)
        const result = this.controller.disconnectPeer(id, body.ip, body.port)
        this.sendJson(res, result)
      } else if (url?.startsWith('/logs') && method === 'GET') {
        const urlObj = new URL(url, `http://localhost:${this.port}`)
        const level = urlObj.searchParams.get('level') || 'info'
        const limit = parseInt(urlObj.searchParams.get('limit') || '100', 10)
        const result = this.controller.getLogs(level, limit)
        this.sendJson(res, result)
      } else if (url === '/engine/tick-stats' && method === 'GET') {
        const result = this.controller.getTickStats()
        this.sendJson(res, result)
      } else {
        res.writeHead(404)
        this.sendJson(res, { ok: false, error: 'Not Found' })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const code =
        message === 'EngineNotRunning' ||
        message === 'EngineAlreadyRunning' ||
        message === 'TorrentNotFound' ||
        message === 'TorrentFileNotFound'
          ? 400
          : 500
      res.writeHead(code)
      this.sendJson(res, { ok: false, error: message })
    }
  }

  private async handleTorrentFileContent(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    torrentId: string,
    fileIndexText: string,
  ): Promise<void> {
    const fileIndex = Number.parseInt(fileIndexText, 10)
    if (!Number.isFinite(fileIndex) || fileIndex < 0) {
      this.sendText(res, 404, 'Not Found')
      return
    }

    try {
      const info = this.controller.getTorrentFileContentInfo(torrentId, fileIndex)
      if (!info.complete) {
        this.sendText(res, 409, 'File is not complete')
        return
      }

      const range = resolveHttpByteRange(req.headers.range, info.fileSize)
      if (!range) {
        res.statusCode = 416
        res.setHeader('Accept-Ranges', 'bytes')
        res.setHeader('Content-Range', `bytes */${info.fileSize}`)
        res.setHeader('Content-Length', '0')
        res.end()
        return
      }

      const contentLength = getContentLength(range)
      res.statusCode = range.partial ? 206 : 200
      res.setHeader('Content-Type', info.mimeType ?? 'application/octet-stream')
      res.setHeader('Accept-Ranges', 'bytes')
      res.setHeader('Cache-Control', 'private, no-store')
      res.setHeader('Pragma', 'no-cache')
      res.setHeader('Content-Length', String(contentLength))
      if (range.partial) {
        res.setHeader('Content-Range', getContentRangeHeader(range))
      }

      if (req.method === 'HEAD') {
        res.end()
        return
      }

      const chunkSize = 256 * 1024
      let nextOffset = range.start
      while (nextOffset <= range.endInclusive && !req.destroyed && !res.destroyed) {
        const bytesToRead = Math.min(chunkSize, range.endInclusive - nextOffset + 1)
        const chunk = await this.controller.readTorrentFileContent(
          torrentId,
          fileIndex,
          nextOffset,
          bytesToRead,
        )
        if (chunk.byteLength === 0) {
          throw new Error('Unexpected empty read while streaming complete file')
        }
        nextOffset += chunk.byteLength
        res.write(Buffer.from(chunk))
      }

      if (!res.writableEnded) {
        res.end()
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      if (message === 'TorrentNotFound' || message === 'TorrentFileNotFound') {
        this.sendText(res, 404, 'Not Found')
        return
      }
      if (message === 'EngineNotRunning') {
        this.sendText(res, 503, 'Engine not running')
        return
      }
      if (message === 'TorrentFileIncomplete') {
        this.sendText(res, 409, 'File is not complete')
        return
      }
      this.sendText(res, 500, message)
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', reject)
    })
  }

  private sendJson(res: http.ServerResponse, data: unknown) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json')
    }
    res.end(JSON.stringify(data))
  }

  private sendText(res: http.ServerResponse, statusCode: number, message: string) {
    res.statusCode = statusCode
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8')
      res.setHeader('Content-Length', String(Buffer.byteLength(message)))
    }
    res.end(message)
  }
}
