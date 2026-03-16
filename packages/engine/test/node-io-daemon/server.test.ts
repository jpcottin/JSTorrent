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
import {
  createNodeIoDaemonCapabilities,
  NODE_IO_DAEMON_CAPABILITIES,
} from '../../src/node-io-daemon/capabilities'
import { buildIoProtocolFrame } from '../../src/node-io-daemon/io-protocol'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'
import type { NodeIoDaemonHttpStreamBridge } from '../../src/node-io-daemon/types'
import { conformanceCase } from '../helpers/conformance'
import { TEST_TLS_CERTIFICATE_PEM, TEST_TLS_PRIVATE_KEY_PEM } from './tls-fixture'

interface HttpResponseData {
  statusCode: number
  headers: http.IncomingHttpHeaders
  body: Buffer
}

interface PendingStreamWait {
  streamToken: string
  torrentId: string
  fileIndex: number
  offset: number
  length: number
  signal?: AbortSignal
  resolve: () => void
  reject: (error: Error) => void
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function createAbortError(): Error {
  if (typeof DOMException !== 'undefined') {
    return new DOMException('Aborted', 'AbortError')
  }
  const error = new Error('Aborted')
  error.name = 'AbortError'
  return error
}

class ControlledHttpStreamBridge implements NodeIoDaemonHttpStreamBridge {
  readonly openedSessions: Array<{
    streamToken: string
    torrentId: string
    fileIndex: number
  }> = []
  readonly closedSessions: Array<{
    streamToken: string
    torrentId: string
    fileIndex: number
    reason: string
  }> = []
  readonly pendingWaits: PendingStreamWait[] = []
  abortCount = 0

  openStreamSession(session: { streamToken: string; torrentId: string; fileIndex: number }): void {
    this.openedSessions.push({ ...session })
  }

  waitForRange(request: {
    streamToken: string
    torrentId: string
    fileIndex: number
    offset: number
    length: number
    signal?: AbortSignal
  }): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        request.signal?.removeEventListener('abort', abortWait)
      }
      const abortWait = () => {
        cleanup()
        this.abortCount += 1
        reject(createAbortError())
      }

      const pending: PendingStreamWait = {
        ...request,
        resolve: () => {
          cleanup()
          resolve()
        },
        reject: (error: Error) => {
          cleanup()
          reject(error)
        },
      }

      request.signal?.addEventListener('abort', abortWait, { once: true })
      if (request.signal?.aborted) {
        abortWait()
        return
      }

