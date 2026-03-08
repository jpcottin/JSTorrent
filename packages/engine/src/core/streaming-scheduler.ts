export type StreamingDemandUrgency = 'metadata' | 'next' | 'file' | 'now'

export interface StreamingDemand {
  token: string
  urgency: StreamingDemandUrgency
  pieces: Set<number>
}

export interface ActivePieceRequestSnapshot {
  blockIndex: number
  peerId: string
}

export interface ActivePieceSnapshot {
  index: number
  state: 'partial' | 'fullyRequested' | 'fullyResponded'
  blocksReceived: number
  blocksNeeded: number
  outstandingRequests: number
  requests: ActivePieceRequestSnapshot[]
}

export interface StreamingPlannerInput {
  piecesCount: number
  basePiecePriority: Uint8Array | null
  demands: StreamingDemand[]
  activePieces: ActivePieceSnapshot[]
}

export interface StreamingPlan {
  effectivePriority: Uint8Array | null
  protectedPieces: Set<number>
  suppressedPieces: Set<number>
  dropPieceIndices: number[]
}

const PRIORITY_SKIP = 0
const PRIORITY_METADATA = 5
const PRIORITY_FILE = 5
const PRIORITY_NEXT = 6
const PRIORITY_NOW = 7
const LOW_PROGRESS_PARTIAL_DROP_THRESHOLD = 0.25

function urgencyToPriority(urgency: StreamingDemandUrgency): number {
  switch (urgency) {
    case 'metadata':
      return PRIORITY_METADATA
    case 'file':
      return PRIORITY_FILE
    case 'next':
      return PRIORITY_NEXT
    case 'now':
      return PRIORITY_NOW
  }
}

export function buildStreamingPlan(input: StreamingPlannerInput): StreamingPlan {
  const { piecesCount, basePiecePriority, demands, activePieces } = input

  if (!basePiecePriority || piecesCount === 0) {
    return {
      effectivePriority: basePiecePriority,
      protectedPieces: new Set(),
      suppressedPieces: new Set(),
      dropPieceIndices: [],
    }
  }

  if (demands.length === 0) {
    return {
      effectivePriority: basePiecePriority,
      protectedPieces: new Set(),
      suppressedPieces: new Set(),
      dropPieceIndices: [],
    }
  }

  const effectivePriority = new Uint8Array(basePiecePriority)
  const protectedPieces = new Set<number>()
  let hasNowDemand = false
  let hasNextDemand = false
  let hasFileDemand = false

  for (const demand of demands) {
    const demandPriority = urgencyToPriority(demand.urgency)
    if (demand.urgency === 'now' && demand.pieces.size > 0) {
      hasNowDemand = true
    }
    if (demand.urgency === 'next' && demand.pieces.size > 0) {
      hasNextDemand = true
    }
    if (demand.urgency === 'file' && demand.pieces.size > 0) {
      hasFileDemand = true
    }

    for (const pieceIndex of demand.pieces) {
      if (pieceIndex < 0 || pieceIndex >= piecesCount) continue
      if (basePiecePriority[pieceIndex] === PRIORITY_SKIP) continue
      protectedPieces.add(pieceIndex)
      effectivePriority[pieceIndex] = Math.max(effectivePriority[pieceIndex], demandPriority)
    }
  }

  const suppressedPieces = new Set<number>()
  const dropPieceIndices: number[] = []

  if (hasNowDemand || hasFileDemand) {
    for (const piece of activePieces) {
      if (protectedPieces.has(piece.index)) continue
      if (piece.state === 'fullyResponded') continue

      const completionRatio = piece.blocksNeeded > 0 ? piece.blocksReceived / piece.blocksNeeded : 0
      const shouldDrop =
        piece.state === 'fullyRequested' ||
        (piece.state === 'partial' && completionRatio <= LOW_PROGRESS_PARTIAL_DROP_THRESHOLD)

      if (!shouldDrop) continue

      suppressedPieces.add(piece.index)
      dropPieceIndices.push(piece.index)
    }
  }

  for (const pieceIndex of suppressedPieces) {
    if (pieceIndex < 0 || pieceIndex >= piecesCount) continue
    effectivePriority[pieceIndex] = PRIORITY_SKIP
  }

  return {
    effectivePriority,
    protectedPieces,
    suppressedPieces,
    dropPieceIndices,
  }
}

export class StreamingScheduler {
  private readonly demands = new Map<string, StreamingDemand>()
  private currentPlan: StreamingPlan = {
    effectivePriority: null,
    protectedPieces: new Set(),
    suppressedPieces: new Set(),
    dropPieceIndices: [],
  }

  updateDemand(
    token: string,
    pieces: Set<number> | null,
    urgency: StreamingDemandUrgency = 'now',
  ): boolean {
    const previous = this.demands.get(token)

    if (!pieces || pieces.size === 0) {
      if (!previous) return false
      this.demands.delete(token)
      return true
    }

    const nextPieces = new Set(pieces)
    if (
      previous &&
      previous.urgency === urgency &&
      previous.pieces.size === nextPieces.size &&
      [...nextPieces].every((piece) => previous.pieces.has(piece))
    ) {
      return false
    }

    this.demands.set(token, { token, urgency, pieces: nextPieces })
    return true
  }

  setLegacyPieces(pieces: Set<number> | null): boolean {
    return this.updateDemand('__legacy__', pieces, 'now')
  }

  buildPlan(input: Omit<StreamingPlannerInput, 'demands'>): {
    previousSuppressedPieces: Set<number>
    plan: StreamingPlan
  } {
    const previousSuppressedPieces = new Set(this.currentPlan.suppressedPieces)
    const plan = buildStreamingPlan({
      ...input,
      demands: [...this.demands.values()],
    })
    this.retainSuppressedPieces(previousSuppressedPieces, plan)
    this.currentPlan = plan
    return {
      previousSuppressedPieces,
      plan: this.currentPlan,
    }
  }

  private retainSuppressedPieces(
    previousSuppressedPieces: Set<number>,
    plan: StreamingPlan,
  ): void {
    if (!plan.effectivePriority || previousSuppressedPieces.size === 0) return

    let shouldRetain = false
    for (const demand of this.demands.values()) {
      if (
        demand.urgency === 'now' ||
        demand.urgency === 'next' ||
        demand.urgency === 'file'
      ) {
        shouldRetain = true
        break
      }
    }
    if (!shouldRetain) return

    for (const pieceIndex of previousSuppressedPieces) {
      if (pieceIndex < 0 || pieceIndex >= plan.effectivePriority.length) continue
      if (plan.protectedPieces.has(pieceIndex)) continue
      plan.suppressedPieces.add(pieceIndex)
      plan.effectivePriority[pieceIndex] = PRIORITY_SKIP
    }
  }

  clear(): void {
    this.demands.clear()
    this.currentPlan = {
      effectivePriority: null,
      protectedPieces: new Set(),
      suppressedPieces: new Set(),
      dropPieceIndices: [],
    }
  }

  get hasDemands(): boolean {
    return this.demands.size > 0
  }

  get effectivePriority(): Uint8Array | null {
    return this.currentPlan.effectivePriority
  }

  isPieceSuppressed(pieceIndex: number): boolean {
    return this.currentPlan.suppressedPieces.has(pieceIndex)
  }
}
