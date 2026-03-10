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

export const PHASE_ONE_NODE_IO_DAEMON_CAPABILITIES: NodeIoDaemonCapabilities = {
  ...PHASE_ZERO_NODE_IO_DAEMON_CAPABILITIES,
  health: true,
  status: true,
}

export function createPhaseOneNodeIoDaemonCapabilities(): NodeIoDaemonCapabilities {
  return { ...PHASE_ONE_NODE_IO_DAEMON_CAPABILITIES }
}

export const PHASE_TWO_NODE_IO_DAEMON_CAPABILITIES: NodeIoDaemonCapabilities = {
  ...PHASE_ONE_NODE_IO_DAEMON_CAPABILITIES,
  ioWebSocket: true,
}

export function createPhaseTwoNodeIoDaemonCapabilities(): NodeIoDaemonCapabilities {
  return { ...PHASE_TWO_NODE_IO_DAEMON_CAPABILITIES }
}

export const PHASE_THREE_NODE_IO_DAEMON_CAPABILITIES: NodeIoDaemonCapabilities = {
  ...PHASE_TWO_NODE_IO_DAEMON_CAPABILITIES,
}

export function createPhaseThreeNodeIoDaemonCapabilities(): NodeIoDaemonCapabilities {
  return { ...PHASE_THREE_NODE_IO_DAEMON_CAPABILITIES }
}
