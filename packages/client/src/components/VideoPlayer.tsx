import { useEffect, useRef, useState } from 'react'
import type {
  ByteRangeStreamingSession,
  StreamingPlaybackOption,
  StreamingPlayerController,
  StreamingVisualization,
} from '@jstorrent/engine'
import { createTorrentSourceFromSession } from '@jstorrent/engine'
import { PlaysVideoEngine, Source } from 'playsvideo'
import type {
  PlaybackDecisionDetail,
  PlaybackEvaluationResult,
  PlaybackOption as PlaysVideoPlaybackOption,
  PlaybackPolicy,
} from 'playsvideo'
import { VideoPieceTimeline } from './VideoPieceTimeline'

const DIRECT_BYTES_MODE = 'direct-bytes' as const
const HLS_MODE = 'hls' as const

export interface VideoPlayerProps {
  bytes: ByteRangeStreamingSession
  controller?: StreamingPlayerController
  diagnostics?: StreamingVisualization
  fileName: string
  playbackPolicy?: PlaybackPolicy
  onClose: () => void
  closeOnBackdrop?: boolean
  closeOnEscape?: boolean
  showCloseButton?: boolean
}

export function VideoPlayer({
  bytes,
  controller,
  diagnostics,
  fileName,
  playbackPolicy: initialPlaybackPolicy = 'auto',
  onClose,
  closeOnBackdrop = true,
  closeOnEscape = true,
  showCloseButton = true,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const fullscreenTargetRef = useRef<HTMLDivElement>(null)
  const engineRef = useRef<PlaysVideoEngine | null>(null)
  const [state, setState] = useState<{
    phase: 'loading' | 'ready' | 'error'
    errorMessage: string | null
    bytes: ByteRangeStreamingSession
  }>({ phase: 'loading', errorMessage: null, bytes })
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [playbackPolicy, setPlaybackPolicy] = useState<PlaybackPolicy>(initialPlaybackPolicy)

  // Reset state when session changes (avoids setState in effect body)
  if (state.bytes !== bytes) {
    setState({ phase: 'loading', errorMessage: null, bytes })
  }

  const { phase, errorMessage } = state

  useEffect(() => {
    setPlaybackPolicy(initialPlaybackPolicy)
  }, [initialPlaybackPolicy])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let disposed = false
    setState((s) => ({ ...s, phase: 'loading', errorMessage: null }))

    void (async () => {
      let playbackOptions: StreamingPlaybackOption[] | null = null
      try {
        playbackOptions = (await controller?.getPlaybackOptions?.()) ?? null
      } catch (error) {
        console.warn('[VideoPlayer] playback options unavailable, defaulting to HLS', error)
      }
      if (disposed) return

      const engine = new PlaysVideoEngine(video)
      engineRef.current = engine

      engine.addEventListener('ready', () => {
        if (disposed) return
        console.log('[VideoPlayer] ready')
        setState((s) => ({ ...s, phase: 'ready' }))
      })

      engine.addEventListener('playbackdecision', ((e: CustomEvent<PlaybackDecisionDetail>) => {
        if (disposed) return
        console.log('[VideoPlayer] playback decision', {
          fileName,
          playbackPolicy: e.detail.playbackPolicy,
          selectedMode: e.detail.evaluation.recommended?.option.mode ?? HLS_MODE,
          recommendation: summarizePlaybackEvaluation(e.detail.evaluation),
        })
      }) as EventListener)

      engine.addEventListener('error', ((e: CustomEvent<{ message: string }>) => {
        if (disposed) return
        console.error('[VideoPlayer] error:', e.detail.message)
        setState((s) => ({ ...s, phase: 'error', errorMessage: e.detail.message }))
      }) as EventListener)

      const source = createTorrentSourceFromSession(Source, bytes)
      const options = toPlaysVideoPlaybackOptions(playbackOptions)

      console.log('[VideoPlayer] loadWithOptions', fileName, {
        playbackPolicy,
        playbackOptions: options,
        fileSize: bytes.fileSize,
      })
      engine.loadWithOptions({
        source,
        options,
        playbackPolicy,
      })
    })()

    return () => {
      disposed = true
      engineRef.current?.destroy()
      engineRef.current = null
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [bytes, controller, fileName, playbackPolicy])

  const toggleFullscreen = async () => {
    const target = fullscreenTargetRef.current
    const video = videoRef.current
    if (!target && !video) return

    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
        return
      }

      if (target?.requestFullscreen) {
        await target.requestFullscreen()
        return
      }

      const webkitVideo = video as HTMLVideoElement & {
        webkitEnterFullscreen?: () => void
      }
      webkitVideo.webkitEnterFullscreen?.()
    } catch (error) {
      console.warn('[VideoPlayer] fullscreen failed', error)
    }
  }

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target
      const isEditableTarget =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')

      if (e.key === 'Escape' && document.fullscreenElement) {
        void document.exitFullscreen().catch(() => {})
        return
      }

      if (!isEditableTarget && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        void toggleFullscreen()
        return
      }

      if (closeOnEscape && e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [closeOnEscape, onClose, toggleFullscreen])

  useEffect(() => {
    const video = videoRef.current

    const handleFullscreenChange = () => {
      const fullscreenElement = document.fullscreenElement
      const target = fullscreenTargetRef.current
      setIsFullscreen(Boolean(target && fullscreenElement && target.contains(fullscreenElement)))
    }

    const handleWebkitBeginFullscreen = () => {
      setIsFullscreen(true)
    }

    const handleWebkitEndFullscreen = () => {
      setIsFullscreen(false)
    }

    document.addEventListener('fullscreenchange', handleFullscreenChange)
    video?.addEventListener('webkitbeginfullscreen', handleWebkitBeginFullscreen as EventListener)
    video?.addEventListener('webkitendfullscreen', handleWebkitEndFullscreen as EventListener)
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange)
      video?.removeEventListener(
        'webkitbeginfullscreen',
        handleWebkitBeginFullscreen as EventListener,
      )
      video?.removeEventListener('webkitendfullscreen', handleWebkitEndFullscreen as EventListener)
    }
  }, [])

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
          <div style={headerActionsStyle}>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() =>
                setPlaybackPolicy((current) => (current === 'auto' ? 'force-hls' : 'auto'))
              }
              title={
                playbackPolicy === 'auto'
                  ? 'Automatic playback selection'
                  : 'Force HLS/remux playback'
              }
            >
              {playbackPolicy === 'auto' ? 'Mode: Auto' : 'Mode: Force HLS'}
            </button>
            <button
              type="button"
              style={secondaryButtonStyle}
              onClick={() => void toggleFullscreen()}
              title={isFullscreen ? 'Exit fullscreen (F)' : 'Enter fullscreen (F)'}
            >
              {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
            </button>
          </div>
        </div>

        <VideoPieceTimeline diagnostics={diagnostics} />

        <div
          ref={fullscreenTargetRef}
          onDoubleClick={() => void toggleFullscreen()}
          style={{
            ...mediaAreaStyle,
            ...(isFullscreen ? fullscreenMediaAreaStyle : null),
          }}
        >
          {phase === 'loading' && <div style={statusStyle}>Loading {fileName}...</div>}

          {phase === 'error' && (
            <div style={statusStyle}>
              <div style={{ color: 'var(--accent-error, #f44)' }}>
                Failed to play: {errorMessage}
              </div>
            </div>
          )}

          <video
            ref={videoRef}
            controls
            autoPlay
            style={{
              ...videoStyle,
              ...(isFullscreen ? fullscreenVideoStyle : null),
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
  gap: '12px',
}

const fileNameStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: '14px',
  fontWeight: 600,
  wordBreak: 'break-word',
}

const headerActionsStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  flexShrink: 0,
}

