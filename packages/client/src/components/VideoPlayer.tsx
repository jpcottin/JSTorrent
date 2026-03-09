import { useEffect, useRef, useState } from 'react'
import type {
  ByteRangeStreamingSession,
  StreamingPlaybackCapabilities,
  StreamingPlaybackMode,
  StreamingPlaybackOption,
  StreamingPlayerController,
  StreamingVisualization,
} from '@jstorrent/engine'
import { createTorrentSourceFromSession } from '@jstorrent/engine'
import {
  createBrowserPlaybackCapabilities,
  demuxSource,
  evaluatePlaybackOptions,
  PlaysVideoEngine,
  Source,
} from 'playsvideo'
import type {
  DirectPlaybackOption as PlaysVideoDirectPlaybackOption,
  PlaybackEvaluationResult,
  PlaybackMediaMetadata,
  PlaybackOption as PlaysVideoPlaybackOption,
} from 'playsvideo'
import { VideoPieceTimeline } from './VideoPieceTimeline'

const DIRECT_BYTES_MODE = 'direct-bytes' as const
const HLS_MODE = 'hls' as const
const PLAYER_PLAYBACK_MODE_PREFERENCE: StreamingPlaybackMode[] = [DIRECT_BYTES_MODE, HLS_MODE]

export interface VideoPlayerProps {
  bytes: ByteRangeStreamingSession
  controller?: StreamingPlayerController
  diagnostics?: StreamingVisualization
  fileName: string
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

  // Reset state when session changes (avoids setState in effect body)
  if (state.bytes !== bytes) {
    setState({ phase: 'loading', errorMessage: null, bytes })
  }

  const { phase, errorMessage } = state

