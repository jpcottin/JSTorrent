#!/usr/bin/env tsx
/**
 * Node.js daemon-backed engine client.
 *
 * Runs a BitTorrent engine that uses an external daemon (Android companion server
 * or Rust io-daemon) for all network/disk I/O. Exposes an HTTP RPC server for
 * controlling the engine.
 *
 * Usage:
 *   pnpm tsx packages/engine/src/cmd/run-daemon-rpc.ts \
 *     --host 100.115.92.2 \
 *     --port 7800 \
 *     --token "$JST_TOKEN"
 *
 * Environment variables:
 *   JST_TOKEN - Auth token (can be used instead of --token)
 *   JST_HOST - Daemon host (default: 127.0.0.1)
 *   JST_PORT - Daemon port (default: 7800)
 *   JST_EXTENSION_ID - Extension ID for auth
 *   JST_INSTALL_ID - Install ID for auth
 *   RPC_PORT - HTTP RPC server port (default: 3000)
 */

import * as http from 'http'
import * as path from 'path'
import * as os from 'os'
import * as fs from 'fs/promises'
import { DaemonConnection } from '../adapters/daemon/daemon-connection'
import { fetchDaemonRoots, fetchDaemonStatus } from '../adapters/daemon/daemon-client'
import { createDaemonEngine } from '../presets/daemon'
import { JsonFileSessionStore } from '../adapters/node/json-file-session-store'
import { MemorySessionStore } from '../adapters/memory/memory-session-store'
import { BtEngine } from '../core/bt-engine'
import { toInfoHashString } from '../utils/infohash'
import { globalLogStore, LogLevel, LogEntry } from '../logging/logger'
import { StorageRoot } from '../storage/types'

// Parse CLI arguments
function parseArgs(): {
  host: string
  port: number
  token: string
  extensionId: string
  installId: string
  rpcPort: number
  sessionPath: string
  noSession: boolean
} {
  const args = process.argv.slice(2)
  let host = process.env.JST_HOST || '127.0.0.1'
  let port = parseInt(process.env.JST_PORT || '7800', 10)
  let token = process.env.JST_TOKEN || ''
  let extensionId = process.env.JST_EXTENSION_ID || ''
  let installId = process.env.JST_INSTALL_ID || ''
  let rpcPort = parseInt(process.env.RPC_PORT || '3000', 10)
  let sessionPath = ''
  let noSession = false

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--host':
        host = args[++i]
        break
      case '--port':
        port = parseInt(args[++i], 10)
        break
      case '--token':
        token = args[++i]
        break
      case '--extension-id':
        extensionId = args[++i]
        break
      case '--install-id':
        installId = args[++i]
        break
      case '--rpc-port':
        rpcPort = parseInt(args[++i], 10)
        break
      case '--session-path':
        sessionPath = args[++i]
        break
      case '--no-session':
        noSession = true
        break
      case '--help':
      case '-h':
        console.log(`Usage: run-daemon-rpc.ts [options]

Options:
  --host <ip>         Daemon host (default: 127.0.0.1, env: JST_HOST)
  --port <port>       Daemon port (default: 7800, env: JST_PORT)
  --token <token>     Auth token (required, env: JST_TOKEN)
  --extension-id <id> Extension ID for auth (env: JST_EXTENSION_ID)
  --install-id <id>   Install ID for auth (env: JST_INSTALL_ID)
  --rpc-port <port>   HTTP RPC server port (default: 3000, env: RPC_PORT)
  --session-path <p>  Path to session file (default: ~/.config/jstorrent-node-client/session.json)
  --no-session        Disable session persistence (stateless mode for testing)
  --help, -h          Show this help
`)
        process.exit(0)
    }
  }

  if (!token) {
    console.error('Error: --token or JST_TOKEN environment variable is required')
    process.exit(1)
  }

  // Default session path
  if (!sessionPath) {
    sessionPath = path.join(os.homedir(), '.config', 'jstorrent-node-client', 'session.json')
  }

  return {
    host,
    port,
    token,
    extensionId,
    installId,
    rpcPort,
    sessionPath,
    noSession,
  }
}

// HTTP RPC Server for daemon-backed engine
class DaemonRpcServer {
  private server: http.Server
  private engine: BtEngine | null = null
  private connection: DaemonConnection | null = null
  private actualPort = 0
  private contentRoots: StorageRoot[] = []

  constructor(private rpcPort: number) {
    this.server = http.createServer((req, res) => this.handleRequest(req, res))
  }

  setEngine(engine: BtEngine, connection: DaemonConnection, roots: StorageRoot[]) {
    this.engine = engine
    this.connection = connection
    this.contentRoots = roots
  }

