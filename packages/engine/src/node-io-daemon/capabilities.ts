import type { NodeIoDaemonCapabilities } from './types'

export const NODE_IO_DAEMON_CAPABILITIES: NodeIoDaemonCapabilities = {
  health: true,
  status: true,
  ioWebSocket: true,
  controlEvents: true,
  rootsRead: true,
  rootsWrite: true,
  fileOps: true,
  mediaCompleteFile206: true,
  mediaBlocking206: false,
}

export function createNodeIoDaemonCapabilities(): NodeIoDaemonCapabilities {
  return { ...NODE_IO_DAEMON_CAPABILITIES }
}
