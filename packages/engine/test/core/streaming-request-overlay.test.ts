import { describe, expect, it } from 'vitest'
import { ActivePieceManager } from '../../src/core/active-piece-manager'
import {
  buildStreamingOverlayPlan,
  STREAM_NOW_PRIORITY,
  STREAM_NOW_RESERVED_SLOTS,
} from '../../src/core/streaming-request-overlay'
import { BitField } from '../../src/utils/bitfield'
import { MockEngine } from '../utils/mock-engine'

describe('buildStreamingOverlayPlan', () => {
  it('prioritizes active now-pieces with peer affinity and finds new now candidates', () => {
    const engine = new MockEngine()
    const activePieces = new ActivePieceManager(engine, () => 32 * 1024, {
      standardPieceLength: 32 * 1024,
    })

    const piece0 = activePieces.getOrCreate(0)!
    piece0.addRequest(0, 'peer-1')
    const piece2 = activePieces.getOrCreate(2)!

    const peerBitfield = BitField.createEmpty(4)
    peerBitfield.set(0, true)
    peerBitfield.set(2, true)
    peerBitfield.set(3, true)

    const plan = buildStreamingOverlayPlan({
      peer: {
        peerChoking: false,
        bitfield: peerBitfield,
        isSeed: false,
        pipelineDepth: 4,
        requestsPending: 0,
        downloadSpeed: 256 * 1024,
        snubbed: false,
        inSlowStart: false,
        recordBlockReceived: () => {},
        sendRequests: () => {},
      },
      peerId: 'peer-1',
      activePieces,
      piecePriority: new Uint8Array([
        STREAM_NOW_PRIORITY,
        4,
        STREAM_NOW_PRIORITY,
        STREAM_NOW_PRIORITY,
      ]),
      availability: {
        rawAvailability: new Uint16Array([3, 5, 2, 1]),
        seedCount: 0,
        getPeerPieceSet: () => undefined,
      } as never,
      bitfield: BitField.createEmpty(4),
      pieceCount: 4,
      firstNeededPiece: 0,
      pipelineLimit: 4,
    })

    expect(plan.reservedSlots).toBe(STREAM_NOW_RESERVED_SLOTS)
    expect(plan.activePieces.map((piece) => piece.index)).toEqual([0, 2])
    expect(plan.newPieceIndices).toEqual([3])
  })

  it('returns no reservation when there are no now-priority pieces', () => {
    const engine = new MockEngine()
    const activePieces = new ActivePieceManager(engine, () => 32 * 1024)

    const peerBitfield = BitField.createEmpty(2)
    peerBitfield.set(0, true)
    peerBitfield.set(1, true)

    const plan = buildStreamingOverlayPlan({
      peer: {
        peerChoking: false,
        bitfield: peerBitfield,
        isSeed: false,
        pipelineDepth: 4,
        requestsPending: 0,
        downloadSpeed: 256 * 1024,
        snubbed: false,
        inSlowStart: false,
        recordBlockReceived: () => {},
        sendRequests: () => {},
      },
      peerId: 'peer-1',
      activePieces,
      piecePriority: new Uint8Array([6, 4]),
      availability: {
        rawAvailability: new Uint16Array([1, 1]),
        seedCount: 0,
        getPeerPieceSet: () => undefined,
      } as never,
      bitfield: BitField.createEmpty(2),
      pieceCount: 2,
      firstNeededPiece: 0,
      pipelineLimit: 4,
    })

    expect(plan).toEqual({
      reservedSlots: 0,
      activePieces: [],
      newPieceIndices: [],
    })
  })

  it('caps urgent reservation for slow or unproven peers', () => {
    const engine = new MockEngine()
    const activePieces = new ActivePieceManager(engine, () => 32 * 1024)
    const piece = activePieces.getOrCreate(0)!
    piece.addRequest(0, 'peer-1')

    const peerBitfield = BitField.createEmpty(2)
    peerBitfield.set(0, true)
    peerBitfield.set(1, true)

    const plan = buildStreamingOverlayPlan({
      peer: {
        peerChoking: false,
        bitfield: peerBitfield,
        isSeed: false,
        pipelineDepth: 4,
        requestsPending: 2,
        downloadSpeed: 16 * 1024,
        snubbed: false,
        inSlowStart: true,
        recordBlockReceived: () => {},
        sendRequests: () => {},
      },
      peerId: 'peer-1',
      activePieces,
      piecePriority: new Uint8Array([STREAM_NOW_PRIORITY, STREAM_NOW_PRIORITY]),
      availability: {
        rawAvailability: new Uint16Array([1, 1]),
        seedCount: 0,
        getPeerPieceSet: () => undefined,
      } as never,
      bitfield: BitField.createEmpty(2),
      pieceCount: 2,
      firstNeededPiece: 0,
      pipelineLimit: 4,
    })

    expect(plan.reservedSlots).toBe(1)
    expect(plan.activePieces.map((activePiece) => activePiece.index)).toEqual([0])
    expect(plan.newPieceIndices).toEqual([1])
  })
})
