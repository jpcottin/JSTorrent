import React from 'react'
import ReactDOM from 'react-dom/client'
import { VideoPopupPage } from '@jstorrent/client/video-popup'
import '@jstorrent/ui/styles.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <VideoPopupPage />
  </React.StrictMode>,
)
