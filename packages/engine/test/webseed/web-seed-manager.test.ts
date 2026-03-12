import { describe, expect, it, vi } from 'vitest'
import { ActivePieceManager } from '../../src/core/active-piece-manager'
import { BLOCK_SIZE } from '../../src/core/active-piece'
import type { HttpBodyReader } from '../../src/http/http-transport'
import { WebSeedManager, type WebSeedManagerDeps } from '../../src/webseed/web-seed-manager'
import type { WebSeedHttpClient } from '../../src/webseed/web-seed-http-client'
import { MockEngine } from '../utils/mock-engine'

class StaticBodyReader implements HttpBodyReader {
  constructor(private readonly chunks: Array<Uint8Array | null>) {}

  async read(): Promise<Uint8Array | null> {
    return this.chunks.shift() ?? null
  }

  cancel(): void {}
}

class DeferredBodyReader implements HttpBodyReader {
  private readonly releasePromise: Promise<void>
  private released = false
  private chunkIndex = 0

  constructor(
    private readonly chunks: Uint8Array[],
    release: Promise<void>,
    private readonly onClose: () => void,
  ) {
    this.releasePromise = release.finally(() => {
      if (!this.released) {
        this.released = true
        this.onClose()
      }
    })
  }

  async read(): Promise<Uint8Array | null> {
    if (this.chunkIndex < this.chunks.length) {
      const chunk = this.chunks[this.chunkIndex]
      this.chunkIndex += 1
      return chunk
    }

    await this.releasePromise
    return null
  }

  cancel(): void {
    if (this.released) return
    this.released = true
    this.onClose()
  }
}

async function flushMicrotasks(rounds = 12): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve()
  }
}

