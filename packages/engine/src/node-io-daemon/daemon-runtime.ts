import * as http from 'node:http'
import type { Duplex } from 'node:stream'
import { createNodeIoDaemonCapabilities } from './capabilities'
import type { NodeIoDaemonExternalCapabilities } from './control-protocol'
import { createTestFolderPickerRoot } from './folder-picker'
import { NodeIoDaemonIoSession } from './io-session'
import {
  NodeIoDaemonHashMismatchError,
  NodeIoDaemonRootFileSystem,
} from './root-filesystem'
import type { NodeIoDaemonConfig, NodeIoDaemonHttpStatus, NodeIoDaemonStatus } from './types'
import { NodeIoDaemonRootStore } from './root-store'

export class NodeIoDaemonRuntime {
  private started = false
  private server: http.Server | null = null
  private boundPort: number
  private readonly ioSessions = new Set<NodeIoDaemonIoSession>()
  private readonly rawSockets = new Set<Duplex>()
  private readonly rootStore: NodeIoDaemonRootStore
  private pairedToken: string | null
  private pairedExtensionId: string | null = null
  private pairedInstallId: string | null = null
  private nextPickedRootId = 1

  constructor(private readonly daemonConfig: NodeIoDaemonConfig) {
    this.boundPort = daemonConfig.port
    this.rootStore = new NodeIoDaemonRootStore(daemonConfig.roots)
    this.pairedToken = daemonConfig.authToken
    this.rootStore.onChange((roots) => {
      this.broadcastRootsChanged(roots)
    })
  }

  get config(): Readonly<NodeIoDaemonConfig> {
    return this.daemonConfig
  }

