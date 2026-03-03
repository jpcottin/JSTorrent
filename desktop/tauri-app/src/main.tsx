import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from '@jstorrent/client'
import { registerExternalUrlOpener } from '@jstorrent/client/utils/external-links'
import { openUrl } from '@tauri-apps/plugin-opener'
import '@jstorrent/ui/styles.css'
import { initUpdater } from './updater'

registerExternalUrlOpener(openUrl)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

initUpdater()
