import { describe, expect, it } from 'vitest'
import { buildStreamingPlan, StreamingScheduler } from '../../src/core/streaming-scheduler'

describe('buildStreamingPlan', () => {
  it('returns base priority unchanged when there are no streaming demands', () => {
    const basePriority = new Uint8Array([4, 4, 0, 6])

    const plan = buildStreamingPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      demands: [],
      activePieces: [],
    })

    expect(plan.effectivePriority).toBe(basePriority)
    expect(plan.dropPieceIndices).toEqual([])
    expect(plan.suppressedPieces.size).toBe(0)
  })

  it('boosts demanded pieces and drops non-critical active work including low-progress partials', () => {
    const basePriority = new Uint8Array(12).fill(4)

    const plan = buildStreamingPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      demands: [{ token: 'player', urgency: 'now', pieces: new Set([8, 9]) }],
      activePieces: [
        {
          index: 2,
          state: 'fullyRequested',
          blocksReceived: 4,
          blocksNeeded: 16,
          outstandingRequests: 12,
          requests: [{ blockIndex: 0, peerId: 'peer-1' }],
        },
        {
          index: 3,
          state: 'partial',
          blocksReceived: 0,
          blocksNeeded: 16,
          outstandingRequests: 2,
          requests: [{ blockIndex: 1, peerId: 'peer-2' }],
        },
        {
          index: 4,
          state: 'partial',
          blocksReceived: 3,
          blocksNeeded: 16,
          outstandingRequests: 3,
          requests: [{ blockIndex: 2, peerId: 'peer-3' }],
        },
        {
          index: 5,
          state: 'partial',
          blocksReceived: 5,
          blocksNeeded: 16,
          outstandingRequests: 3,
          requests: [{ blockIndex: 3, peerId: 'peer-4' }],
        },
      ],
    })

    expect(plan.effectivePriority?.[8]).toBe(7)
    expect(plan.effectivePriority?.[9]).toBe(7)
    expect(plan.effectivePriority?.[2]).toBe(0)
    expect(plan.effectivePriority?.[3]).toBe(0)
    expect(plan.effectivePriority?.[4]).toBe(0)
    expect(plan.effectivePriority?.[5]).toBe(4)
    expect(plan.dropPieceIndices.sort((a, b) => a - b)).toEqual([2, 3, 4])
    expect(plan.suppressedPieces.has(2)).toBe(true)
    expect(plan.suppressedPieces.has(3)).toBe(true)
    expect(plan.suppressedPieces.has(4)).toBe(true)
    expect(plan.suppressedPieces.has(5)).toBe(false)
  })

  it('uses urgency tiers when merging multiple demand windows', () => {
    const basePriority = new Uint8Array([4, 4, 4])

    const plan = buildStreamingPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      demands: [
        { token: 'metadata', urgency: 'metadata', pieces: new Set([0]) },
        { token: 'read-ahead', urgency: 'next', pieces: new Set([1]) },
        { token: 'player', urgency: 'now', pieces: new Set([2]) },
      ],
      activePieces: [],
    })

    expect(plan.effectivePriority?.[0]).toBe(5)
    expect(plan.effectivePriority?.[1]).toBe(6)
    expect(plan.effectivePriority?.[2]).toBe(7)
  })

  it('does not drop protected or fully responded pieces during now-demand preemption', () => {
    const basePriority = new Uint8Array(8).fill(4)

    const plan = buildStreamingPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      demands: [{ token: 'player', urgency: 'now', pieces: new Set([2]) }],
      activePieces: [
        {
          index: 2,
          state: 'partial',
          blocksReceived: 1,
          blocksNeeded: 16,
          outstandingRequests: 2,
          requests: [{ blockIndex: 0, peerId: 'peer-1' }],
        },
        {
          index: 3,
          state: 'fullyResponded',
          blocksReceived: 16,
          blocksNeeded: 16,
          outstandingRequests: 0,
          requests: [],
        },
        {
          index: 4,
          state: 'partial',
          blocksReceived: 1,
          blocksNeeded: 16,
          outstandingRequests: 2,
          requests: [{ blockIndex: 1, peerId: 'peer-2' }],
        },
      ],
    })

    expect(plan.dropPieceIndices).toEqual([4])
    expect(plan.suppressedPieces.has(2)).toBe(false)
    expect(plan.suppressedPieces.has(3)).toBe(false)
    expect(plan.suppressedPieces.has(4)).toBe(true)
    expect(plan.effectivePriority?.[2]).toBe(7)
    expect(plan.effectivePriority?.[3]).toBe(4)
    expect(plan.effectivePriority?.[4]).toBe(0)
  })

  it('does not suppress active work when only metadata or next demands exist', () => {
    const basePriority = new Uint8Array(6).fill(4)

    const plan = buildStreamingPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      demands: [
        { token: 'metadata', urgency: 'metadata', pieces: new Set([0]) },
        { token: 'read-ahead', urgency: 'next', pieces: new Set([1]) },
      ],
      activePieces: [
        {
          index: 4,
          state: 'fullyRequested',
          blocksReceived: 4,
          blocksNeeded: 16,
          outstandingRequests: 12,
          requests: [{ blockIndex: 0, peerId: 'peer-1' }],
        },
      ],
    })

    expect(plan.dropPieceIndices).toEqual([])
    expect(plan.suppressedPieces.size).toBe(0)
    expect(plan.effectivePriority?.[0]).toBe(5)
    expect(plan.effectivePriority?.[1]).toBe(6)
    expect(plan.effectivePriority?.[4]).toBe(4)
  })

  it('ignores skipped pieces in streaming demand windows', () => {
    const basePriority = new Uint8Array([0, 4, 4])

    const plan = buildStreamingPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      demands: [{ token: 'player', urgency: 'now', pieces: new Set([0, 1]) }],
      activePieces: [],
    })

    expect(plan.effectivePriority?.[0]).toBe(0)
    expect(plan.effectivePriority?.[1]).toBe(7)
    expect(plan.protectedPieces.has(0)).toBe(false)
    expect(plan.protectedPieces.has(1)).toBe(true)
  })

  it('keeps file-locked pieces eligible so within-file work can continue around the cursor', () => {
    const basePriority = new Uint8Array(10).fill(4)

    const plan = buildStreamingPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      demands: [
        { token: 'file-lock', urgency: 'file', pieces: new Set([5, 6, 7]) },
        { token: 'player', urgency: 'now', pieces: new Set([5]) },
      ],
      activePieces: [
        {
          index: 6,
          state: 'partial',
          blocksReceived: 1,
          blocksNeeded: 16,
          outstandingRequests: 2,
          requests: [{ blockIndex: 0, peerId: 'peer-1' }],
        },
        {
          index: 8,
          state: 'partial',
          blocksReceived: 1,
          blocksNeeded: 16,
          outstandingRequests: 2,
          requests: [{ blockIndex: 1, peerId: 'peer-2' }],
        },
      ],
    })

    expect(plan.effectivePriority?.[5]).toBe(7)
    expect(plan.effectivePriority?.[6]).toBe(5)
    expect(plan.dropPieceIndices.sort((a, b) => a - b)).toEqual([8])
    expect(plan.suppressedPieces.has(6)).toBe(false)
    expect(plan.suppressedPieces.has(8)).toBe(true)
    expect(plan.protectedPieces.has(5)).toBe(true)
    expect(plan.protectedPieces.has(6)).toBe(true)
  })
})

