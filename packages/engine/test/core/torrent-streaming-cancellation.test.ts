import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Torrent } from '../../src/core/torrent'
import { ActivePieceManager, type ActivePieceConfig } from '../../src/core/active-piece-manager'
import type { BtEngine } from '../../src/core/bt-engine'
import type { ISocketFactory } from '../../src/interfaces/socket'
import { MockEngine } from '../utils/mock-engine'

const mockSocketFactory = {
  createTcpSocket: vi.fn(),
  createTcpServer: vi.fn(),
  wrapTcpSocket: vi.fn(),
  createUdpSocket: vi.fn(),
} as unknown as ISocketFactory

interface FakeConnectedPeer {
  remoteAddress: string
  remotePort: number
  peerId: Uint8Array | null
  requestsPending: number
  sendCancel: ReturnType<typeof vi.fn>
  recordBlockReceived: ReturnType<typeof vi.fn>
  recordRttSample: ReturnType<typeof vi.fn>
}

function createFakePeer(remoteAddress: string, remotePort: number): FakeConnectedPeer {
  return {
    remoteAddress,
    remotePort,
    peerId: null,
    requestsPending: 1,
    sendCancel: vi.fn(),
    recordBlockReceived: vi.fn(),
    recordRttSample: vi.fn(),
  }
}

describe('Torrent streaming cancellation', () => {
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

    const pieceHashes = Array.from({ length: 2 }, () => new Uint8Array(20))
    torrent.initBitfield(2)
    torrent.initPieceInfo(pieceHashes, 16_384, 16_384)
    torrent.contentStorage = {
      filesList: [{ offset: 0, length: 32_768, path: 'video.mkv' }],
      setFilePriorities: vi.fn(),
    } as Torrent['contentStorage']
    torrent.initFilePriorities()
  })

  it('cancels dropped streaming-suppressed pieces and ignores late blocks for them', () => {
    const peer = createFakePeer('1.2.3.4', 6881)
    ;(torrent as Torrent & { _swarm: { addIncomingConnection: Function } })._swarm.addIncomingConnection(
      peer.remoteAddress,
      peer.remotePort,
      'ipv4',
      peer,
    )

    const activePieces = new ActivePieceManager(
      engine,
      (index) => torrent.getPieceLength(index),
      { standardPieceLength: torrent.pieceLength } satisfies Partial<ActivePieceConfig>,
    )
    ;(torrent as Torrent & { activePieces: ActivePieceManager }).activePieces = activePieces

    const droppedPiece = activePieces.getOrCreate(1)
    expect(droppedPiece).toBeDefined()
    droppedPiece!.addRequest(0, `${peer.remoteAddress}:${peer.remotePort}`)
    activePieces.promoteToFullyRequested(1)

    expect(
      (torrent as Torrent & { piecePriority: Uint8Array | null }).piecePriority,
    ).toEqual(new Uint8Array([4, 4]))

    torrent.updateStreamingDemand('player', new Set([0]), 'now')

    expect(peer.sendCancel).toHaveBeenCalledWith(1, 0, 16_384)
    expect(peer.requestsPending).toBe(0)
    expect(activePieces.get(1)).toBeUndefined()
    expect(
      (torrent as Torrent & { _streamingScheduler: { isPieceSuppressed: (pieceIndex: number) => boolean } })
        ._streamingScheduler.isPieceSuppressed(1),
    ).toBe(true)

    const addBlock = vi.fn(() => true)
    ;(
      torrent as Torrent & {
        handleBlockCommon: (
          peer: FakeConnectedPeer,
          pieceIndex: number,
          blockOffset: number,
          dataLength: number,
          addBlockFn: (
            piece: unknown,
            blockIndex: number,
            peerId: string,
          ) => boolean,
        ) => void
      }
    ).handleBlockCommon(peer, 1, 0, 16_384, addBlock)

    expect(peer.recordBlockReceived).toHaveBeenCalledTimes(1)
    expect(addBlock).not.toHaveBeenCalled()
    expect(activePieces.get(1)).toBeUndefined()
  })
})
