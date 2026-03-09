import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { VideoPopupLaunchOptions } from '../host/types'
import { createRemoteByteRangeStreamingSession } from '../utils/video-popup-session'
import { VideoPlayer } from './VideoPlayer'

function parsePopupDescriptor(): VideoPopupLaunchOptions | null {
  const params = new URLSearchParams(window.location.search)
  const sessionId = params.get('sessionId')
  const fileName = params.get('fileName')
  const fileSizeParam = params.get('fileSize')
  const fileSize = Number(fileSizeParam)

  if (!sessionId || !fileName || fileSizeParam === null) return null
  if (!Number.isFinite(fileSize)) {
    return null
  }

  return {
    sessionId,
    fileName,
    fileSize,
  }
}

export function VideoPopupPage() {
  const descriptor = useMemo(() => parsePopupDescriptor(), [])
  const error = descriptor ? null : 'Missing popup session data'

  const [sessionHandle] = useState(() =>
    descriptor
      ? createRemoteByteRangeStreamingSession(descriptor, {
          onSessionClosed: () => window.close(),
        })
      : null,
  )

  useEffect(() => {
    if (!descriptor) return
    document.title = `JSTorrent - ${descriptor.fileName}`
    return () => sessionHandle?.dispose()
  }, [descriptor, sessionHandle])

  if (error) {
    return <div style={errorStyle}>{error}</div>
  }

  if (!descriptor || !sessionHandle) {
    return <div style={loadingStyle}>Opening player...</div>
  }

  return (
    <VideoPlayer
      bytes={sessionHandle.playback.bytes}
      control={sessionHandle.playback.control}
      diagnostics={sessionHandle.playback.diagnostics}
      fileName={descriptor.fileName}
      onClose={() => window.close()}
      closeOnBackdrop={false}
      closeOnEscape={false}
      showCloseButton={false}
    />
  )
}

const loadingStyle: CSSProperties = {
  position: 'fixed',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  background: '#000',
  color: '#fff',
  fontSize: '16px',
}

const errorStyle: CSSProperties = {
  ...loadingStyle,
  color: '#f66',
}
