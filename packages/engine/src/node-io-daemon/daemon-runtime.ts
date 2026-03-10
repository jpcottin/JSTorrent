import * as http from 'node:http'
import { createPhaseOneNodeIoDaemonCapabilities } from './capabilities'
import type { NodeIoDaemonConfig, NodeIoDaemonStatus } from './types'

export class NodeIoDaemonRuntime {
  private started = false
  private server: http.Server | null = null
  private boundPort: number

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

    const server = http.createServer((req, res) => this.handleRequest(req, res))

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
      phase: 'phase1',
      started: this.started,
      host: this.daemonConfig.host,
      port: this.boundPort,
      bootstrapMode: this.daemonConfig.bootstrapMode,
      capabilities: createPhaseOneNodeIoDaemonCapabilities(),
    }
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

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

    if (req.method === 'GET' && pathname === '/status') {
      this.sendJson(res, 200, this.getStatus())
      return
    }

    this.sendText(res, 404, 'Not Found')
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
