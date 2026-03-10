import { afterEach, describe, expect, it } from 'vitest'
import type { DaemonBackedEngineStreamingFixture } from './helpers/daemon-backed-engine-streaming'
import {
  createDaemonBackedEngineStreamingFixture,
  delay,
  makeRequest,
  startRequest,
  waitForCondition,
} from './helpers/daemon-backed-engine-streaming'
import { startDaemon } from './helpers/daemon-harness'
import { conformanceCase } from '../../test/helpers/conformance'

describe('DaemonBackedEngine with Rust daemon streaming', () => {
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

  conformanceCase(
    'rust',
    'stream.blocks_until_ready',
    'blocks a tokenized HTTP range until torrent bytes are available through the Rust daemon',
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

  conformanceCase(
    'rust',
    'stream.multi_chunk_waits',
    'streams across multiple Rust daemon chunks and torrent-piece waits',
    async () => {
      const waitCalls: Array<{ offset: number; length: number }> = []
      const fixture = await createStreamingFixture({
        fileSize: 2 * 256 * 1024 + 8192,
      })
      const controlStream = fixture.daemonBackedEngine.getControlStreamService()
      expect(controlStream).not.toBeNull()

      const originalWaitForRange = (controlStream as any).waitForRange.bind(controlStream)
      ;(controlStream as any).waitForRange = async (
        sessionId: string,
        offset: number,
        requestedLength: number,
      ) => {
        waitCalls.push({ offset, length: requestedLength })
        return await originalWaitForRange(sessionId, offset, requestedLength)
      }

      const mediaPort = await fixture.registerStreamToken('multi-chunk-stream-token')

      let settled = false
      const responsePromise = makeRequest(mediaPort, '/stream/multi-chunk-stream-token', {
        headers: {
          Range: `bytes=0-${fixture.fileContent.length - 1}`,
        },
      }).then((response) => {
        settled = true
        return response
      })

      await delay(100)
      expect(settled).toBe(false)

      const response = await responsePromise
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

  it(
    'serves complete ranges while rejecting incomplete ranges concurrently after the torrent is stopped',
    async () => {
      const fixture = await createStreamingFixture({
        preloadBytes: 16 * 1024,
      })
      await fixture.torrent.recheckData()
      await waitForCondition(() => fixture.torrent.hasPiece(0))
      await fixture.torrent.userStop()

      const mediaPort = await fixture.registerStreamToken('mixed-stopped-stream-token')

      const [completeResponse, incompleteResponse] = await Promise.all([
        makeRequest(mediaPort, '/stream/mixed-stopped-stream-token', {
          headers: {
            Range: 'bytes=0-4',
          },
        }),
        makeRequest(mediaPort, '/stream/mixed-stopped-stream-token', {
          headers: {
            Range: 'bytes=393216-393231',
          },
        }),
      ])

      expect(completeResponse.statusCode).toBe(206)
      expect(completeResponse.body.equals(fixture.fileContent.subarray(0, 5))).toBe(true)
      expect(incompleteResponse.statusCode).toBe(409)
      expect(incompleteResponse.body.toString('utf8')).toContain('stopped')
    },
    40_000,
  )

  it(
    'serves complete ranges while rejecting incomplete ranges concurrently after the file is skipped',
    async () => {
      const fixture = await createStreamingFixture({
        preloadBytes: 16 * 1024,
      })
      await fixture.torrent.recheckData()
      await waitForCondition(() => fixture.torrent.hasPiece(0))
      await fixture.torrent.setFilePriorityAsync(0, 1)

      const mediaPort = await fixture.registerStreamToken('mixed-skipped-stream-token')

      const [completeResponse, incompleteResponse] = await Promise.all([
        makeRequest(mediaPort, '/stream/mixed-skipped-stream-token', {
          headers: {
            Range: 'bytes=0-4',
          },
        }),
        makeRequest(mediaPort, '/stream/mixed-skipped-stream-token', {
          headers: {
            Range: 'bytes=393216-393231',
          },
        }),
      ])

      expect(completeResponse.statusCode).toBe(206)
      expect(completeResponse.body.equals(fixture.fileContent.subarray(0, 5))).toBe(true)
      expect(incompleteResponse.statusCode).toBe(409)
      expect(incompleteResponse.body.toString('utf8')).toContain('skipped')
    },
    40_000,
  )

  conformanceCase(
    'rust',
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
  )

  conformanceCase(
    'rust',
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
  )

  conformanceCase(
    'rust',
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
    'rust',
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

  it(
    'fans out torrent stop to multiple concurrent blocking requests on the same token',
    async () => {
      const fixture = await createStreamingFixture()
      const mediaPort = await fixture.registerStreamToken('concurrent-stop-stream-token')

      let firstSettled = false
      let secondSettled = false
      const firstResponsePromise = startRequest(mediaPort, '/stream/concurrent-stop-stream-token', {
        headers: {
          Range: 'bytes=393216-393231',
        },
      }).response.then((response) => {
        firstSettled = true
        return response
      })
      const secondResponsePromise = startRequest(mediaPort, '/stream/concurrent-stop-stream-token', {
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

      await fixture.torrent.userStop()

      const [firstResponse, secondResponse] = await Promise.all([
        firstResponsePromise,
        secondResponsePromise,
      ])

      expect(firstResponse.statusCode).toBe(409)
      expect(firstResponse.body.toString('utf8')).toContain('stopped')
      expect(secondResponse.statusCode).toBe(409)
      expect(secondResponse.body.toString('utf8')).toContain('stopped')
    },
    40_000,
  )

  it(
    'fans out torrent removal to multiple concurrent blocking requests on the same token',
    async () => {
      const fixture = await createStreamingFixture()
      const mediaPort = await fixture.registerStreamToken('concurrent-remove-stream-token')

      let firstSettled = false
      let secondSettled = false
      const firstResponsePromise = startRequest(
        mediaPort,
        '/stream/concurrent-remove-stream-token',
        {
          headers: {
            Range: 'bytes=393216-393231',
          },
        },
      ).response.then((response) => {
        firstSettled = true
        return response
      })
      const secondResponsePromise = startRequest(
        mediaPort,
        '/stream/concurrent-remove-stream-token',
        {
          headers: {
            Range: 'bytes=393248-393263',
          },
        },
      ).response.then((response) => {
        secondSettled = true
        return response
      })

      await delay(100)
      expect(firstSettled).toBe(false)
      expect(secondSettled).toBe(false)

      await fixture.daemonBackedEngine.engine.removeTorrent(fixture.torrent)
      await delay(50)

      const [firstResponse, secondResponse] = await Promise.all([
        firstResponsePromise,
        secondResponsePromise,
      ])

      expect(firstResponse.statusCode).toBe(404)
      expect(secondResponse.statusCode).toBe(404)

      const retryResponse = await makeRequest(mediaPort, '/stream/concurrent-remove-stream-token', {
        headers: {
          Range: 'bytes=0-15',
        },
      })
      expect(retryResponse.statusCode).toBe(404)
    },
    40_000,
  )
})
