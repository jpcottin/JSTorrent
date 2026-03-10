import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { DaemonBackedEngineDownloadFixture } from '../../integration/daemon/helpers/daemon-backed-engine-download'
import { createDaemonBackedEngineDownloadFixture } from '../../integration/daemon/helpers/daemon-backed-engine-download'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'

describe('DaemonBackedEngine download flow with Node daemon', () => {
  let fixture: DaemonBackedEngineDownloadFixture | null = null

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  async function createDownloadFixture(): Promise<DaemonBackedEngineDownloadFixture> {
    fixture = await createDaemonBackedEngineDownloadFixture({
      async startDaemon(downloadDir) {
        const daemon = createNodeIoDaemon({
          host: '127.0.0.1',
          port: 0,
          bootstrapMode: 'realistic',
          authToken: 'secret',
          roots: [
            {
              key: 'root-a',
              uri: pathToFileURL(downloadDir).toString(),
              display_name: 'Download Root',
              removable: true,
              last_stat_ok: true,
              last_checked: Date.now(),
            },
          ],
        })
        await daemon.start()
        return {
          port: daemon.getStatus().port,
          token: 'secret',
          installId: 'install-id',
          stop: async () => {
            await daemon.stop()
          },
        }
      },
    })
    return fixture
  }

  async function waitForTorrentComplete(
    torrent: NonNullable<Awaited<ReturnType<typeof createDownloadFixture>>['daemonBackedEngine']['engine']['torrents'][number]>,
    timeoutMs = 30_000,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for daemon-backed download'))
      }, timeoutMs)
      torrent.once('complete', () => {
        clearTimeout(timeout)
        resolve()
      })
      torrent.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  }

  it(
    'adds a download root after engine creation and downloads to the new default root',
    async () => {
      const fixture = await createDownloadFixture()

      expect(fixture.daemonBackedEngine.engine.storageRootManager.getRoots()).toEqual([])
      expect(fixture.daemonBackedEngine.engine.storageRootManager.getDefaultRoot()).toBeUndefined()

      fixture.daemonBackedEngine.engine.storageRootManager.addRoot(fixture.availableRoot)
      fixture.daemonBackedEngine.engine.storageRootManager.setDefaultRoot(fixture.availableRoot.key)

      const { torrent } = await fixture.daemonBackedEngine.engine.addTorrent(fixture.torrentBuffer)
      if (!torrent) {
        throw new Error('Failed to add daemon-backed torrent')
      }

      await waitForTorrentComplete(torrent)

      const downloadedPath = path.join(fixture.downloadDir, fixture.fileName)
      expect(fs.existsSync(downloadedPath)).toBe(true)
      expect(fs.readFileSync(downloadedPath).equals(fixture.fileContent)).toBe(true)
    },
    40_000,
  )

  it(
    'removes downloaded data from the daemon-backed default root during cleanup',
    async () => {
      const fixture = await createDownloadFixture()
      fixture.daemonBackedEngine.engine.storageRootManager.addRoot(fixture.availableRoot)
      fixture.daemonBackedEngine.engine.storageRootManager.setDefaultRoot(fixture.availableRoot.key)

      const { torrent } = await fixture.daemonBackedEngine.engine.addTorrent(fixture.torrentBuffer)
      if (!torrent) {
        throw new Error('Failed to add daemon-backed torrent')
      }

      await waitForTorrentComplete(torrent)

      const downloadedPath = path.join(fixture.downloadDir, fixture.fileName)
      expect(fs.existsSync(downloadedPath)).toBe(true)

      const removal = await fixture.daemonBackedEngine.engine.removeTorrentWithData(torrent)

      expect(removal.success).toBe(true)
      expect(removal.errors).toEqual([])
      expect(fs.existsSync(downloadedPath)).toBe(false)
      expect(fixture.daemonBackedEngine.engine.getTorrent(torrent.infoHashStr)).toBeUndefined()
    },
    40_000,
  )
})
