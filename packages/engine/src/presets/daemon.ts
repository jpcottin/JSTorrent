import { BtEngine } from '../core/bt-engine'
import { DaemonConnection } from '../adapters/daemon/daemon-connection'
import { DaemonFileSystem } from '../adapters/daemon/daemon-filesystem'
import { DaemonSocketFactory } from '../adapters/daemon/daemon-socket-factory'
import { StorageRootManager, StorageRoot } from '../storage/storage-root-manager'
import { ISessionStore } from '../interfaces/session-store'
import { LogEntry } from '../logging/logger'
import type { ConfigHub } from '../config/config-hub'

export interface DaemonEngineConfig {
  /**
   * Daemon connection parameters. Required if `connection` is not provided.
   */
  daemon?: {
    port: number
    authToken: string
    host?: string
  }
  /**
   * Pre-connected DaemonConnection. If provided, `daemon` is ignored.
   */
  connection?: DaemonConnection
  contentRoots: StorageRoot[]
  defaultContentRoot?: string
  sessionStore: ISessionStore
  onLog?: (entry: LogEntry) => void
  port?: number
  /**
   * Optional ConfigHub for reactive configuration.
   */
  config?: ConfigHub
  /**
   * If true, writes are discarded (not sent to daemon).
   * Use for benchmarking to isolate disk I/O bottlenecks.
   */
  nullStorage?: boolean
}

export async function createDaemonEngine(config: DaemonEngineConfig): Promise<BtEngine> {
  let connection: DaemonConnection

  if (config.connection) {
    // Use pre-connected connection
    connection = config.connection
    if (!connection.ready) {
      await connection.connectWebSocket()
    }
  } else if (config.daemon) {
    // Create new connection from parameters
    const host = config.daemon.host ?? '127.0.0.1'
    connection = await DaemonConnection.connect(config.daemon.port, config.daemon.authToken, host)
    await connection.connectWebSocket()
  } else {
    throw new Error('Either daemon or connection must be provided')
  }

  const storageRootManager = new StorageRootManager((root) => {
    return new DaemonFileSystem(connection, root.key, config.nullStorage ?? false)
  })

  for (const root of config.contentRoots) {
    storageRootManager.addRoot(root)
  }

  if (config.defaultContentRoot) {
    storageRootManager.setDefaultRoot(config.defaultContentRoot)
  }

  return new BtEngine({
    socketFactory: new DaemonSocketFactory(connection),
    storageRootManager,
    sessionStore: config.sessionStore,
    port: config.port,
    onLog: config.onLog,
    config: config.config,
  })
}