  start(): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(this.rpcPort, () => {
        const addr = this.server.address()
        this.actualPort = typeof addr === 'object' && addr ? addr.port : this.rpcPort
        // Output in parseable format for test harness
        console.log(`RPC_PORT=${this.actualPort}`)
        console.log(`HTTP RPC Server listening on port ${this.actualPort}`)
        resolve(this.actualPort)
      })
    })
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse) {
    const { method, url } = req

    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS')
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

    if (method === 'OPTIONS') {
      res.writeHead(200)
      res.end()
      return
    }

    try {
      if (url === '/engine/status' && method === 'GET') {
        this.sendJson(res, this.getEngineStatus())
      } else if (url === '/engine/roots' && method === 'GET') {
        this.sendJson(res, { ok: true, roots: this.contentRoots })
      } else if (url === '/torrent/add' && method === 'POST') {
        const body = await this.readBody(req)
        const result = await this.addTorrent(body)
        this.sendJson(res, result)
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/status') && method === 'GET') {
        const id = url.split('/')[2]
        const status = this.getTorrentStatus(id)
        this.sendJson(res, status)
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/remove') && method === 'POST') {
        const id = url.split('/')[2]
        const body = await this.readBody(req)
        await this.removeTorrent(id, body.deleteData === true)
        this.sendJson(res, { ok: true })
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/add-peer') && method === 'POST') {
        const id = url.split('/')[2]
        const body = await this.readBody(req)
        await this.addPeer(id, body.ip, body.port)
        this.sendJson(res, { ok: true })
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/recheck') && method === 'POST') {
        const id = url.split('/')[2]
        await this.recheckTorrent(id)
        this.sendJson(res, { ok: true })
      } else if (url?.startsWith('/torrent/') && url?.endsWith('/peers') && method === 'GET') {
        const id = url.split('/')[2]
        const result = this.getPeerInfo(id)
        this.sendJson(res, result)
      } else if (url?.startsWith('/logs') && method === 'GET') {
        const urlObj = new URL(url, `http://localhost:${this.actualPort}`)
        const level = urlObj.searchParams.get('level') || 'info'
        const limit = parseInt(urlObj.searchParams.get('limit') || '100', 10)
        const result = this.getLogs(level, limit)
        this.sendJson(res, result)
      } else if (url === '/engine/tick-stats' && method === 'GET') {
        const result = this.getTickStats()
        this.sendJson(res, result)
      } else if (url === '/shutdown' && method === 'POST') {
        this.sendJson(res, { ok: true })
        setTimeout(async () => {
          if (this.engine) {
            await this.engine.destroy()
          }
          if (this.connection) {
            this.connection.close()
          }
          await this.stop()
          process.exit(0)
        }, 100)
      } else {
        res.writeHead(404)
        this.sendJson(res, { ok: false, error: 'Not Found' })
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      const code = message === 'EngineNotRunning' || message === 'TorrentNotFound' ? 400 : 500
      res.writeHead(code)
      this.sendJson(res, { ok: false, error: message })
    }
  }

  private getEngineStatus() {
    if (!this.engine) {
      return { ok: true, running: false }
    }

    const torrents = this.engine.torrents.map((t) => ({
      id: toInfoHashString(t.infoHash),
      state: t.progress >= 1.0 ? 'seeding' : 'downloading',
      progress: t.progress,
    }))

    return {
      ok: true,
      running: true,
      version: '1.0.0',
      port: this.engine.port,
      torrents,
      daemonConnected: this.connection?.ready ?? false,
    }
  }

  private async addTorrent(params: { type: string; data: string; storageRoot?: string }) {
    if (!this.engine) throw new Error('EngineNotRunning')

    if (params.type === 'magnet') {
      const result = await this.engine.addTorrent(params.data, {
        storageKey: params.storageRoot,
      })
      if (!result.torrent) throw new Error('Failed to add torrent')
      return { ok: true, id: toInfoHashString(result.torrent.infoHash) }
    } else if (params.type === 'file') {
      const buffer = Buffer.from(params.data, 'base64')
      const result = await this.engine.addTorrent(buffer, {
        storageKey: params.storageRoot,
      })
      if (!result.torrent) throw new Error('Failed to add torrent')
      return { ok: true, id: toInfoHashString(result.torrent.infoHash) }
    } else {
      throw new Error('Invalid torrent type')
    }
  }

  private getTorrentStatus(id: string) {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')

    return {
      ok: true,
      id,
      state: torrent.progress >= 1.0 ? 'seeding' : 'downloading',
      progress: torrent.progress,
      downloadRate: torrent.downloadSpeed,
      uploadRate: torrent.uploadSpeed,
      totalUploaded: torrent.totalUploaded,
      peers: torrent.numPeers,
    }
  }

  private async removeTorrent(id: string, deleteData = false) {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')
    if (deleteData) {
      await this.engine.removeTorrentWithData(torrent)
    } else {
      await this.engine.removeTorrent(torrent)
    }
  }

  private async addPeer(torrentId: string, ip: string, port: number) {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(torrentId)
    if (!torrent) throw new Error('TorrentNotFound')
    await torrent.connectToPeer({ ip, port })
  }

  private async recheckTorrent(id: string) {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')
    await torrent.recheckData()
  }

  private getPeerInfo(id: string) {
    if (!this.engine) throw new Error('EngineNotRunning')
    const torrent = this.engine.getTorrent(id)
    if (!torrent) throw new Error('TorrentNotFound')
    return { ok: true, peers: torrent.getPeerInfo() }
  }

  private getLogs(level: string, limit: number) {
    const levelPriority: Record<LogLevel, number> = {
      debug: 0,
      info: 1,
      warn: 2,
      error: 3,
    }
    const minPriority = levelPriority[level as LogLevel] ?? 1
    const allLogs = globalLogStore.getEntries()
    const filtered = allLogs.filter((l) => levelPriority[l.level] >= minPriority)
    const logs = filtered.slice(-limit)
    return { ok: true, logs }
  }

  private getTickStats() {
    if (!this.engine) throw new Error('EngineNotRunning')
    const stats = this.engine.getEngineStats()
    return { ok: true, ...stats }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk.toString()
      })
      req.on('end', () => {
        try {
          resolve(body ? JSON.parse(body) : {})
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', reject)
    })
  }

  private sendJson(res: http.ServerResponse, data: unknown) {
    if (!res.headersSent) {
      res.setHeader('Content-Type', 'application/json')
    }
    res.end(JSON.stringify(data))
  }
}