const secondaryButtonStyle: React.CSSProperties = {
  appearance: 'none',
  border: '1px solid rgba(255, 255, 255, 0.18)',
  background: 'rgba(255, 255, 255, 0.08)',
  color: '#fff',
  borderRadius: '999px',
  padding: '8px 14px',
  fontSize: '13px',
  fontWeight: 600,
  cursor: 'pointer',
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
  background: '#000',
  borderRadius: '8px',
  overflow: 'hidden',
}

const fullscreenMediaAreaStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  minHeight: '100%',
  borderRadius: 0,
}

const videoStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: '100%',
  maxHeight: '78vh',
  borderRadius: '8px',
  background: '#000',
}

const fullscreenVideoStyle: React.CSSProperties = {
  width: '100%',
  height: '100%',
  maxWidth: '100%',
  maxHeight: '100%',
  borderRadius: 0,
  objectFit: 'contain',
}

const statusStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: '16px',
  textAlign: 'center',
}

function isDirectBytePlaybackOption(
  option: StreamingPlaybackOption,
): option is Extract<StreamingPlaybackOption, { mode: typeof DIRECT_BYTES_MODE }> {
  return option.mode === DIRECT_BYTES_MODE
}

function toPlaysVideoPlaybackOptions(
  options?: StreamingPlaybackOption[] | null,
): PlaysVideoPlaybackOption[] {
  const playbackOptionsInput = options ?? [{ mode: HLS_MODE }]
  const playbackOptions: PlaysVideoPlaybackOption[] = []

  for (const option of playbackOptionsInput) {
    if (option.mode === HLS_MODE) {
      playbackOptions.push({ mode: 'hls' })
      continue
    }

    if (isDirectBytePlaybackOption(option)) {
      playbackOptions.push({
        mode: 'direct-url',
        url: option.url,
        mimeType: option.mimeType ?? null,
      })
    }
  }

  if (!playbackOptions.some((option) => option.mode === 'hls')) {
    playbackOptions.push({ mode: 'hls' })
  }

  return playbackOptions
}

function summarizePlaybackEvaluation(evaluation: PlaybackEvaluationResult | null): string | null {
  if (!evaluation) {
    return null
  }

  return evaluation.evaluations
    .map((candidate) => {
      const diagnostics = candidate.diagnostics.map((diag) => diag.code).join(',')
      return `${candidate.option.mode}:${candidate.status}:${diagnostics}`
    })
    .join(' | ')
}
