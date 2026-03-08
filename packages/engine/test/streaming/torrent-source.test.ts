import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createTorrentSource, type ReadResult } from '../../src/streaming/torrent-source'
import type { Torrent } from '../../src/core/torrent'

/**
 * Minimal mock Source base class standing in for mediabunny's Source.
 * The real Source is abstract with _retrieveSize, _read, _dispose.
 */
abstract class MockSourceBase {
  abstract _retrieveSize(): number
  abstract _read(start: number, end: number, signal?: AbortSignal): Promise<ReadResult> | null
  abstract _dispose(): void
}

/** Piece length used in all tests. */
const PIECE_LENGTH = 16384

interface MockTorrentOpts {
  fileLength: number
  pieceLength?: number
  /** Pieces that are already downloaded. */
  availablePieces?: Set<number>
  includeTokenizedDemandApi?: boolean
  includeStreamingFileLockApi?: boolean
}

function createMockTorrent(opts: MockTorrentOpts) {
  const pieceLength = opts.pieceLength ?? PIECE_LENGTH
  const available = new Set(opts.availablePieces ?? [])

  // Deferred resolve for waitForPieces — test can control when pieces "arrive"
  let waitResolve: (() => void) | null = null
  let waitReject: ((err: Error) => void) | null = null

  const mock = {
    files: [{ length: opts.fileLength }],

    fileBytesToPieces: vi.fn((_fileIndex: number, offset: number, length: number): number[] => {
      const first = Math.floor(offset / pieceLength)
      const last = Math.floor((offset + length - 1) / pieceLength)
      const pieces: number[] = []
      for (let i = first; i <= last; i++) pieces.push(i)
      return pieces
    }),

    hasPiece: vi.fn((index: number): boolean => available.has(index)),

    readFileBytes: vi.fn(
      async (_fileIndex: number, offset: number, length: number): Promise<Uint8Array> => {
        // Return deterministic bytes: each byte = (offset + i) & 0xff
        const buf = new Uint8Array(length)
        for (let i = 0; i < length; i++) buf[i] = (offset + i) & 0xff
        return buf
      },
    ),

    waitForPieces: vi.fn((pieceIndices: number[], signal?: AbortSignal): Promise<void> => {
      // If all pieces already available, resolve immediately
      const missing = pieceIndices.filter((i) => !available.has(i))
      if (missing.length === 0) return Promise.resolve()

      // Otherwise return a controllable promise
      return new Promise<void>((resolve, reject) => {
        waitResolve = resolve
        waitReject = reject

        signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })

        if (signal?.aborted) {
          reject(new DOMException('Aborted', 'AbortError'))
        }
      })
    }),

    setStreamingPieces: vi.fn((_pieces: Set<number> | null): void => {}),

    // Helpers for tests to simulate piece arrival
    _simulatePiecesArrived(indices: number[]) {
      for (const i of indices) available.add(i)
      waitResolve?.()
    },
    _simulateWaitRejection(err: Error) {
      waitReject?.(err)
    },
  }

  if (opts.includeTokenizedDemandApi) {
    Object.assign(mock, {
      updateStreamingDemand: vi.fn(
        (_token: string, _pieces: Set<number> | null, _urgency?: 'metadata' | 'next' | 'now') =>
          undefined,
      ),
    })
  }

  if (opts.includeStreamingFileLockApi) {
    Object.assign(mock, {
      updateStreamingFileLock: vi.fn((_token: string, _enabled: boolean) => undefined),
    })
  }

  return mock
}

