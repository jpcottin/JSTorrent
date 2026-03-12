import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivePieceManager, type ActivePieceConfig } from '../../src/core/active-piece-manager'
import { BLOCK_SIZE } from '../../src/core/active-piece'
import { Torrent } from '../../src/core/torrent'
import type { BtEngine } from '../../src/core/bt-engine'
import type { ISocketFactory } from '../../src/interfaces/socket'
import { MockEngine } from '../utils/mock-engine'

const mockSocketFactory = {
  createTcpSocket: vi.fn(),
  createTcpServer: vi.fn(),
  wrapTcpSocket: vi.fn(),
  createUdpSocket: vi.fn(),
} as unknown as ISocketFactory

describe('Torrent web-seed block ingestion', () => {
  let engine: MockEngine
  let torrent: Torrent

  beforeEach(() => {
    engine = new MockEngine()
    torrent = new Torrent(
      engine as unknown as BtEngine,
      new Uint8Array(20).fill(1),
      new Uint8Array(20).fill(2),
      mockSocketFactory,
      6881,
      undefined,
      [],
      50,
      4,
    )
  })

  it('accepts requested web-seed blocks and finalizes the piece through the normal verify/write path', async () => {
    const pieceData = new Uint8Array(BLOCK_SIZE * 2)
    pieceData.fill(0x11, 0, BLOCK_SIZE)
    pieceData.fill(0x22, BLOCK_SIZE)
    const pieceHash = await engine.hasher.sha1(pieceData)

    torrent.initBitfield(1)
    torrent.initPieceInfo([pieceHash], pieceData.length, pieceData.length)

    const writePieceVerified = vi.fn().mockResolvedValue(false)
    torrent.contentStorage = {
      filesList: [{ offset: 0, length: pieceData.length, path: 'movie.bin' }],
      setFilePriorities: vi.fn(),
      writePieceVerified,
    } as unknown as Torrent['contentStorage']
    torrent.initFilePriorities()

    const activePieces = new ActivePieceManager(engine, (index) => torrent.getPieceLength(index), {
      standardPieceLength: pieceData.length,
    } satisfies Partial<ActivePieceConfig>)
    ;(torrent as Torrent & { activePieces: ActivePieceManager }).activePieces = activePieces

    const piece = activePieces.getOrCreate(0)
    expect(piece).toBeDefined()
    piece!.addRequestFromSource(0, 'webseed:https://seed.example/movie.bin')
    piece!.addRequestFromSource(1, 'webseed:https://seed.example/movie.bin')
    activePieces.promoteToFullyRequested(0)

    const handleBlockFromSource = (
      torrent as Torrent & {
        handleBlockFromSource: (
          sourceId: string,
          pieceIndex: number,
          blockOffset: number,
          data: Uint8Array,
        ) => boolean
      }
    ).handleBlockFromSource.bind(torrent)
    const recordSpy = vi.spyOn(engine.bandwidthTracker, 'record')

    expect(
      handleBlockFromSource(
        'webseed:https://seed.example/movie.bin',
        0,
        0,
        pieceData.subarray(0, BLOCK_SIZE),
      ),
    ).toBe(true)
    expect(
      handleBlockFromSource(
        'webseed:https://seed.example/movie.bin',
        0,
        BLOCK_SIZE,
        pieceData.subarray(BLOCK_SIZE),
      ),
    ).toBe(true)

    await pollUntil(
      () => writePieceVerified.mock.calls.length === 1 && torrent.completedPiecesCount === 1,
    )

    expect(writePieceVerified).toHaveBeenCalledWith(0, pieceData, pieceHash)
    expect(recordSpy).toHaveBeenCalledWith('web-seed:payload', BLOCK_SIZE, 'down')
    expect(recordSpy).toHaveBeenCalledWith('web-seed:payload', BLOCK_SIZE, 'down')
    expect(torrent.hasPiece(0)).toBe(true)
    expect(activePieces.get(0)).toBeUndefined()
    expect(torrent.totalDownloaded).toBe(pieceData.length)
  })
})

async function pollUntil(predicate: () => boolean, attempts = 20): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return
    await Promise.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
  }

  throw new Error('Condition not met before timeout')
}
