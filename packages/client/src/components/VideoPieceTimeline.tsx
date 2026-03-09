import { fromHex, type StreamingVisualization } from '@jstorrent/engine'
import {
  PieceBar,
  PieceLegend,
  PieceState,
  type BitFieldLike,
  type PieceVisualizationData,
} from '@jstorrent/ui'
import { useEffect, useMemo, useRef, useState } from 'react'

const POLL_INTERVAL_MS = 500

class SnapshotBitField implements BitFieldLike {
  constructor(
    private readonly bytes: Uint8Array,
    private readonly size: number,
  ) {}

  get(index: number): boolean {
    if (index < 0 || index >= this.size) return false
    const byteIndex = Math.floor(index / 8)
    const bitIndex = 7 - (index % 8)
    return (((this.bytes[byteIndex] ?? 0) >> bitIndex) & 1) === 1
  }
}

function toPieceState(state: number): PieceState {
  switch (state) {
    case PieceState.Partial:
      return PieceState.Partial
    case PieceState.FullyRequested:
      return PieceState.FullyRequested
    case PieceState.FullyResponded:
      return PieceState.FullyResponded
    case PieceState.Completed:
      return PieceState.Completed
    case PieceState.Missing:
    default:
      return PieceState.Missing
  }
}

export interface VideoPieceTimelineProps {
  diagnostics?: StreamingVisualization
}

export function VideoPieceTimeline({ diagnostics }: VideoPieceTimelineProps) {
  const [snapshot, setSnapshot] = useState<Awaited<
    ReturnType<NonNullable<StreamingVisualization['getPieceTimelineSnapshot']>>
  > | null>(null)
  const warnedRef = useRef(false)

  useEffect(() => {
    const getSnapshot = diagnostics?.getPieceTimelineSnapshot
    if (!getSnapshot) {
      setSnapshot(null)
      return
    }

    let disposed = false
    let loading = false

    const refresh = async () => {
      if (disposed || loading) return
      loading = true
      try {
        const nextSnapshot = await getSnapshot()
        if (!disposed) {
          setSnapshot(nextSnapshot)
        }
      } catch (error) {
        if (!disposed && !warnedRef.current) {
          warnedRef.current = true
          console.warn('[VideoPieceTimeline] failed to load piece timeline', error)
        }
      } finally {
        loading = false
      }
    }

    void refresh()
    const interval = window.setInterval(() => {
      void refresh()
    }, POLL_INTERVAL_MS)

    return () => {
      disposed = true
      window.clearInterval(interval)
    }
  }, [diagnostics])

  const visualizationData = useMemo<PieceVisualizationData | null>(() => {
    if (!snapshot || snapshot.piecesTotal === 0) return null

    return {
      piecesTotal: snapshot.piecesTotal,
      bitfield: new SnapshotBitField(fromHex(snapshot.bitfieldHex), snapshot.piecesTotal),
      piecesCompleted: snapshot.piecesCompleted,
      activePieces: snapshot.activePieces.map((piece) => ({
        index: piece.index,
        // StreamingPieceState values intentionally match ui PieceState values.
        state: toPieceState(piece.state),
      })),
    }
  }, [snapshot])

  const activeSummary = useMemo(() => {
    if (!snapshot) return null

    let partial = 0
    let fullyRequested = 0
    let fullyResponded = 0

    for (const piece of snapshot.activePieces) {
      if (piece.state === PieceState.Partial) partial++
      else if (piece.state === PieceState.FullyRequested) fullyRequested++
      else if (piece.state === PieceState.FullyResponded) fullyResponded++
    }

    return {
      active: snapshot.activePieces.length,
      partial,
      fullyRequested,
      fullyResponded,
    }
  }, [snapshot])

  if (!visualizationData || !snapshot || !activeSummary) {
    return null
  }

  const progressPct =
    snapshot.piecesTotal > 0
      ? Math.round((snapshot.piecesCompleted / snapshot.piecesTotal) * 100)
      : 0

  return (
    <div style={panelStyle}>
      <div style={headerStyle}>
        <div style={titleStyle}>Piece timeline</div>
        <div style={metaStyle}>
          {snapshot.piecesCompleted} / {snapshot.piecesTotal} pieces ({progressPct}%)
          {activeSummary.active > 0 && (
            <>
              {' '}
              • active {activeSummary.active} ({activeSummary.partial} requesting,{' '}
              {activeSummary.fullyRequested} receiving, {activeSummary.fullyResponded} verifying)
            </>
          )}
        </div>
      </div>

      <PieceBar getData={() => visualizationData} height={14} />
      <div style={legendStyle}>
        <PieceLegend />
      </div>
    </div>
  )
}

const panelStyle: React.CSSProperties = {
  padding: '12px 14px',
  borderRadius: '10px',
  border: '1px solid rgba(255, 255, 255, 0.14)',
  background: 'rgba(8, 12, 18, 0.72)',
  backdropFilter: 'blur(10px)',
  display: 'flex',
  flexDirection: 'column',
  gap: '10px',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '4px',
}

const titleStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: '13px',
  fontWeight: 600,
}

const metaStyle: React.CSSProperties = {
  color: 'rgba(255, 255, 255, 0.72)',
  fontSize: '12px',
}

const legendStyle: React.CSSProperties = {
  overflowX: 'auto',
}