describe('WebSeedManager', () => {
  it('maps multi-file BEP 19 spans into file requests and reassembles cross-file blocks', async () => {
    const engine = new MockEngine()
    const activePieces = new ActivePieceManager(engine, () => BLOCK_SIZE, {
      standardPieceLength: BLOCK_SIZE,
    })
    const deliveredBlocks: Array<{ pieceIndex: number; blockOffset: number; data: Uint8Array }> = []
    const completedPieces = new Set<number>()

    const client = {
      requests: [] as Array<{ url: string; start: number; endInclusive: number }>,
      async requestRange(request: { url: string; start: number; endInclusive: number }) {
        this.requests.push(request)

        if (request.url.endsWith('/root/alpha.bin')) {
          return {
            statusCode: 206,
            headers: {},
            finalUrl: request.url,
            body: new StaticBodyReader([new Uint8Array(10_000).fill(0x61), null]),
            start: request.start,
            endInclusive: request.endInclusive,
          }
        }

        return {
          statusCode: 206,
          headers: {},
          finalUrl: request.url,
          body: new StaticBodyReader([new Uint8Array(6_384).fill(0x62), null]),
          start: request.start,
          endInclusive: request.endInclusive,
        }
      },
    } as unknown as WebSeedHttpClient & {
      requests: Array<{ url: string; start: number; endInclusive: number }>
    }

    const reindexed: number[] = []

    const deps: WebSeedManagerDeps = {
      isNetworkActive: () => true,
      isComplete: () => false,
      hasMetadata: () => true,
      isDownloadRateLimited: () => false,
      getWebSeedUrls: () => ['https://seed.example/content/'],
      getFiles: () => [
        { path: 'root/alpha.bin', length: 10_000, offset: 0 },
        { path: 'root/two two.bin', length: 6_384, offset: 10_000 },
      ],
      isMultiFileTorrent: () => true,
      getPieceCount: () => 1,
      getFirstNeededPiece: () => 0,
      getPieceLength: () => BLOCK_SIZE,
      getPieceOffset: () => 0,
      shouldRequestPiece: (index) => !completedPieces.has(index),
      hasPiece: (index) => completedPieces.has(index),
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getMaxConcurrentTransfers: () => 1,
      getMaxTransferBytes: () => BLOCK_SIZE,
      tryConsumeDownloadBandwidth: () => true,
      waitForDownloadBandwidth: async () => {},
      removePieceFromAllIndices: vi.fn(),
      reindexPieceForConnectedPeers: (index) => {
        reindexed.push(index)
      },
      onReceivedBlockFromSource: (sourceId, pieceIndex, blockOffset, data) => {
        const piece = activePieces.get(pieceIndex)
        expect(piece).toBeDefined()
        const blockIndex = blockOffset / BLOCK_SIZE
        expect(piece!.hasRequestForBlockFromSource(blockIndex, sourceId)).toBe(true)
        piece!.addBlock(blockIndex, data, sourceId)
        deliveredBlocks.push({ pieceIndex, blockOffset, data })
        if (piece!.haveAllBlocks) {
          completedPieces.add(pieceIndex)
          activePieces.promoteToFullyResponded(pieceIndex)
          activePieces.removeFullyResponded(pieceIndex)
        }
        return true
      },
    }

    const manager = new WebSeedManager(engine, client, deps)
    manager.tick()
    await flushMicrotasks()

    expect(client.requests).toHaveLength(2)
    expect(client.requests[0]).toMatchObject({
      url: 'https://seed.example/content/root/alpha.bin',
      start: 0,
      endInclusive: 9_999,
    })
    expect(client.requests[1]).toMatchObject({
      url: 'https://seed.example/content/root/two%20two.bin',
      start: 0,
      endInclusive: 6_383,
    })
    expect(deliveredBlocks).toHaveLength(1)
    expect(deliveredBlocks[0].pieceIndex).toBe(0)
    expect(deliveredBlocks[0].blockOffset).toBe(0)
    expect(deliveredBlocks[0].data.length).toBe(BLOCK_SIZE)
    expect(deliveredBlocks[0].data.slice(0, 10_000)).toEqual(new Uint8Array(10_000).fill(0x61))
    expect(deliveredBlocks[0].data.slice(10_000)).toEqual(new Uint8Array(6_384).fill(0x62))
    expect(activePieces.get(0)).toBeUndefined()
    expect(reindexed).toEqual([])
  })

  it('cleans up empty reservations and reindexes the piece after a failed request', async () => {
    const engine = new MockEngine()
    const activePieces = new ActivePieceManager(engine, () => BLOCK_SIZE, {
      standardPieceLength: BLOCK_SIZE,
    })
    const reindexed: number[] = []

    const client = {
      async requestRange(request: { url: string; start: number; endInclusive: number }) {
        return {
          statusCode: 206,
          headers: {},
          finalUrl: request.url,
          body: new StaticBodyReader([new Uint8Array(128), null]),
          start: request.start,
          endInclusive: request.endInclusive,
        }
      },
    } as unknown as WebSeedHttpClient

    const deps: WebSeedManagerDeps = {
      isNetworkActive: () => true,
      isComplete: () => false,
      hasMetadata: () => true,
      isDownloadRateLimited: () => false,
      getWebSeedUrls: () => ['https://seed.example/file.bin'],
      getFiles: () => [{ path: 'file.bin', length: BLOCK_SIZE, offset: 0 }],
      isMultiFileTorrent: () => false,
      getPieceCount: () => 1,
      getFirstNeededPiece: () => 0,
      getPieceLength: () => BLOCK_SIZE,
      getPieceOffset: () => 0,
      shouldRequestPiece: () => true,
      hasPiece: () => false,
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getMaxConcurrentTransfers: () => 1,
      getMaxTransferBytes: () => BLOCK_SIZE,
      tryConsumeDownloadBandwidth: () => true,
      waitForDownloadBandwidth: async () => {},
      removePieceFromAllIndices: vi.fn(),
      reindexPieceForConnectedPeers: (index) => {
        reindexed.push(index)
      },
      onReceivedBlockFromSource: vi.fn(() => true),
    }

    const manager = new WebSeedManager(engine, client, deps)
    manager.tick()
    await flushMicrotasks()

    expect(activePieces.get(0)).toBeUndefined()
    expect(reindexed).toEqual([0])
  })

  it('coalesces contiguous pieces from a single file into one range request', async () => {
    const engine = new MockEngine()
    const activePieces = new ActivePieceManager(engine, () => BLOCK_SIZE, {
      standardPieceLength: BLOCK_SIZE,
    })
    const completedPieces = new Set<number>()

    const client = {
      requests: [] as Array<{ url: string; start: number; endInclusive: number }>,
      async requestRange(request: { url: string; start: number; endInclusive: number }) {
        this.requests.push(request)
        return {
          statusCode: 206,
          headers: {},
          finalUrl: request.url,
          body: new StaticBodyReader([
            new Uint8Array(BLOCK_SIZE).fill(0x61),
            new Uint8Array(BLOCK_SIZE).fill(0x62),
            null,
          ]),
          start: request.start,
          endInclusive: request.endInclusive,
        }
      },
    } as unknown as WebSeedHttpClient & {
      requests: Array<{ url: string; start: number; endInclusive: number }>
    }

    const deliveredBlocks: Array<{ pieceIndex: number; blockOffset: number; byte: number }> = []

    const deps: WebSeedManagerDeps = {
      isNetworkActive: () => true,
      isComplete: () => completedPieces.size === 2,
      hasMetadata: () => true,
      isDownloadRateLimited: () => false,
      getWebSeedUrls: () => ['https://seed.example/file.bin'],
      getFiles: () => [{ path: 'file.bin', length: BLOCK_SIZE * 2, offset: 0 }],
      isMultiFileTorrent: () => false,
      getPieceCount: () => 2,
      getFirstNeededPiece: () => 0,
      getPieceLength: () => BLOCK_SIZE,
      getPieceOffset: (index) => index * BLOCK_SIZE,
      shouldRequestPiece: (index) => !completedPieces.has(index),
      hasPiece: (index) => completedPieces.has(index),
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getMaxConcurrentTransfers: () => 1,
      getMaxTransferBytes: () => BLOCK_SIZE * 2,
      tryConsumeDownloadBandwidth: () => true,
      waitForDownloadBandwidth: async () => {},
      removePieceFromAllIndices: vi.fn(),
      reindexPieceForConnectedPeers: vi.fn(),
      onReceivedBlockFromSource: (sourceId, pieceIndex, blockOffset, data) => {
        const piece = activePieces.get(pieceIndex)
        expect(piece).toBeDefined()
        const blockIndex = blockOffset / BLOCK_SIZE
        expect(piece!.hasRequestForBlockFromSource(blockIndex, sourceId)).toBe(true)
        piece!.addBlock(blockIndex, data, sourceId)
        deliveredBlocks.push({ pieceIndex, blockOffset, byte: data[0] ?? 0 })
        if (piece!.haveAllBlocks) {
          completedPieces.add(pieceIndex)
          activePieces.promoteToFullyResponded(pieceIndex)
          activePieces.removeFullyResponded(pieceIndex)
        }
        return true
      },
    }

    const manager = new WebSeedManager(engine, client, deps)
    manager.tick()
    await flushMicrotasks()

    expect(client.requests).toHaveLength(1)
    expect(client.requests[0]).toMatchObject({
      url: 'https://seed.example/file.bin',
      start: 0,
      endInclusive: BLOCK_SIZE * 2 - 1,
    })
    expect(deliveredBlocks).toEqual([
      { pieceIndex: 0, blockOffset: 0, byte: 0x61 },
      { pieceIndex: 1, blockOffset: 0, byte: 0x62 },
    ])
  })

  it('runs multiple web-seed transfers concurrently up to the configured limit', async () => {
    const engine = new MockEngine()
    const activePieces = new ActivePieceManager(engine, () => BLOCK_SIZE, {
      standardPieceLength: BLOCK_SIZE,
    })
    const startedRequests: Array<{ url: string; start: number; endInclusive: number }> = []
    const completedPieces = new Set<number>()
    let releaseBodies: (() => void) | null = null
    let activeRequests = 0
    let maxConcurrentRequests = 0

    const client = {
      async requestRange(request: { url: string; start: number; endInclusive: number }) {
        startedRequests.push(request)
        activeRequests += 1
        maxConcurrentRequests = Math.max(maxConcurrentRequests, activeRequests)

        return {
          statusCode: 206,
          headers: {},
          finalUrl: request.url,
          body: new DeferredBodyReader(
            [
              new Uint8Array(BLOCK_SIZE).fill(request.url.endsWith('a.bin') ? 0x61 : 0x62),
              new Uint8Array(BLOCK_SIZE).fill(request.url.endsWith('a.bin') ? 0x61 : 0x62),
            ],
            new Promise<void>((resolve) => {
              const previousRelease = releaseBodies
              releaseBodies = () => {
                previousRelease?.()
                resolve()
              }
            }),
            () => {
              activeRequests -= 1
            },
          ),
          start: request.start,
          endInclusive: request.endInclusive,
        }
      },
    } as unknown as WebSeedHttpClient

    const deps: WebSeedManagerDeps = {
      isNetworkActive: () => true,
      isComplete: () => completedPieces.size === 4,
      hasMetadata: () => true,
      isDownloadRateLimited: () => false,
      getWebSeedUrls: () => ['https://seed-a.example/a.bin', 'https://seed-b.example/b.bin'],
      getFiles: () => [{ path: 'file.bin', length: BLOCK_SIZE * 4, offset: 0 }],
      isMultiFileTorrent: () => false,
      getPieceCount: () => 4,
      getFirstNeededPiece: () => 0,
      getPieceLength: () => BLOCK_SIZE,
      getPieceOffset: (index) => index * BLOCK_SIZE,
      shouldRequestPiece: (index) => !completedPieces.has(index),
      hasPiece: (index) => completedPieces.has(index),
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getMaxConcurrentTransfers: () => 2,
      getMaxTransferBytes: () => BLOCK_SIZE * 2,
      tryConsumeDownloadBandwidth: () => true,
      waitForDownloadBandwidth: async () => {},
      removePieceFromAllIndices: vi.fn(),
      reindexPieceForConnectedPeers: vi.fn(),
      onReceivedBlockFromSource: (sourceId, pieceIndex, blockOffset, data) => {
        const piece = activePieces.get(pieceIndex)
        expect(piece).toBeDefined()
        expect(piece!.hasRequestForBlockFromSource(blockOffset / BLOCK_SIZE, sourceId)).toBe(true)
        piece!.addBlock(blockOffset / BLOCK_SIZE, data, sourceId)
        if (piece!.haveAllBlocks) {
          completedPieces.add(pieceIndex)
          activePieces.promoteToFullyResponded(pieceIndex)
          activePieces.removeFullyResponded(pieceIndex)
        }
        return true
      },
    }

    const manager = new WebSeedManager(engine, client, deps)
    manager.tick()
    await flushMicrotasks()
    releaseBodies?.()
    await flushMicrotasks()

    expect(startedRequests).toHaveLength(2)
    expect(maxConcurrentRequests).toBe(2)
    expect(completedPieces).toEqual(new Set([0, 1, 2, 3]))
  })

  it('waits for download bandwidth before delivering web-seed bytes', async () => {
    const engine = new MockEngine()
    const activePieces = new ActivePieceManager(engine, () => BLOCK_SIZE, {
      standardPieceLength: BLOCK_SIZE,
    })
    const completedPieces = new Set<number>()
    const deliveredBlocks: number[] = []
    let releaseBandwidth: (() => void) | null = null
    let bandwidthAvailable = false

    const client = {
      async requestRange(request: { url: string; start: number; endInclusive: number }) {
        return {
          statusCode: 206,
          headers: {},
          finalUrl: request.url,
          body: new StaticBodyReader([new Uint8Array(BLOCK_SIZE).fill(0x61), null]),
          start: request.start,
          endInclusive: request.endInclusive,
        }
      },
    } as unknown as WebSeedHttpClient

    const deps: WebSeedManagerDeps = {
      isNetworkActive: () => true,
      isComplete: () => completedPieces.size === 1,
      hasMetadata: () => true,
      isDownloadRateLimited: () => true,
      getWebSeedUrls: () => ['https://seed.example/file.bin'],
      getFiles: () => [{ path: 'file.bin', length: BLOCK_SIZE, offset: 0 }],
      isMultiFileTorrent: () => false,
      getPieceCount: () => 1,
      getFirstNeededPiece: () => 0,
      getPieceLength: () => BLOCK_SIZE,
      getPieceOffset: () => 0,
      shouldRequestPiece: (index) => !completedPieces.has(index),
      hasPiece: (index) => completedPieces.has(index),
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getMaxConcurrentTransfers: () => 1,
      getMaxTransferBytes: () => BLOCK_SIZE,
      tryConsumeDownloadBandwidth: () => bandwidthAvailable,
      waitForDownloadBandwidth: async () => {
        await new Promise<void>((resolve) => {
          releaseBandwidth = () => {
            bandwidthAvailable = true
            resolve()
          }
        })
      },
      removePieceFromAllIndices: vi.fn(),
      reindexPieceForConnectedPeers: vi.fn(),
      onReceivedBlockFromSource: (sourceId, pieceIndex, blockOffset, data) => {
        const piece = activePieces.get(pieceIndex)
        expect(piece).toBeDefined()
        piece!.addBlock(blockOffset / BLOCK_SIZE, data, sourceId)
        deliveredBlocks.push(data.length)
        if (piece!.haveAllBlocks) {
          completedPieces.add(pieceIndex)
          activePieces.promoteToFullyResponded(pieceIndex)
          activePieces.removeFullyResponded(pieceIndex)
        }
        return true
      },
    }

    const manager = new WebSeedManager(engine, client, deps)
    manager.tick()
    await flushMicrotasks()

    expect(deliveredBlocks).toEqual([])
    releaseBandwidth?.()
    await flushMicrotasks()

    expect(deliveredBlocks).toEqual([BLOCK_SIZE])
  })

  it('prefers healthier sources after a failing source recovers from backoff', async () => {
    const engine = new MockEngine()
    const activePieces = new ActivePieceManager(engine, () => BLOCK_SIZE, {
      standardPieceLength: BLOCK_SIZE,
    })
    const completedPieces = new Set<number>()
    const startedRequests: string[] = []
    let now = 1_000
    const dateNowSpy = vi.spyOn(Date, 'now').mockImplementation(() => now)

    try {
      const client = {
        async requestRange(request: { url: string; start: number; endInclusive: number }) {
          startedRequests.push(request.url)

          if (request.url.endsWith('/a.bin') && startedRequests.length === 1) {
            return {
              statusCode: 206,
              headers: {},
              finalUrl: request.url,
              body: new StaticBodyReader([new Uint8Array(128), null]),
              start: request.start,
              endInclusive: request.endInclusive,
            }
          }

          if (request.url.endsWith('/b.bin')) {
            now += 2_000
          }

          return {
            statusCode: 206,
            headers: {},
            finalUrl: request.url,
            body: new StaticBodyReader([new Uint8Array(BLOCK_SIZE).fill(0x61), null]),
            start: request.start,
            endInclusive: request.endInclusive,
          }
        },
      } as unknown as WebSeedHttpClient

      const deps: WebSeedManagerDeps = {
        isNetworkActive: () => true,
        isComplete: () => completedPieces.size === 2,
        hasMetadata: () => true,
        isDownloadRateLimited: () => false,
        getWebSeedUrls: () => ['https://seed-a.example/a.bin', 'https://seed-b.example/b.bin'],
        getFiles: () => [{ path: 'file.bin', length: BLOCK_SIZE * 2, offset: 0 }],
        isMultiFileTorrent: () => false,
        getPieceCount: () => 2,
        getFirstNeededPiece: () => 0,
        getPieceLength: () => BLOCK_SIZE,
        getPieceOffset: (index) => index * BLOCK_SIZE,
        shouldRequestPiece: (index) => !completedPieces.has(index),
        hasPiece: (index) => completedPieces.has(index),
        getActivePieces: () => activePieces,
        initActivePieces: () => activePieces,
        getMaxConcurrentTransfers: () => 1,
        getMaxTransferBytes: () => BLOCK_SIZE,
        tryConsumeDownloadBandwidth: () => true,
        waitForDownloadBandwidth: async () => {},
        removePieceFromAllIndices: vi.fn(),
        reindexPieceForConnectedPeers: vi.fn(),
        onReceivedBlockFromSource: (sourceId, pieceIndex, blockOffset, data) => {
          const piece = activePieces.get(pieceIndex)
          expect(piece).toBeDefined()
          piece!.addBlock(blockOffset / BLOCK_SIZE, data, sourceId)
          if (piece!.haveAllBlocks) {
            completedPieces.add(pieceIndex)
            activePieces.promoteToFullyResponded(pieceIndex)
            activePieces.removeFullyResponded(pieceIndex)
          }
          return true
        },
      }

      const manager = new WebSeedManager(engine, client, deps)
      manager.tick()
      await flushMicrotasks(20)

      expect(startedRequests).toEqual([
        'https://seed-a.example/a.bin',
        'https://seed-b.example/b.bin',
        'https://seed-b.example/b.bin',
      ])
    } finally {
      dateNowSpy.mockRestore()
    }
  })
})
