import { useEffect, useRef, useState } from 'react'
import type { PrebuiltKeyframeIndex, StreamingFileProvider } from '@jstorrent/engine'
import { createTorrentSourceFromProvider } from '@jstorrent/engine'
import { PlaysVideoEngine, Source } from 'playsvideo'
import type { KeyframeIndex } from 'playsvideo'
import { VideoPieceTimeline } from './VideoPieceTimeline'

export interface VideoPlayerProps {
  provider: StreamingFileProvider
  fileName: string
  onClose: () => void
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  showCloseButton?: boolean
}

export function VideoPlayer({
  provider,
  fileName,
  onClose,
  closeOnBackdrop = true,
  closeOnEscape = true,
  showCloseButton = true,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const engineRef = useRef<PlaysVideoEngine | null>(null)
  const [state, setState] = useState<{
    phase: 'loading' | 'ready' | 'error'
    errorMessage: string | null
    provider: StreamingFileProvider
  }>({ phase: 'loading', errorMessage: null, provider })

  // Reset state when provider changes (avoids setState in effect body)
  if (state.provider !== provider) {
    setState({ phase: 'loading', errorMessage: null, provider })
  }

  const { phase, errorMessage } = state

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let disposed = false

    const source = createTorrentSourceFromProvider(Source, provider)
    const engine = new PlaysVideoEngine(video)
    engineRef.current = engine

    engine.addEventListener('ready', () => {
      if (disposed) return
      console.log('[VideoPlayer] ready')
      setState((s) => ({ ...s, phase: 'ready' }))
    })

    engine.addEventListener('error', ((e: CustomEvent<{ message: string }>) => {
      if (disposed) return
      console.error('[VideoPlayer] error:', e.detail.message)
      setState((s) => ({ ...s, phase: 'error', errorMessage: e.detail.message }))
    }) as EventListener)

    void (async () => {
      let keyframeIndex: KeyframeIndex | undefined

      try {
        const prebuilt = await provider.buildPrebuiltKeyframeIndex?.()
        if (disposed) return
        if (prebuilt) {
          keyframeIndex = toPlaysVideoKeyframeIndex(prebuilt)
        }
      } catch (error) {
        console.warn('[VideoPlayer] prebuilt keyframe index unavailable, falling back', error)
      }

      if (disposed) return

      console.log(
        '[VideoPlayer] loadSource',
        fileName,
        'fileSize=',
        provider.fileSize,
        'prebuiltKeyframes=',
        keyframeIndex?.keyframes.length ?? 0,
      )
      engine.loadSource(source, keyframeIndex ? { keyframeIndex } : undefined)
    })()

    return () => {
      disposed = true
      engine.destroy()
      engineRef.current = null
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [fileName, provider])

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (closeOnEscape && e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeOnEscape, onClose])

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (closeOnBackdrop && e.target === e.currentTarget) onClose()
  }

  return (
    <div style={overlayStyle} onClick={handleOverlayClick}>
      {showCloseButton && (
        <button style={closeButtonStyle} onClick={onClose} title="Close">
          ✕
        </button>
      )}

      <div style={contentStyle}>
        <div style={headerStyle}>
          <div style={fileNameStyle}>{fileName}</div>
        </div>

        <VideoPieceTimeline provider={provider} />

        <div style={mediaAreaStyle}>
          {phase === 'loading' && <div style={statusStyle}>Loading {fileName}...</div>}

          {phase === 'error' && (
            <div style={statusStyle}>
              <div style={{ color: 'var(--accent-error, #f44)' }}>Failed to play: {errorMessage}</div>
            </div>
          )}

          <video
            ref={videoRef}
            controls
            autoPlay
            style={{
              ...videoStyle,
              display: phase === 'ready' ? 'block' : 'none',
            }}
          />
        </div>
      </div>
    </div>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: 'rgba(0, 0, 0, 0.9)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '32px 24px',
  overflow: 'auto',
  zIndex: 2000,
}

const contentStyle: React.CSSProperties = {
  width: 'min(1100px, 100%)',
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
}

const headerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
}

const fileNameStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: '14px',
  fontWeight: 600,
  wordBreak: 'break-word',
}

const closeButtonStyle: React.CSSProperties = {
  position: 'absolute',
  top: '16px',
  right: '16px',
  background: 'rgba(255, 255, 255, 0.1)',
  border: 'none',
  color: '#fff',
  fontSize: '20px',
  width: '40px',
  height: '40px',
  borderRadius: '50%',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1,
}

const mediaAreaStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  minHeight: '220px',
}

const videoStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '100%',
  maxHeight: '78vh',
  borderRadius: '8px',
  background: '#000',
}

const statusStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: '16px',
  textAlign: 'center',
}

function toPlaysVideoKeyframeIndex(prebuilt: PrebuiltKeyframeIndex): KeyframeIndex {
  return {
    duration: prebuilt.durationSec,
    keyframes: prebuilt.keyframeTimestampsSec.map((timestamp, sequenceNumber) => ({
      timestamp,
      sequenceNumber,
    })),
  }
}