describe('TorrentSource', () => {
  let mockTorrent: ReturnType<typeof createMockTorrent>

  beforeEach(() => {
    mockTorrent = createMockTorrent({
      fileLength: 65536, // 4 pieces at 16KB each
      availablePieces: new Set([0, 1, 2, 3]),
    })
  })

  it('throws on invalid file index', () => {
    expect(() => createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 5)).toThrow(
      'Invalid file index: 5',
    )
  })

  it('_retrieveSize returns the file length', () => {
    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)
    expect(source._retrieveSize()).toBe(65536)
  })

  it('resolves immediately when all pieces are available', async () => {
    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    const result = source._read(0, 100)
    expect(result).toBeInstanceOf(Promise)

    const data = await result
    expect(data).not.toBeNull()
    expect(data!.bytes).toBeInstanceOf(Uint8Array)
    expect(data!.bytes.length).toBe(100)
    // Verify deterministic content
    expect(data!.bytes[0]).toBe(0)
    expect(data!.bytes[99]).toBe(99)
    expect(data!.view).toBeInstanceOf(DataView)
    expect(data!.offset).toBe(0)
  })

  it('prioritizes pieces via setStreamingPieces', async () => {
    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    // Read a range spanning pieces 1 and 2 (offset 20000 to 33000)
    const start = 20000
    const end = 33000
    await source._read(start, end)

    expect(mockTorrent.setStreamingPieces).toHaveBeenCalledWith(new Set([1, 2]))
  })

  it('uses tokenized streaming demand when available and clears it when the signal ends', async () => {
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set([0, 1, 2, 3]),
      includeTokenizedDemandApi: true,
      includeStreamingFileLockApi: true,
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)
    const controller = new AbortController()

    await source._read(0, 100, controller.signal)

    expect(mockTorrent.setStreamingPieces).not.toHaveBeenCalled()
    expect(mockTorrent.updateStreamingFileLock).toHaveBeenCalledTimes(1)
    expect(mockTorrent.updateStreamingFileLock).toHaveBeenCalledWith(
      expect.stringMatching(/^torrent-source-file:/),
      0,
    )
    expect(mockTorrent.updateStreamingDemand).toHaveBeenCalledTimes(1)

    const [token, pieces, urgency] = mockTorrent.updateStreamingDemand.mock.calls[0]
    expect(token).toMatch(/^torrent-source:/)
    expect(pieces).toEqual(new Set([0]))
    expect(urgency).toBe('now')

    controller.abort()

    expect(mockTorrent.updateStreamingDemand.mock.calls[1]).toEqual([token, null, 'now'])
  })

  it('reuses one tokenized demand window across unsignaled startup reads until a segment signal takes over', async () => {
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set([0, 1, 2, 3]),
      includeTokenizedDemandApi: true,
      includeStreamingFileLockApi: true,
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    await source._read(0, 100)
    await source._read(20000, 33000)

    expect(mockTorrent.updateStreamingDemand).toHaveBeenCalledTimes(2)
    const [firstToken, firstPieces, firstUrgency] = mockTorrent.updateStreamingDemand.mock.calls[0]
    const [secondToken, secondPieces, secondUrgency] =
      mockTorrent.updateStreamingDemand.mock.calls[1]
    expect(firstToken).toMatch(/^torrent-source:/)
    expect(secondToken).toBe(firstToken)
    expect(firstPieces).toEqual(new Set([0]))
    expect(secondPieces).toEqual(new Set([0, 1, 2]))
    expect(firstUrgency).toBe('now')
    expect(secondUrgency).toBe('now')

    source.setCurrentSignal(new AbortController().signal)

    expect(mockTorrent.updateStreamingDemand.mock.calls[2]).toEqual([firstToken, null, 'now'])
  })

  it('reuses one tokenized demand window across reads sharing the same current signal', async () => {
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set([0, 1, 2, 3]),
      includeTokenizedDemandApi: true,
      includeStreamingFileLockApi: true,
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)
    const firstController = new AbortController()
    source.setCurrentSignal(firstController.signal)

    await source._read(0, 100)
    await source._read(20000, 33000)

    expect(mockTorrent.updateStreamingDemand).toHaveBeenCalledTimes(2)
    const [firstToken, firstPieces, firstUrgency] = mockTorrent.updateStreamingDemand.mock.calls[0]
    const [secondToken, secondPieces, secondUrgency] =
      mockTorrent.updateStreamingDemand.mock.calls[1]
    expect(firstToken).toMatch(/^torrent-source:/)
    expect(secondToken).toBe(firstToken)
    expect(firstPieces).toEqual(new Set([0]))
    expect(secondPieces).toEqual(new Set([0, 1, 2]))
    expect(firstUrgency).toBe('now')
    expect(secondUrgency).toBe('now')

    source.setCurrentSignal(new AbortController().signal)

    expect(mockTorrent.updateStreamingDemand.mock.calls[2]).toEqual([firstToken, null, 'now'])
  })

  it('waits for missing pieces then resolves with correct bytes', async () => {
    // No pieces available initially
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set(), // nothing downloaded yet
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    const promise = source._read(0, 100)
    expect(promise).toBeInstanceOf(Promise)

    // waitForPieces was called
    expect(mockTorrent.waitForPieces).toHaveBeenCalled()
    const [requestedPieces] = mockTorrent.waitForPieces.mock.calls[0]
    expect(requestedPieces).toEqual([0])

    // Simulate pieces arriving
    mockTorrent._simulatePiecesArrived([0])

    const data = await promise
    expect(data!.bytes.length).toBe(100)
    expect(mockTorrent.readFileBytes).toHaveBeenCalledWith(0, 0, 100)
  })

  it('rejects with AbortError when signal is aborted', async () => {
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set(), // nothing downloaded
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    const controller = new AbortController()
    const promise = source._read(0, 100, controller.signal)

    // Abort before pieces arrive
    controller.abort()

    await expect(promise).rejects.toThrow()
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('deprioritizes pieces on abort via setStreamingPieces(null)', async () => {
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set(),
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    const controller = new AbortController()
    const promise = source._read(0, 100, controller.signal)

    // First call: setStreamingPieces(new Set([0]))
    expect(mockTorrent.setStreamingPieces).toHaveBeenCalledWith(new Set([0]))

    controller.abort()

    // After abort: setStreamingPieces(null) to deprioritize
    expect(mockTorrent.setStreamingPieces).toHaveBeenCalledWith(null)

    // Suppress unhandled rejection
    await promise.catch(() => {})
  })

  it('clears tokenized streaming demand on abort', async () => {
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set(),
      includeTokenizedDemandApi: true,
      includeStreamingFileLockApi: true,
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    const controller = new AbortController()
    const promise = source._read(0, 100, controller.signal)

    expect(mockTorrent.updateStreamingDemand).toHaveBeenCalledTimes(1)
    const [token, pieces, urgency] = mockTorrent.updateStreamingDemand.mock.calls[0]
    expect(token).toMatch(/^torrent-source:/)
    expect(pieces).toEqual(new Set([0]))
    expect(urgency).toBe('now')

    controller.abort()

    expect(mockTorrent.updateStreamingDemand.mock.calls[1]).toEqual([token, null, 'now'])
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('handles reads spanning multiple pieces', async () => {
    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    // Range spanning pieces 0, 1, 2: offset 0 to 40000
    const start = 0
    const end = 40000
    await source._read(start, end)

    expect(mockTorrent.waitForPieces).toHaveBeenCalledWith([0, 1, 2], expect.any(AbortSignal))
    expect(mockTorrent.setStreamingPieces).toHaveBeenCalledWith(new Set([0, 1, 2]))
    expect(mockTorrent.readFileBytes).toHaveBeenCalledWith(0, 0, 40000)
  })

  it('returns null when fileBytesToPieces throws', () => {
    mockTorrent.fileBytesToPieces.mockImplementation((_fileIndex: number, offset: number) => {
      if (offset === 0) {
        return [0, 1, 2, 3]
      }
      throw new Error('out of range')
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    const result = source._read(999999, 999999 + 100)
    expect(result).toBeNull()
  })

  it('rejects immediately if signal is already aborted', async () => {
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set(),
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    const controller = new AbortController()
    controller.abort() // pre-aborted

    const promise = source._read(0, 100, controller.signal)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('aborts pending reads when disposed', async () => {
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set(),
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)

    const promise = source._read(0, 100)
    expect(mockTorrent.setStreamingPieces).toHaveBeenCalledWith(new Set([0]))

    source._dispose()

    expect(mockTorrent.setStreamingPieces).toHaveBeenCalledWith(null)
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(mockTorrent.readFileBytes).not.toHaveBeenCalled()
  })

  it('clears the streaming file lock when disposed', async () => {
    mockTorrent = createMockTorrent({
      fileLength: 65536,
      availablePieces: new Set(),
      includeStreamingFileLockApi: true,
    })

    const source = createTorrentSource(MockSourceBase, mockTorrent as unknown as Torrent, 0)
    const promise = source._read(0, 100)

    expect(mockTorrent.updateStreamingFileLock).toHaveBeenCalledTimes(1)
    const [token, enabled] = mockTorrent.updateStreamingFileLock.mock.calls[0]
    expect(token).toMatch(/^torrent-source-file:/)
    expect(enabled).toBe(0)

    source._dispose()

    expect(mockTorrent.updateStreamingFileLock.mock.calls[1]).toEqual([token, null])
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
  })
})
