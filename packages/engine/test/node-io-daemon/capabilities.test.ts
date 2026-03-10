import { describe, expect, it } from 'vitest'
import {
  PHASE_ZERO_NODE_IO_DAEMON_CAPABILITIES,
  PHASE_ONE_NODE_IO_DAEMON_CAPABILITIES,
  createPhaseZeroNodeIoDaemonCapabilities,
  createPhaseOneNodeIoDaemonCapabilities,
} from '../../src/node-io-daemon/capabilities'

describe('node-io-daemon capabilities', () => {
  it('starts with all protocol surfaces disabled in phase zero', () => {
    expect(createPhaseZeroNodeIoDaemonCapabilities()).toEqual(
      PHASE_ZERO_NODE_IO_DAEMON_CAPABILITIES,
    )
  })

  it('returns a fresh capabilities object each time', () => {
    const first = createPhaseZeroNodeIoDaemonCapabilities()
    const second = createPhaseZeroNodeIoDaemonCapabilities()

    expect(first).not.toBe(second)
    first.health = true
    expect(second.health).toBe(false)
  })

  it('enables only health and status in phase one', () => {
    expect(createPhaseOneNodeIoDaemonCapabilities()).toEqual(
      PHASE_ONE_NODE_IO_DAEMON_CAPABILITIES,
    )
    expect(PHASE_ONE_NODE_IO_DAEMON_CAPABILITIES.health).toBe(true)
    expect(PHASE_ONE_NODE_IO_DAEMON_CAPABILITIES.status).toBe(true)
    expect(PHASE_ONE_NODE_IO_DAEMON_CAPABILITIES.ioWebSocket).toBe(false)
  })
})
