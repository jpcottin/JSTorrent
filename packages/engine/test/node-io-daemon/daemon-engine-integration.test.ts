import { afterEach, describe, expect, it } from 'vitest'
import { fetchDaemonRoots, fetchDaemonStatus } from '../../src/adapters/daemon/daemon-client'
import { DaemonConnection } from '../../src/adapters/daemon/daemon-connection'
import { MemorySessionStore } from '../../src/adapters/memory/memory-session-store'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'
import { createDaemonEngine } from '../../src/presets/daemon'

describe('node-io-daemon daemon engine integration', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
  })

  it('boots a daemon-backed engine in trusted-token mode', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      roots: [
        {
          key: 'root-a',
          uri: 'file:///downloads/a',
          display_name: 'Downloads A',
          removable: true,
          last_stat_ok: true,
          last_checked: 123,
        },
      ],
    })
    await daemon.start()

    const status = await fetchDaemonStatus(
      '127.0.0.1',
      daemon.getStatus().port,
      'secret',
      'extension-id',
      'install-id',
    )
    const connection = new DaemonConnection(
      daemon.getStatus().port,
      '127.0.0.1',
      undefined,
      'secret',
      status.ioPort,
    )
    const roots = await fetchDaemonRoots(connection)

    const engine = await createDaemonEngine({
      connection,
      contentRoots: roots,
      defaultContentRoot: 'root-a',
      sessionStore: new MemorySessionStore(),
      startSuspended: true,
      port: 0,
    })

    try {
      expect(connection.ready).toBe(true)
      expect(engine.isSuspended).toBe(true)
      expect(engine.storageRootManager.getRoots()).toEqual([
        {
          key: 'root-a',
          label: 'Downloads A',
          path: 'file:///downloads/a',
        },
      ])
      expect(engine.storageRootManager.getDefaultRoot()).toBe('root-a')

      const udpSocket = await engine.socketFactory.createUdpSocket({
        bindAddr: '127.0.0.1',
        bindPort: 0,
      })
      udpSocket.close()
    } finally {
      await engine.destroy()
      connection.close()
    }
  })
})