  async start(): Promise<void> {
    if (this.started) {
      return
    }

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res)
    })
    server.on('connection', (socket) => {
      this.rawSockets.add(socket)
      socket.on('close', () => {
        this.rawSockets.delete(socket)
      })
    })
    server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head))

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.daemonConfig.port, this.daemonConfig.host, () => {
        server.off('error', reject)
        const address = server.address()
        this.boundPort =
          typeof address === 'object' && address && typeof address.port === 'number'
            ? address.port
            : this.daemonConfig.port
        resolve()
      })
    })

    this.server = server
    this.started = true
  }

  async stop(): Promise<void> {
    for (const session of this.ioSessions) {
      session.destroy()
    }
    this.ioSessions.clear()

    for (const socket of this.rawSockets) {
      socket.destroy()
    }
    this.rawSockets.clear()

    if (!this.server) {
      this.started = false
      this.boundPort = this.daemonConfig.port
      return
    }

    const server = this.server
    this.server = null
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error)
        } else {
          resolve()
        }
      })
    })

    this.started = false
    this.boundPort = this.daemonConfig.port
  }

  getStatus(): NodeIoDaemonStatus {
    return {
      implementation: 'node-io-daemon',
      started: this.started,
      host: this.daemonConfig.host,
      port: this.boundPort,
      bootstrapMode: this.daemonConfig.bootstrapMode,
      capabilities: createNodeIoDaemonCapabilities(),
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Content-Type, X-JST-Auth, X-JST-ExtensionId, X-JST-InstallId, Origin',
    )

    if (req.method === 'OPTIONS') {
      res.statusCode = 200
      res.end()
      return
    }

    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (req.method === 'GET' && pathname === '/health') {
      this.sendText(res, 200, 'ok')
      return
    }

    if ((req.method === 'GET' || req.method === 'POST') && pathname === '/status') {
      const token = await this.readStatusToken(req)
      this.sendJson(res, 200, this.getHttpStatus(req, token))
      return
    }

    if (pathname === '/pair' && req.method === 'POST') {
      const body = await this.readJsonBody(req)
      const token = body && typeof body === 'object' ? (body as Record<string, unknown>).token : null
      if (typeof token !== 'string' || token.length === 0) {
        this.sendText(res, 400, 'Missing token')
        return
      }

      const pairResult = this.handlePairRequest(req, token)
      if (pairResult === 'conflict') {
        this.sendJson(res, 409, { status: 'conflict' })
        return
      }

      this.sendJson(res, 200, { status: pairResult })
      return
    }

    if (pathname === '/roots' && req.method === 'GET') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      this.sendJson(res, 200, { roots: this.rootStore.list() })
      return
    }

    if (pathname.startsWith('/roots/') && req.method === 'DELETE') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      const key = decodeURIComponent(pathname.slice('/roots/'.length))
      if (!key) {
        this.sendText(res, 400, 'Missing root key')
        return
      }

      if (!this.rootStore.delete(key)) {
        this.sendText(res, 404, 'Not Found')
        return
      }

      this.sendJson(res, 200, { ok: true })
      return
    }

    if (pathname.startsWith('/read/') && req.method === 'GET') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      const fileSystem = this.getRootFileSystem(pathname.slice('/read/'.length))
      if (!fileSystem) {
        this.sendText(res, 404, 'Unknown root')
        return
      }

      const relativePath = this.readPathHeader(req)
      if (relativePath === null) {
        this.sendText(res, 400, 'Missing X-Path-Base64')
        return
      }

      const offset = this.readIntegerHeader(req, 'x-offset')
      const length = this.readIntegerHeader(req, 'x-length')
      if (offset === null || length === null || offset < 0 || length < 0) {
        this.sendText(res, 400, 'Invalid read range')
        return
      }

      try {
        const bytes = await fileSystem.read(relativePath, offset, length)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Length', String(bytes.byteLength))
        res.end(Buffer.from(bytes))
      } catch (error) {
        this.sendText(res, 500, error instanceof Error ? error.message : String(error))
      }
      return
    }

    if (pathname.startsWith('/write/') && req.method === 'POST') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      const fileSystem = this.getRootFileSystem(pathname.slice('/write/'.length))
      if (!fileSystem) {
        this.sendText(res, 404, 'Unknown root')
        return
      }

      const relativePath = this.readPathHeader(req)
      if (relativePath === null) {
        this.sendText(res, 400, 'Missing X-Path-Base64')
        return
      }

      const offset = this.readIntegerHeader(req, 'x-offset')
      if (offset === null || offset < 0) {
        this.sendText(res, 400, 'Invalid X-Offset')
        return
      }

      const expectedSha1 = this.readFirstHeader(req, 'x-expected-sha1')
      const body = await this.readBinaryBody(req)

      try {
        await fileSystem.write(relativePath, offset, body, expectedSha1)
        this.sendText(res, 200, 'ok')
      } catch (error) {
        if (error instanceof NodeIoDaemonHashMismatchError) {
          this.sendText(res, 409, error.message)
          return
        }
        this.sendText(res, 500, error instanceof Error ? error.message : String(error))
      }
      return
    }

    if (pathname.startsWith('/write-batch/') && req.method === 'POST') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      const fileSystem = this.getRootFileSystem(pathname.slice('/write-batch/'.length))
      if (!fileSystem) {
        this.sendText(res, 404, 'Unknown root')
        return
      }

      try {
        const writes = this.parseWriteBatchPayload(await this.readBinaryBody(req))
        await fileSystem.writeBatch(writes)
        this.sendText(res, 200, 'ok')
      } catch (error) {
        if (error instanceof NodeIoDaemonHashMismatchError) {
          this.sendText(res, 409, error.message)
          return
        }
        this.sendText(res, 500, error instanceof Error ? error.message : String(error))
      }
      return
    }

    if (pathname === '/ops/exists' && req.method === 'GET') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      const fileSystem = this.getRootFileSystemFromRequest(req)
      const relativePath = this.readQueryPath(req)
      if (!fileSystem || relativePath === null) {
        this.sendText(res, 400, 'Missing root_key or path')
        return
      }

      this.sendJson(res, 200, { exists: await fileSystem.exists(relativePath) })
      return
    }

    if (pathname === '/ops/stat' && req.method === 'GET') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      const fileSystem = this.getRootFileSystemFromRequest(req)
      const relativePath = this.readQueryPath(req)
      if (!fileSystem || relativePath === null) {
        this.sendText(res, 400, 'Missing root_key or path')
        return
      }

      try {
        this.sendJson(res, 200, await fileSystem.stat(relativePath))
      } catch (error) {
        this.sendText(res, 404, error instanceof Error ? error.message : String(error))
      }
      return
    }

    if (pathname === '/files/ensure_dir' && req.method === 'POST') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      const body = await this.readJsonBody(req)
      const rootKey = body && typeof body === 'object' ? (body as Record<string, unknown>).root_key : null
      const relativePath = body && typeof body === 'object' ? (body as Record<string, unknown>).path : null
      if (typeof rootKey !== 'string' || typeof relativePath !== 'string') {
        this.sendText(res, 400, 'Missing root_key or path')
        return
      }

      const fileSystem = this.getRootFileSystem(rootKey)
      if (!fileSystem) {
        this.sendText(res, 404, 'Unknown root')
        return
      }

      await fileSystem.ensureDir(relativePath)
      this.sendJson(res, 200, { ok: true })
      return
    }

    if (pathname === '/ops/truncate' && req.method === 'POST') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      const body = await this.readJsonBody(req)
      const rootKey = body && typeof body === 'object' ? (body as Record<string, unknown>).root_key : null
      const relativePath = body && typeof body === 'object' ? (body as Record<string, unknown>).path : null
      const length = body && typeof body === 'object' ? (body as Record<string, unknown>).length : null
      if (typeof rootKey !== 'string' || typeof relativePath !== 'string' || typeof length !== 'number') {
        this.sendText(res, 400, 'Missing root_key, path, or length')
        return
      }

      const fileSystem = this.getRootFileSystem(rootKey)
      if (!fileSystem) {
        this.sendText(res, 404, 'Unknown root')
        return
      }

      await fileSystem.truncate(relativePath, length)
      this.sendJson(res, 200, { ok: true })
      return
    }

    if (pathname === '/ops/delete' && req.method === 'POST') {
      if (!this.isHttpAuthAccepted(this.readAuthToken(req))) {
        this.sendText(res, 401, 'Unauthorized')
        return
      }

      const body = await this.readJsonBody(req)
      const rootKey = body && typeof body === 'object' ? (body as Record<string, unknown>).root_key : null
      const relativePath = body && typeof body === 'object' ? (body as Record<string, unknown>).path : null
      if (typeof rootKey !== 'string' || typeof relativePath !== 'string') {
        this.sendText(res, 400, 'Missing root_key or path')
        return
      }

      const fileSystem = this.getRootFileSystem(rootKey)
      if (!fileSystem) {
        this.sendText(res, 404, 'Unknown root')
        return
      }

      await fileSystem.delete(relativePath)
      this.sendJson(res, 200, { ok: true })
      return
    }

    this.sendText(res, 404, 'Not Found')
  }

  private handleUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
    if (pathname !== '/io' && pathname !== '/control') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n')
      return
    }

    let session: NodeIoDaemonIoSession | null = null
    session = NodeIoDaemonIoSession.upgrade(
      { headers: req.headers },
      {
        path: pathname as '/io' | '/control',
        socket,
        getExpectedAuthToken: () => this.pairedToken,
        bootstrapMode: this.daemonConfig.bootstrapMode,
        getExternalCapabilities: () => this.getExternalCapabilities(),
        handleFolderPickerRequest: () => this.handleFolderPickerRequest(),
        onClose: () => {
          if (session) {
            this.ioSessions.delete(session)
          }
        },
      },
    )

    if (!session) {
      return
    }

    this.ioSessions.add(session)
    session.receiveHead(head)
  }

  private getHttpStatus(req: http.IncomingMessage, token: string | null): NodeIoDaemonHttpStatus {
    const paired = this.pairedToken !== null
    let tokenValid: boolean | null = null
    if (token !== null) {
      tokenValid =
        this.pairedToken !== null
          ? token === this.pairedToken
          : this.daemonConfig.bootstrapMode === 'test'
    }

    const extensionId = this.readFirstHeader(req, 'x-jst-extensionid')
    const installId = this.readFirstHeader(req, 'x-jst-installid')

    return {
      port: this.boundPort,
      ioPort: this.boundPort > 0 ? this.boundPort : null,
      paired,
      extensionId:
        paired && this.isPairedForClient(extensionId, installId) ? this.pairedExtensionId : null,
      installId:
        paired && this.isPairedForClient(extensionId, installId) ? this.pairedInstallId : null,
      version: null,
      tokenValid,
      implementation: 'node-io-daemon',
      bootstrapMode: this.daemonConfig.bootstrapMode,
      capabilities: createNodeIoDaemonCapabilities(),
    }
  }

  private async readStatusToken(req: http.IncomingMessage): Promise<string | null> {
    const headerToken = this.readAuthToken(req)
    if (headerToken) {
      return headerToken
    }

    if (req.method !== 'POST') {
      return null
    }

    const body = await this.readJsonBody(req)
    if (!body || typeof body !== 'object') {
      return null
    }

    const token = (body as Record<string, unknown>).token
    return typeof token === 'string' ? token : null
  }

  private readAuthToken(req: http.IncomingMessage): string | null {
    return this.readFirstHeader(req, 'x-jst-auth')
  }

  private readPathHeader(req: http.IncomingMessage): string | null {
    const value = this.readFirstHeader(req, 'x-path-base64')
    if (!value) {
      return null
    }

    try {
      return Buffer.from(value, 'base64').toString('utf8')
    } catch {
      return null
    }
  }

  private readIntegerHeader(req: http.IncomingMessage, name: string): number | null {
    const value = this.readFirstHeader(req, name)
    if (value === null) {
      return null
    }
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : null
  }

  private isHttpAuthAccepted(token: string | null): boolean {
    if (this.pairedToken !== null) {
      return token === this.pairedToken
    }

    return this.daemonConfig.bootstrapMode === 'test'
  }

  private getExternalCapabilities(): NodeIoDaemonExternalCapabilities {
    return {
      roots_manageable: true,
      lan_share_urls: false,
    }
  }

  private async handleFolderPickerRequest(): Promise<{
    ok: boolean
    error?: string
    root?: ReturnType<NodeIoDaemonRootStore['list']>[number]
  }> {
    const picker = this.daemonConfig.folderPicker
    const root =
      picker !== null
        ? await picker()
        : this.daemonConfig.bootstrapMode === 'test'
          ? await createTestFolderPickerRoot(this.nextPickedRootId++)
          : null

    if (!root) {
      return { ok: false, error: 'Folder picker not implemented' }
    }

    this.rootStore.add(root)
    return { ok: true, root }
  }

  private broadcastRootsChanged(roots: ReturnType<NodeIoDaemonRootStore['list']>): void {
    for (const session of this.ioSessions) {
      session.sendControlRootsChanged(roots)
    }
  }

  private handlePairRequest(
    req: http.IncomingMessage,
    token: string,
  ): 'approved' | 'pending' | 'conflict' {
    const extensionId = this.readFirstHeader(req, 'x-jst-extensionid')
    const installId = this.readFirstHeader(req, 'x-jst-installid')
    if (!extensionId || !installId) {
      return 'pending'
    }

    if (
      this.pairedToken !== null &&
      !this.isPairedForClient(extensionId, installId) &&
      (this.pairedExtensionId !== null || this.pairedInstallId !== null)
    ) {
      return 'conflict'
    }

    this.pairedToken = token
    this.pairedExtensionId = extensionId
    this.pairedInstallId = installId
    return 'approved'
  }

  private isPairedForClient(extensionId: string | null, installId: string | null): boolean {
    return (
      extensionId !== null &&
      installId !== null &&
      extensionId === this.pairedExtensionId &&
      installId === this.pairedInstallId
    )
  }

  private readFirstHeader(req: http.IncomingMessage, name: string): string | null {
    const value = req.headers[name]
    if (Array.isArray(value)) {
      return value[0] ?? null
    }
    return value ?? null
  }

  private getRootFileSystem(rootKey: string): NodeIoDaemonRootFileSystem | null {
    const root = this.rootStore.get(rootKey)
    if (!root) {
      return null
    }
    return new NodeIoDaemonRootFileSystem(root.uri)
  }

  private getRootFileSystemFromRequest(req: http.IncomingMessage): NodeIoDaemonRootFileSystem | null {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const rootKey = url.searchParams.get('root_key')
    if (!rootKey) {
      return null
    }
    return this.getRootFileSystem(rootKey)
  }

  private readQueryPath(req: http.IncomingMessage): string | null {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    return url.searchParams.get('path')
  }

  private async readBinaryBody(req: http.IncomingMessage): Promise<Uint8Array> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk))
    }
    return new Uint8Array(Buffer.concat(chunks))
  }

  private parseWriteBatchPayload(payload: Uint8Array): Array<{
    path: string
    position: number
    data: Uint8Array
    expectedHashHex: string
  }> {
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    const decoder = new TextDecoder()
    let offset = 0
    const count = view.getUint32(offset, true)
    offset += 4

    const writes: Array<{
      path: string
      position: number
      data: Uint8Array
      expectedHashHex: string
    }> = []

    for (let index = 0; index < count; index += 1) {
      const rootKeyLength = payload[offset]
      offset += 1 + rootKeyLength

      const pathLength = view.getUint16(offset, true)
      offset += 2
      const relativePath = decoder.decode(payload.subarray(offset, offset + pathLength))
      offset += pathLength

      const lowPosition = view.getUint32(offset, true)
      const highPosition = view.getUint32(offset + 4, true)
      const position = highPosition * 0x100000000 + lowPosition
      offset += 8

      const dataLength = view.getUint32(offset, true)
      offset += 4
      const data = payload.slice(offset, offset + dataLength)
      offset += dataLength

      const expectedHashHex = decoder.decode(payload.subarray(offset, offset + 40))
      offset += 40

      const callbackIdLength = payload[offset]
      offset += 1 + callbackIdLength

      writes.push({
        path: relativePath,
        position,
        data,
        expectedHashHex,
      })
    }

    return writes
  }

  private async readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.from(chunk))
    }

    if (chunks.length === 0) {
      return null
    }

    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      return null
    }
  }

  private sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
    const text = JSON.stringify(body)
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Length', String(Buffer.byteLength(text)))
    res.end(text)
  }

  private sendText(res: http.ServerResponse, statusCode: number, body: string): void {
    res.statusCode = statusCode
    res.setHeader('Content-Type', 'text/plain; charset=utf-8')
    res.setHeader('Content-Length', String(Buffer.byteLength(body)))
    res.end(body)
  }
}
