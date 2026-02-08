import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from '@jstorrent/client'
import '@jstorrent/ui/styles.css'
import { initUpdater } from './updater'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)

initUpdater()
