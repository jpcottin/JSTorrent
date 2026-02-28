import { BtEngine, BtEngineOptions } from '../core/bt-engine'
import {
  NodeSocketFactory,
  ScopedNodeFileSystem,
  JsonFileSessionStore,
  NodeHasher,
} from '../adapters/node'
import { StorageRootManager } from '../storage/storage-root-manager'
import { Socks5SocketFactory } from '../proxy'
import type { ISocketFactory } from '../interfaces/socket'
import { ISessionStore } from '../interfaces/session-store'
import { LogEntry } from '../logging/logger'
import type { NetworkInterface, GatewayInfo } from '../interfaces/network'
import * as path from 'path'
import * as fs from 'fs'
import { exec } from 'child_process'
import * as os from 'os'

function getNetworkInterfaces(): Promise<NetworkInterface[]> {
  const ifaces = os.networkInterfaces()
  const result: NetworkInterface[] = []
  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue
    for (const addr of addrs) {
      if (addr.family === 'IPv4' && !addr.internal) {
        result.push({ name, address: addr.address, prefixLength: addr.cidr ? parseInt(addr.cidr.split('/')[1]) : 24 })
      }
    }
  }
  return Promise.resolve(result)
}

function execCommand(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 5000 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

async function getDefaultGateway(): Promise<GatewayInfo | null> {
  try {
    const platform = os.platform()
    if (platform === 'darwin') {
      const output = await execCommand('route -n get default')
      const match = output.match(/gateway:\s+(\S+)/)
      if (match) {
        const ifaceMatch = output.match(/interface:\s+(\S+)/)
        return { ip: match[1], interfaceName: ifaceMatch?.[1] }
      }
    } else if (platform === 'linux') {
      const output = await execCommand('ip route show default')
      const match = output.match(/default via (\S+) dev (\S+)/)
      if (match) {
        return { ip: match[1], interfaceName: match[2] }
      }
    } else if (platform === 'win32') {
      // PowerShell is more reliable than ipconfig for parsing
      const output = await execCommand(
        'powershell -Command "(Get-NetRoute -DestinationPrefix 0.0.0.0/0 | Select-Object -First 1).NextHop"',
      )
      const ip = output.trim()
      if (ip && /^\d+\.\d+\.\d+\.\d+$/.test(ip)) {
        return { ip }
      }
    }
  } catch {
    // Command failed — gateway detection unavailable
  }
  return null
}

export interface NodeEngineConfig extends Partial<BtEngineOptions> {
  downloadPath: string
  sessionStore?: ISessionStore
  port?: number
  onLog?: (entry: LogEntry) => void
}

export function createNodeEngine(config: NodeEngineConfig): BtEngine {
  // Use file-based session store by default, located in the download directory
  const sessionStorePath = path.join(config.downloadPath, '.jstorrent-session.json')
  const sessionStore = config.sessionStore ?? new JsonFileSessionStore(sessionStorePath)

  const storageRootManager = new StorageRootManager((root) => {
    return new ScopedNodeFileSystem(root.path)
  })

  // Register downloadPath as default root
  let diskId: string | undefined
  try {
    diskId = String(fs.statSync(config.downloadPath).dev)
  } catch {
    // Path may not exist yet — diskId will be populated later
  }
  storageRootManager.addRoot({
    key: config.downloadPath,
    label: 'Downloads',
    path: config.downloadPath,
    diskId,
  })
  storageRootManager.setDefaultRoot(config.downloadPath)

  // Create socket factory, optionally wrapped with SOCKS5 proxy
  let socketFactory: ISocketFactory = new NodeSocketFactory()
  if (config.config) {
    const proxyEnabled = config.config.proxyEnabled.get()
    const proxyHost = config.config.proxyHost.get()
    const proxyPort = config.config.proxyPort.get()

    if (proxyEnabled && proxyHost) {
      socketFactory = new Socks5SocketFactory(
        socketFactory,
        {
          host: proxyHost,
          port: proxyPort,
          username: config.config.proxyUsername.get() ?? undefined,
          password: config.config.proxyPassword.get() ?? undefined,
        },
        {
          proxyHttpTrackers: config.config.proxyHttpTrackers.get(),
          proxyUdpTrackers: config.config.proxyUdpTrackers.get(),
          proxyPeerConnections: config.config.proxyPeerConnections.get(),
        },
      )
    }
  }

  return new BtEngine({
    socketFactory,
    storageRootManager,
    sessionStore,
    hasher: new NodeHasher(),
    ...config, // Pass through other options like maxConnections, peerId, etc.
    port: config.port,
    onLog: config.onLog,
    getNetworkInterfaces,
    getDefaultGateway,
  })
}
