import { describe, expect, it } from 'vitest'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'

describe('node-io-daemon phase zero scaffold', () => {
  it('exposes normalized config and a phase-zero status shape', () => {
    const daemon = createNodeIoDaemon({
      host: 'localhost',
      port: 19090,
    })

    expect(daemon.config).toEqual({
      host: 'localhost',
      port: 19090,
      bootstrapMode: 'test',
      authToken: null,
      configPath: null,
    })

    expect(daemon.getStatus()).toEqual({
      implementation: 'node-io-daemon',
      phase: 'phase0',
      started: false,
      host: 'localhost',
      port: 19090,
      bootstrapMode: 'test',
      capabilities: {
        health: false,
        status: false,
        ioWebSocket: false,
        controlEvents: false,
        rootsRead: false,
        rootsWrite: false,
        fileOps: false,
        mediaCompleteFile206: false,
        mediaBlocking206: false,
      },
    })
  })

  it('supports idempotent start/stop state transitions', async () => {
    const daemon = createNodeIoDaemon()

    await daemon.start()
    await daemon.start()
    expect(daemon.getStatus().started).toBe(true)

    await daemon.stop()
    await daemon.stop()
    expect(daemon.getStatus().started).toBe(false)
  })
})
