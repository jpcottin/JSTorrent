import { afterEach, describe, expect, it } from 'vitest'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'
import {
  fetchChromeosStatus,
  findChromeosDaemonPort,
  requestChromeosPairing,
} from '../../../../extension/src/lib/daemon-bridge/chromeos/http-api'
import { ensureChromeosPairedAndConnect } from '../../../../extension/src/lib/daemon-bridge/chromeos/pairing'

describe('node-io-daemon bootstrap compatibility', () => {
  let daemon: ReturnType<typeof createNodeIoDaemon> | null = null

  afterEach(async () => {
    if (daemon) {
      await daemon.stop()
      daemon = null
    }
  })

  it('matches the ChromeOS discovery and pairing helper flow', async () => {
    daemon = createNodeIoDaemon({
      host: '127.0.0.1',
      port: 0,
      bootstrapMode: 'realistic',
      authToken: null,
    })
    await daemon.start()

    const storage = createMemoryChromeStorage()
    const host = '127.0.0.1'
    const port = daemon.getStatus().port
    const extensionId = 'extension-a'
    const installId = 'install-a'
    const token = 'compat-token'

    const found = await findChromeosDaemonPort({
      storage,
      fetchImpl: fetch,
      storageKeyPort: 'port',
      storageKeyHost: 'host',
      hosts: [host],
      fallbackPorts: [port],
      timeoutMs: 500,
    })
    expect(found).toEqual({ host, port })

    const completeCalls: Array<{
      host: string
      port: number
      version?: string | null
      ioPort?: number
      streamingPort?: number
    }> = []

    const result = await ensureChromeosPairedAndConnect({
      host,
      port,
      extensionId,
      installId,
      fetchStatus: async (statusHost, statusPort) =>
        await fetchChromeosStatus({
          fetchImpl: fetch,
          host: statusHost,
          port: statusPort,
          headers: {
            'X-JST-Auth': token,
            'X-JST-ExtensionId': extensionId,
            'X-JST-InstallId': installId,
          },
        }),
      requestPairing: async (pairHost, pairPort) =>
        await requestChromeosPairing({
          fetchImpl: fetch,
          host: pairHost,
          port: pairPort,
          headers: {
            'X-JST-ExtensionId': extensionId,
            'X-JST-InstallId': installId,
          },
          token,
        }),
      completeConnection: async (connectedHost, connectedPort, version, ioPort, streamingPort) => {
        completeCalls.push({
          host: connectedHost,
          port: connectedPort,
          version,
          ioPort,
          streamingPort,
        })
      },
      wait: async () => {},
      conflictRetryMs: 1,
      pollIntervalMs: 1,
      maxPollAttempts: 3,
    })

    expect(result).toBe('connected')
    expect(completeCalls).toEqual([
      {
        host,
        port,
        version: null,
        ioPort: port,
        streamingPort: undefined,
      },
    ])

    const pairedStatus = await fetchChromeosStatus({
      fetchImpl: fetch,
      host,
      port,
      headers: {
        'X-JST-Auth': token,
        'X-JST-ExtensionId': extensionId,
        'X-JST-InstallId': installId,
      },
    })
    expect(pairedStatus.paired).toBe(true)
    expect(pairedStatus.extensionId).toBe(extensionId)
    expect(pairedStatus.installId).toBe(installId)
    expect(pairedStatus.ioPort).toBe(port)
  })
})

function createMemoryChromeStorage(): {
  get(keys: string[]): Promise<Record<string, unknown>>
  set(items: Record<string, unknown>): Promise<void>
} {
  const store = new Map<string, unknown>()

  return {
    async get(keys: string[]): Promise<Record<string, unknown>> {
      return Object.fromEntries(keys.map((key) => [key, store.get(key)]))
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [key, value] of Object.entries(items)) {
        store.set(key, value)
      }
    },
  }
}
