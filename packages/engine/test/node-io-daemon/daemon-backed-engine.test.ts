import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { fetchDaemonRoots, fetchDaemonStatus } from '../../src/adapters/daemon/daemon-client'
import { DaemonConnection } from '../../src/adapters/daemon/daemon-connection'
import { DaemonBackedEngine } from '../../src/adapters/daemon/daemon-backed-engine'
import { MemorySessionStore } from '../../src/adapters/memory/memory-session-store'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'

describe('DaemonBackedEngine', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null
  let tempDir: string | null = null

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
    if (tempDir) {
      fs.rmSync(tempDir, { recursive: true, force: true })
      tempDir = null
    }
  })

  async function createHarness() {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-backed-engine-'))
    fs.writeFileSync(path.join(tempDir, 'fixture.bin'), Buffer.from('fixture-body'))

    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: 'secret',
      roots: [
        {
          key: 'root-a',
          uri: pathToFileURL(tempDir).toString(),
          display_name: 'Downloads A',
          removable: true,
          last_stat_ok: true,
          last_checked: Date.now(),
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

    const harness = await DaemonBackedEngine.create({
      connection,
      contentRoots: roots,
      defaultContentRoot: 'root-a',
      sessionStore: new MemorySessionStore(),
      startSuspended: true,
    })

    return { harness }
  }

  it('initializes a daemon-backed engine harness', async () => {
    const { harness } = await createHarness()

    try {
      expect(harness.engine).toBeTruthy()
      expect(harness.connection.ready).toBe(true)
      expect(harness.engine.isSuspended).toBe(true)
      expect(harness.engine.storageRootManager.getDefaultRoot()).toBe('root-a')
      expect(harness.engine.storageRootManager.getRoots()).toEqual([
        {
          key: 'root-a',
          label: 'Downloads A',
          path: pathToFileURL(tempDir!).toString(),
        },
      ])
    } finally {
      await harness.destroy()
    }
  })

  it('registers an HTTP stream over the daemon control channel', async () => {
    const { harness } = await createHarness()

    try {
      const response = await harness.registerHttpStream(
        {
          host: '127.0.0.1',
          port: daemon!.getStatus().port,
          token: 'secret',
          extensionId: 'extension-id',
          installId: 'install-id',
        },
        {
          streamToken: 'stream-token',
          torrentId: 'torrent-a',
          fileIndex: 0,
          rootKey: 'root-a',
          path: 'fixture.bin',
          fileSize: Buffer.byteLength('fixture-body'),
          mimeType: 'application/octet-stream',
        },
      )

      expect(response.mediaPort).toBeGreaterThan(0)
      expect(harness.getControlStreamService()).toBeTruthy()
    } finally {
      await harness.destroy()
    }
  })
})
