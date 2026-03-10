import * as http from 'node:http'
import type { Duplex } from 'node:stream'
import { createNodeIoDaemonCapabilities } from './capabilities'
import type { NodeIoDaemonExternalCapabilities } from './control-protocol'
import { createTestFolderPickerRoot } from './folder-picker'
import { NodeIoDaemonIoSession } from './io-session'
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
