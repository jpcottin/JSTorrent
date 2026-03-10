import * as http from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'

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

describe('node-io-daemon phase one server', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
  })

  it('starts a listener and serves /health', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
    })

    expect(daemon.getStatus()).toEqual({
      implementation: 'node-io-daemon',
      phase: 'phase1',
      started: false,
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'test',
      capabilities: {
        health: true,
        status: true,
        ioWebSocket: false,
        controlEvents: false,
        rootsRead: false,
        rootsWrite: false,
        fileOps: false,
        mediaCompleteFile206: false,
        mediaBlocking206: false,
      },
    })

    await daemon.start()

    const status = daemon.getStatus()
    expect(status.started).toBe(true)
    expect(status.port).toBeGreaterThan(0)

    const response = await makeRequest(status.port, '/health')
    expect(response.statusCode).toBe(200)
    expect(response.headers['access-control-allow-origin']).toBe('*')
    expect(response.body.toString('utf8')).toBe('ok')
  })

  it('serves /status and resets cleanly after stop', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      configPath: '/tmp/node-io-daemon.json',
    })

    await daemon.start()
    const startedStatus = daemon.getStatus()
    const response = await makeRequest(startedStatus.port, '/status')
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')

    const payload = JSON.parse(response.body.toString('utf8')) as ReturnType<typeof daemon.getStatus>
    expect(payload).toEqual(startedStatus)

    const notFound = await makeRequest(startedStatus.port, '/missing')
    expect(notFound.statusCode).toBe(404)

    await daemon.stop()
    expect(daemon.getStatus()).toEqual({
      implementation: 'node-io-daemon',
      phase: 'phase1',
      started: false,
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      capabilities: {
        health: true,
        status: true,
        ioWebSocket: false,
        controlEvents: false,
        rootsRead: false,
        rootsWrite: false,
        fileOps: false,
        mediaCompleteFile206: false,
        mediaBlocking206: false,
      },
    })
  })
})
