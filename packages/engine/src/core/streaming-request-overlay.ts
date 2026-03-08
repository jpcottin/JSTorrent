import type { ActivePiece } from './active-piece'
import { ActivePieceManager } from './active-piece-manager'
import { PieceAvailability } from './piece-availability'
import type { RequestablePeer } from './piece-requester'
import { BitField } from '../utils/bitfield'

export const STREAM_NOW_PRIORITY = 7
export const STREAM_NOW_RESERVED_SLOTS = 2
const PRIO_LEVELS = 8
const PRIO_FACTOR = 3

export interface StreamingOverlayPlan {
  reservedSlots: number
  activePieces: ActivePiece[]
  newPieceIndices: number[]
}

export interface StreamingOverlayInput {
  peer: RequestablePeer
  peerId: string
  activePieces: ActivePieceManager
  piecePriority: Uint8Array | null
  availability: PieceAvailability
  bitfield: BitField | undefined
  pieceCount: number
  firstNeededPiece: number
  pipelineLimit: number
}

export function buildStreamingOverlayPlan(input: StreamingOverlayInput): StreamingOverlayPlan {
  const {
    peer,
    peerId,
    activePieces,
    piecePriority,
    availability,
    bitfield,
    pieceCount,
    firstNeededPiece,
    pipelineLimit,
  } = input

  if (!piecePriority || pipelineLimit <= 0) {
    return { reservedSlots: 0, activePieces: [], newPieceIndices: [] }
  }

  const peerBitfield = peer.bitfield
  const rawAvailability = availability.rawAvailability
  const activeNowPieces: ActivePiece[] = []

  if (rawAvailability) {
    const sorted = activePieces.getPartialsRarestFirst(
      rawAvailability,
      availability.seedCount,
      piecePriority,
    )
    for (const piece of sorted) {
      if (piecePriority[piece.index] !== STREAM_NOW_PRIORITY) continue
      if (!peer.isSeed && !peerBitfield?.get(piece.index)) continue
      activeNowPieces.push(piece)
    }
    activeNowPieces.sort((a, b) => {
      const aAffinity = a.hasRequestsFromPeer(peerId) ? 0 : 1
      const bAffinity = b.hasRequestsFromPeer(peerId) ? 0 : 1
      return aAffinity - bAffinity
    })
  } else {
    for (const piece of activePieces.partialValues()) {
      if (piecePriority[piece.index] !== STREAM_NOW_PRIORITY) continue
      if (!peer.isSeed && !peerBitfield?.get(piece.index)) continue
      activeNowPieces.push(piece)
    }
    activeNowPieces.sort((a, b) => {
      const aAffinity = a.hasRequestsFromPeer(peerId) ? 0 : 1
      const bAffinity = b.hasRequestsFromPeer(peerId) ? 0 : 1
      return aAffinity - bAffinity
    })
  }

  const newPieceIndices = findNewStreamingPieceCandidates({
    peer,
    peerId,
    activePieces,
    piecePriority,
    availability,
    bitfield,
    pieceCount,
    firstNeededPiece,
    maxCount: STREAM_NOW_RESERVED_SLOTS,
  })

  if (activeNowPieces.length === 0 && newPieceIndices.length === 0) {
    return { reservedSlots: 0, activePieces: [], newPieceIndices: [] }
  }

  return {
    reservedSlots: Math.min(STREAM_NOW_RESERVED_SLOTS, pipelineLimit),
    activePieces: activeNowPieces,
    newPieceIndices,
  }
}

interface FindStreamingCandidatesInput {
  peer: RequestablePeer
  peerId: string
  activePieces: ActivePieceManager
  piecePriority: Uint8Array
  availability: PieceAvailability
  bitfield: BitField | undefined
  pieceCount: number
  firstNeededPiece: number
  maxCount: number
}

function findNewStreamingPieceCandidates(input: FindStreamingCandidatesInput): number[] {
  const {
    peer,
    peerId,
    activePieces,
    piecePriority,
    availability,
    bitfield,
    pieceCount,
    firstNeededPiece,
    maxCount,
  } = input

  if (!bitfield || maxCount <= 0) return []

  const availabilityArray = availability.rawAvailability
  const seedCount = availability.seedCount
  const candidates: Array<{ index: number; sortKey: number }> = []
  const collectLimit = maxCount * 2
  const peerPieceSet = availability.getPeerPieceSet(peerId)

  if (!peer.isSeed && peerPieceSet && peerPieceSet.size > 0 && availabilityArray) {
    for (const i of peerPieceSet) {
      if (candidates.length >= collectLimit) break
      if (bitfield.get(i)) continue
      if (piecePriority[i] !== STREAM_NOW_PRIORITY) continue
      if (activePieces.has(i)) continue

      const pieceAvail = availabilityArray[i] + seedCount
      const sortKey = pieceAvail * (PRIO_LEVELS - piecePriority[i]) * PRIO_FACTOR
      candidates.push({ index: i, sortKey })
    }
  } else {
    const peerBitfield = peer.bitfield
    for (let i = firstNeededPiece; i < pieceCount && candidates.length < collectLimit; i++) {
      if (bitfield.get(i)) continue
      if (!peer.isSeed && !peerBitfield?.get(i)) continue
      if (piecePriority[i] !== STREAM_NOW_PRIORITY) continue
      if (activePieces.has(i)) continue

      const pieceAvail = availabilityArray ? availabilityArray[i] + seedCount : seedCount
      const sortKey = pieceAvail * (PRIO_LEVELS - piecePriority[i]) * PRIO_FACTOR
      candidates.push({ index: i, sortKey })
    }
  }

  candidates.sort((a, b) => a.sortKey - b.sortKey)
  return candidates.slice(0, maxCount).map((candidate) => candidate.index)
}
