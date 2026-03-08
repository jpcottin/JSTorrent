import { describe, it, expect, vi } from 'vitest'
import { ActivePieceManager } from '../../src/core/active-piece-manager'
import { BLOCK_SIZE } from '../../src/core/active-piece'
import { TorrentPieceRequester, type PieceRequesterDeps } from '../../src/core/piece-requester'
import { STREAM_NOW_PRIORITY } from '../../src/core/streaming-request-overlay'
import { BitField } from '../../src/utils/bitfield'
import { MockEngine } from '../utils/mock-engine'

function createEndgameManagerMock(options?: {
  isEndgame?: boolean
  maxDuplicateRequests?: number
  maxStreamingDuplicateRequests?: number
}) {
  const isEndgame = options?.isEndgame ?? false
  const maxDuplicateRequests = options?.maxDuplicateRequests ?? 2
  const maxStreamingDuplicateRequests = options?.maxStreamingDuplicateRequests ?? 2

  return {
    isEndgame,
    getConfig: () => ({ maxDuplicateRequests, maxStreamingDuplicateRequests }),
    shouldUseDuplicateRequests: (piecePriority: number) =>
      isEndgame || piecePriority === STREAM_NOW_PRIORITY,
    getMaxDuplicateRequestsForPiece: (piecePriority: number) => {
      if (isEndgame) return maxDuplicateRequests
      if (piecePriority === STREAM_NOW_PRIORITY) return maxStreamingDuplicateRequests
      return 0
    },
  }
}

