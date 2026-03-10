import * as http from 'node:http'
import * as dgram from 'node:dgram'
import * as net from 'node:net'
import * as tls from 'node:tls'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { ControlConnection } from '../../src/adapters/daemon/control-connection'
import { fetchDaemonRoots, fetchDaemonStatus } from '../../src/adapters/daemon/daemon-client'
import { DaemonConnection } from '../../src/adapters/daemon/daemon-connection'
import { DaemonSocketFactory } from '../../src/adapters/daemon/daemon-socket-factory'
import { NODE_IO_DAEMON_CAPABILITIES } from '../../src/node-io-daemon/capabilities'
import { buildIoProtocolFrame } from '../../src/node-io-daemon/io-protocol'
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
    body?: string
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
    req.end(options.body)
  })
}

describe('node-io-daemon server', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null
  let tcpServer: net.Server | null = null
  let tlsServer: tls.Server | null = null
  let udpServer: dgram.Socket | null = null
  const tempDirs: string[] = []

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

    if (udpServer) {
      await new Promise<void>((resolve) => {
        udpServer!.close(() => {
          resolve()
        })
      })
      udpServer = null
    }

    for (const tempDir of tempDirs.splice(0, tempDirs.length)) {
      fs.rmSync(tempDir, { recursive: true, force: true })
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

  it('serves authenticated roots and broadcasts deletions over /control', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      roots: [
        {
          key: 'root-a',
          uri: 'file:///downloads/a',
          display_name: 'Downloads A',
          removable: true,
          last_stat_ok: true,
          last_checked: 100,
        },
        {
          key: 'root-b',
          uri: 'file:///downloads/b',
          display_name: 'Downloads B',
          removable: false,
          last_stat_ok: true,
          last_checked: 200,
        },
      ],
    })
    await daemon.start()

    const status = await fetchDaemonStatus(
      '127.0.0.1',
      daemon.getStatus().port,
      'secret',
      'extension-id',
      'install',
    )
    const httpConnection = new DaemonConnection(
      daemon.getStatus().port,
      '127.0.0.1',
      undefined,
      'secret',
      status.ioPort,
    )
    const control = new ControlConnection('127.0.0.1', daemon.getStatus().port, 'secret')

    try {
      const roots = await fetchDaemonRoots(httpConnection)
      expect(roots).toEqual([
        { key: 'root-a', label: 'Downloads A', path: 'file:///downloads/a' },
        { key: 'root-b', label: 'Downloads B', path: 'file:///downloads/b' },
      ])

      const rootsChangedPromise = new Promise<string[]>((resolve) => {
        const unsubscribe = control.onRootsChanged((nextRoots) => {
          unsubscribe()
          resolve(nextRoots.map((root) => root.key))
        })
      })

      await control.connect()

      const deleteResponse = await makeRequest(daemon.getStatus().port, '/roots/root-a', {
        method: 'DELETE',
        headers: {
          'X-JST-Auth': 'secret',
        },
      })
      expect(deleteResponse.statusCode).toBe(200)

      await expect(rootsChangedPromise).resolves.toEqual(['root-b'])

      const remainingRoots = await fetchDaemonRoots(httpConnection)
      expect(remainingRoots).toEqual([{ key: 'root-b', label: 'Downloads B', path: 'file:///downloads/b' }])
    } finally {
      control.close()
    }
  })

  it('answers control capability requests over /control', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
    })
    await daemon.start()

    const ws = await connectAuthenticatedControlWebSocket(daemon.getStatus().port, 'secret')

    try {
      const response = await sendControlJsonRequest(ws, 0xed, 9, {})
      expect(response.opcode).toBe(0xed)
      expect(response.requestId).toBe(9)
      expect(response.payload).toEqual({
        ok: true,
        capabilities: {
          roots_manageable: true,
          lan_share_urls: true,
        },
      })
    } finally {
      ws.close()
    }
  })

  it('registers an HTTP stream over /control and serves it from the media port', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-stream-'))
    tempDirs.push(tempDir)
    const content = Buffer.from('hello world')
    fs.writeFileSync(path.join(tempDir, 'movie.mp4'), content)

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      roots: [
        {
          key: 'root-a',
          uri: pathToFileURL(tempDir).toString(),
          display_name: 'Temp Root',
          removable: true,
          last_stat_ok: true,
          last_checked: Date.now(),
        },
      ],
    })
    await daemon.start()

    const ws = await connectAuthenticatedControlWebSocket(daemon.getStatus().port, 'secret')

    try {
      const response = await sendControlJsonRequest<{ ok: boolean; mediaPort: number }>(ws, 0xec, 17, {
        streamToken: 'token-123',
        torrentId: 'torrent-123',
        rootKey: 'root-a',
        path: 'movie.mp4',
        fileSize: content.length,
        mimeType: 'video/mp4',
      })

      expect(response.opcode).toBe(0xec)
      expect(response.requestId).toBe(17)
      expect(response.payload).toEqual({
        ok: true,
        mediaPort: expect.any(Number),
      })
      const mediaPort = response.payload.mediaPort
      const mediaResponse = await makeRequest(mediaPort, '/stream/token-123', {
        headers: { Range: 'bytes=0-4' },
      })
      expect(mediaResponse.statusCode).toBe(206)
      expect(mediaResponse.headers['content-range']).toBe(`bytes 0-4/${content.length}`)
      expect(mediaResponse.body.toString('utf8')).toBe('hello')
    } finally {
      ws.close()
    }
  })

  it('registers an HTTP stream over /stream/register and exposes network discovery routes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-stream-register-'))
    tempDirs.push(tempDir)
    const content = Buffer.from('stream me')
    fs.writeFileSync(path.join(tempDir, 'clip.mp4'), content)

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      roots: [
        {
          key: 'root-a',
          uri: pathToFileURL(tempDir).toString(),
          display_name: 'Temp Root',
          removable: true,
          last_stat_ok: true,
          last_checked: Date.now(),
        },
      ],
    })
    await daemon.start()

    const interfacesResponse = await makeRequest(daemon.getStatus().port, '/network/interfaces', {
      headers: { 'X-JST-Auth': 'secret' },
    })
    expect(interfacesResponse.statusCode).toBe(200)
    expect(Array.isArray(JSON.parse(interfacesResponse.body.toString('utf8')))).toBe(true)

    const gatewayResponse = await makeRequest(daemon.getStatus().port, '/network/gateway', {
      headers: { 'X-JST-Auth': 'secret' },
    })
    expect(gatewayResponse.statusCode).toBe(200)
    expect(gatewayResponse.body.toString('utf8')).toBe('null')

    const registerResponse = await makeRequest(daemon.getStatus().port, '/stream/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-JST-Auth': 'secret',
      },
      body: JSON.stringify({
        streamToken: 'http-token',
        torrentId: 'torrent-123',
        rootKey: 'root-a',
        path: 'clip.mp4',
        fileSize: content.length,
        mimeType: 'video/mp4',
      }),
    })
    expect(registerResponse.statusCode).toBe(200)
    expect(JSON.parse(registerResponse.body.toString('utf8'))).toEqual({
      ok: true,
      mediaPort: expect.any(Number),
    })

    const mediaPort = (JSON.parse(registerResponse.body.toString('utf8')) as { mediaPort: number })
      .mediaPort
    const headResponse = await makeRequest(mediaPort, '/stream/http-token', {
      method: 'HEAD',
      headers: { Range: 'bytes=0-3' },
    })
    expect(headResponse.statusCode).toBe(206)
    expect(headResponse.headers['content-range']).toBe(`bytes 0-3/${content.length}`)
    expect(headResponse.body.byteLength).toBe(0)
  })

  it('auto-picks a temp-backed root in test mode when folder picker is requested', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'test',
    })
    await daemon.start()

    const control = new ControlConnection('127.0.0.1', daemon.getStatus().port, 'ignored')
    const ws = await connectAuthenticatedControlWebSocket(daemon.getStatus().port, 'ignored')

    try {
      const rootsChangedPromise = new Promise<string[]>((resolve) => {
        const unsubscribe = control.onRootsChanged((nextRoots) => {
          unsubscribe()
          resolve(nextRoots.map((root) => root.uri ?? ''))
        })
      })

      await control.connect()

      const response = await sendControlJsonRequest(ws, 0xe2, 11, {})

      expect(response.opcode).toBe(0xe2)
      expect(response.requestId).toBe(11)
      expect(response.payload).toMatchObject({
        ok: true,
        root: {
          key: 'picked-root-1',
          display_name: 'Picked Root 1',
          removable: true,
          last_stat_ok: true,
        },
      })

      const pickedRootPaths = await rootsChangedPromise
      expect(pickedRootPaths).toHaveLength(1)
      expect(pickedRootPaths[0]).toContain('/jstorrent-node-io-daemon/picked-root-1')
    } finally {
      control.close()
      ws.close()
    }
  })

  it('supports in-memory pairing bootstrap and dynamic /io auth', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: null,
    })
    await daemon.start()

    const prePairStatus = await fetchDaemonStatus(
      '127.0.0.1',
      daemon.getStatus().port,
      'fresh-token',
      'extension-a',
      'install-a',
    )
    expect(prePairStatus.paired).toBe(false)
    expect(prePairStatus.tokenValid).toBe(false)
    expect(prePairStatus.extensionId).toBeNull()
    expect(prePairStatus.installId).toBeNull()

    const pairResponse = await makeRequest(daemon.getStatus().port, '/pair', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-JST-ExtensionId': 'extension-a',
        'X-JST-InstallId': 'install-a',
      },
      body: JSON.stringify({ token: 'fresh-token' }),
    })
    expect(pairResponse.statusCode).toBe(200)
    expect(JSON.parse(pairResponse.body.toString('utf8'))).toEqual({ status: 'approved' })

    const pairedStatus = await fetchDaemonStatus(
      '127.0.0.1',
      daemon.getStatus().port,
      'fresh-token',
      'extension-a',
      'install-a',
    )
    expect(pairedStatus.paired).toBe(true)
    expect(pairedStatus.tokenValid).toBe(true)
    expect(pairedStatus.extensionId).toBe('extension-a')
    expect(pairedStatus.installId).toBe('install-a')

    const connection = new DaemonConnection(
      daemon.getStatus().port,
      '127.0.0.1',
      undefined,
      'fresh-token',
      pairedStatus.ioPort,
    )

    try {
      await connection.connectWebSocket()
      expect(connection.ready).toBe(true)
    } finally {
      connection.close()
    }

    const conflictResponse = await makeRequest(daemon.getStatus().port, '/pair', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-JST-ExtensionId': 'extension-b',
        'X-JST-InstallId': 'install-b',
      },
      body: JSON.stringify({ token: 'other-token' }),
    })
    expect(conflictResponse.statusCode).toBe(409)
    expect(JSON.parse(conflictResponse.body.toString('utf8'))).toEqual({ status: 'conflict' })
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

  it('supports UDP bind/send/receive through the daemon socket adapter', async () => {
    udpServer = dgram.createSocket('udp4')
    udpServer.on('message', (message, remoteInfo) => {
      udpServer!.send(Buffer.concat([Buffer.from('udp:'), message]), remoteInfo.port, remoteInfo.address)
    })

    await new Promise<void>((resolve, reject) => {
      udpServer!.bind(0, '127.0.0.1', () => resolve())
      udpServer!.once('error', reject)
    })

    const target = udpServer.address()
    if (typeof target === 'string') {
      throw new Error('UDP test server failed to bind')
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
        factory.createUdpSocket({ bindAddr: '127.0.0.1', bindPort: 0 }),
      )

      const messagePromise = new Promise<string>((resolve) => {
        socket.onMessage((_src, data) => {
          resolve(Buffer.from(data).toString('utf8'))
        })
      })

      socket.send('127.0.0.1', target.port, new TextEncoder().encode('ping'))

      await expect(waitForWithDaemonFlush(factory, messagePromise)).resolves.toBe('udp:ping')

      socket.close()
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

async function connectAuthenticatedControlWebSocket(port: number, token: string): Promise<WebSocket> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/control`)
    ws.binaryType = 'arraybuffer'
    const timeout = setTimeout(() => {
      ws.close()
      reject(new Error('Timed out connecting control websocket'))
    }, 2000)

    ws.onopen = () => {
      ws.send(buildIoProtocolFrame(0x01, 1))
    }

    ws.onmessage = (event) => {
      const frame = new Uint8Array(event.data as ArrayBuffer)
      const opcode = frame[1]

      if (opcode === 0x02) {
        const tokenBytes = new TextEncoder().encode(token)
        const extensionIdBytes = new TextEncoder().encode('extension-id')
        const installIdBytes = new TextEncoder().encode('install-id')
        const payload = new Uint8Array(
          1 + tokenBytes.length + 1 + extensionIdBytes.length + 1 + installIdBytes.length,
        )
        let offset = 0
        payload[offset++] = 0
        payload.set(tokenBytes, offset)
        offset += tokenBytes.length
        payload[offset++] = 0
        payload.set(extensionIdBytes, offset)
        offset += extensionIdBytes.length
        payload[offset++] = 0
        payload.set(installIdBytes, offset)
        ws.send(buildIoProtocolFrame(0x03, 2, payload))
        return
      }

      if (opcode === 0x04) {
        clearTimeout(timeout)
        if (frame[8] === 0) {
          resolve(ws)
        } else {
          reject(new Error('Control auth failed'))
        }
      }
    }

    ws.onerror = () => {
      clearTimeout(timeout)
      reject(new Error('Control websocket error'))
    }
  })
}

async function sendControlJsonRequest<TPayload extends unknown>(
  ws: WebSocket,
  opcode: number,
  requestId: number,
  payload: Record<string, unknown>,
): Promise<{ opcode: number; requestId: number; payload: TPayload }> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for control response'))
    }, 2000)

    ws.onmessage = (event) => {
      const frame = new Uint8Array(event.data as ArrayBuffer)
      const responseOpcode = frame[1]
      const responseRequestId = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(
        4,
        true,
      )
      if (responseRequestId !== requestId) {
        return
      }

      clearTimeout(timeout)
      const responsePayload = JSON.parse(new TextDecoder().decode(frame.slice(8))) as TPayload
      resolve({
        opcode: responseOpcode,
        requestId: responseRequestId,
        payload: responsePayload,
      })
    }

    ws.send(buildIoProtocolFrame(opcode, requestId, new TextEncoder().encode(JSON.stringify(payload))))
  })
}
