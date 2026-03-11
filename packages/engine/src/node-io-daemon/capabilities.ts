import type { NodeIoDaemonCapabilities } from './types'

export const IO_DAEMON_PROTOCOL_VERSION = 1
export const IO_DAEMON_BEHAVIOR_VERSION = 1

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

export function createNodeIoDaemonCapabilities(mediaBlocking206 = false): NodeIoDaemonCapabilities {
  return {
    ...NODE_IO_DAEMON_CAPABILITIES,
    mediaBlocking206,
  }
}
