import { describe, it, expect, vi } from 'vitest'
import { TorrentPieceRequester, type PieceRequesterDeps } from '../../src/core/piece-requester'
import { BitField } from '../../src/utils/bitfield'
import { MockEngine } from '../utils/mock-engine'

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
      getActivePieces: () => undefined,
      initActivePieces,
      getAvailability: () =>
        ({
          rawAvailability: new Uint16Array([1]),
          seedCount: 0,
          getPeerPieceSet: () => undefined,
        }) as never,
      getEndgameManager: () =>
        ({
          isEndgame: false,
          getConfig: () => ({ maxDuplicateRequests: 2 }),
        }) as never,
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
      recordBlockReceived: () => {},
      sendRequests,
    }

    requester.request(peer, Date.now())

    expect(initActivePieces).not.toHaveBeenCalled()
    expect(sendRequests).not.toHaveBeenCalled()
    expect(peer.requestsPending).toBe(0)
  })
})
