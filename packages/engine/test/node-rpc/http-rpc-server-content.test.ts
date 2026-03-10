import * as http from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpRpcServer } from '../../src/node-rpc/server'
import type { EngineController, TorrentFileContentInfo } from '../../src/node-rpc/controller'

interface HttpResponseData {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

async function makeRequest(
  port: number,
  path: string,
  options: {
    method?: string
    headers?: Record<string, string>
  } = {},
): Promise<HttpResponseData> {
  return await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
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
    req.end()
  })
}

function createFakeController(data: Buffer, complete = true) {
  const info: TorrentFileContentInfo = {
    ok: true,
    id: 'torrent-1',
    fileIndex: 0,
    filePath: 'movie.mp4',
    fileSize: data.length,
    complete,
    mimeType: 'video/mp4',
  }

  return {
    getTorrentFileContentInfo: vi.fn(() => info),
    readTorrentFileContent: vi.fn(async (_id: string, _fileIndex: number, offset: number, length: number) =>
      new Uint8Array(data.subarray(offset, offset + length)),
    ),
  }
}

describe('HttpRpcServer torrent file content route', () => {
  let server: HttpRpcServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('serves the full file when no Range header is provided', async () => {
    const data = Buffer.from('hello world')
    const controller = createFakeController(data)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    const response = await makeRequest(port, '/torrent/torrent-1/files/0/content')

    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toBe('video/mp4')
    expect(response.headers['accept-ranges']).toBe('bytes')
    expect(response.headers['content-length']).toBe(String(data.length))
    expect(response.headers['content-range']).toBeUndefined()
    expect(response.body.equals(data)).toBe(true)
    expect(controller.readTorrentFileContent).toHaveBeenCalledWith('torrent-1', 0, 0, data.length)
  })

  it('serves partial content for a valid byte range', async () => {
    const data = Buffer.from('hello world')
    const controller = createFakeController(data)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    const response = await makeRequest(port, '/torrent/torrent-1/files/0/content', {
      headers: { Range: 'bytes=0-4' },
    })

    expect(response.statusCode).toBe(206)
    expect(response.headers['content-length']).toBe('5')
    expect(response.headers['content-range']).toBe(`bytes 0-4/${data.length}`)
    expect(response.body.toString('utf8')).toBe('hello')
    expect(controller.readTorrentFileContent).toHaveBeenCalledWith('torrent-1', 0, 0, 5)
  })

  it('supports HEAD requests without sending a body', async () => {
    const data = Buffer.from('hello world')
    const controller = createFakeController(data)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    const response = await makeRequest(port, '/torrent/torrent-1/files/0/content', {
      method: 'HEAD',
      headers: { Range: 'bytes=6-10' },
    })

    expect(response.statusCode).toBe(206)
    expect(response.headers['content-length']).toBe('5')
    expect(response.headers['content-range']).toBe(`bytes 6-10/${data.length}`)
    expect(response.body.byteLength).toBe(0)
    expect(controller.readTorrentFileContent).not.toHaveBeenCalled()
  })

  it('returns 416 for an invalid range', async () => {
    const data = Buffer.from('hello world')
    const controller = createFakeController(data)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    const response = await makeRequest(port, '/torrent/torrent-1/files/0/content', {
      headers: { Range: 'bytes=99-100' },
    })

    expect(response.statusCode).toBe(416)
    expect(response.headers['content-range']).toBe(`bytes */${data.length}`)
    expect(response.body.byteLength).toBe(0)
    expect(controller.readTorrentFileContent).not.toHaveBeenCalled()
  })

  it('returns 409 when the file is incomplete', async () => {
    const data = Buffer.from('hello world')
    const controller = createFakeController(data, false)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    const response = await makeRequest(port, '/torrent/torrent-1/files/0/content')

    expect(response.statusCode).toBe(409)
    expect(response.body.toString('utf8')).toBe('File is not complete')
    expect(controller.readTorrentFileContent).not.toHaveBeenCalled()
  })
})
