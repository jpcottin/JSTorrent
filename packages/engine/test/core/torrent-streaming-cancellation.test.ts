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

function createSingleFileTorrent(engine: MockEngine): Torrent {
  const torrent = new Torrent(
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
  return torrent
}

function createMultiFileTorrent(engine: MockEngine): Torrent {
  const PIECE_LENGTH = 16_384
  const torrent = new Torrent(
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

  // 4 pieces × 16KB = 64KB total
  // File A: pieces 0-1 (32KB), File B: pieces 2-3 (32KB)
  const files = [
    { offset: 0, length: 32_768, path: 'video.mkv' },
    { offset: 32_768, length: 32_768, path: 'extras.mkv' },
  ]
  const pieceHashes = Array.from({ length: 4 }, () => new Uint8Array(20))
  torrent.initBitfield(4)
  torrent.initPieceInfo(pieceHashes, PIECE_LENGTH, PIECE_LENGTH)
  torrent.contentStorage = {
    filesList: files,
    setFilePriorities: vi.fn(),
    fileBytesToPieces: (_fileIndex: number, offset: number, length: number) => {
      const fileOffset = files[_fileIndex].offset
      const absStart = fileOffset + offset
      const absEnd = fileOffset + offset + length
      const first = Math.floor(absStart / PIECE_LENGTH)
      const last = Math.floor((absEnd - 1) / PIECE_LENGTH)
      const pieces: number[] = []
      for (let i = first; i <= last; i++) pieces.push(i)
      return pieces
    },
  } as Torrent['contentStorage']
  torrent.initFilePriorities()
  return torrent
}

describe('Torrent streaming cancellation', () => {
  let engine: MockEngine
  let torrent: Torrent

  beforeEach(() => {
    engine = new MockEngine()
    torrent = createSingleFileTorrent(engine)
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

  it('does not set file lock when streaming a completed file, leaving other files downloadable', () => {
    const multiTorrent = createMultiFileTorrent(engine)

    // Mark file A's pieces (0 and 1) as complete.
    // Must access .files first to populate _files, then call the private helper
    // to update downloaded bytes (markPieceVerified alone doesn't update file progress).
    void multiTorrent.files
    multiTorrent.markPieceVerified(0)
    ;(
      multiTorrent as Torrent & { updateFileProgressForVerifiedPiece: (i: number) => void }
    ).updateFileProgressForVerifiedPiece(0)
    multiTorrent.markPieceVerified(1)
    ;(
      multiTorrent as Torrent & { updateFileProgressForVerifiedPiece: (i: number) => void }
    ).updateFileProgressForVerifiedPiece(1)

    expect(multiTorrent.files[0].isComplete).toBe(true)
    expect(multiTorrent.files[1].isComplete).toBe(false)

    const prio = () =>
      (multiTorrent as Torrent & { piecePriority: Uint8Array | null }).piecePriority

    // All pieces should be at normal priority (4) before streaming
    // (pieces 0-1 are complete so won't be requested anyway, but priority is still 4)
    expect(prio()).toEqual(new Uint8Array([4, 4, 4, 4]))

    // Stream file A (which is already complete) — lock should be skipped
    multiTorrent.updateStreamingFileLock('player-file', 0)

    // File B's pieces (2, 3) should still be at normal priority, not zeroed out
    expect(prio()![2]).toBe(4)
    expect(prio()![3]).toBe(4)
  })

  it('unsuppresses other files when streamed file completes while session demands remain', () => {
    const multiTorrent = createMultiFileTorrent(engine)
    const scheduler = (
      multiTorrent as Torrent & {
        _streamingScheduler: {
          isPieceSuppressed: (i: number) => boolean
        }
      }
    )._streamingScheduler

    const prio = () =>
      (multiTorrent as Torrent & { piecePriority: Uint8Array | null }).piecePriority

    // Set up active piece on file B (piece 2) that will get suppressed
    const activePieces = new ActivePieceManager(
      engine,
      (index) => multiTorrent.getPieceLength(index),
      { standardPieceLength: multiTorrent.pieceLength } satisfies Partial<ActivePieceConfig>,
    )
    ;(multiTorrent as Torrent & { activePieces: ActivePieceManager }).activePieces = activePieces
    const piece2 = activePieces.getOrCreate(2)!
    piece2.addRequest(0, 'peer-a')
    activePieces.promoteToFullyRequested(2)

    // Force lazy init of _files so updateFileProgressForVerifiedPiece can update them
    const filesRef = multiTorrent.files
    expect(filesRef.length).toBe(2)
    expect(filesRef[0].isComplete).toBe(false)

    // 1. Start streaming file A (incomplete): set file lock + now demand
    multiTorrent.updateStreamingFileLock('player-file', 0)
    multiTorrent.updateStreamingDemand('player-now', new Set([0]), 'now')

    // File B's piece 2 should be suppressed (file lock zeroed non-locked pieces,
    // now demand triggered suppression of the active piece)
    expect(prio()![2]).toBe(0)
    expect(scheduler.isPieceSuppressed(2)).toBe(true)

    // Verify _files is still the same cached array
    expect(multiTorrent.files).toBe(filesRef)

    // Helper to simulate piece completion (markPieceVerified + file progress update)
    const completePiece = (i: number) => {
      multiTorrent.markPieceVerified(i)
      ;(
        multiTorrent as Torrent & { updateFileProgressForVerifiedPiece: (i: number) => void }
      ).updateFileProgressForVerifiedPiece(i)
    }

    // 2. File A completes during streaming
    completePiece(0)
    expect(filesRef[0].downloaded).toBe(16_384)
    completePiece(1)
    expect(filesRef[0].downloaded).toBe(32_768)
    expect(filesRef[0].isComplete).toBe(true)

    // cleanupCompletedStreamingFileLocks ran via updateFileProgressForVerifiedPiece →
    // file lock removed → base priority for piece 2 restored to 4.
    // retainSuppressedPieces should NOT keep piece 2 suppressed because its base
    // priority is now non-zero (wanted), even though 'now' demand still exists.
    expect(prio()![2]).toBe(4)
    expect(scheduler.isPieceSuppressed(2)).toBe(false)

    // 3. Session closes — clears remaining demands (should be a no-op for piece 2)
    multiTorrent.updateStreamingDemand('player-now', null, 'now')

    // Piece 2 stays at normal priority
    expect(prio()![2]).toBe(4)
    expect(scheduler.isPieceSuppressed(2)).toBe(false)
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
