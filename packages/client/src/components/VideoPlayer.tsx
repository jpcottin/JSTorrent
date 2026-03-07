import { useEffect, useRef, useState } from 'react'
import type { StreamingFileProvider } from '@jstorrent/engine'
import { createTorrentSourceFromProvider } from '@jstorrent/engine'
import { PlaysVideoEngine, Source } from 'playsvideo'

export interface VideoPlayerProps {
  provider: StreamingFileProvider
  fileName: string
  onClose: () => void
}

export function VideoPlayer({ provider, fileName, onClose }: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const engineRef = useRef<PlaysVideoEngine | null>(null)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let disposed = false
    setPhase('loading')
    setErrorMessage(null)

    const source = createTorrentSourceFromProvider(Source, provider)
    const engine = new PlaysVideoEngine(video)
    engineRef.current = engine

    engine.addEventListener('ready', () => {
      if (disposed) return
      console.log('[VideoPlayer] ready')
      setPhase('ready')
    })

    engine.addEventListener('error', ((e: CustomEvent<{ message: string }>) => {
      if (disposed) return
      console.error('[VideoPlayer] error:', e.detail.message)
      setPhase('error')
      setErrorMessage(e.detail.message)
    }) as EventListener)

    console.log('[VideoPlayer] loadSource', fileName, 'fileSize=', provider.fileSize)
    engine.loadSource(source)

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
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [onClose])

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) onClose()
  }

  return (
    <div style={overlayStyle} onClick={handleOverlayClick}>
      <button style={closeButtonStyle} onClick={onClose} title="Close">
        ✕
      </button>

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
  zIndex: 2000,
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

const videoStyle: React.CSSProperties = {
  maxWidth: '95vw',
  maxHeight: '90vh',
  borderRadius: '4px',
}

const statusStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: '16px',
}
