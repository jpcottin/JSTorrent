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
import * as path from 'path'
import * as fs from 'fs'

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
  })
}
