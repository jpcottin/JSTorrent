import { useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import type { VideoPopupLaunchOptions } from '../host/types'
import { createRemoteStreamingFileProvider } from '../utils/video-popup-session'
import { VideoPlayer } from './VideoPlayer'

function parsePopupDescriptor(): VideoPopupLaunchOptions | null {
  const params = new URLSearchParams(window.location.search)
  const sessionId = params.get('sessionId')
  const fileName = params.get('fileName')
  const fileSize = Number(params.get('fileSize'))
  const fileOffset = Number(params.get('fileOffset'))
  const pieceLength = Number(params.get('pieceLength'))

  if (!sessionId || !fileName) return null
  if (!Number.isFinite(fileSize) || !Number.isFinite(fileOffset) || !Number.isFinite(pieceLength)) {
    return null
  }

  return {
    sessionId,
    fileName,
    fileSize,
    fileOffset,
    pieceLength,
  }
}

export function VideoPopupPage() {
  const descriptor = useMemo(() => parsePopupDescriptor(), [])
  const error = descriptor ? null : 'Missing popup session data'

  const [providerHandle] = useState(() =>
    descriptor
      ? createRemoteStreamingFileProvider(descriptor, {
          onSessionClosed: () => window.close(),
        })
      : null,
  )

  useEffect(() => {
    if (!descriptor) return
    document.title = `JSTorrent - ${descriptor.fileName}`
    return () => providerHandle?.dispose()
  }, [descriptor, providerHandle])

  if (error) {
    return <div style={errorStyle}>{error}</div>
  }

  if (!descriptor || !providerHandle) {
    return <div style={loadingStyle}>Opening player...</div>
  }

  return (
    <VideoPlayer
      provider={providerHandle.provider}
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
