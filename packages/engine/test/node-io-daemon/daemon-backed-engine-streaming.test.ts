import { afterEach, describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import type { DaemonBackedEngineStreamingFixture } from '../../integration/daemon/helpers/daemon-backed-engine-streaming'
import {
  createDaemonBackedEngineStreamingFixture,
  makeRequest,
  startRequest,
} from '../../integration/daemon/helpers/daemon-backed-engine-streaming'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'

describe('DaemonBackedEngine with Node daemon streaming', () => {
  let fixture: DaemonBackedEngineStreamingFixture | null = null

  afterEach(async () => {
    await fixture?.cleanup()
    fixture = null
  })

  async function createStreamingFixture(
    options: { fileSize?: number; preloadBytes?: number } = {},
  ): Promise<DaemonBackedEngineStreamingFixture> {
    fixture = await createDaemonBackedEngineStreamingFixture({
      ...options,
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

  it(
    'serves a completed file over tokenized HTTP after control-channel registration',
    async () => {
      const fixture = await createStreamingFixture()
      await waitForTorrentComplete(fixture)

      const mediaPort = await fixture.registerStreamToken('completed-stream-token')
      const response = await makeRequest(mediaPort, '/stream/completed-stream-token', {
        headers: {
          Range: 'bytes=0-31',
        },
      })

      expect(response.statusCode).toBe(206)
      expect(response.headers['content-range']).toBe(`bytes 0-31/${fixture.fileContent.length}`)
      expect(response.body.equals(fixture.fileContent.subarray(0, 32))).toBe(true)
    },
    40_000,
  )

  it(
    'streams a completed file across multiple Node daemon media chunks after control registration',
    async () => {
      const fixture = await createStreamingFixture({
        fileSize: 2 * 256 * 1024 + 8192,
      })
      await waitForTorrentComplete(fixture)

      const mediaPort = await fixture.registerStreamToken('multi-chunk-complete-stream-token')
      const response = await makeRequest(mediaPort, '/stream/multi-chunk-complete-stream-token', {
        headers: {
          Range: `bytes=0-${fixture.fileContent.length - 1}`,
        },
      })

      expect(response.statusCode).toBe(206)
      expect(response.body.equals(fixture.fileContent)).toBe(true)
    },
    40_000,
  )

  it(
    'serves concurrent completed-range readers on the same token independently',
    async () => {
      const fixture = await createStreamingFixture()
      await waitForTorrentComplete(fixture)

      const mediaPort = await fixture.registerStreamToken('concurrent-complete-stream-token')
      const firstResponsePromise = startRequest(mediaPort, '/stream/concurrent-complete-stream-token', {
        headers: {
          Range: 'bytes=0-15',
        },
      }).response
      const secondResponsePromise = startRequest(
        mediaPort,
        '/stream/concurrent-complete-stream-token',
        {
          headers: {
            Range: 'bytes=32-63',
          },
        },
      ).response

      const [firstResponse, secondResponse] = await Promise.all([
        firstResponsePromise,
        secondResponsePromise,
      ])

      expect(firstResponse.statusCode).toBe(206)
      expect(firstResponse.body.equals(fixture.fileContent.subarray(0, 16))).toBe(true)
      expect(secondResponse.statusCode).toBe(206)
      expect(secondResponse.body.equals(fixture.fileContent.subarray(32, 64))).toBe(true)
    },
    40_000,
  )
})
