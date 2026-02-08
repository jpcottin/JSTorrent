import { useState, useEffect } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const chromeApi = (globalThis as any).chrome as any

const EXTENSION_ID = 'dbokmlpefliilbjldladbimlcfgbolhk'
const WEBSTORE_URL = `https://chromewebstore.google.com/detail/jstorrent/${EXTENSION_ID}`
const PLAYSTORE_URL = 'https://play.google.com/store/apps/details?id=com.jstorrent.app'
const GITHUB_RELEASES_URL = 'https://api.github.com/repos/kzahel/jstorrent/releases'

// Build-time values from CI, fall back to hardcoded versions
const FALLBACK_BRIDGE_TAG = import.meta.env.VITE_SYSTEM_BRIDGE_TAG || 'v0.1.12'
const FALLBACK_TAURI_TAG = import.meta.env.VITE_TAURI_APP_TAG || 'v0.1.0'

interface BridgeReleaseInfo {
  tag: string
  windowsUrl: string
  macosUrl: string
}

interface TauriReleaseInfo {
  tag: string
  windowsUrl: string
  macosArmUrl: string
  macosIntelUrl: string
  linuxDebUrl: string
  linuxAppImageUrl: string
}

function makeBridgeReleaseInfo(tag: string): BridgeReleaseInfo {
  return {
    tag,
    windowsUrl: `https://github.com/kzahel/jstorrent/releases/download/system-bridge-${tag}/jstorrent-system-bridge-install-windows-x86_64.exe`,
    macosUrl: `https://github.com/kzahel/jstorrent/releases/download/system-bridge-${tag}/jstorrent-system-bridge-install-macos-x86_64.pkg`,
  }
}

function makeTauriReleaseInfo(tag: string): TauriReleaseInfo {
  const version = tag.replace(/^v/, '')
  return {
    tag,
    windowsUrl: `https://github.com/kzahel/jstorrent/releases/download/tauri-app-${tag}/JSTorrent_${version}_x64-setup.exe`,
    macosArmUrl: `https://github.com/kzahel/jstorrent/releases/download/tauri-app-${tag}/JSTorrent_${version}_aarch64.dmg`,
    macosIntelUrl: `https://github.com/kzahel/jstorrent/releases/download/tauri-app-${tag}/JSTorrent_${version}_x64.dmg`,
    linuxDebUrl: `https://github.com/kzahel/jstorrent/releases/download/tauri-app-${tag}/JSTorrent_${version}_amd64.deb`,
    linuxAppImageUrl: `https://github.com/kzahel/jstorrent/releases/download/tauri-app-${tag}/JSTorrent_${version}_amd64.AppImage`,
  }
}

interface GitHubRelease {
  tag_name: string
  prerelease: boolean
  assets: Array<{ name: string; browser_download_url: string }>
}

function useGitHubReleases(): {
  bridge: BridgeReleaseInfo
  tauri: TauriReleaseInfo
} {
  const [bridge, setBridge] = useState<BridgeReleaseInfo>(() =>
    makeBridgeReleaseInfo(FALLBACK_BRIDGE_TAG),
  )
  const [tauri, setTauri] = useState<TauriReleaseInfo>(() =>
    makeTauriReleaseInfo(FALLBACK_TAURI_TAG),
  )

  useEffect(() => {
    let cancelled = false
    fetch(GITHUB_RELEASES_URL)
      .then((res) => res.json())
      .then((releases: GitHubRelease[]) => {
        if (cancelled) return

        const latestBridge = releases.find((r) => r.tag_name.startsWith('system-bridge-v'))
        if (latestBridge) {
          const tag = latestBridge.tag_name.replace('system-bridge-', '')
          const info = makeBridgeReleaseInfo(tag)
          const windows = latestBridge.assets.find((a) => a.name.includes('windows'))
          const macos = latestBridge.assets.find((a) => a.name.includes('macos'))
          setBridge({
            tag,
            windowsUrl: windows?.browser_download_url ?? info.windowsUrl,
            macosUrl: macos?.browser_download_url ?? info.macosUrl,
          })
        }

        const latestTauri = releases.find((r) => {
          if (!r.tag_name.startsWith('tauri-app-v') || r.prerelease) return false
          const a = r.assets
          // Only show releases where all major platform builds are complete
          return (
            a.some((x) => x.name.endsWith('-setup.exe')) &&
            a.some((x) => x.name.includes('aarch64') && x.name.endsWith('.dmg')) &&
            a.some((x) => x.name.endsWith('.deb')) &&
            a.some((x) => x.name.endsWith('.AppImage'))
          )
        })
        if (latestTauri) {
          const tag = latestTauri.tag_name.replace('tauri-app-', '')
          const windowsExe = latestTauri.assets.find((a) => a.name.endsWith('-setup.exe'))!
          const macosArm = latestTauri.assets.find(
            (a) => a.name.includes('aarch64') && a.name.endsWith('.dmg'),
          )!
          const macosIntel = latestTauri.assets.find(
            (a) => a.name.includes('x64') && a.name.endsWith('.dmg'),
          )!
          const linuxDeb = latestTauri.assets.find((a) => a.name.endsWith('.deb'))!
          const linuxAppImage = latestTauri.assets.find((a) => a.name.endsWith('.AppImage'))!
          setTauri({
            tag,
            windowsUrl: windowsExe.browser_download_url,
            macosArmUrl: macosArm.browser_download_url,
            macosIntelUrl: macosIntel.browser_download_url,
            linuxDebUrl: linuxDeb.browser_download_url,
            linuxAppImageUrl: linuxAppImage.browser_download_url,
          })
        }
      })
      .catch(() => {
        // Keep fallback on error
      })
    return () => {
      cancelled = true
    }
  }, [])

  return { bridge, tauri }
}