describe('StreamingScheduler', () => {
  it('tracks demand updates by token', () => {
    const scheduler = new StreamingScheduler()

    expect(scheduler.updateDemand('a', new Set([1, 2]), 'now')).toBe(true)
    expect(scheduler.updateDemand('a', new Set([1, 2]), 'now')).toBe(false)
    expect(scheduler.updateDemand('a', null, 'now')).toBe(true)
    expect(scheduler.updateDemand('a', null, 'now')).toBe(false)
  })

  it('reports previously suppressed pieces when now-demand is removed', () => {
    const scheduler = new StreamingScheduler()
    const basePriority = new Uint8Array(6).fill(4)

    scheduler.updateDemand('player', new Set([5]), 'now')
    const first = scheduler.buildPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      activePieces: [
        {
          index: 1,
          state: 'fullyRequested',
          blocksReceived: 8,
          blocksNeeded: 16,
          outstandingRequests: 8,
          requests: [{ blockIndex: 0, peerId: 'peer-1' }],
        },
      ],
    })

    expect(first.previousSuppressedPieces.size).toBe(0)
    expect(first.plan.suppressedPieces).toEqual(new Set([1]))

    scheduler.updateDemand('player', null, 'now')
    const second = scheduler.buildPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      activePieces: [],
    })

    expect(second.previousSuppressedPieces).toEqual(new Set([1]))
    expect(second.plan.suppressedPieces.size).toBe(0)
    expect(second.plan.effectivePriority).toBe(basePriority)
  })

  it('retains suppressed pieces across planner runs while now-demand remains active', () => {
    const scheduler = new StreamingScheduler()
    const basePriority = new Uint8Array(8).fill(4)

    scheduler.updateDemand('file-lock', new Set([0, 1, 2, 3, 4, 5]), 'file')
    scheduler.updateDemand('player', new Set([5]), 'now')

    const first = scheduler.buildPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      activePieces: [
        {
          index: 6,
          state: 'fullyRequested',
          blocksReceived: 8,
          blocksNeeded: 16,
          outstandingRequests: 8,
          requests: [{ blockIndex: 0, peerId: 'peer-1' }],
        },
      ],
    })

    expect(first.plan.suppressedPieces).toEqual(new Set([6]))
    expect(first.plan.effectivePriority?.[6]).toBe(0)

    const second = scheduler.buildPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      activePieces: [],
    })

    expect(second.previousSuppressedPieces).toEqual(new Set([6]))
    expect(second.plan.suppressedPieces).toEqual(new Set([6]))
    expect(second.plan.effectivePriority?.[6]).toBe(0)
  })

  it('releases retained suppression when a piece becomes protected again', () => {
    const scheduler = new StreamingScheduler()
    const basePriority = new Uint8Array(6).fill(4)

    scheduler.updateDemand('file-lock', new Set([0, 1, 2, 3, 4, 5]), 'file')
    scheduler.updateDemand('player', new Set([5]), 'now')
    scheduler.buildPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      activePieces: [
        {
          index: 1,
          state: 'fullyRequested',
          blocksReceived: 8,
          blocksNeeded: 16,
          outstandingRequests: 8,
          requests: [{ blockIndex: 0, peerId: 'peer-1' }],
        },
      ],
    })

    scheduler.updateDemand('player', new Set([1]), 'now')
    const next = scheduler.buildPlan({
      piecesCount: basePriority.length,
      basePiecePriority: basePriority,
      activePieces: [],
    })

    expect(next.plan.suppressedPieces.has(1)).toBe(false)
    expect(next.plan.protectedPieces.has(1)).toBe(true)
    expect(next.plan.effectivePriority?.[1]).toBe(7)
  })

  it('exposes a streaming selection hint for next-then-backfill scans', () => {
    const scheduler = new StreamingScheduler()

    scheduler.updateDemand('file-lock', new Set([20, 21, 22, 23, 24, 25]), 'file')
    scheduler.updateDemand('ahead', new Set([23, 24, 25]), 'next')

    expect(scheduler.selectionHint).toEqual({
      nextStartPiece: 23,
      nextEndPiece: 25,
      fileStartPiece: 20,
      fileEndPiece: 25,
    })
  })
})
