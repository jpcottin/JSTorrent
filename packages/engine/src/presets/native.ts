/**
 * Native Engine Preset
 *
 * Factory function to create a BtEngine configured for QuickJS/JSC runtimes.
 */

import { BtEngine } from '../core/bt-engine'
import { NativeSocketFactory } from '../adapters/native/native-socket-factory'
import { NativeFileSystem } from '../adapters/native/native-filesystem'
import { NullFileSystem } from '../adapters/null/null-filesystem'
import { NativeSessionStore } from '../adapters/native/native-session-store'
import { MemorySessionStore } from '../adapters/memory/memory-session-store'
import { NativeHasher } from '../adapters/native/native-hasher'
import {
  flushBatchedWrites,
  getGlobalBatchingQueue,
} from '../adapters/native/native-batching-disk-queue'
import { flushPendingReads } from '../adapters/native/native-async-read'
import { flushPendingWrites } from '../adapters/native/native-async-write'
import { NativeFileHandle } from '../adapters/native/native-file-handle'
import { StorageRootManager, StorageRoot } from '../storage/storage-root-manager'
import { Socks5SocketFactory } from '../proxy'
import type { ISocketFactory } from '../interfaces/socket'
import type { NetworkInterface, GatewayInfo } from '../interfaces/network'
import type { LogEntry } from '../logging/logger'
import type { ConfigHub } from '../config/config-hub'

// Enable async reads and writes on Android/iOS — disk I/O dispatches to
// native I/O threads instead of blocking the JS thread.
NativeFileHandle.useAsyncReads = true
NativeFileHandle.useAsyncWrites = true

// Verified-write queue pressure budget for Android/QuickJS.
// Keep this aligned with the conservative active-piece byte budget so
// large-piece torrents stop requesting before write backlog runs away.
const WRITE_QUEUE_HIGH_WATER = 32 * 1024 * 1024
const WRITE_QUEUE_LOW_WATER = 16 * 1024 * 1024

/**
 * Get network interfaces from the native layer.
 * Returns parsed array of NetworkInterface objects.
 */
async function getNetworkInterfaces(): Promise<NetworkInterface[]> {
  if (typeof __jstorrent_get_network_interfaces !== 'function') {
    return []
  }
  try {
    const json = __jstorrent_get_network_interfaces()
    return JSON.parse(json) as NetworkInterface[]
  } catch {
    return []
  }
}

/**
 * Get the default gateway IP from the native layer.
 * Used for NAT-PMP/PCP port mapping.
 */
async function getDefaultGateway(): Promise<GatewayInfo | null> {
  if (typeof __jstorrent_get_default_gateway !== 'function') {
    return null
  }
  try {
    const json = __jstorrent_get_default_gateway()
    return JSON.parse(json) as GatewayInfo | null
  } catch {
    return null
  }
}

export interface NativeEngineConfig {
  /**
   * Content roots for storing downloaded files.
   * Each root has a unique key used by the native filesystem.
   */
  contentRoots: StorageRoot[]

  /**
   * Default content root key for new torrents.
   */
  defaultContentRoot?: string

  /**
   * Listening port to announce to trackers/peers.
   */
  port?: number

  /**
   * Callback for log entries.
   */
  onLog?: (entry: LogEntry) => void

  /**
   * Start the engine in suspended state (no network activity).
   * Use this when you need to restore session before starting networking.
   * Call engine.resume() after setup/restore is complete.
   */
  startSuspended?: boolean

  /**
   * Storage mode: 'native' uses NativeFileSystem, 'null' discards all writes.
   * Use 'null' for performance testing without I/O overhead.
   * Default: 'native'
   */
  storageMode?: 'native' | 'null'

  /**
   * Optional ConfigHub for reactive configuration.
   */
  config?: ConfigHub
}

/**
 * Create a BtEngine configured for native (QuickJS/JSC) runtime.
 */
export function createNativeEngine(config: NativeEngineConfig): BtEngine {
  const storageRootManager = new StorageRootManager((root) => {
    if (config.storageMode === 'null') {
      return new NullFileSystem()
    }
    return new NativeFileSystem(root.key)
  })

  // In null mode, add a synthetic root so the engine has a valid storage target
  // (all writes will be discarded by NullFileSystem anyway)
  if (config.storageMode === 'null') {
    const nullRoot = { key: '__null__', label: 'Null Storage', path: '/dev/null' }
    storageRootManager.addRoot(nullRoot)
    storageRootManager.setDefaultRoot('__null__')
  }

  for (const root of config.contentRoots) {
    storageRootManager.addRoot(root)
  }

  if (config.defaultContentRoot) {
    storageRootManager.setDefaultRoot(config.defaultContentRoot)
  }

  // Create socket factory, optionally wrapped with SOCKS5 proxy
  let socketFactory: ISocketFactory = new NativeSocketFactory()
  if (config.config) {
    const proxyEnabled = config.config.proxyEnabled.get()
    const proxyHost = config.config.proxyHost.get()
    const proxyPort = config.config.proxyPort.get()

    if (proxyEnabled && proxyHost) {
      socketFactory = new Socks5SocketFactory(socketFactory, {
        host: proxyHost,
        port: proxyPort,
        username: config.config.proxyUsername.get() ?? undefined,
        password: config.config.proxyPassword.get() ?? undefined,
      })
    }
  }

  return new BtEngine({
    socketFactory,
    storageRootManager,
    sessionStore:
      config.storageMode === 'null' ? new MemorySessionStore() : new NativeSessionStore(),
    hasher: new NativeHasher(),
    port: config.port,
    onLog: config.onLog,
    startSuspended: config.startSuspended,
    config: config.config,
    getNetworkInterfaces,
    getDefaultGateway,
    onEndOfTick: () => {
      flushBatchedWrites()
      flushPendingWrites()
      flushPendingReads()
    },
    getWriteQueueStats: () => getGlobalBatchingQueue().getPressureStats(),
    writeQueueBackpressureHighWater: WRITE_QUEUE_HIGH_WATER,
    writeQueueBackpressureLowWater: WRITE_QUEUE_LOW_WATER,
    usePassthroughDiskQueue: true,
  })
}
