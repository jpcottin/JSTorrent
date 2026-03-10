import * as http from 'node:http'
import type { Duplex } from 'node:stream'
import { createPhaseFourNodeIoDaemonCapabilities } from './capabilities'
import { NodeIoDaemonIoSession } from './io-session'
import type { NodeIoDaemonConfig, NodeIoDaemonHttpStatus, NodeIoDaemonStatus } from './types'

export class NodeIoDaemonRuntime {
  private started = false
  private server: http.Server | null = null
  private boundPort: number
  private readonly ioSessions = new Set<NodeIoDaemonIoSession>()
  private readonly rawSockets = new Set<Duplex>()

  constructor(private readonly daemonConfig: NodeIoDaemonConfig) {
    this.boundPort = daemonConfig.port
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
      phase: 'phase4',
      started: this.started,
      host: this.daemonConfig.host,
      port: this.boundPort,
      bootstrapMode: this.daemonConfig.bootstrapMode,
      capabilities: createPhaseFourNodeIoDaemonCapabilities(),
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
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
      this.sendJson(res, 200, this.getHttpStatus(token))
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
        expectedAuthToken: this.daemonConfig.authToken,
        bootstrapMode: this.daemonConfig.bootstrapMode,
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

  private getHttpStatus(token: string | null): NodeIoDaemonHttpStatus {
    const paired = this.daemonConfig.authToken !== null
    let tokenValid: boolean | null = null
    if (token !== null) {
      tokenValid =
        this.daemonConfig.authToken !== null
          ? token === this.daemonConfig.authToken
          : this.daemonConfig.bootstrapMode === 'test'
    }

    return {
      port: this.boundPort,
      ioPort: this.boundPort > 0 ? this.boundPort : null,
      paired,
      extensionId: null,
      installId: null,
      version: null,
      tokenValid,
      implementation: 'node-io-daemon',
      phase: 'phase4',
      bootstrapMode: this.daemonConfig.bootstrapMode,
      capabilities: createPhaseFourNodeIoDaemonCapabilities(),
    }
  }

  private async readStatusToken(req: http.IncomingMessage): Promise<string | null> {
    const headerValue = req.headers['x-jst-auth']
    const headerToken = Array.isArray(headerValue) ? headerValue[0] : headerValue
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