async function main() {
  const config = parseArgs()

  console.log(`Connecting to daemon at ${config.host}:${config.port}...`)

  // First, fetch status to discover ioPort (WebSocket port) and streamingPort (batch writes)
  let ioPort: number | undefined
  let streamingPort: number | undefined
  if (config.extensionId && config.installId) {
    try {
      console.log('Fetching daemon status...')
      const status = await fetchDaemonStatus(
        config.host,
        config.port,
        config.token,
        config.extensionId,
        config.installId,
      )
      ioPort = status.ioPort
      streamingPort = status.streamingPort
      console.log(
        `Daemon status: port=${status.port}, ioPort=${ioPort}, streamingPort=${streamingPort}, paired=${status.paired}`,
      )
    } catch (e) {
      console.warn(`Could not fetch daemon status: ${e}`)
      // Android companion server typically uses port+1 for WebSocket IO
      ioPort = config.port + 1
      console.log(`Falling back to ioPort=${ioPort} (port+1)`)
    }
  } else {
    // Without extension credentials, assume port+1 for ioPort
    ioPort = config.port + 1
    console.log(`Using default ioPort=${ioPort} (port+1)`)
  }

  // Create daemon connection with credentials
  const connection = new DaemonConnection(
    config.port,
    config.host,
    config.extensionId && config.installId
      ? async () => ({
          token: config.token,
          extensionId: config.extensionId,
          installId: config.installId,
        })
      : undefined,
    config.extensionId && config.installId ? undefined : config.token,
    ioPort, // Use separate WebSocket port if available
    streamingPort, // Use streaming server for batch writes if available
  )

  // Connect WebSocket
  await connection.connectWebSocket()
  console.log(`WebSocket connected${ioPort ? ` on ioPort ${ioPort}` : ''}`)

  // Fetch storage roots from daemon
  const roots = await fetchDaemonRoots(connection)
  console.log(`Fetched ${roots.length} storage roots:`)
  for (const root of roots) {
    console.log(`  - ${root.label} (${root.key})`)
  }

  if (roots.length === 0) {
    console.error('No storage roots available from daemon')
    process.exit(1)
  }

  // Create session store (memory-only if --no-session)
  let sessionStore
  if (config.noSession) {
    console.log('Session persistence disabled (--no-session)')
    sessionStore = new MemorySessionStore()
  } else {
    await fs.mkdir(path.dirname(config.sessionPath), { recursive: true })
    sessionStore = new JsonFileSessionStore(config.sessionPath)
  }

  // Create engine with daemon connection
  const engine = await createDaemonEngine({
    connection,
    contentRoots: roots,
    defaultContentRoot: roots[0].key,
    sessionStore,
    onLog: (entry: LogEntry) => {
      const ts = new Date(entry.timestamp).toISOString().slice(11, 23)
      console.log(`[${ts}] [${entry.level.toUpperCase()}] ${entry.message}`)
    },
  })

  console.log(`Engine created, listening on port ${engine.port}`)

  // Create and start RPC server
  const server = new DaemonRpcServer(config.rpcPort)
  server.setEngine(engine, connection, roots)
  await server.start()

  // Handle signals
  const cleanup = async () => {
    console.log('Shutting down...')
    await engine.destroy()
    connection.close()
    await server.stop()
    process.exit(0)
  }

  process.on('SIGINT', cleanup)
  process.on('SIGTERM', cleanup)
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
