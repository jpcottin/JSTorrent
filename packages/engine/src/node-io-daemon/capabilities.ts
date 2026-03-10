import type { NodeIoDaemonCapabilities } from './types'

export const PHASE_ZERO_NODE_IO_DAEMON_CAPABILITIES: NodeIoDaemonCapabilities = {
  health: false,
  status: false,
  ioWebSocket: false,
  controlEvents: false,
  rootsRead: false,
  rootsWrite: false,
  fileOps: false,
  mediaCompleteFile206: false,
  mediaBlocking206: false,
}

export function createPhaseZeroNodeIoDaemonCapabilities(): NodeIoDaemonCapabilities {
  return { ...PHASE_ZERO_NODE_IO_DAEMON_CAPABILITIES }
}
