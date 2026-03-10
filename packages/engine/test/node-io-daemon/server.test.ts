import * as http from 'node:http'
import * as net from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchDaemonStatus } from '../../src/adapters/daemon/daemon-client'
import { DaemonConnection } from '../../src/adapters/daemon/daemon-connection'
import { DaemonSocketFactory } from '../../src/adapters/daemon/daemon-socket-factory'
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

describe('node-io-daemon phase three server', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null
  let tcpServer: net.Server | null = null

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }

    if (tcpServer) {
      await new Promise<void>((resolve, reject) => {
        tcpServer!.close((error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
      tcpServer = null
    }
  })

  it('starts a listener and serves /health', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
    })

    expect(daemon.getStatus()).toEqual({
      implementation: 'node-io-daemon',
      phase: 'phase3',
      started: false,
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'test',
      capabilities: {
        health: true,
        status: true,
        ioWebSocket: true,
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

  it('serves daemon-compatible /status over POST and resets cleanly after stop', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      configPath: '/tmp/node-io-daemon.json',
    })

    await daemon.start()
    const startedStatus = daemon.getStatus()
    const response = await makeRequest(startedStatus.port, '/status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-JST-Auth': 'secret',
      },
    })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('application/json')

    const payload = JSON.parse(response.body.toString('utf8')) as {
      port: number
      ioPort: number | null
      paired: boolean
      tokenValid: boolean | null
      phase: string
      capabilities: { ioWebSocket: boolean }
    }
    expect(payload.port).toBe(startedStatus.port)
    expect(payload.ioPort).toBe(startedStatus.port)
    expect(payload.paired).toBe(true)
    expect(payload.tokenValid).toBe(true)
    expect(payload.phase).toBe('phase3')
    expect(payload.capabilities.ioWebSocket).toBe(true)

    const notFound = await makeRequest(startedStatus.port, '/missing')
    expect(notFound.statusCode).toBe(404)

    await daemon.stop()
    expect(daemon.getStatus()).toEqual({
      implementation: 'node-io-daemon',
      phase: 'phase3',
      started: false,
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      capabilities: {
        health: true,
        status: true,
        ioWebSocket: true,
        controlEvents: false,
        rootsRead: false,
        rootsWrite: false,
        fileOps: false,
        mediaCompleteFile206: false,
        mediaBlocking206: false,
      },
    })
  })

  it('supports daemon status discovery and /io auth handshake through the existing client', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
    })

    await daemon.start()
    const port = daemon.getStatus().port

    const status = await fetchDaemonStatus('127.0.0.1', port, 'secret', 'extension-id', 'install')
    expect(status.port).toBe(port)
    expect(status.ioPort).toBe(port)
    expect(status.paired).toBe(true)
    expect(status.tokenValid).toBe(true)

    const connection = new DaemonConnection(port, '127.0.0.1', undefined, 'secret', status.ioPort)

    try {
      await connection.connectWebSocket()
      expect(connection.ready).toBe(true)
    } finally {
      connection.close()
    }
  })

  it('supports a real outbound TCP round-trip through the daemon socket adapter', async () => {
    tcpServer = net.createServer((socket) => {
      socket.once('data', (chunk) => {
        socket.write(Buffer.concat([Buffer.from('echo:'), chunk]))
        socket.end()
      })
    })

    await new Promise<void>((resolve, reject) => {
      tcpServer!.listen(0, '127.0.0.1', () => resolve())
      tcpServer!.once('error', reject)
    })

    const target = tcpServer.address()
    if (!target || typeof target === 'string') {
      throw new Error('TCP test server failed to bind')
    }

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
    })
    await daemon.start()

    const status = await fetchDaemonStatus(
      '127.0.0.1',
      daemon.getStatus().port,
      'secret',
      'extension-id',
      'install',
    )
    const connection = new DaemonConnection(
      daemon.getStatus().port,
      '127.0.0.1',
      undefined,
      'secret',
      status.ioPort,
    )
    const factory = new DaemonSocketFactory(connection)

    try {
      await connection.connectWebSocket()
      const socket = await waitForWithDaemonFlush(
        factory,
        factory.createTcpSocket({ host: '127.0.0.1', port: target.port }),
      )

      const dataPromise = new Promise<string>((resolve) => {
        socket.onData((data) => {
          resolve(Buffer.from(data).toString('utf8'))
        })
      })
      const closePromise = new Promise<boolean>((resolve) => {
        socket.onClose((hadError) => resolve(hadError))
      })

      socket.send(new TextEncoder().encode('ping'))

      await expect(waitForWithDaemonFlush(factory, dataPromise)).resolves.toBe('echo:ping')
      await expect(waitForWithDaemonFlush(factory, closePromise)).resolves.toBe(false)
    } finally {
      connection.close()
    }
  })
})

async function waitForWithDaemonFlush<T>(
  factory: DaemonSocketFactory,
  promise: Promise<T>,
  timeoutMs = 2000,
): Promise<T> {
  const start = Date.now()
  let settled = false
  let value: T | undefined
  let rejection: unknown

  promise.then(
    (result) => {
      settled = true
      value = result
    },
    (error) => {
      settled = true
      rejection = error
    },
  )

  while (!settled) {
    factory.flushCallbacks()
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for daemon callback flush')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }

  if (rejection) {
    throw rejection
  }

  return value as T
}
