import * as http from 'node:http'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchDaemonStatus } from '../../src/adapters/daemon/daemon-client'
import { DaemonConnection } from '../../src/adapters/daemon/daemon-connection'
import { DaemonSocketFactory } from '../../src/adapters/daemon/daemon-socket-factory'
import { NODE_IO_DAEMON_CAPABILITIES } from '../../src/node-io-daemon/capabilities'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'
import { TEST_TLS_CERTIFICATE_PEM, TEST_TLS_PRIVATE_KEY_PEM } from './tls-fixture'

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

describe('node-io-daemon server', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null
  let tcpServer: net.Server | null = null
  let tlsServer: tls.Server | null = null

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

    if (tlsServer) {
      await new Promise<void>((resolve, reject) => {
        tlsServer!.close((error) => {
          if (error) {
            reject(error)
          } else {
            resolve()
          }
        })
      })
      tlsServer = null
    }
  })

  it('starts a listener and serves /health', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
    })

    expect(daemon.getStatus()).toEqual({
      implementation: 'node-io-daemon',
      started: false,
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'test',
      capabilities: NODE_IO_DAEMON_CAPABILITIES,
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
      capabilities: { ioWebSocket: boolean }
    }
    expect(payload.port).toBe(startedStatus.port)
    expect(payload.ioPort).toBe(startedStatus.port)
    expect(payload.paired).toBe(true)
    expect(payload.tokenValid).toBe(true)
    expect(payload.capabilities.ioWebSocket).toBe(true)

    const notFound = await makeRequest(startedStatus.port, '/missing')
    expect(notFound.statusCode).toBe(404)

    await daemon.stop()
    expect(daemon.getStatus()).toEqual({
      implementation: 'node-io-daemon',
      started: false,
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      capabilities: NODE_IO_DAEMON_CAPABILITIES,
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

  it('supports inbound TCP listen and accept through the daemon socket adapter', async () => {
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
      const server = factory.createTcpServer()

      const acceptedSocketPromise = new Promise<{
        remoteAddress: string | undefined
        remotePort: number | undefined
        socket: { onData(cb: (data: Uint8Array) => void): void; send(data: Uint8Array): void }
      }>((resolve) => {
        server.on('connection', (socket: { remoteAddress?: string; remotePort?: number }) => {
          resolve({
            remoteAddress: socket.remoteAddress,
            remotePort: socket.remotePort,
            socket: socket as {
              onData(cb: (data: Uint8Array) => void): void
              send(data: Uint8Array): void
            },
          })
        })
      })

      server.listen(0)
      await waitForConditionWithDaemonFlush(factory, () => server.address() !== null)

      const address = server.address()
      expect(address).not.toBeNull()
      const port = address!.port
      expect(port).toBeGreaterThan(0)

      const client = net.createConnection({ host: '127.0.0.1', port })

      const accepted = await waitForWithDaemonFlush(factory, acceptedSocketPromise)
      expect(accepted.remoteAddress).toBeTruthy()
      expect(accepted.remotePort).toBeGreaterThan(0)

      const serverDataPromise = new Promise<string>((resolve) => {
        accepted.socket.onData((data) => {
          resolve(Buffer.from(data).toString('utf8'))
        })
      })

      client.write('hello-server')
      await expect(waitForWithDaemonFlush(factory, serverDataPromise)).resolves.toBe('hello-server')

      const clientDataPromise = new Promise<string>((resolve) => {
        client.once('data', (chunk) => resolve(Buffer.from(chunk).toString('utf8')))
      })

      accepted.socket.send(new TextEncoder().encode('hello-client'))
      await expect(clientDataPromise).resolves.toBe('hello-client')

      client.destroy()
      server.close()
    } finally {
      connection.close()
    }
  })

  it('supports TLS upgrade for a pending outbound daemon socket', async () => {
    tlsServer = tls.createServer(
      {
        key: TEST_TLS_PRIVATE_KEY_PEM,
        cert: TEST_TLS_CERTIFICATE_PEM,
      },
      (socket) => {
        socket.once('data', (chunk) => {
          socket.write(Buffer.concat([Buffer.from('tls:'), chunk]))
          socket.end()
        })
      },
    )

    await new Promise<void>((resolve, reject) => {
      tlsServer!.listen(0, '127.0.0.1', () => resolve())
      tlsServer!.once('error', reject)
    })

    const target = tlsServer.address()
    if (!target || typeof target === 'string') {
      throw new Error('TLS test server failed to bind')
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

      await waitForWithDaemonFlush(factory, socket.secure!('localhost', { skipValidation: true }))
      expect(socket.isSecure).toBe(true)

      const dataPromise = new Promise<string>((resolve) => {
        socket.onData((data) => {
          resolve(Buffer.from(data).toString('utf8'))
        })
      })

      socket.send(new TextEncoder().encode('ping'))
      await expect(waitForWithDaemonFlush(factory, dataPromise)).resolves.toBe('tls:ping')
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

async function waitForConditionWithDaemonFlush(
  factory: DaemonSocketFactory,
  condition: () => boolean,
  timeoutMs = 2000,
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    factory.flushCallbacks()
    if (Date.now() - start > timeoutMs) {
      throw new Error('Timed out waiting for daemon condition')
    }
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
