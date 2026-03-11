export type NodeIoDaemonBootstrapMode = 'test' | 'realistic'

export const NODE_IO_DAEMON_HTTP_STREAM_STATUS = {
  FileSkipped: 'FileSkipped',
  StreamSessionMismatch: 'StreamSessionMismatch',
  StreamSessionNotFound: 'StreamSessionNotFound',
  TorrentErrored: 'TorrentErrored',
  TorrentInactive: 'TorrentInactive',
  TorrentRemoved: 'TorrentRemoved',
  TorrentStopped: 'TorrentStopped',
} as const

export type NodeIoDaemonHttpStreamStatus =
  (typeof NODE_IO_DAEMON_HTTP_STREAM_STATUS)[keyof typeof NODE_IO_DAEMON_HTTP_STREAM_STATUS]

export function createNodeIoDaemonHttpStreamStatusError(
  status: NodeIoDaemonHttpStreamStatus,
): Error {
  const error = new Error(status)
  error.name = status
  return error
}

export function getNodeIoDaemonHttpStreamStatus(
  error: unknown,
): NodeIoDaemonHttpStreamStatus | null {
  if (!(error instanceof Error)) {
    return null
  }

  const candidates = [error.message, error.name]
  for (const candidate of candidates) {
    if (
      candidate &&
      Object.values(NODE_IO_DAEMON_HTTP_STREAM_STATUS).includes(
        candidate as NodeIoDaemonHttpStreamStatus,
      )
    ) {
      return candidate as NodeIoDaemonHttpStreamStatus
    }
  }

  return null
}

export type NodeIoDaemonFolderPicker = () =>
  | NodeIoDaemonRoot
  | null
  | Promise<NodeIoDaemonRoot | null>

export interface NodeIoDaemonHttpStreamSessionDescriptor {
  streamToken: string
  torrentId: string
  fileIndex: number
}

export interface NodeIoDaemonHttpStreamWaitRequest
  extends NodeIoDaemonHttpStreamSessionDescriptor {
  offset: number
  length: number
  signal?: AbortSignal
}

export interface NodeIoDaemonHttpStreamCloseRequest
  extends NodeIoDaemonHttpStreamSessionDescriptor {
  reason: string
}

export interface NodeIoDaemonHttpStreamLifecycleEvent {
  torrentId: string
  reason: string
}

export interface NodeIoDaemonHttpStreamBridge {
  openStreamSession(
    session: NodeIoDaemonHttpStreamSessionDescriptor,
  ): Promise<void> | void
  waitForRange(request: NodeIoDaemonHttpStreamWaitRequest): Promise<void>
  closeStreamSession?(request: NodeIoDaemonHttpStreamCloseRequest): Promise<void> | void
  subscribeLifecycle?(
    listener: (event: NodeIoDaemonHttpStreamLifecycleEvent) => void,
  ): (() => void) | void
}

export interface NodeIoDaemonConfig {
  host: string
  port: number
  bootstrapMode: NodeIoDaemonBootstrapMode
  authToken: string | null
  configPath: string | null
  roots: NodeIoDaemonRoot[]
  folderPicker: NodeIoDaemonFolderPicker | null
  httpStreamBridge: NodeIoDaemonHttpStreamBridge | null
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

export interface NodeIoDaemonRoot {
  key: string
  uri: string
  display_name: string
  removable: boolean
  last_stat_ok: boolean
  last_checked: number
}

export interface NodeIoDaemonStatus {
  implementation: 'node-io-daemon'
  started: boolean
  host: string
  port: number
  bootstrapMode: NodeIoDaemonBootstrapMode
  protocolVersion: number
  behaviorVersion: number
  capabilities: NodeIoDaemonCapabilities
}

export interface NodeIoDaemonHttpStatus {
  port: number
  ioPort: number | null
  paired: boolean
  extensionId: string | null
  installId: string | null
  version: string | null
  tokenValid: boolean | null
  implementation: 'node-io-daemon'
  bootstrapMode: NodeIoDaemonBootstrapMode
  protocolVersion?: number
  behaviorVersion?: number
  capabilities: NodeIoDaemonCapabilities
}

export interface NodeIoDaemon {
  readonly config: Readonly<NodeIoDaemonConfig>
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): NodeIoDaemonStatus
}