      this.pendingWaits.push(pending)
    })
  }

  closeStreamSession(session: {
    streamToken: string
    torrentId: string
    fileIndex: number
    reason: string
  }): void {
    this.closedSessions.push({ ...session })
  }
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

  conformanceCase(
    'node',
    'health.ok_is_reported',
    'starts a listener and serves /health',
    async () => {
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
        protocolVersion: 1,
        behaviorVersion: 1,
        capabilities: createNodeIoDaemonCapabilities(true),
      })

      await daemon.start()

      const status = daemon.getStatus()
      expect(status.started).toBe(true)
      expect(status.port).toBeGreaterThan(0)

      const response = await makeRequest(status.port, '/health')
      expect(response.statusCode).toBe(200)
      expect(response.headers['access-control-allow-origin']).toBe('*')
      expect(response.body.toString('utf8')).toBe('ok')
    },
  )

  conformanceCase(
    'node',
    'status.capabilities_are_reported',
    'serves daemon-compatible /status over POST and reports capabilities',
    async () => {
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
        protocolVersion?: number
        behaviorVersion?: number
        capabilities: { ioWebSocket: boolean }
      }
      expect(payload.port).toBe(startedStatus.port)
      expect(payload.ioPort).toBe(startedStatus.port)
      expect(payload.paired).toBe(true)
      expect(payload.tokenValid).toBe(true)
      expect(payload.capabilities.ioWebSocket).toBe(true)
      expect(payload.protocolVersion).toBe(1)
      expect(payload.behaviorVersion).toBe(1)

      const notFound = await makeRequest(startedStatus.port, '/missing')
      expect(notFound.statusCode).toBe(404)

      await daemon.stop()
      expect(daemon.getStatus()).toEqual({
        implementation: 'node-io-daemon',
        started: false,
        host: '127.0.0.1',
        port: 0,
        bootstrapMode: 'realistic',
        protocolVersion: 1,
        behaviorVersion: 1,
        capabilities: createNodeIoDaemonCapabilities(true),
      })
    },
  )

  conformanceCase(
    'node',
    'status.contract_versions_are_reported',
    'reports additive protocol and behavior versions in /status',
    async () => {
      daemon = createNodeIoDaemon({
        host: '127.0.0.1',
        port: 0,
        bootstrapMode: 'realistic',
        authToken: 'secret',
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
      const payload = JSON.parse(response.body.toString('utf8')) as {
        protocolVersion?: number
        behaviorVersion?: number
      }
      expect(payload.protocolVersion).toBe(1)
      expect(payload.behaviorVersion).toBe(1)
    },
  )

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

  conformanceCase(
    'node',
    'roots.list_is_reported',
    'serves authenticated roots from /roots',
    async () => {
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

      const roots = await fetchDaemonRoots(httpConnection)
      expect(roots).toEqual([
        { key: 'root-a', label: 'Downloads A', path: 'file:///downloads/a' },
        { key: 'root-b', label: 'Downloads B', path: 'file:///downloads/b' },
      ])
    },
  )

  conformanceCase(
    'node',
    'roots.delete_existing_root_succeeds',
    'deletes an existing root through DELETE /roots/:key',
    async () => {
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

      const deleteResponse = await makeRequest(daemon.getStatus().port, '/roots/root-a', {
        method: 'DELETE',
        headers: {
          'X-JST-Auth': 'secret',
        },
      })
      expect(deleteResponse.statusCode).toBe(200)

      const remainingRoots = await fetchDaemonRoots(httpConnection)
      expect(remainingRoots).toEqual([
        { key: 'root-b', label: 'Downloads B', path: 'file:///downloads/b' },
      ])
    },
  )

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
      expect(remainingRoots).toEqual([
        { key: 'root-b', label: 'Downloads B', path: 'file:///downloads/b' },
      ])
    } finally {
      control.close()
    }
  })

  conformanceCase(
    'node',
    'ops.delete.missing_returns_404',
    'returns 404 for a missing /ops/delete target',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-delete-missing-'))
      tempDirs.push(tempDir)

      daemon = createNodeIoDaemon({
        host: '127.0.0.1',
        port: 0,
        bootstrapMode: 'realistic',
        authToken: 'secret',
        roots: [
          {
            key: 'root-a',
            uri: pathToFileURL(tempDir).toString(),
            display_name: 'Downloads A',
            removable: true,
            last_stat_ok: true,
            last_checked: Date.now(),
          },
        ],
      })

      await daemon.start()

      const response = await makeRequest(daemon.getStatus().port, '/ops/delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-JST-Auth': 'secret',
        },
        body: JSON.stringify({
          root_key: 'root-a',
          path: 'missing-file.bin',
        }),
      })

      expect(response.statusCode).toBe(404)
      expect(response.body.toString('utf8')).toContain('File not found')
    },
  )

  conformanceCase(
    'node',
    'ops.batch_delete.ignores_missing_entries',
    'ignores missing entries during /ops/batch_delete and only reports real failures',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-batch-delete-'))
      tempDirs.push(tempDir)
      fs.mkdirSync(path.join(tempDir, 'nested'), { recursive: true })
      fs.writeFileSync(path.join(tempDir, 'nested', 'present.txt'), 'hello')

      daemon = createNodeIoDaemon({
        host: '127.0.0.1',
        port: 0,
        bootstrapMode: 'realistic',
        authToken: 'secret',
        roots: [
          {
            key: 'root-a',
            uri: pathToFileURL(tempDir).toString(),
            display_name: 'Downloads A',
            removable: true,
            last_stat_ok: true,
            last_checked: Date.now(),
          },
        ],
      })

      await daemon.start()

      const response = await makeRequest(daemon.getStatus().port, '/ops/batch_delete', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-JST-Auth': 'secret',
        },
        body: JSON.stringify({
          root_key: 'root-a',
          directory: 'nested',
          entries: ['present.txt', 'missing.txt', '../escape.txt'],
        }),
      })

      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body.toString('utf8'))).toEqual(['../escape.txt'])
      expect(fs.existsSync(path.join(tempDir, 'nested', 'present.txt'))).toBe(false)
    },
  )

  conformanceCase(
    'node',
    'control.capabilities_are_reported',
    'answers control capability requests over /control',
    async () => {
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
          protocolVersion: 1,
          behaviorVersion: 1,
          capabilities: {
            roots_manageable: true,
            lan_share_urls: true,
            free_space: true,
          },
        })
      } finally {
        ws.close()
      }
    },
  )

  conformanceCase(
    'node',
    'network.interfaces_are_reported',
    'returns a JSON array from /network/interfaces',
    async () => {
      daemon = createNodeIoDaemon({
        host: '127.0.0.1',
        port: 0,
        bootstrapMode: 'realistic',
        authToken: 'secret',
      })
      await daemon.start()

      const response = await makeRequest(daemon.getStatus().port, '/network/interfaces', {
        headers: {
          'X-JST-Auth': 'secret',
        },
      })

      expect(response.statusCode).toBe(200)
      expect(Array.isArray(JSON.parse(response.body.toString('utf8')))).toBe(true)
    },
  )

  conformanceCase(
    'node',
    'ops.exists_reports_presence',
    'returns presence information from GET /ops/exists',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-exists-'))
      tempDirs.push(tempDir)
      fs.writeFileSync(path.join(tempDir, 'present.txt'), 'hello')

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

      const presentResponse = await makeRequest(
        daemon.getStatus().port,
        '/ops/exists?root_key=root-a&path=present.txt',
        {
          headers: {
            'X-JST-Auth': 'secret',
          },
        },
      )
      expect(presentResponse.statusCode).toBe(200)
      expect(JSON.parse(presentResponse.body.toString('utf8'))).toEqual({ exists: true })

      const missingResponse = await makeRequest(
        daemon.getStatus().port,
        '/ops/exists?root_key=root-a&path=missing.txt',
        {
          headers: {
            'X-JST-Auth': 'secret',
          },
        },
      )
      expect(missingResponse.statusCode).toBe(200)
      expect(JSON.parse(missingResponse.body.toString('utf8'))).toEqual({ exists: false })
    },
  )

  conformanceCase(
    'node',
    'ops.stat_reports_metadata',
    'returns file metadata from GET /ops/stat',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-stat-'))
      tempDirs.push(tempDir)
      fs.writeFileSync(path.join(tempDir, 'present.txt'), 'hello')

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

      const response = await makeRequest(
        daemon.getStatus().port,
        '/ops/stat?root_key=root-a&path=present.txt',
        {
          headers: {
            'X-JST-Auth': 'secret',
          },
        },
      )
      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body.toString('utf8'))).toEqual({
        size: 5,
        mtime: expect.any(Number),
        is_directory: false,
        is_file: true,
      })

      const missingResponse = await makeRequest(
        daemon.getStatus().port,
        '/ops/stat?root_key=root-a&path=missing.txt',
        {
          headers: {
            'X-JST-Auth': 'secret',
          },
        },
      )
      expect(missingResponse.statusCode).toBe(404)
    },
  )

  conformanceCase(
    'node',
    'ops.list_tree_reports_file_entries',
    'returns recursive file entries from GET /ops/list_tree',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-list-tree-'))
      tempDirs.push(tempDir)
      fs.mkdirSync(path.join(tempDir, 'tree_dir', 'sub'), { recursive: true })
      fs.writeFileSync(path.join(tempDir, 'tree_dir', 'file1.txt'), 'AAAA')
      fs.writeFileSync(path.join(tempDir, 'tree_dir', 'sub', 'file2.bin'), 'BBBBBB')

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

      const response = await makeRequest(
        daemon.getStatus().port,
        '/ops/list_tree?root_key=root-a&path=tree_dir',
        {
          headers: {
            'X-JST-Auth': 'secret',
          },
        },
      )
      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body.toString('utf8'))).toEqual([
        { path: 'file1.txt', size: 4 },
        { path: 'sub/file2.bin', size: 6 },
      ])

      const missingResponse = await makeRequest(
        daemon.getStatus().port,
        '/ops/list_tree?root_key=root-a&path=missing_dir',
        {
          headers: {
            'X-JST-Auth': 'secret',
          },
        },
      )
      expect(missingResponse.statusCode).toBe(200)
      expect(JSON.parse(missingResponse.body.toString('utf8'))).toEqual([])
    },
  )

  conformanceCase(
    'node',
    'ops.list_reports_directory_entries',
    'returns direct directory entries from GET /ops/list',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-list-'))
      tempDirs.push(tempDir)
      fs.mkdirSync(path.join(tempDir, 'list_dir', 'sub'), { recursive: true })
      fs.writeFileSync(path.join(tempDir, 'list_dir', 'file1.txt'), 'AAAA')
      fs.writeFileSync(path.join(tempDir, 'list_dir', 'sub', 'file2.bin'), 'BBBBBB')

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

      const response = await makeRequest(
        daemon.getStatus().port,
        '/ops/list?root_key=root-a&path=list_dir',
        {
          headers: {
            'X-JST-Auth': 'secret',
          },
        },
      )
      expect(response.statusCode).toBe(200)
      expect(JSON.parse(response.body.toString('utf8')).sort()).toEqual(['file1.txt', 'sub'])
    },
  )

  conformanceCase(
    'node',
    'files.ensure_dir_creates_directory',
    'creates nested directories through POST /files/ensure_dir',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-ensure-dir-'))
      tempDirs.push(tempDir)

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

      const response = await makeRequest(daemon.getStatus().port, '/files/ensure_dir', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-JST-Auth': 'secret',
        },
        body: JSON.stringify({
          root_key: 'root-a',
          path: 'nested/inner',
        }),
      })
      expect(response.statusCode).toBe(200)
      expect(fs.existsSync(path.join(tempDir, 'nested', 'inner'))).toBe(true)
      expect(fs.statSync(path.join(tempDir, 'nested', 'inner')).isDirectory()).toBe(true)
    },
  )

  conformanceCase(
    'node',
    'ops.truncate_resizes_file',
    'truncates an existing file through POST /ops/truncate',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-truncate-'))
      tempDirs.push(tempDir)
      fs.writeFileSync(path.join(tempDir, 'truncate.txt'), 'hello world')

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

      const response = await makeRequest(daemon.getStatus().port, '/ops/truncate', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-JST-Auth': 'secret',
        },
        body: JSON.stringify({
          root_key: 'root-a',
          path: 'truncate.txt',
          length: 5,
        }),
      })
      expect(response.statusCode).toBe(200)
      expect(fs.readFileSync(path.join(tempDir, 'truncate.txt'), 'utf8')).toBe('hello')
      expect(fs.statSync(path.join(tempDir, 'truncate.txt')).size).toBe(5)
    },
  )

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

    const port = daemon.getStatus().port

    // Register via HTTP API (no ownerId) so media serving uses direct file reads
    // without needing a torrent engine bridge
    const registerResponse = await makeRequest(port, '/stream/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-jst-auth': 'secret',
      },
      body: JSON.stringify({
        streamToken: 'token-123',
        torrentId: 'torrent-123',
        rootKey: 'root-a',
        path: 'movie.mp4',
        fileSize: content.length,
        mimeType: 'video/mp4',
      }),
    })

    const payload = JSON.parse(registerResponse.body.toString('utf8'))
    expect(registerResponse.statusCode).toBe(200)
    expect(payload.ok).toBe(true)
    expect(typeof payload.mediaPort).toBe('number')

    const mediaPort = payload.mediaPort
    const mediaResponse = await makeRequest(mediaPort, '/stream/token-123', {
      headers: { Range: 'bytes=0-4' },
    })
    expect(mediaResponse.statusCode).toBe(206)
    expect(mediaResponse.headers['content-range']).toBe(`bytes 0-4/${content.length}`)
    expect(mediaResponse.body.toString('utf8')).toBe('hello')
  })

  it('blocks tokenized media ranges until the torrent bridge resolves the wait', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-stream-bridge-'))
    tempDirs.push(tempDir)
    const content = Buffer.from('hello world')
    fs.writeFileSync(path.join(tempDir, 'movie.mp4'), content)
    const bridge = new ControlledHttpStreamBridge()

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      httpStreamBridge: bridge,
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

    const registerResponse = await makeRequest(daemon.getStatus().port, '/stream/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-JST-Auth': 'secret',
      },
      body: JSON.stringify({
        streamToken: 'bridge-token',
        torrentId: 'torrent-123',
        fileIndex: 0,
        rootKey: 'root-a',
        path: 'movie.mp4',
        fileSize: content.length,
        mimeType: 'video/mp4',
      }),
    })
    expect(registerResponse.statusCode).toBe(200)

    const mediaPort = (JSON.parse(registerResponse.body.toString('utf8')) as { mediaPort: number })
      .mediaPort
    let settled = false
    const responsePromise = makeRequest(mediaPort, '/stream/bridge-token', {
      headers: { Range: 'bytes=0-4' },
    }).then((response) => {
      settled = true
      return response
    })

    await delay(50)
    expect(bridge.openedSessions).toEqual([
      {
        streamToken: 'bridge-token',
        torrentId: 'torrent-123',
        fileIndex: 0,
      },
    ])
    expect(bridge.pendingWaits).toHaveLength(1)
    expect(bridge.pendingWaits[0]?.offset).toBe(0)
    expect(bridge.pendingWaits[0]?.length).toBe(5)
    expect(settled).toBe(false)

    bridge.pendingWaits[0]?.resolve()

    const response = await responsePromise
    expect(response.statusCode).toBe(206)
    expect(response.headers['content-range']).toBe(`bytes 0-4/${content.length}`)
    expect(response.body.toString('utf8')).toBe('hello')
    expect(bridge.closedSessions).toHaveLength(0)
  })

  it('aborts a pending tokenized media wait when the HTTP client disconnects', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-stream-abort-'))
    tempDirs.push(tempDir)
    const content = Buffer.from('hello world')
    fs.writeFileSync(path.join(tempDir, 'movie.mp4'), content)
    const bridge = new ControlledHttpStreamBridge()

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      httpStreamBridge: bridge,
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

    const registerResponse = await makeRequest(daemon.getStatus().port, '/stream/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-JST-Auth': 'secret',
      },
      body: JSON.stringify({
        streamToken: 'abort-token',
        torrentId: 'torrent-123',
        fileIndex: 0,
        rootKey: 'root-a',
        path: 'movie.mp4',
        fileSize: content.length,
        mimeType: 'video/mp4',
      }),
    })
    const mediaPort = (JSON.parse(registerResponse.body.toString('utf8')) as { mediaPort: number })
      .mediaPort

    const req = http.request({
      host: '127.0.0.1',
      port: mediaPort,
      path: '/stream/abort-token',
      method: 'GET',
      agent: false,
      headers: {
        Connection: 'close',
        Range: 'bytes=0-4',
      },
    })
    req.end()

    await delay(50)
    expect(bridge.pendingWaits).toHaveLength(1)

    req.destroy()
    await new Promise<void>((resolve) => {
      req.once('error', () => resolve())
      setTimeout(resolve, 100)
    })

    await delay(25)
    expect(bridge.pendingWaits[0]?.signal?.aborted).toBe(true)
    expect(bridge.abortCount).toBeGreaterThanOrEqual(1)
  })

  it('supports HEAD for a bridge-backed stream without opening a range wait', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-stream-head-'))
    tempDirs.push(tempDir)
    const content = Buffer.from('hello world')
    fs.writeFileSync(path.join(tempDir, 'movie.mp4'), content)
    const bridge = new ControlledHttpStreamBridge()

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      httpStreamBridge: bridge,
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

    const registerResponse = await makeRequest(daemon.getStatus().port, '/stream/register', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-JST-Auth': 'secret',
      },
      body: JSON.stringify({
        streamToken: 'head-token',
        torrentId: 'torrent-123',
        fileIndex: 0,
        rootKey: 'root-a',
        path: 'movie.mp4',
        fileSize: content.length,
        mimeType: 'video/mp4',
      }),
    })
    const mediaPort = (JSON.parse(registerResponse.body.toString('utf8')) as { mediaPort: number })
      .mediaPort

    const response = await makeRequest(mediaPort, '/stream/head-token', {
      method: 'HEAD',
      headers: { Range: 'bytes=0-4' },
    })
    expect(response.statusCode).toBe(206)
    expect(response.headers['content-range']).toBe(`bytes 0-4/${content.length}`)
    expect(response.body.byteLength).toBe(0)
    expect(bridge.pendingWaits).toHaveLength(0)
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

  it('revokes control-owned stream tokens when the control session closes', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'node-io-daemon-stream-owner-'))
    tempDirs.push(tempDir)
    const content = Buffer.from('hello world')
    fs.writeFileSync(path.join(tempDir, 'movie.mp4'), content)
    const bridge = new ControlledHttpStreamBridge()

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      httpStreamBridge: bridge,
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

    const response = await sendControlJsonRequest<{ ok: boolean; mediaPort: number }>(
      ws,
      0xec,
      23,
      {
        streamToken: 'owned-token',
        torrentId: 'torrent-123',
        fileIndex: 0,
        rootKey: 'root-a',
        path: 'movie.mp4',
        fileSize: content.length,
        mimeType: 'video/mp4',
      },
    )
    expect(response.payload).toEqual({
      ok: true,
      mediaPort: expect.any(Number),
    })

    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve()
    })
    ws.close()
    await closed
    await delay(25)

    expect(bridge.closedSessions).toContainEqual({
      streamToken: 'owned-token',
      torrentId: 'torrent-123',
      fileIndex: 0,
      reason: 'owner-closed',
    })

    const mediaResponse = await makeRequest(response.payload.mediaPort, '/stream/owned-token', {
      headers: { Range: 'bytes=0-4' },
    })
    expect(mediaResponse.statusCode).toBe(404)
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
      udpServer!.send(
        Buffer.concat([Buffer.from('udp:'), message]),
        remoteInfo.port,
        remoteInfo.address,
      )
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

async function connectAuthenticatedControlWebSocket(
  port: number,
  token: string,
): Promise<WebSocket> {
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

async function sendControlJsonRequest<TPayload>(
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
      const responseRequestId = new DataView(
        frame.buffer,
        frame.byteOffset,
        frame.byteLength,
      ).getUint32(4, true)
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

    ws.send(
      buildIoProtocolFrame(opcode, requestId, new TextEncoder().encode(JSON.stringify(payload))),
    )
  })
}
