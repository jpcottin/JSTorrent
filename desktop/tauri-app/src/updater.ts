import { check, type Update } from '@tauri-apps/plugin-updater'
import { relaunch } from '@tauri-apps/plugin-process'
import { listen } from '@tauri-apps/api/event'

const STARTUP_CHECK_DELAY_MS = 5_000

/** Initialize the auto-updater: listen for tray events and check on startup. */
export function initUpdater(): void {
  // Tray menu "Check for Updates" triggers this event
  listen('check-for-updates', () => {
    checkForUpdates(true)
  })

  // Silent startup check after a short delay
  setTimeout(() => checkForUpdates(false), STARTUP_CHECK_DELAY_MS)
}

async function checkForUpdates(userInitiated: boolean): Promise<void> {
  // Prevent concurrent checks
  if (document.getElementById('jst-updater-overlay')) return

  try {
    const update = await check()
    if (update) {
      showUpdateDialog(update)
    } else if (userInitiated) {
      showInfoDialog('You are running the latest version.')
    }
  } catch (err) {
    console.error('Update check failed:', err)
    if (userInitiated) {
      showInfoDialog(`Failed to check for updates: ${err}`)
    }
  }
}

function showInfoDialog(message: string): void {
  const overlay = createOverlay()
  const dialog = overlay.querySelector('.jst-updater-dialog')!
  dialog.innerHTML = `
    <h2>Updates</h2>
    <p>${escapeHtml(message)}</p>
    <div class="jst-updater-actions">
      <button class="jst-updater-btn" data-action="close">OK</button>
    </div>
  `
  dialog.querySelector('[data-action="close"]')!.addEventListener('click', () => {
    overlay.remove()
  })
}

function showUpdateDialog(update: Update): void {
  const overlay = createOverlay()
  const dialog = overlay.querySelector('.jst-updater-dialog')!
  dialog.innerHTML = `
    <h2>Update Available</h2>
    <p>Version <strong>${escapeHtml(update.version)}</strong> is available (current: ${escapeHtml(update.currentVersion)}).</p>
    ${update.body ? `<div class="jst-updater-notes">${escapeHtml(update.body)}</div>` : ''}
    <div class="jst-updater-progress" style="display:none">
      <div class="jst-updater-progress-bar"><div class="jst-updater-progress-fill"></div></div>
      <p class="jst-updater-status">Downloading...</p>
    </div>
    <div class="jst-updater-actions">
      <button class="jst-updater-btn primary" data-action="install">Install &amp; Restart</button>
      <button class="jst-updater-btn" data-action="later">Later</button>
    </div>
  `

  dialog.querySelector('[data-action="later"]')!.addEventListener('click', () => {
    overlay.remove()
  })

  dialog.querySelector('[data-action="install"]')!.addEventListener('click', async () => {
    const actions = dialog.querySelector('.jst-updater-actions') as HTMLElement
    const progress = dialog.querySelector('.jst-updater-progress') as HTMLElement
    const fill = dialog.querySelector('.jst-updater-progress-fill') as HTMLElement
    const status = dialog.querySelector('.jst-updater-status') as HTMLElement
    actions.style.display = 'none'
    progress.style.display = 'block'

    let downloaded = 0
    let contentLength = 0

    try {
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started' && event.data.contentLength) {
          contentLength = event.data.contentLength
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength
          if (contentLength > 0) {
            const pct = Math.min(100, (downloaded / contentLength) * 100)
            fill.style.width = `${pct}%`
          }
        } else if (event.event === 'Finished') {
          fill.style.width = '100%'
          status.textContent = 'Installing...'
        }
      })
      await relaunch()
    } catch (err) {
      console.error('Update install failed:', err)
      status.textContent = `Update failed: ${err}`
      actions.style.display = ''
      actions.innerHTML = `<button class="jst-updater-btn" data-action="close">Close</button>`
      actions.querySelector('[data-action="close"]')!.addEventListener('click', () => {
        overlay.remove()
      })
    }
  })
}

function createOverlay(): HTMLElement {
  // Remove any existing overlay
  document.getElementById('jst-updater-overlay')?.remove()

  // Inject styles once
  if (!document.getElementById('jst-updater-styles')) {
    const style = document.createElement('style')
    style.id = 'jst-updater-styles'
    style.textContent = `
      #jst-updater-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0,0,0,0.5);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      }
      .jst-updater-dialog {
        background: #1e1e2e;
        color: #cdd6f4;
        border-radius: 8px;
        padding: 24px;
        max-width: 420px;
        width: 90%;
        box-shadow: 0 8px 32px rgba(0,0,0,0.4);
      }
      .jst-updater-dialog h2 {
        margin: 0 0 12px;
        font-size: 18px;
        color: #cdd6f4;
      }
      .jst-updater-dialog p { margin: 0 0 16px; font-size: 14px; line-height: 1.5; }
      .jst-updater-notes {
        max-height: 120px;
        overflow-y: auto;
        background: #181825;
        border-radius: 4px;
        padding: 8px 12px;
        margin-bottom: 16px;
        font-size: 13px;
        white-space: pre-wrap;
      }
      .jst-updater-actions { display: flex; gap: 8px; justify-content: flex-end; }
      .jst-updater-btn {
        padding: 8px 16px;
        border: 1px solid #45475a;
        border-radius: 6px;
        background: #313244;
        color: #cdd6f4;
        cursor: pointer;
        font-size: 14px;
      }
      .jst-updater-btn:hover { background: #45475a; }
      .jst-updater-btn.primary {
        background: #89b4fa;
        color: #1e1e2e;
        border-color: #89b4fa;
        font-weight: 600;
      }
      .jst-updater-btn.primary:hover { background: #74c7ec; border-color: #74c7ec; }
      .jst-updater-progress-bar {
        height: 6px;
        background: #313244;
        border-radius: 3px;
        overflow: hidden;
        margin-bottom: 8px;
      }
      .jst-updater-progress-fill {
        height: 100%;
        background: #89b4fa;
        width: 0%;
        transition: width 0.2s;
      }
      .jst-updater-status { font-size: 13px; color: #a6adc8; }
    `
    document.head.appendChild(style)
  }

  const overlay = document.createElement('div')
  overlay.id = 'jst-updater-overlay'
  overlay.innerHTML = `<div class="jst-updater-dialog"></div>`
  document.body.appendChild(overlay)
  return overlay
}

function escapeHtml(s: string): string {
  const div = document.createElement('div')
  div.textContent = s
  return div.innerHTML
}
