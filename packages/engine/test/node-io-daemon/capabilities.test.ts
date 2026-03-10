import { describe, expect, it } from 'vitest'
import {
  PHASE_ZERO_NODE_IO_DAEMON_CAPABILITIES,
  createPhaseZeroNodeIoDaemonCapabilities,
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
})
