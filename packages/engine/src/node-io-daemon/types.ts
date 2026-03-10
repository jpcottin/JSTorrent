export type NodeIoDaemonBootstrapMode = 'test' | 'realistic'

export interface NodeIoDaemonConfig {
  host: string
  port: number
  bootstrapMode: NodeIoDaemonBootstrapMode
  authToken: string | null
  configPath: string | null
}

export interface NodeIoDaemonCapabilities {
  health: boolean
  status: boolean
  ioWebSocket: boolean
  controlEvents: boolean
  rootsRead: boolean
  rootsWrite: boolean
  fileOps: boolean
  mediaCompleteFile206: boolean
  mediaBlocking206: boolean
}

export interface NodeIoDaemonStatus {
  implementation: 'node-io-daemon'
  phase: 'phase0'
  started: boolean
  host: string
  port: number
  bootstrapMode: NodeIoDaemonBootstrapMode
  capabilities: NodeIoDaemonCapabilities
}

export interface NodeIoDaemon {
  readonly config: Readonly<NodeIoDaemonConfig>
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): NodeIoDaemonStatus
}
