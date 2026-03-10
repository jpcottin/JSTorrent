import * as http from 'http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpRpcServer } from '../../src/node-rpc/server'
import type {
  EngineController,
  TorrentFileContentInfo,
  TorrentFileStreamingHandle,
} from '../../src/node-rpc/controller'
import type { ByteRangeStreamingSession } from '../../src/streaming/streaming-file-provider'

interface HttpResponseData {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface PendingRead {
  offset: number
  length: number
  signal?: AbortSignal
  resolve: (value: Uint8Array) => void
  reject: (error: Error) => void
}

class ControlledStreamingSession implements ByteRangeStreamingSession {
  readonly fileSize: number
  readonly pendingReads: PendingRead[] = []
  closeCount = 0
  abortCount = 0

  constructor(fileSize: number) {
    this.fileSize = fileSize
  }

  read(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    return new Promise<Uint8Array>((resolve, reject) => {
      const pending: PendingRead = {
        offset,
        length,
        signal,
        resolve,
        reject,
      }
      this.pendingReads.push(pending)

      const abortListener = () => {
        this.abortCount += 1
        reject(this.createAbortError())
      }
      signal?.addEventListener('abort', abortListener, { once: true })
    })
  }

  waitForRange(): Promise<void> {
    return Promise.resolve()
  }

  close(): void {
    this.closeCount += 1
  }

  private createAbortError(): Error {
    if (typeof DOMException !== 'undefined') {
      return new DOMException('Aborted', 'AbortError')
    }
    const error = new Error('Aborted')
    error.name = 'AbortError'
    return error
  }
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createStreamingController(
  session: ControlledStreamingSession,
  fileSize: number,
  mimeType = 'video/mp4',
) {
  const info: TorrentFileContentInfo = {
    ok: true,
    id: 'torrent-1',
    fileIndex: 0,
    filePath: 'movie.mp4',
    fileSize,
    complete: false,
    mimeType,
  }
  const handle: TorrentFileStreamingHandle = { info, session }

  return {
    createTorrentFileStreamingHandle: vi.fn(() => handle),
  }
}

describe('HttpRpcServer torrent file streaming route', () => {
  let server: HttpRpcServer | null = null

  afterEach(async () => {
    if (server) {
      await server.stop()
      server = null
    }
  })

  it('blocks until the requested bytes become available', async () => {
    const session = new ControlledStreamingSession(11)
    const controller = createStreamingController(session, 11)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    let settled = false
    const responsePromise = makeRequest(port, '/torrent/torrent-1/files/0/stream', {
      headers: { Range: 'bytes=0-4' },
    }).then((response) => {
      settled = true
      return response
    })

    await delay(50)
    expect(session.pendingReads).toHaveLength(1)
    expect(session.pendingReads[0]?.offset).toBe(0)
    expect(session.pendingReads[0]?.length).toBe(5)
    expect(settled).toBe(false)

    session.pendingReads[0]?.resolve(Buffer.from('hello'))

    const response = await responsePromise
    expect(response.statusCode).toBe(206)
    expect(response.headers['content-range']).toBe('bytes 0-4/11')
    expect(response.body.toString('utf8')).toBe('hello')
    expect(session.closeCount).toBe(1)
  })

  it('streams larger ranges across multiple blocking reads', async () => {
    const fileSize = 300_000
    const session = new ControlledStreamingSession(fileSize)
    const controller = createStreamingController(session, fileSize)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    const responsePromise = makeRequest(port, '/torrent/torrent-1/files/0/stream')

    await delay(25)
    expect(session.pendingReads).toHaveLength(1)
    expect(session.pendingReads[0]?.offset).toBe(0)
    expect(session.pendingReads[0]?.length).toBe(256 * 1024)
    session.pendingReads[0]?.resolve(Buffer.alloc(256 * 1024, 0x61))

    await delay(25)
    expect(session.pendingReads).toHaveLength(2)
    expect(session.pendingReads[1]?.offset).toBe(256 * 1024)
    expect(session.pendingReads[1]?.length).toBe(fileSize - 256 * 1024)
    session.pendingReads[1]?.resolve(Buffer.alloc(fileSize - 256 * 1024, 0x62))

    const response = await responsePromise
    expect(response.statusCode).toBe(200)
    expect(response.body.byteLength).toBe(fileSize)
    expect(response.body.subarray(0, 1).toString('hex')).toBe('61')
    expect(response.body.subarray(fileSize - 1).toString('hex')).toBe('62')
    expect(session.closeCount).toBe(1)
  })

  it('aborts a pending blocking read when the client disconnects', async () => {
    const session = new ControlledStreamingSession(11)
    const controller = createStreamingController(session, 11)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    const req = http.request({
      host: '127.0.0.1',
      port,
      path: '/torrent/torrent-1/files/0/stream',
      method: 'GET',
      agent: false,
      headers: {
        Connection: 'close',
        Range: 'bytes=0-4',
      },
    })
    req.end()

    await delay(50)
    expect(session.pendingReads).toHaveLength(1)
    req.destroy()

    await new Promise<void>((resolve) => {
      req.once('error', () => resolve())
      setTimeout(resolve, 100)
    })

    await delay(25)
    expect(session.pendingReads[0]?.signal?.aborted).toBe(true)
    expect(session.abortCount).toBeGreaterThanOrEqual(1)
    expect(session.closeCount).toBe(1)
  })

  it('supports HEAD requests without opening a blocking read', async () => {
    const session = new ControlledStreamingSession(11)
    const controller = createStreamingController(session, 11)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    const response = await makeRequest(port, '/torrent/torrent-1/files/0/stream', {
      method: 'HEAD',
      headers: { Range: 'bytes=6-10' },
    })

    expect(response.statusCode).toBe(206)
    expect(response.headers['content-range']).toBe('bytes 6-10/11')
    expect(response.body.byteLength).toBe(0)
    expect(session.pendingReads).toHaveLength(0)
    expect(session.closeCount).toBe(1)
  })

  it('returns 416 for an invalid range without opening a session read', async () => {
    const session = new ControlledStreamingSession(11)
    const controller = createStreamingController(session, 11)
    server = new HttpRpcServer(0, controller as unknown as EngineController)
    const port = await server.start()

    const response = await makeRequest(port, '/torrent/torrent-1/files/0/stream', {
      headers: { Range: 'bytes=99-100' },
    })

    expect(response.statusCode).toBe(416)
    expect(response.headers['content-range']).toBe('bytes */11')
    expect(response.body.byteLength).toBe(0)
    expect(session.pendingReads).toHaveLength(0)
    expect(session.closeCount).toBe(1)
  })
})
