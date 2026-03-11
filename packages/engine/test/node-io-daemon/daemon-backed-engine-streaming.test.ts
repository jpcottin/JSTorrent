import { afterEach, describe, expect, it } from 'vitest'
import { pathToFileURL } from 'node:url'
import type { DaemonBackedEngineStreamingFixture } from '../../integration/daemon/helpers/daemon-backed-engine-streaming'
import {
  createDaemonBackedEngineStreamingFixture,
  delay,
  makeRequest,
  startRequest,
} from '../../integration/daemon/helpers/daemon-backed-engine-streaming'
import { createNodeIoDaemon } from '../../src/node-io-daemon/server'
import { conformanceCase } from '../helpers/conformance'

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

  conformanceCase(
    'node',
    'stream.blocks_until_ready',
    'blocks a tokenized HTTP range until torrent bytes are available through the Node daemon',
    async () => {
      const fixture = await createStreamingFixture()

      const mediaPort = await fixture.registerStreamToken('blocking-stream-token')
      let settled = false
      const responsePromise = startRequest(mediaPort, '/stream/blocking-stream-token', {
        headers: {
          Range: 'bytes=393216-393231',
        },
      }).response.then((response) => {
        settled = true
        return response
      })

      await delay(100)
      expect(settled).toBe(false)

      const response = await responsePromise
      expect(response.statusCode).toBe(206)
      expect(response.headers['content-range']).toBe(
        `bytes 393216-393231/${fixture.fileContent.length}`,
      )
      expect(response.body.equals(fixture.fileContent.subarray(393216, 393232))).toBe(true)
    },
    40_000,
  )

  it('serves a completed file over tokenized HTTP after control-channel registration', async () => {
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
  }, 40_000)

  conformanceCase(
    'node',
    'stream.stopped_incomplete_returns_409',
    'returns 409 for an incomplete range after the torrent is stopped',
    async () => {
      const fixture = await createStreamingFixture()
      await fixture.torrent.userStop()

      const mediaPort = await fixture.registerStreamToken('stopped-stream-token')
      const response = await makeRequest(mediaPort, '/stream/stopped-stream-token', {
        headers: {
          Range: 'bytes=393216-393231',
        },
      })

      expect(response.statusCode).toBe(409)
      expect(response.body.toString('utf8')).toContain('stopped')
    },
    40_000,
  )

  conformanceCase(
    'node',
    'stream.removed_token_returns_404',
    'returns 404 after torrent removal revokes the registered token',
    async () => {
      const fixture = await createStreamingFixture()
      const mediaPort = await fixture.registerStreamToken('removed-stream-token')

      await fixture.daemonBackedEngine.engine.removeTorrent(fixture.torrent)
      await delay(50)

      const response = await makeRequest(mediaPort, '/stream/removed-stream-token', {
        headers: {
          Range: 'bytes=0-15',
        },
      })

      expect(response.statusCode).toBe(404)
    },
    40_000,
  )

  conformanceCase(
    'node',
    'stream.multi_chunk_waits',
    'streams across multiple Node daemon chunks and torrent wait windows',
    async () => {
      const waitCalls: Array<{ offset: number; length: number }> = []
      const fixture = await createStreamingFixture({
        fileSize: 2 * 256 * 1024 + 8192,
      })
      const controlStream = fixture.daemonBackedEngine.getControlStreamService()
      expect(controlStream).not.toBeNull()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- monkey-patching private method for test
      const originalWaitForRange = (controlStream as any).waitForRange.bind(controlStream)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(controlStream as any).waitForRange = async (
        sessionId: string,
        offset: number,
        requestedLength: number,
      ) => {
        waitCalls.push({ offset, length: requestedLength })
        return await originalWaitForRange(sessionId, offset, requestedLength)
      }

      await waitForTorrentComplete(fixture)

      const mediaPort = await fixture.registerStreamToken('multi-chunk-complete-stream-token')
      const response = await makeRequest(mediaPort, '/stream/multi-chunk-complete-stream-token', {
        headers: {
          Range: `bytes=0-${fixture.fileContent.length - 1}`,
        },
      })

      expect(response.statusCode).toBe(206)
      expect(response.body.equals(fixture.fileContent)).toBe(true)
      expect(waitCalls).toEqual([
        { offset: 0, length: 256 * 1024 },
        { offset: 256 * 1024, length: 256 * 1024 },
        { offset: 2 * 256 * 1024, length: 8192 },
      ])
    },
    40_000,
  )

  conformanceCase(
    'node',
    'stream.concurrent_readers_are_isolated',
    'serves two concurrent blocking requests on the same token independently',
    async () => {
      const fixture = await createStreamingFixture()
      const mediaPort = await fixture.registerStreamToken('concurrent-stream-token')

      let firstSettled = false
      let secondSettled = false
      const firstResponsePromise = startRequest(mediaPort, '/stream/concurrent-stream-token', {
        headers: {
          Range: 'bytes=393216-393231',
        },
      }).response.then((response) => {
        firstSettled = true
        return response
      })
      const secondResponsePromise = startRequest(mediaPort, '/stream/concurrent-stream-token', {
        headers: {
          Range: 'bytes=393248-393263',
        },
      }).response.then((response) => {
        secondSettled = true
        return response
      })

      await delay(100)
      expect(firstSettled).toBe(false)
      expect(secondSettled).toBe(false)

      const [firstResponse, secondResponse] = await Promise.all([
        firstResponsePromise,
        secondResponsePromise,
      ])

      expect(firstResponse.statusCode).toBe(206)
      expect(firstResponse.body.equals(fixture.fileContent.subarray(393216, 393232))).toBe(true)
      expect(secondResponse.statusCode).toBe(206)
      expect(secondResponse.body.equals(fixture.fileContent.subarray(393248, 393264))).toBe(true)
    },
    40_000,
  )

  conformanceCase(
    'node',
    'stream.cancel_isolation',
    'canceling one concurrent request does not cancel another on the same token',
    async () => {
      const fixture = await createStreamingFixture()
      const mediaPort = await fixture.registerStreamToken('cancel-isolation-stream-token')

      const firstRequest = startRequest(mediaPort, '/stream/cancel-isolation-stream-token', {
        headers: {
          Range: 'bytes=393216-393231',
        },
      })
      const secondRequest = startRequest(mediaPort, '/stream/cancel-isolation-stream-token', {
        headers: {
          Range: 'bytes=393248-393263',
        },
      })

      await delay(100)
      firstRequest.req.destroy()

      await expect(firstRequest.response).rejects.toThrow()

      const secondResponse = await secondRequest.response
      expect(secondResponse.statusCode).toBe(206)
      expect(secondResponse.body.equals(fixture.fileContent.subarray(393248, 393264))).toBe(true)
    },
    40_000,
  )

  it('serves concurrent completed-range readers on the same token independently', async () => {
    const fixture = await createStreamingFixture()
    await waitForTorrentComplete(fixture)

    const mediaPort = await fixture.registerStreamToken('concurrent-complete-stream-token')
    const firstResponsePromise = startRequest(
      mediaPort,
      '/stream/concurrent-complete-stream-token',
      {
        headers: {
          Range: 'bytes=0-15',
        },
      },
    ).response
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
  }, 40_000)
})
