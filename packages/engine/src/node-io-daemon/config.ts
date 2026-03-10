import type { NodeIoDaemonConfig } from './types'

export interface PartialNodeIoDaemonConfig {
  host?: string
  port?: number
  bootstrapMode?: NodeIoDaemonConfig['bootstrapMode']
  authToken?: string | null
  configPath?: string | null
  roots?: NodeIoDaemonConfig['roots']
  folderPicker?: NodeIoDaemonConfig['folderPicker']
  httpStreamBridge?: NodeIoDaemonConfig['httpStreamBridge']
}

export const DEFAULT_NODE_IO_DAEMON_CONFIG: NodeIoDaemonConfig = {
  host: '127.0.0.1',
  port: 7800,
  bootstrapMode: 'test',
  authToken: null,
  configPath: null,
  roots: [],
  folderPicker: null,
  httpStreamBridge: null,
}

export function normalizeNodeIoDaemonConfig(
  config: PartialNodeIoDaemonConfig = {},
): NodeIoDaemonConfig {
  return {
    host: config.host ?? DEFAULT_NODE_IO_DAEMON_CONFIG.host,
    port: config.port ?? DEFAULT_NODE_IO_DAEMON_CONFIG.port,
    bootstrapMode: config.bootstrapMode ?? DEFAULT_NODE_IO_DAEMON_CONFIG.bootstrapMode,
    authToken:
      config.authToken === undefined ? DEFAULT_NODE_IO_DAEMON_CONFIG.authToken : config.authToken,
    configPath:
      config.configPath === undefined
        ? DEFAULT_NODE_IO_DAEMON_CONFIG.configPath
        : config.configPath,
    roots:
      config.roots === undefined
        ? DEFAULT_NODE_IO_DAEMON_CONFIG.roots.map((root) => ({ ...root }))
        : config.roots.map((root) => ({ ...root })),
    folderPicker:
      config.folderPicker === undefined
        ? DEFAULT_NODE_IO_DAEMON_CONFIG.folderPicker
        : config.folderPicker,
    httpStreamBridge:
      config.httpStreamBridge === undefined
        ? DEFAULT_NODE_IO_DAEMON_CONFIG.httpStreamBridge
        : config.httpStreamBridge,
  }
}