describe('TorrentPieceRequester write-queue backpressure', () => {
  it('does not send new requests while write queue backpressure is active', () => {
    const engine = new MockEngine()
    const initActivePieces = vi.fn()
    const sendRequests = vi.fn()
    const ourBitfield = BitField.createEmpty(1)
    const peerBitfield = BitField.createEmpty(1)
    peerBitfield.set(0, true)

    const deps: PieceRequesterDeps = {
      getPieceCount: () => 1,
      getPieceLength: () => 16 * 1024,
      getPiecePriority: () => new Uint8Array([7]),
      getBitfield: () => ourBitfield,
      isKillSwitchEnabled: () => false,
      isNetworkActive: () => true,
      isWriteQueueBackpressured: () => true,
      hasMetadata: () => true,
      getConnectedPeerCount: () => 1,
      getCompletedPieceCount: () => 0,
      getFirstNeededPiece: () => 0,
      getStreamingSelectionHint: () => null,
      getActivePieces: () => undefined,
      initActivePieces,
      getAvailability: () =>
        ({
          rawAvailability: new Uint16Array([1]),
          seedCount: 0,
          getPeerPieceSet: () => undefined,
        }) as never,
      getEndgameManager: () => createEndgameManagerMock() as never,
      getMaxPipelineDepth: () => 10,
      isDownloadRateLimited: () => false,
      getDownloadRateLimit: () => 0,
      tryConsumeDownloadBandwidth: () => true,
      removePieceFromAllIndices: () => {},
      shouldAddToIndex: () => true,
      scheduleRateLimitRetry: () => true,
      onEndgameEvaluate: () => {},
      getPeerId: () => 'peer-1',
    }

    const requester = new TorrentPieceRequester(engine, deps)
    const peer = {
      peerId: undefined,
      remoteAddress: '127.0.0.1',
      remotePort: 6881,
      peerChoking: false,
      bitfield: peerBitfield,
      isSeed: false,
      pipelineDepth: 4,
      requestsPending: 0,
      downloadSpeed: 256 * 1024,
      snubbed: false,
      inSlowStart: false,
      recordBlockReceived: () => {},
      sendRequests,
    }

    requester.request(peer, Date.now())

    expect(initActivePieces).not.toHaveBeenCalled()
    expect(sendRequests).not.toHaveBeenCalled()
    expect(peer.requestsPending).toBe(0)
  })

  it('requests streaming-now pieces before existing normal partial work', () => {
    const engine = new MockEngine()
    const sentBatches: Array<Array<{ index: number; begin: number; length: number }>> = []
    const sendRequests = vi.fn(
      (requests: Array<{ index: number; begin: number; length: number }>) => {
        sentBatches.push(requests.map((request) => ({ ...request })))
      },
    )
    const activePieces = new ActivePieceManager(engine, () => 32 * 1024, {
      standardPieceLength: 32 * 1024,
    })
    activePieces.getOrCreate(1)

    const ourBitfield = BitField.createEmpty(2)
    const peerBitfield = BitField.createEmpty(2)
    peerBitfield.set(0, true)
    peerBitfield.set(1, true)

    const deps: PieceRequesterDeps = {
      getPieceCount: () => 2,
      getPieceLength: () => 32 * 1024,
      getPiecePriority: () => new Uint8Array([7, 4]),
      getBitfield: () => ourBitfield,
      isKillSwitchEnabled: () => false,
      isNetworkActive: () => true,
      isWriteQueueBackpressured: () => false,
      hasMetadata: () => true,
      getConnectedPeerCount: () => 2,
      getCompletedPieceCount: () => 0,
      getFirstNeededPiece: () => 0,
      getStreamingSelectionHint: () => null,
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getAvailability: () =>
        ({
          rawAvailability: new Uint16Array([1, 1]),
          seedCount: 0,
          getPeerPieceSet: () => undefined,
        }) as never,
      getEndgameManager: () => createEndgameManagerMock() as never,
      getMaxPipelineDepth: () => 4,
      isDownloadRateLimited: () => false,
      getDownloadRateLimit: () => 0,
      tryConsumeDownloadBandwidth: () => true,
      removePieceFromAllIndices: () => {},
      shouldAddToIndex: () => true,
      scheduleRateLimitRetry: () => true,
      onEndgameEvaluate: () => {},
      getPeerId: () => 'peer-1',
    }

    const requester = new TorrentPieceRequester(engine, deps)
    const peer = {
      peerId: undefined,
      remoteAddress: '127.0.0.1',
      remotePort: 6881,
      peerChoking: false,
      bitfield: peerBitfield,
      isSeed: false,
      pipelineDepth: 4,
      requestsPending: 0,
      downloadSpeed: 256 * 1024,
      snubbed: false,
      inSlowStart: false,
      recordBlockReceived: () => {},
      sendRequests,
    }

    requester.request(peer, Date.now())

    expect(sendRequests).toHaveBeenCalledTimes(1)
    expect(sentBatches[0].map((request) => request.index)).toEqual([0, 0, 1, 1])
  })

  it('limits urgent requests on slow-start peers to one slot before normal work', () => {
    const engine = new MockEngine()
    const sentBatches: Array<Array<{ index: number; begin: number; length: number }>> = []
    const sendRequests = vi.fn(
      (requests: Array<{ index: number; begin: number; length: number }>) => {
        sentBatches.push(requests.map((request) => ({ ...request })))
      },
    )
    const activePieces = new ActivePieceManager(engine, () => 32 * 1024, {
      standardPieceLength: 32 * 1024,
    })
    activePieces.getOrCreate(1)

    const ourBitfield = BitField.createEmpty(2)
    const peerBitfield = BitField.createEmpty(2)
    peerBitfield.set(0, true)
    peerBitfield.set(1, true)

    const deps: PieceRequesterDeps = {
      getPieceCount: () => 2,
      getPieceLength: () => 32 * 1024,
      getPiecePriority: () => new Uint8Array([7, 4]),
      getBitfield: () => ourBitfield,
      isKillSwitchEnabled: () => false,
      isNetworkActive: () => true,
      isWriteQueueBackpressured: () => false,
      hasMetadata: () => true,
      getConnectedPeerCount: () => 2,
      getCompletedPieceCount: () => 0,
      getFirstNeededPiece: () => 0,
      getStreamingSelectionHint: () => null,
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getAvailability: () =>
        ({
          rawAvailability: new Uint16Array([1, 1]),
          seedCount: 0,
          getPeerPieceSet: () => undefined,
        }) as never,
      getEndgameManager: () => createEndgameManagerMock() as never,
      getMaxPipelineDepth: () => 4,
      isDownloadRateLimited: () => false,
      getDownloadRateLimit: () => 0,
      tryConsumeDownloadBandwidth: () => true,
      removePieceFromAllIndices: () => {},
      shouldAddToIndex: () => true,
      scheduleRateLimitRetry: () => true,
      onEndgameEvaluate: () => {},
      getPeerId: () => 'peer-1',
    }

    const requester = new TorrentPieceRequester(engine, deps)
    const peer = {
      peerId: undefined,
      remoteAddress: '127.0.0.1',
      remotePort: 6881,
      peerChoking: false,
      bitfield: peerBitfield,
      isSeed: false,
      pipelineDepth: 4,
      requestsPending: 0,
      downloadSpeed: 16 * 1024,
      snubbed: false,
      inSlowStart: true,
      recordBlockReceived: () => {},
      sendRequests,
    }

    requester.request(peer, Date.now())

    expect(sendRequests).toHaveBeenCalledTimes(1)
    expect(sentBatches[0].map((request) => request.index)).toEqual([0, 1, 1])
  })

  it('issues duplicate requests for fully-requested streaming-now pieces outside global endgame', () => {
    const engine = new MockEngine()
    const sentBatches: Array<Array<{ index: number; begin: number; length: number }>> = []
    const sendRequests = vi.fn(
      (requests: Array<{ index: number; begin: number; length: number }>) => {
        sentBatches.push(requests.map((request) => ({ ...request })))
      },
    )
    const activePieces = new ActivePieceManager(engine, () => 32 * 1024, {
      standardPieceLength: 32 * 1024,
    })
    const piece = activePieces.getOrCreate(0)!
    piece.addRequest(0, 'peer-1')
    piece.addRequest(1, 'peer-1')
    activePieces.promoteToFullyRequested(0)

    const ourBitfield = BitField.createEmpty(1)
    const peerBitfield = BitField.createEmpty(1)
    peerBitfield.set(0, true)

    const deps: PieceRequesterDeps = {
      getPieceCount: () => 1,
      getPieceLength: () => 32 * 1024,
      getPiecePriority: () => new Uint8Array([STREAM_NOW_PRIORITY]),
      getBitfield: () => ourBitfield,
      isKillSwitchEnabled: () => false,
      isNetworkActive: () => true,
      isWriteQueueBackpressured: () => false,
      hasMetadata: () => true,
      getConnectedPeerCount: () => 2,
      getCompletedPieceCount: () => 0,
      getFirstNeededPiece: () => 0,
      getStreamingSelectionHint: () => null,
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getAvailability: () =>
        ({
          rawAvailability: new Uint16Array([1]),
          seedCount: 0,
          getPeerPieceSet: () => undefined,
        }) as never,
      getEndgameManager: () => createEndgameManagerMock() as never,
      getMaxPipelineDepth: () => 4,
      isDownloadRateLimited: () => false,
      getDownloadRateLimit: () => 0,
      tryConsumeDownloadBandwidth: () => true,
      removePieceFromAllIndices: () => {},
      shouldAddToIndex: () => true,
      scheduleRateLimitRetry: () => true,
      onEndgameEvaluate: () => {},
      getPeerId: () => 'peer-2',
    }

    const requester = new TorrentPieceRequester(engine, deps)
    const peer = {
      peerId: undefined,
      remoteAddress: '127.0.0.1',
      remotePort: 6881,
      peerChoking: false,
      bitfield: peerBitfield,
      isSeed: false,
      pipelineDepth: 4,
      requestsPending: 0,
      downloadSpeed: 256 * 1024,
      snubbed: false,
      inSlowStart: false,
      recordBlockReceived: () => {},
      sendRequests,
    }

    requester.request(peer, Date.now())

    expect(sendRequests).toHaveBeenCalledTimes(1)
    expect(sentBatches[0]).toEqual([
      { index: 0, begin: 0, length: BLOCK_SIZE },
      { index: 0, begin: BLOCK_SIZE, length: BLOCK_SIZE },
    ])
  })

  it('does not duplicate fully-requested non-streaming pieces before global endgame', () => {
    const engine = new MockEngine()
    const sendRequests = vi.fn()
    const activePieces = new ActivePieceManager(engine, () => 32 * 1024, {
      standardPieceLength: 32 * 1024,
    })
    const piece = activePieces.getOrCreate(0)!
    piece.addRequest(0, 'peer-1')
    piece.addRequest(1, 'peer-1')
    activePieces.promoteToFullyRequested(0)

    const ourBitfield = BitField.createEmpty(1)
    const peerBitfield = BitField.createEmpty(1)
    peerBitfield.set(0, true)

    const deps: PieceRequesterDeps = {
      getPieceCount: () => 1,
      getPieceLength: () => 32 * 1024,
      getPiecePriority: () => new Uint8Array([4]),
      getBitfield: () => ourBitfield,
      isKillSwitchEnabled: () => false,
      isNetworkActive: () => true,
      isWriteQueueBackpressured: () => false,
      hasMetadata: () => true,
      getConnectedPeerCount: () => 2,
      getCompletedPieceCount: () => 0,
      getFirstNeededPiece: () => 0,
      getStreamingSelectionHint: () => null,
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getAvailability: () =>
        ({
          rawAvailability: new Uint16Array([1]),
          seedCount: 0,
          getPeerPieceSet: () => undefined,
        }) as never,
      getEndgameManager: () => createEndgameManagerMock() as never,
      getMaxPipelineDepth: () => 4,
      isDownloadRateLimited: () => false,
      getDownloadRateLimit: () => 0,
      tryConsumeDownloadBandwidth: () => true,
      removePieceFromAllIndices: () => {},
      shouldAddToIndex: () => true,
      scheduleRateLimitRetry: () => true,
      onEndgameEvaluate: () => {},
      getPeerId: () => 'peer-2',
    }

    const requester = new TorrentPieceRequester(engine, deps)
    const peer = {
      peerId: undefined,
      remoteAddress: '127.0.0.1',
      remotePort: 6881,
      peerChoking: false,
      bitfield: peerBitfield,
      isSeed: false,
      pipelineDepth: 4,
      requestsPending: 0,
      downloadSpeed: 256 * 1024,
      snubbed: false,
      inSlowStart: false,
      recordBlockReceived: () => {},
      sendRequests,
    }

    requester.request(peer, Date.now())

    expect(sendRequests).not.toHaveBeenCalled()
  })

  it('prefers later next-priority pieces over earlier same-file backfill when activating new work', () => {
    const engine = new MockEngine()
    const sentBatches: Array<Array<{ index: number; begin: number; length: number }>> = []
    const sendRequests = vi.fn(
      (requests: Array<{ index: number; begin: number; length: number }>) => {
        sentBatches.push(requests.map((request) => ({ ...request })))
      },
    )
    const activePieces = new ActivePieceManager(engine, () => 32 * 1024, {
      standardPieceLength: 32 * 1024,
    })

    const piecePriority = new Uint8Array(12).fill(5)
    piecePriority[10] = 6
    piecePriority[11] = 6

    const ourBitfield = BitField.createEmpty(12)
    const peerBitfield = BitField.createEmpty(12)
    for (let i = 0; i < 12; i++) {
      peerBitfield.set(i, true)
    }

    const peerPieceSet = new Set<number>()
    for (let i = 0; i < 12; i++) {
      peerPieceSet.add(i)
    }

    const deps: PieceRequesterDeps = {
      getPieceCount: () => 12,
      getPieceLength: () => 32 * 1024,
      getPiecePriority: () => piecePriority,
      getBitfield: () => ourBitfield,
      isKillSwitchEnabled: () => false,
      isNetworkActive: () => true,
      isWriteQueueBackpressured: () => false,
      hasMetadata: () => true,
      getConnectedPeerCount: () => 2,
      getCompletedPieceCount: () => 0,
      getFirstNeededPiece: () => 0,
      getStreamingSelectionHint: () => ({
        nextStartPiece: 10,
        nextEndPiece: 11,
        fileStartPiece: 0,
        fileEndPiece: 11,
      }),
      getActivePieces: () => activePieces,
      initActivePieces: () => activePieces,
      getAvailability: () =>
        ({
          rawAvailability: new Uint16Array(12).fill(1),
          seedCount: 0,
          getPeerPieceSet: () => peerPieceSet,
        }) as never,
      getEndgameManager: () => createEndgameManagerMock() as never,
      getMaxPipelineDepth: () => 4,
      isDownloadRateLimited: () => false,
      getDownloadRateLimit: () => 0,
      tryConsumeDownloadBandwidth: () => true,
      removePieceFromAllIndices: () => {},
      shouldAddToIndex: () => true,
      scheduleRateLimitRetry: () => true,
      onEndgameEvaluate: () => {},
      getPeerId: () => 'peer-1',
    }

    const requester = new TorrentPieceRequester(engine, deps)
    const peer = {
      peerId: undefined,
      remoteAddress: '127.0.0.1',
      remotePort: 6881,
      peerChoking: false,
      bitfield: peerBitfield,
      isSeed: false,
      pipelineDepth: 4,
      requestsPending: 0,
      downloadSpeed: 256 * 1024,
      snubbed: false,
      inSlowStart: false,
      recordBlockReceived: () => {},
      sendRequests,
    }

    requester.request(peer, Date.now())

    expect(sendRequests).toHaveBeenCalledTimes(1)
    expect(sentBatches[0].map((request) => request.index)).toEqual([10, 10, 11, 11])
  })
})
