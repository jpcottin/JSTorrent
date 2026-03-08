import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Torrent } from '../../src/core/torrent'
import { ActivePieceManager, type ActivePieceConfig } from '../../src/core/active-piece-manager'
import type { BtEngine } from '../../src/core/bt-engine'
import type { ISocketFactory } from '../../src/interfaces/socket'
import { toHex } from '../../src/utils/buffer'
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

function invokeHandleBlockCommon(
  torrent: Torrent,
  peer: FakeConnectedPeer,
  pieceIndex: number,
  blockOffset: number,
  dataLength: number,
  addBlockFn: (piece: unknown, blockIndex: number, peerId: string) => boolean,
): void {
  ;(
    torrent as Torrent & {
      handleBlockCommon: (
        peer: FakeConnectedPeer,
        pieceIndex: number,
        blockOffset: number,
        dataLength: number,
        addBlockFn: (piece: unknown, blockIndex: number, peerId: string) => boolean,
      ) => void
    }
  ).handleBlockCommon(peer, pieceIndex, blockOffset, dataLength, addBlockFn)
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
    ;(
      torrent as Torrent & { _swarm: { addIncomingConnection: (...args: unknown[]) => void } }
    )._swarm.addIncomingConnection(peer.remoteAddress, peer.remotePort, 'ipv4', peer)

    const activePieces = new ActivePieceManager(engine, (index) => torrent.getPieceLength(index), {
      standardPieceLength: torrent.pieceLength,
    } satisfies Partial<ActivePieceConfig>)
    ;(torrent as Torrent & { activePieces: ActivePieceManager }).activePieces = activePieces

    const droppedPiece = activePieces.getOrCreate(1)
    expect(droppedPiece).toBeDefined()
    droppedPiece!.addRequest(0, `${peer.remoteAddress}:${peer.remotePort}`)
    activePieces.promoteToFullyRequested(1)

    expect((torrent as Torrent & { piecePriority: Uint8Array | null }).piecePriority).toEqual(
      new Uint8Array([4, 4]),
    )

    torrent.updateStreamingDemand('player', new Set([0]), 'now')

    expect(peer.sendCancel).toHaveBeenCalledWith(1, 0, 16_384)
    expect(peer.requestsPending).toBe(0)
    expect(activePieces.get(1)).toBeUndefined()
    expect(
      (
        torrent as Torrent & {
          _streamingScheduler: { isPieceSuppressed: (pieceIndex: number) => boolean }
        }
      )._streamingScheduler.isPieceSuppressed(1),
    ).toBe(true)

    const addBlock = vi.fn(() => true)
    invokeHandleBlockCommon(torrent, peer, 1, 0, 16_384, addBlock)

    expect(peer.recordBlockReceived).toHaveBeenCalledTimes(1)
    expect(addBlock).not.toHaveBeenCalled()
    expect(activePieces.get(1)).toBeUndefined()
  })

  it('drops inbound blocks that do not match an active piece request', () => {
    const activePieces = new ActivePieceManager(engine, (index) => torrent.getPieceLength(index), {
      standardPieceLength: torrent.pieceLength,
    } satisfies Partial<ActivePieceConfig>)
    ;(torrent as Torrent & { activePieces: ActivePieceManager }).activePieces = activePieces

    const activePiece = activePieces.getOrCreate(1)
    expect(activePiece).toBeDefined()
    activePiece!.addRequest(0, 'peer-a')

    const wrongPeer = createFakePeer('2.3.4.5', 6881)
    const unsolicitedPiece = vi.fn(() => true)
    invokeHandleBlockCommon(torrent, wrongPeer, 1, 0, 16_384, unsolicitedPiece)

    expect(unsolicitedPiece).not.toHaveBeenCalled()
    expect(activePieces.get(1)).toBe(activePiece)

    const noActivePiecePeer = createFakePeer('3.4.5.6', 6882)
    const recreateDroppedPiece = vi.fn(() => true)
    invokeHandleBlockCommon(torrent, noActivePiecePeer, 0, 0, 16_384, recreateDroppedPiece)

    expect(recreateDroppedPiece).not.toHaveBeenCalled()
    expect(activePieces.get(0)).toBeUndefined()
  })

  it('sends cancels for duplicate requests on streaming-now pieces outside global endgame', () => {
    const firstPeer = createFakePeer('1.2.3.4', 6881)
    const secondPeer = createFakePeer('2.3.4.5', 6882)
    firstPeer.peerId = new Uint8Array(20).fill(1)
    secondPeer.peerId = new Uint8Array(20).fill(2)
    ;(
      torrent as Torrent & { _swarm: { addIncomingConnection: (...args: unknown[]) => void } }
    )._swarm.addIncomingConnection(firstPeer.remoteAddress, firstPeer.remotePort, 'ipv4', firstPeer)
    ;(
      torrent as Torrent & { _swarm: { addIncomingConnection: (...args: unknown[]) => void } }
    )._swarm.addIncomingConnection(
      secondPeer.remoteAddress,
      secondPeer.remotePort,
      'ipv4',
      secondPeer,
    )

    const activePieces = new ActivePieceManager(engine, (index) => torrent.getPieceLength(index), {
      standardPieceLength: torrent.pieceLength,
    } satisfies Partial<ActivePieceConfig>)
    ;(torrent as Torrent & { activePieces: ActivePieceManager }).activePieces = activePieces

    const activePiece = activePieces.getOrCreate(0)
    expect(activePiece).toBeDefined()
    activePiece!.addRequest(0, toHex(firstPeer.peerId))
    activePiece!.addRequest(0, toHex(secondPeer.peerId))

    torrent.updateStreamingDemand('player', new Set([0]), 'now')

    const addBlock = vi.fn((piece, blockIndex, peerId) =>
      (
        piece as {
          addBlock: (blockIndex: number, data: Uint8Array, peerId: string) => boolean
        }
      ).addBlock(blockIndex, new Uint8Array(16_384), peerId),
    )

    invokeHandleBlockCommon(torrent, firstPeer, 0, 0, 16_384, addBlock)

    expect(addBlock).toHaveBeenCalledTimes(1)
    expect(secondPeer.sendCancel).toHaveBeenCalledWith(0, 0, 16_384)
    expect(firstPeer.sendCancel).not.toHaveBeenCalled()
  })
})