type Platform = 'windows' | 'mac' | 'linux' | 'chromeos'

interface StatusResponse {
  ok: true
  installed: true
  extensionVersion: string
  platform: 'desktop' | 'chromeos'
  nativeHostConnected: boolean
  nativeHostVersion?: string
  hasEverConnected: boolean
  lastConnectedTime?: number
  installId: string
}

function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase()
  if (ua.includes('win')) return 'windows'
  if (ua.includes('mac')) return 'mac'
  return 'linux'
}

function formatTimestamp(timestamp: number): string {
  const date = new Date(timestamp)
  return date.toLocaleString()
}

function App() {
  const [copied, setCopied] = useState(false)
  const [extensionInstalled, setExtensionInstalled] = useState<boolean | null>(null)
  const [status, setStatus] = useState<StatusResponse | null>(null)
  const [selectedPlatform, setSelectedPlatform] = useState<Platform>(detectPlatform)
  const { bridge, tauri } = useGitHubReleases()

  useEffect(() => {
    // Check extension status with comprehensive info
    const checkExtension = () => {
      try {
        if (chromeApi && chromeApi.runtime) {
          chromeApi.runtime.sendMessage(
            EXTENSION_ID,
            { type: 'status' },
            (response: StatusResponse | undefined) => {
              if (chromeApi.runtime.lastError || !response) {
                setExtensionInstalled(false)
                setStatus(null)
              } else {
                setExtensionInstalled(true)
                setStatus(response)
              }
            },
          )
        } else {
          setExtensionInstalled(false)
        }
      } catch {
        setExtensionInstalled(false)
      }
    }
    checkExtension()
  }, [])

  const copyToClipboard = () => {
    const command = 'curl -fsSL https://new.jstorrent.com/install.sh | bash'
    navigator.clipboard.writeText(command).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    })
  }

  const handleLaunch = async () => {
    try {
      if (chromeApi && chromeApi.runtime) {
        chromeApi.runtime.sendMessage(
          EXTENSION_ID,
          { type: 'launch-ping' },
          (response: unknown) => {
            console.log('Extension response:', response)
          },
        )
      } else {
        console.warn('Chrome runtime not available')
      }
    } catch (e) {
      console.error('Failed to message extension:', e)
    }
  }

  return (
    <div className="container">
      <header className="header">
        <img src="/cook/JSTorrent/js-128.png" alt="JSTorrent" className="logo" />
        <h1>JSTorrent</h1>
        <p className="subtitle">A fast, free BitTorrent client.</p>
        <p className="description">
          Download torrents on desktop, Android, or directly in Chrome. Free and{' '}
          <a href="https://github.com/kzahel/jstorrent">open source</a>.
        </p>
      </header>

      {/* Desktop App section */}
      <section className="section">
        <h2>Desktop App</h2>
        <p>Standalone desktop client with built-in UI. No browser extension needed.</p>
        <div className="tabs">
          <button
            className={`tab ${selectedPlatform === 'windows' ? 'active' : ''}`}
            onClick={() => setSelectedPlatform('windows')}
          >
            Windows
          </button>
          <button
            className={`tab ${selectedPlatform === 'mac' ? 'active' : ''}`}
            onClick={() => setSelectedPlatform('mac')}
          >
            Mac
          </button>
          <button
            className={`tab ${selectedPlatform === 'linux' ? 'active' : ''}`}
            onClick={() => setSelectedPlatform('linux')}
          >
            Linux
          </button>
        </div>

        <div className="tab-content">
          {selectedPlatform === 'windows' && (
            <a href={tauri.windowsUrl} className="btn btn-primary">
              Download for Windows ({tauri.tag})
            </a>
          )}

          {selectedPlatform === 'mac' && (
            <div className="btn-group">
              <a href={tauri.macosArmUrl} className="btn btn-primary">
                Download for Mac — Apple Silicon ({tauri.tag})
              </a>
              <a href={tauri.macosIntelUrl} className="btn btn-secondary">
                Intel Mac
              </a>
            </div>
          )}

          {selectedPlatform === 'linux' && (
            <div className="btn-group">
              <a href={tauri.linuxDebUrl} className="btn btn-primary">
                Download .deb ({tauri.tag})
              </a>
              <a href={tauri.linuxAppImageUrl} className="btn btn-secondary">
                AppImage
              </a>
            </div>
          )}
        </div>
      </section>

      {/* Extension section */}
      <section className="section">
        <h2>Extension</h2>
        {extensionInstalled === true ? (
          <>
            <div className="status-row success">
              <span className="status-indicator success" />
              <span>Installed</span>
              {status && <span className="text-muted">v{status.extensionVersion}</span>}
            </div>
            <button className="btn btn-primary btn-large" onClick={handleLaunch}>
              Launch JSTorrent
            </button>
          </>
        ) : extensionInstalled === false ? (
          <>
            <div className="status-row">
              <span className="status-indicator" />
              <span>Not detected</span>
            </div>
            <a
              href={WEBSTORE_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-primary"
            >
              Install from Chrome Web Store
            </a>
          </>
        ) : (
          <p className="text-muted">Checking...</p>
        )}
      </section>

      {/* Native Host section */}
      <section className="section">
        <h2>Native Host</h2>
        {status?.nativeHostConnected ? (
          <div className="status-row success">
            <span className="status-indicator success" />
            <span>Connected</span>
            {status.nativeHostVersion && (
              <span className="text-muted">v{status.nativeHostVersion}</span>
            )}
          </div>
        ) : status ? (
          <>
            <div className="status-row">
              <span className="status-indicator" />
              <span>Not connected</span>
            </div>
            {status.hasEverConnected && status.lastConnectedTime && (
              <p className="text-muted" style={{ marginBottom: '1rem' }}>
                Last connected: {formatTimestamp(status.lastConnectedTime)}
              </p>
            )}
          </>
        ) : extensionInstalled === false ? null : (
          <p className="text-muted">Checking...</p>
        )}

        <h3>Install Native Host</h3>
        <div className="tabs">
          <button
            className={`tab ${selectedPlatform === 'windows' ? 'active' : ''}`}
            onClick={() => setSelectedPlatform('windows')}
          >
            Windows
          </button>
          <button
            className={`tab ${selectedPlatform === 'mac' ? 'active' : ''}`}
            onClick={() => setSelectedPlatform('mac')}
          >
            Mac
          </button>
          <button
            className={`tab ${selectedPlatform === 'linux' ? 'active' : ''}`}
            onClick={() => setSelectedPlatform('linux')}
          >
            Linux
          </button>
          <button
            className={`tab ${selectedPlatform === 'chromeos' ? 'active' : ''}`}
            onClick={() => setSelectedPlatform('chromeos')}
          >
            ChromeOS
          </button>
        </div>

        <div className="tab-content">
          {selectedPlatform === 'windows' && (
            <>
              <p>Download and run the Windows installer:</p>
              <a href={bridge.windowsUrl} className="btn btn-primary">
                Download for Windows ({bridge.tag})
              </a>
            </>
          )}

          {selectedPlatform === 'mac' && (
            <>
              <p>Download and run the macOS installer:</p>
              <a href={bridge.macosUrl} className="btn btn-primary">
                Download for macOS ({bridge.tag})
              </a>
            </>
          )}

          {selectedPlatform === 'linux' && (
            <>
              <p>Run this command in your terminal:</p>
              <div className="command-box">
                <code>curl -fsSL https://new.jstorrent.com/install.sh | bash</code>
                <button
                  className="copy-btn"
                  onClick={copyToClipboard}
                  aria-label="Copy to clipboard"
                >
                  <svg
                    viewBox="0 0 16 16"
                    version="1.1"
                    style={{ width: 16, height: 16, fill: 'currentColor' }}
                  >
                    <path d="M0 6.75C0 5.784.784 5 1.75 5h1.5a.75.75 0 0 1 0 1.5h-1.5a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 9.25 16h-7.5A1.75 1.75 0 0 1 0 14.25Z"></path>
                    <path d="M5 1.75C5 .784 5.784 0 6.75 0h7.5C15.216 0 16 .784 16 1.75v7.5A1.75 1.75 0 0 1 14.25 11h-7.5A1.75 1.75 0 0 1 5 9.25Zm1.75-.25a.25.25 0 0 0-.25.25v7.5c0 .138.112.25.25.25h7.5a.25.25 0 0 0 .25-.25v-7.5a.25.25 0 0 0-.25-.25Z"></path>
                  </svg>
                </button>
                {copied && <div className="tooltip show">Copied!</div>}
              </div>
            </>
          )}

          {selectedPlatform === 'chromeos' && (
            <>
              <p>Install the Android app from the Play Store:</p>
              <a
                href={PLAYSTORE_URL}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
              >
                Get it on Google Play
              </a>
            </>
          )}
        </div>
      </section>
    </div>
  )
}

export default App