  useEffect(() => {
    const video = videoRef.current
    if (!video) return

    let disposed = false
    let cleanupPlayback = () => {}

    void (async () => {
      try {
        const [playbackCapabilities, playbackOptions] = await Promise.all([
          controller?.getPlaybackCapabilities?.(),
          controller?.getPlaybackOptions?.(),
        ])
        if (disposed) return
        const playbackDecision = await recommendPlayback(video, bytes, playbackOptions)
        if (disposed) return
        console.log('[VideoPlayer] selected playback mode', {
          selectedMode: playbackDecision.mode,
          playbackOptions: playbackOptions ?? [{ mode: HLS_MODE }],
          supportedModes: playbackCapabilities?.supportedModes ?? [HLS_MODE],
          containerFormat: playbackCapabilities?.containerFormat ?? 'unknown',
          recommendation: summarizePlaybackEvaluation(playbackDecision.evaluation),
        })

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

        if (playbackDecision.mode === DIRECT_BYTES_MODE && playbackDecision.url) {
          console.log(
            '[VideoPlayer] loadUrl',
            fileName,
            'url=',
            playbackDecision.url,
          )
          engine.loadUrl(playbackDecision.url)
          return
        }
      } catch (error) {
        console.warn('[VideoPlayer] playback preparation unavailable, falling back', error)
      }

      if (disposed) return

      const source = createTorrentSourceFromSession(Source, bytes)
      const engine = engineRef.current ?? new PlaysVideoEngine(video)
      engineRef.current = engine

      console.log(
        '[VideoPlayer] loadSource',
        fileName,
        'fileSize=',
        bytes.fileSize,
      )
      engine.loadSource(source)
    })()

    return () => {
      disposed = true
      cleanupPlayback()
      engineRef.current?.destroy()
      engineRef.current = null
      video.pause()
      video.removeAttribute('src')
      video.load()
    }
  }, [bytes, controller, fileName])

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
          <button
            type="button"
            style={secondaryButtonStyle}
            onClick={() => void toggleFullscreen()}
            title={isFullscreen ? 'Exit fullscreen (F)' : 'Enter fullscreen (F)'}
          >
            {isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
          </button>
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
}

const fileNameStyle: React.CSSProperties = {
  color: '#fff',
  fontSize: '14px',
  fontWeight: 600,
  wordBreak: 'break-word',
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

function selectPlaybackMode(
  capabilities?: StreamingPlaybackCapabilities | null,
): StreamingPlaybackMode {
  if (!capabilities) {
    return HLS_MODE
  }

  for (const mode of PLAYER_PLAYBACK_MODE_PREFERENCE) {
    if (capabilities.supportedModes.includes(mode)) {
      return mode
    }
  }

  return capabilities.preferredMode
}

function selectPlaybackOption(
  playbackOptions?: StreamingPlaybackOption[] | null,
  capabilities?: StreamingPlaybackCapabilities | null,
): StreamingPlaybackOption {
  const options = playbackOptions ?? [{ mode: HLS_MODE }]

  for (const mode of PLAYER_PLAYBACK_MODE_PREFERENCE) {
    const option = options.find((candidate) => candidate.mode === mode)
    if (!option) continue
    return option
  }

  const fallbackMode = selectPlaybackMode(capabilities)
  return options.find((candidate) => candidate.mode === fallbackMode) ?? { mode: HLS_MODE }
}

interface PlaybackDecision {
  mode: StreamingPlaybackMode
  url?: string
  evaluation: PlaybackEvaluationResult | null
}

async function recommendPlayback(
  video: HTMLVideoElement,
  bytes: ByteRangeStreamingSession,
  playbackOptions?: StreamingPlaybackOption[] | null,
): Promise<PlaybackDecision> {
  const options = playbackOptions ?? [{ mode: HLS_MODE }]
  const directOption = options.find(isDirectBytePlaybackOption)
  if (!directOption?.url) {
    return {
      mode: selectPlaybackOption(playbackOptions).mode,
      evaluation: null,
    }
  }

  const evaluation = evaluatePlaybackOptions({
    options: toPlaysVideoPlaybackOptions(options, directOption),
    media: await loadPlaybackMediaMetadata(bytes),
    capabilities: createBrowserPlaybackCapabilities(video),
    preferenceOrder: ['direct-url', 'hls'],
  })

  if (evaluation.recommended?.option.mode === 'direct-url') {
    return {
      mode: DIRECT_BYTES_MODE,
      url: directOption.url,
      evaluation,
    }
  }

  return {
    mode: HLS_MODE,
    evaluation,
  }
}

async function loadPlaybackMediaMetadata(
  session: ByteRangeStreamingSession,
): Promise<PlaybackMediaMetadata> {
  const demux = await demuxSource(createPlaybackProbeSource(session))
  try {
    return {
      sourceVideoCodec: demux.videoCodec,
      sourceAudioCodec: demux.audioCodec,
      videoCodec: demux.videoDecoderConfig.codec,
      audioCodec: demux.audioDecoderConfig?.codec ?? null,
    }
  } finally {
    demux.dispose()
  }
}

function createPlaybackProbeSource(session: ByteRangeStreamingSession): Source {
  class PlaybackProbeSource extends Source {
    _retrieveSize(): number {
      return session.fileSize
    }

    _read(
      start: number,
      end: number,
      signal?: AbortSignal,
    ): Promise<{ bytes: Uint8Array; view: DataView; offset: number }> | null {
      if (start < 0 || end < start || end > session.fileSize) {
        return null
      }

      return session.read(start, end - start, signal).then((bytes) => ({
        bytes,
        view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength),
        offset: start,
      }))
    }

    _dispose(): void {
      // Demux probing should not own the playback session lifetime.
    }
  }

  return new PlaybackProbeSource()
}

function isDirectBytePlaybackOption(
  option: StreamingPlaybackOption,
): option is Extract<StreamingPlaybackOption, { mode: typeof DIRECT_BYTES_MODE }> {
  return option.mode === DIRECT_BYTES_MODE
}

function toPlaysVideoPlaybackOptions(
  options: StreamingPlaybackOption[],
  directOption: Extract<StreamingPlaybackOption, { mode: typeof DIRECT_BYTES_MODE }>,
): PlaysVideoPlaybackOption[] {
  const playbackOptions: PlaysVideoPlaybackOption[] = []

  for (const option of options) {
    if (option.mode === HLS_MODE) {
      playbackOptions.push({ mode: 'hls' })
      continue
    }

    if (option === directOption) {
      playbackOptions.push({
        mode: 'direct-url',
        url: directOption.url,
        mimeType: directOption.mimeType ?? null,
      } satisfies PlaysVideoDirectPlaybackOption)
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
