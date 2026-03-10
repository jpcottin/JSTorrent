import { afterEach, describe, expect, it } from 'vitest'
import { prepareTorrentForVideoPlayback } from '../../../client/src/utils/watch-video'
import type { DaemonBackedEngineStreamingFixture } from './helpers/daemon-backed-engine-streaming'
import {
  createDaemonBackedEngineStreamingFixture,
  makeRequest,
  waitForCondition,
} from './helpers/daemon-backed-engine-streaming'
import { startDaemon } from './helpers/daemon-harness'
import { conformanceCase } from '../../test/helpers/conformance'

describe('prepareTorrentForVideoPlayback with Rust daemon-backed engine', () => {
  let fixture: DaemonBackedEngineStreamingFixture | null = null

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  async function createStreamingFixture(): Promise<DaemonBackedEngineStreamingFixture> {
    fixture = await createDaemonBackedEngineStreamingFixture({
      async startDaemon(downloadDir) {
        const daemon = await startDaemon({
          roots: [{ key: 'root-a', path: downloadDir, displayName: 'Download Root' }],
        })
        return {
          port: daemon.port,
          token: daemon.token,
          installId: daemon.installId,
          stop: daemon.cleanup,
        }
      },
    })
    return fixture
  }

  async function waitForTorrentComplete(
    createdFixture: DaemonBackedEngineStreamingFixture,
    timeoutMs = 30_000,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('Timeout waiting for daemon-backed download'))
      }, timeoutMs)

      createdFixture.torrent.once('complete', () => {
        clearTimeout(timeout)
        resolve()
      })
      createdFixture.torrent.once('error', (error) => {
        clearTimeout(timeout)
        reject(error)
      })
    })
  }

  conformanceCase(
    'rust',
    'watch_video.unskip_and_start_incomplete_torrent',
    'unskips and starts a stopped incomplete torrent so daemon-backed video streaming can proceed',
    async () => {
      const fixture = await createStreamingFixture()
      await fixture.torrent.setFilePriorityAsync(0, 1)
      await fixture.torrent.userStop()

      expect(fixture.torrent.isFileSkipped(0)).toBe(true)
      expect(fixture.torrent.userState).toBe('stopped')

      const mediaPort = await fixture.registerStreamToken('watch-video-start-token')
      const blockedResponse = await makeRequest(mediaPort, '/stream/watch-video-start-token', {
        headers: {
          Range: 'bytes=393216-393231',
        },
      })
      expect(blockedResponse.statusCode).toBe(409)

      await prepareTorrentForVideoPlayback(fixture.torrent, 0)

      await waitForCondition(() => fixture.torrent.userState === 'active')
      expect(fixture.torrent.isFileSkipped(0)).toBe(false)

      const response = await makeRequest(mediaPort, '/stream/watch-video-start-token', {
        headers: {
          Range: 'bytes=393216-393231',
        },
      })
      expect(response.statusCode).toBe(206)
      expect(response.body.equals(fixture.fileContent.subarray(393216, 393232))).toBe(true)
    },
    40_000,
  )

  conformanceCase(
    'rust',
    'watch_video.complete_stopped_torrent_stays_stopped',
    'does not restart a stopped torrent when the watched file is already complete',
    async () => {
      const fixture = await createStreamingFixture()
      await waitForTorrentComplete(fixture)
      await fixture.torrent.userStop()

      expect(fixture.torrent.userState).toBe('stopped')

      await prepareTorrentForVideoPlayback(fixture.torrent, 0)

      expect(fixture.torrent.userState).toBe('stopped')

      const mediaPort = await fixture.registerStreamToken('watch-video-complete-token')
      const response = await makeRequest(mediaPort, '/stream/watch-video-complete-token', {
        headers: {
          Range: 'bytes=0-31',
        },
      })
      expect(response.statusCode).toBe(206)
      expect(response.body.equals(fixture.fileContent.subarray(0, 32))).toBe(true)
    },
    40_000,
  )
})
