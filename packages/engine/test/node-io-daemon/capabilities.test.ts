import { describe, expect, it } from 'vitest'
import {
  NODE_IO_DAEMON_CAPABILITIES,
  createNodeIoDaemonCapabilities,
} from '../../src/node-io-daemon/capabilities'

describe('node-io-daemon capabilities', () => {
  it('returns the current daemon capability surface', () => {
    expect(createNodeIoDaemonCapabilities()).toEqual(NODE_IO_DAEMON_CAPABILITIES)
  })

  it('returns a fresh capabilities object each time', () => {
    const first = createNodeIoDaemonCapabilities()
    const second = createNodeIoDaemonCapabilities()

    expect(first).not.toBe(second)
    first.health = false
    expect(second.health).toBe(true)
  })

  it('advertises the currently implemented transport and bootstrap surfaces', () => {
    expect(NODE_IO_DAEMON_CAPABILITIES).toEqual({
      health: true,
      status: true,
      ioWebSocket: true,
      controlEvents: true,
      rootsRead: true,
      rootsWrite: true,
      fileOps: true,
      mediaCompleteFile206: true,
      mediaBlocking206: false,
      freeSpace: true,
    })
  })
})
