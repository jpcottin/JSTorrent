import React, { useEffect, useState, useSyncExternalStore, useCallback } from 'react'
import { useEngineManager, useFileOperations } from '../context/EngineManagerContext'
import { useConfig } from '../context/ConfigContext'
import type { ConfigHub, UPnPStatus } from '@jstorrent/engine'
import { clearAllUISettings } from '@jstorrent/ui'
import type { IEngineManager } from '../engine-manager/types'
import { standaloneConfirm, standaloneAlert } from '../utils/dialogs'
import { useHostChannel } from '../host/HostChannelContext'
import type { HostChannel } from '../host/host-channel'
import type { UpdateCheckResult, ProfileListEntry } from '../host/types'

/**
 * Build a config snapshot object from ConfigHub.
 * This is extracted to ensure consistent structure.
 */
function buildConfigSnapshot(config: ConfigHub) {
  return {
    // Notifications
    notifyOnTorrentComplete: config.notifyOnTorrentComplete.get(),
    notifyOnError: config.notifyOnError.get(),
    notifyProgressWhenBackgrounded: config.notifyProgressWhenBackgrounded.get(),
    // Behavior
    keepAwake: config.keepAwake.get(),
    preventBackgroundThrottling: config.preventBackgroundThrottling.get(),
    showFileSelection: config.showFileSelection.get(),
    // UI
    theme: config.theme.get(),
    progressBarStyle: config.progressBarStyle.get(),
    uiScale: config.uiScale.get(),
    maxFps: config.maxFps.get(),
    windowMode: config.windowMode.get(),
    // Network
    listeningPortAuto: config.listeningPortAuto.get(),
    listeningPort: config.listeningPort.get(),
    upnpEnabled: config.upnpEnabled.get(),
    encryptionPolicy: config.encryptionPolicy.get(),
    downloadSpeedUnlimited: config.downloadSpeedUnlimited.get(),
    downloadSpeedLimit: config.downloadSpeedLimit.get(),
    uploadSpeedUnlimited: config.uploadSpeedUnlimited.get(),
    uploadSpeedLimit: config.uploadSpeedLimit.get(),
    maxPeersPerTorrent: config.maxPeersPerTorrent.get(),
    maxGlobalPeers: config.maxGlobalPeers.get(),
    maxUploadSlots: config.maxUploadSlots.get(),
    maxPipelineDepth: config.maxPipelineDepth.get(),
    dhtEnabled: config.dhtEnabled.get(),
    // Queue
    activeDownloads: config.activeDownloads.get(),
    activeSeeds: config.activeSeeds.get(),
    // Advanced
    loggingLevel: config.loggingLevel.get(),
    loggingLevelClient: config.loggingLevelClient.get(),
    loggingLevelTorrent: config.loggingLevelTorrent.get(),
    loggingLevelPeer: config.loggingLevelPeer.get(),
    loggingLevelActivePieces: config.loggingLevelActivePieces.get(),
    loggingLevelContentStorage: config.loggingLevelContentStorage.get(),
    loggingLevelPartsFile: config.loggingLevelPartsFile.get(),
    loggingLevelTrackerManager: config.loggingLevelTrackerManager.get(),
    loggingLevelHttpTracker: config.loggingLevelHttpTracker.get(),
    loggingLevelUdpTracker: config.loggingLevelUdpTracker.get(),
    loggingLevelDht: config.loggingLevelDht.get(),
    daemonOpsPerSecond: config.daemonOpsPerSecond.get(),
    daemonOpsBurst: config.daemonOpsBurst.get(),
  }
}

/**
 * Hook to read all config values as a snapshot for UI rendering.
 * This provides a settings-like object for backward compatibility while
 * using ConfigHub as the source of truth.
 *
 * Uses a ref to cache the snapshot and only creates a new object when
 * values actually change (required by useSyncExternalStore).
 */
function useConfigSnapshot(config: ConfigHub) {
  // Cache the last snapshot to return same reference if unchanged
  const cacheRef = React.useRef<ReturnType<typeof buildConfigSnapshot> | null>(null)

  // getSnapshot must return cached value if nothing changed
  const getSnapshot = useCallback(() => {
    const newSnapshot = buildConfigSnapshot(config)

    // Compare with cached - if all values match, return cached reference
    if (cacheRef.current) {
      const cached = cacheRef.current
      const keys = Object.keys(newSnapshot) as (keyof typeof newSnapshot)[]
      const hasChanges = keys.some((key) => cached[key] !== newSnapshot[key])
      if (!hasChanges) {
        return cached
      }
    }

    // Values changed, update cache and return new snapshot
    cacheRef.current = newSnapshot
    return newSnapshot
  }, [config])

  // Subscribe to all changes
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      return config.subscribeAll(onStoreChange)
    },
    [config],
  )

  return useSyncExternalStore(subscribe, getSnapshot)
}

type ConfigSnapshot = ReturnType<typeof useConfigSnapshot>

type SettingsTab = 'general' | 'interface' | 'network' | 'advanced' | 'profiles'
type Theme = 'system' | 'dark' | 'light'
type ProgressBarStyle = 'text' | 'bar'
type UiScale = 'small' | 'default' | 'large' | 'larger'
type WindowMode = 'popup' | 'tab'

/** Strip Windows extended-length path prefix for display */
function formatPathForDisplay(path: string): string {
  if (path.startsWith('\\\\?\\')) {
    return path.slice(4)
  }
  return path
}

const PROGRESS_BAR_STYLES: { value: ProgressBarStyle; label: string }[] = [
  { value: 'text', label: 'Text Only' },
  { value: 'bar', label: 'Progress Bar' },
]

const UI_SCALES: { value: UiScale; label: string }[] = [
  { value: 'small', label: 'Small (85%)' },
  { value: 'default', label: 'Default (100%)' },
  { value: 'large', label: 'Large (115%)' },
  { value: 'larger', label: 'Larger (130%)' },
]

interface DownloadRoot {
  key: string
  label: string
  path: string
}

interface SettingsOverlayProps {
  isOpen: boolean
  onClose: () => void
  activeTab: SettingsTab
  setActiveTab: (tab: SettingsTab) => void
}

const TABS: { id: SettingsTab; label: string; platforms?: string[] }[] = [
  { id: 'general', label: 'General' },
  { id: 'interface', label: 'Interface' },
  { id: 'network', label: 'Network' },
  { id: 'profiles', label: 'Profiles', platforms: ['desktop', 'tauri'] },
  { id: 'advanced', label: 'Advanced' },
]

const FPS_OPTIONS = [1, 5, 10, 20, 30, 60, 120, 144, 165, 240, 0] // 0 = unlimited

export const SettingsOverlay: React.FC<SettingsOverlayProps> = ({
  isOpen,
  onClose,
  activeTab,
  setActiveTab,
}) => {
  const { config, resetAll } = useConfig()
  const settings = useConfigSnapshot(config)
  const engineManager = useEngineManager()
  const fileOps = useFileOperations()
  const channel = useHostChannel()

  // Download roots state
  const [roots, setRoots] = useState<DownloadRoot[]>([])
  const [defaultKey, setDefaultKey] = useState<string | null>(null)
  const [loadingRoots, setLoadingRoots] = useState(true)
  const [addingRoot, setAddingRoot] = useState(false)

  // Keep download roots in sync while the overlay is open so late ROOTS_CHANGED
  // updates do not leave settings showing stale state.
  useEffect(() => {
    if (!isOpen) return

    let cancelled = false
    const syncRoots = async () => {
      setLoadingRoots(true)
      const loadedRoots = engineManager.getRoots()
      const loadedDefaultKey = await engineManager.getDefaultRootKey()
      if (cancelled) return
      setRoots(loadedRoots)
      setDefaultKey(loadedDefaultKey)
      setLoadingRoots(false)
    }

    void syncRoots()

    const unsubStorageRoots = config.storageRoots.subscribe(() => {
      void syncRoots()
    })
    const unsubDefaultRoot = config.defaultRootKey.subscribe(() => {
      void syncRoots()
    })

    return () => {
      cancelled = true
      unsubStorageRoots()
      unsubDefaultRoot()
    }
  }, [isOpen, engineManager, config])

  const reloadRoots = async () => {
    setLoadingRoots(true)
    const loadedRoots = engineManager.getRoots()
    const loadedDefaultKey = await engineManager.getDefaultRootKey()
    setRoots(loadedRoots)
    setDefaultKey(loadedDefaultKey)
    setLoadingRoots(false)
  }

  const handleAddRoot = () => {
    if (!fileOps) return
    setAddingRoot(true)
    // Re-enable button after 2s (notification may be missed, allow retry)
    setTimeout(() => setAddingRoot(false), 2000)

    // Start picker in background, update UI when result comes back
    fileOps.pickDownloadFolder().then(async (root) => {
      if (root) {
        await reloadRoots()
        // If this is the first root, set it as default
        if (roots.length === 0) {
          await handleSetDefault(root.key)
        }
      }
    })
  }

  const handleSetDefault = async (key: string) => {
    await engineManager.setDefaultRoot(key)
    setDefaultKey(key)
  }

  const handleRemoveRoot = async (key: string) => {
    console.log('[SettingsOverlay] handleRemoveRoot called:', key, 'fileOps:', !!fileOps)
    if (!fileOps) {
      console.warn(
        '[SettingsOverlay] fileOps is null - supportsFileOperations:',
        engineManager.supportsFileOperations,
      )
      return
    }
    const root = roots.find((r) => r.key === key)

    const confirmed = standaloneConfirm(
      `Remove download location "${root?.label || key}"?\n\n` +
        'Existing downloads using this location will need to be moved or removed.',
    )
    console.log('[SettingsOverlay] confirmed:', confirmed)
    if (!confirmed) return

    console.log('[SettingsOverlay] Calling removeDownloadRoot for key:', key)
    const success = await fileOps.removeDownloadRoot(key)
    console.log('[SettingsOverlay] removeDownloadRoot returned:', success)
    if (success) {
      await reloadRoots()
    } else {
      standaloneAlert('Failed to remove download location.')
    }
  }

  // State for clear all data operation
  const [clearingData, setClearingData] = useState(false)

  // Handle reset all settings
  const handleResetAllSettings = async () => {
    const confirmed = standaloneConfirm(
      'Reset ALL settings to their default values?\n\n' +
        'This includes network limits, notification preferences, theme, and UI layout.\n' +
        'Your download locations and downloaded files will not be affected.\n\n' +
        'The page will reload to apply changes.',
    )
    if (confirmed) {
      await resetAll()
      clearAllUISettings()
      window.location.reload()
    }
  }

  // Handle clear all data (torrents + settings)
  const handleClearAllData = async (deleteFiles: boolean) => {
    setClearingData(true)
    try {
      // 1. Remove all torrents from engine
      const engine = engineManager.engine
      if (engine) {
        const torrents = [...engine.torrents]
        for (const torrent of torrents) {
          try {
            if (deleteFiles) {
              await engine.removeTorrentWithData(torrent)
            } else {
              await engine.removeTorrent(torrent)
            }
          } catch (e) {
            console.error('[Settings] Failed to remove torrent:', e)
          }
        }
      }

      // 2. Clear session storage (session:* keys) but preserve telemetryId and metrics
      try {
        await channel.clearSessionStorage()
      } catch (e) {
        console.error('[Settings] Failed to clear session storage:', e)
      }

      // 3. Reset all settings
      await resetAll()

      // 4. Clear UI settings
      clearAllUISettings()

      // 5. Reload page
      window.location.reload()
    } catch (e) {
      console.error('[Settings] Failed to clear all data:', e)
      standaloneAlert('Failed to clear all data. Please try again.')
    } finally {
      setClearingData(false)
    }
  }

  // Close on escape key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  if (!isOpen) return null

  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div style={styles.header}>
          <h2 style={styles.title}>Settings</h2>
          <button style={styles.closeButton} onClick={onClose} title="Close">
            &times;
          </button>
        </div>

        {/* Content area with sidebar */}
        <div style={styles.content}>
          {/* Left sidebar with tabs */}
          <div style={styles.sidebar}>
            {TABS.filter(
              (tab) => !tab.platforms || tab.platforms.includes(channel.getState().platform),
            ).map((tab) => (
              <button
                key={tab.id}
                style={{
                  ...styles.tabButton,
                  ...(activeTab === tab.id ? styles.tabButtonActive : {}),
                }}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Right content area */}
          <div style={styles.tabContent}>
            {activeTab === 'general' && (
              <GeneralTab
                roots={roots}
                defaultKey={defaultKey}
                loadingRoots={loadingRoots}
                addingRoot={addingRoot}
                onAddRoot={handleAddRoot}
                onSetDefault={handleSetDefault}
                onRemoveRoot={handleRemoveRoot}
                settings={settings}
                config={config}
                supportsFileOperations={engineManager.supportsFileOperations}
                rootsManageable={engineManager.rootsManageable}
                isStandalone={engineManager.isStandalone}
              />
            )}
            {activeTab === 'interface' && (
              <InterfaceTab
                settings={settings}
                config={config}
                isStandalone={engineManager.isStandalone}
              />
            )}
            {activeTab === 'network' && (
              <NetworkTab settings={settings} config={config} engineManager={engineManager} />
            )}
            {activeTab === 'profiles' && <ProfilesTab activeTab={activeTab} />}
            {activeTab === 'advanced' && (
              <AdvancedTab
                settings={settings}
                config={config}
                onResetAllSettings={handleResetAllSettings}
                onClearAllData={handleClearAllData}
                clearingData={clearingData}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ============ Tab Components ============

interface TabProps {
  settings: ConfigSnapshot
  config: ConfigHub
}

interface GeneralTabProps extends TabProps {
  roots: DownloadRoot[]
  defaultKey: string | null
  loadingRoots: boolean
  addingRoot: boolean
  onAddRoot: () => void
  onSetDefault: (key: string) => void
  onRemoveRoot: (key: string) => void
  supportsFileOperations: boolean
  rootsManageable: boolean
  isStandalone: boolean
}

const GeneralTab: React.FC<GeneralTabProps> = ({
  roots,
  defaultKey,
  loadingRoots,
  addingRoot,
  onAddRoot,
  onSetDefault,
  onRemoveRoot,
  settings,
  config,
  supportsFileOperations,
  rootsManageable,
  isStandalone,
}) => {
  const channel = useHostChannel()

  // Handle keepAwake toggle with permission request
  const handleKeepAwakeChange = async (enabled: boolean) => {
    if (enabled) {
      try {
        const granted = await channel.requestPermission('power')
        if (granted) {
          config.set('keepAwake', true)
          channel.setKeepAwake(true)
        }
        // If denied, toggle stays off (no action needed)
      } catch (e) {
        console.error('Failed to request power permission:', e)
      }
    } else {
      config.set('keepAwake', false)
      channel.setKeepAwake(false)
    }
  }

  return (
    <div>
      {supportsFileOperations && (
        <Section title="Download Locations">
          {loadingRoots ? (
            <div style={{ color: 'var(--text-secondary)' }}>Loading...</div>
          ) : roots.length === 0 ? (
            <div style={styles.warning}>
              <strong>No download location configured</strong>
              <p style={{ margin: 'var(--spacing-sm, 8px) 0 0 0' }}>
                {rootsManageable
                  ? 'You need to select a download folder before you can download torrents.'
                  : 'The daemon was started without a download location configured.'}
              </p>
            </div>
          ) : (
            <>
              {roots.length > 1 && (
                <div style={styles.fieldRow}>
                  <span>Default</span>
                  <select
                    value={defaultKey ?? ''}
                    onChange={(e) => onSetDefault(e.target.value)}
                    style={styles.select}
                  >
                    {roots.map((root) => (
                      <option key={root.key} value={root.key}>
                        {root.label}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div
                style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs, 4px)' }}
              >
                {roots.map((root) => (
                  <div key={root.key} style={styles.rootItem}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div>{root.label}</div>
                      <div
                        style={{
                          fontSize: 'var(--font-xs, 12px)',
                          color: 'var(--text-secondary)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {formatPathForDisplay(root.path)}
                      </div>
                    </div>
                    {rootsManageable && (
                      <button
                        style={{ ...styles.iconButton, color: 'var(--accent-error, #ef4444)' }}
                        onClick={() => onRemoveRoot(root.key)}
                        title="Remove"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
              </div>
              {!rootsManageable && (
                <div
                  style={{
                    marginTop: 'var(--spacing-sm, 8px)',
                    fontSize: 'var(--font-sm, 12px)',
                    color: 'var(--text-secondary)',
                  }}
                >
                  Download location is set by the daemon and cannot be changed here.
                </div>
              )}
            </>
          )}
          {rootsManageable && (
            <button onClick={onAddRoot} disabled={addingRoot} style={styles.addButton}>
              {addingRoot ? 'Selecting...' : '+ Add Download Location'}
            </button>
          )}
        </Section>
      )}

      <Section title="Notifications">
        <ToggleRow
          label="Notify when torrent completes"
          sublabel="Show notification when a single download finishes"
          checked={settings.notifyOnTorrentComplete}
          onChange={(v) => config.set('notifyOnTorrentComplete', v)}
        />
        <ToggleRow
          label="Notify on errors"
          sublabel="Show notification when a download fails"
          checked={settings.notifyOnError}
          onChange={(v) => config.set('notifyOnError', v)}
        />
        {!isStandalone && (
          <ToggleRow
            label="Show progress in background tab"
            sublabel="Persistent notification when you switch to another tab"
            checked={settings.notifyProgressWhenBackgrounded}
            onChange={(v) => config.set('notifyProgressWhenBackgrounded', v)}
          />
        )}
      </Section>

      <Section title="Behavior">
        <ToggleRow
          label="Keep system awake while downloading"
          sublabel={
            isStandalone
              ? 'Prevents sleep during active downloads'
              : 'Prevents sleep during active downloads (requires permission)'
          }
          checked={settings.keepAwake}
          onChange={handleKeepAwakeChange}
        />
        {!isStandalone && (
          <ToggleRow
            label="Prevent background throttling"
            sublabel="Keeps downloads running at full speed when tab is in background"
            checked={settings.preventBackgroundThrottling}
            onChange={(v) => config.set('preventBackgroundThrottling', v)}
          />
        )}
        <ToggleRow
          label="Show file selection when adding torrents"
          sublabel="Choose which files to download and where to save them"
          checked={settings.showFileSelection}
          onChange={(v) => config.set('showFileSelection', v)}
        />
      </Section>

      <Section title="About">
        <div style={styles.fieldRow}>
          <span>Version</span>
          <span style={{ color: 'var(--text-secondary)' }}>
            {(!isStandalone &&
              channel.getState().platform === 'desktop' &&
              channel.getState().daemonInfo?.desktopVersion) ||
              channel.getVersion() ||
              'unknown'}
          </span>
        </div>
        {(isStandalone || channel.getState().platform === 'desktop') && (
          <div style={styles.fieldRow}>
            <span>Updates</span>
            <UpdateCheckButton channel={channel} isStandalone={isStandalone} />
          </div>
        )}
      </Section>
    </div>
  )
}

/**
 * Poll channel state until desktopVersion matches expectedVersion or timeout.
 * Waits for the connection to come back after retryConnection() kills the native host.
 */
async function pollForVersion(
  channel: HostChannel,
  expectedVersion: string,
  timeoutMs: number,
): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const state = channel.getState()
    if (state.status === 'connected' && state.daemonInfo?.desktopVersion === expectedVersion) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

/** Button that checks for desktop app updates, showing results in a modal dialog. */
function UpdateCheckButton({
  channel,
  isStandalone,
}: {
  channel: HostChannel
  isStandalone: boolean
}) {
  const [checking, setChecking] = useState(false)
  const [installing, setInstalling] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [result, setResult] = useState<UpdateCheckResult | null>(null)
  const [dialogMessage, setDialogMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const closeDialog = () => {
    setResult(null)
    setDialogMessage(null)
    setError(null)
    setInstalling(false)
    setVerifying(false)
  }

  const handleCheck = async () => {
    setChecking(true)
    setResult(null)
    setDialogMessage(null)
    setError(null)
    try {
      const r = await channel.checkForUpdates()
      if (r === null) {
        // Channel handles updates itself (e.g., Tauri native updater)
      } else if (r.available) {
        setResult(r)
      } else {
        setDialogMessage('You are running the latest version.')
      }
    } catch {
      setError('Failed to check for updates.')
    }
    setChecking(false)
  }

  const handleInstall = async () => {
    const expectedVersion = result?.version
    if (!expectedVersion) return

    setInstalling(true)
    setError(null)

    // Trigger the install — don't rely on return value for success.
    // On Windows, NSIS kills the Tauri process mid-install so the native host
    // sees a premature exit. On all platforms, verify via version polling instead.
    try {
      await channel.installUpdate()
    } catch {
      // Swallow — install may have worked despite the error
    }

    setInstalling(false)
    setVerifying(true)

    // Wait for install to settle (especially Windows NSIS)
    await new Promise((resolve) => setTimeout(resolve, 3000))

    // Kill old native host, Chrome spawns a fresh one from the (now-updated) disk binary
    channel.retryConnection()

    // Poll until the reconnected native host reports the new version
    const verified = await pollForVersion(channel, expectedVersion, 30000)
    setVerifying(false)

    if (verified) {
      setResult(null)
      setDialogMessage(`Updated to v${expectedVersion}.`)
    } else {
      setError('Update may not have completed. Try checking again.')
    }
  }

  const showDialog = !!(result?.available || dialogMessage || error || installing || verifying)

  return (
    <>
      <button onClick={handleCheck} disabled={checking} style={styles.checkUpdatesButton}>
        {checking ? 'Checking...' : 'Check for Updates'}
      </button>
      {showDialog && (
        <div style={styles.dialogBackdrop} onClick={closeDialog}>
          <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3 style={styles.dialogTitle}>Updates</h3>
            {installing && <p style={styles.dialogMessage}>Installing...</p>}
            {verifying && <p style={styles.dialogMessage}>Verifying update...</p>}
            {error && (
              <p style={{ ...styles.dialogMessage, color: 'var(--accent-error)' }}>{error}</p>
            )}
            {dialogMessage && <p style={styles.dialogMessage}>{dialogMessage}</p>}
            {result?.available && !installing && !verifying && (
              <>
                <p style={styles.dialogMessage}>
                  Version <strong>{result.version}</strong> is available (current:{' '}
                  {result.currentVersion}).
                </p>
                {result.body && (
                  <div
                    style={{
                      maxHeight: 200,
                      overflowY: 'auto',
                      background: 'var(--bg-tertiary)',
                      borderRadius: '4px',
                      padding: '8px 12px',
                      marginBottom: 'var(--spacing-lg, 16px)',
                      fontSize: 'var(--font-sm, 13px)',
                      whiteSpace: 'pre-wrap',
                      color: 'var(--text-secondary)',
                    }}
                  >
                    {result.body}
                  </div>
                )}
              </>
            )}
            {!installing && !verifying && (
              <div style={styles.dialogButtons}>
                {result?.available && !isStandalone && (
                  <button onClick={handleInstall} style={styles.dialogButtonPrimary}>
                    Install &amp; Restart
                  </button>
                )}
                <button onClick={closeDialog} style={styles.dialogButtonCancel}>
                  {result?.available ? 'Later' : 'OK'}
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  )
}

interface InterfaceTabProps extends TabProps {
  isStandalone: boolean
}

const InterfaceTab: React.FC<InterfaceTabProps> = ({ settings, config, isStandalone }) => {
  const channel = useHostChannel()
  const state = channel.getState()
  const platform = state.platform
  const desktopVersion = state.daemonInfo?.desktopVersion

  return (
    <div>
      <Section title="Appearance">
        <div style={styles.fieldRow}>
          <span>Theme</span>
          <div style={styles.radioGroup}>
            {(['system', 'dark', 'light'] as Theme[]).map((theme) => (
              <label key={theme} style={styles.radioLabel}>
                <input
                  type="radio"
                  name="theme"
                  checked={settings.theme === theme}
                  onChange={() => config.set('theme', theme)}
                />
                {theme.charAt(0).toUpperCase() + theme.slice(1)}
              </label>
            ))}
          </div>
        </div>
        <div style={styles.fieldRow}>
          <span>Progress Bar Style</span>
          <select
            value={settings.progressBarStyle}
            onChange={(e) => config.set('progressBarStyle', e.target.value as ProgressBarStyle)}
            style={styles.select}
          >
            {PROGRESS_BAR_STYLES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div style={styles.fieldRow}>
          <span>UI Scale</span>
          <select
            value={settings.uiScale}
            onChange={(e) => config.set('uiScale', e.target.value as UiScale)}
            style={styles.select}
          >
            {UI_SCALES.map(({ value, label }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </div>
        {!isStandalone && (
          <div style={styles.fieldRow}>
            <div style={{ flex: 1 }}>
              <div>Window Mode</div>
              <div style={{ fontSize: 'var(--font-xs, 12px)', color: 'var(--text-secondary)' }}>
                Popup opens in a standalone window without browser chrome
              </div>
            </div>
            <select
              value={settings.windowMode}
              onChange={(e) => config.set('windowMode', e.target.value as WindowMode)}
              style={styles.select}
            >
              <option value="popup">Popup Window</option>
              <option value="tab">Browser Tab</option>
            </select>
          </div>
        )}
      </Section>

      <Section title="Performance">
        <div style={styles.fieldRow}>
          <span>Max FPS</span>
          <select
            value={settings.maxFps}
            onChange={(e) => config.set('maxFps', Number(e.target.value))}
            style={styles.select}
          >
            {FPS_OPTIONS.map((fps) => (
              <option key={fps} value={fps}>
                {fps === 0 ? 'Match refresh rate' : fps}
              </option>
            ))}
          </select>
        </div>
      </Section>

      {platform === 'desktop' && !isStandalone && desktopVersion && (
        <DesktopAppSection desktopVersion={desktopVersion} channel={channel} />
      )}
    </div>
  )
}

/** "Desktop App" section shown in Interface tab when extension is connected to desktop host. */
function DesktopAppSection({
  desktopVersion,
  channel,
}: {
  desktopVersion: string
  channel: HostChannel
}) {
  const [launching, setLaunching] = useState(false)

  const handleLaunch = async () => {
    setLaunching(true)
    try {
      await channel.launchDesktop()
    } catch {
      // Ignore — bridge will disconnect when native host is killed
    }
    // Don't reset launching — the extension will disconnect shortly
  }

  return (
    <Section title="Desktop App">
      <div style={{ color: 'var(--text-secondary)', marginBottom: 'var(--spacing-md, 12px)' }}>
        You can also use JSTorrent as a standalone desktop app.
      </div>
      <div style={styles.fieldRow}>
        <span style={{ flex: 1 }}>v{desktopVersion} installed</span>
        <button onClick={handleLaunch} disabled={launching} style={styles.checkUpdatesButton}>
          {launching ? 'Opening...' : 'Open Desktop App'}
        </button>
      </div>
    </Section>
  )
}

interface NetworkTabProps extends TabProps {
  engineManager: IEngineManager
}

/** Generate a random port in the ephemeral range (49152-65535) */
function generateRandomPort(): number {
  return Math.floor(Math.random() * (65535 - 49152 + 1)) + 49152
}

const NetworkTab: React.FC<NetworkTabProps> = ({ settings, config, engineManager }) => {
  // UPnP status state - initialize from engine if available
  const [upnpStatus, setUpnpStatus] = useState<UPnPStatus>(
    () => engineManager.engine?.upnpStatus ?? 'disabled',
  )

  // Subscribe to UPnP status changes
  useEffect(() => {
    const engine = engineManager.engine
    if (!engine) return

    // Subscribe to changes
    const handler = (status: UPnPStatus) => setUpnpStatus(status)
    engine.on('upnpStatusChanged', handler)
    return () => {
      engine.off('upnpStatusChanged', handler)
    }
  }, [engineManager])

  // Port auto handlers
  const handlePortAutoChange = (auto: boolean) => {
    config.set('listeningPortAuto', auto)
    // If switching to manual and no port is set yet, generate a random one
    if (!auto && settings.listeningPort === 0) {
      config.set('listeningPort', generateRandomPort())
    }
  }

  // Speed limit handlers - now use separate boolean flags
  const handleDownloadLimitChange = (v: number) => {
    config.set('downloadSpeedLimit', v)
  }

  const handleDownloadUnlimitedChange = (unlimited: boolean) => {
    config.set('downloadSpeedUnlimited', unlimited)
  }

  const handleUploadLimitChange = (v: number) => {
    config.set('uploadSpeedLimit', v)
  }

  const handleUploadUnlimitedChange = (unlimited: boolean) => {
    config.set('uploadSpeedUnlimited', unlimited)
  }

  // UPnP status indicator
  const getUpnpStatusInfo = (): { text: string; color: string } => {
    switch (upnpStatus) {
      case 'discovering':
        return { text: 'Discovering...', color: 'var(--text-secondary)' }
      case 'mapped': {
        const externalIP = engineManager.engine?.upnpExternalIP
        return { text: externalIP ? `✓ ${externalIP}` : '✓ Mapped', color: 'var(--accent-success)' }
      }
      case 'unavailable':
        return { text: 'Unavailable', color: 'var(--text-secondary)' }
      case 'failed':
        return { text: 'Failed', color: 'var(--accent-error)' }
      default:
        return { text: '', color: '' }
    }
  }

  const statusInfo = getUpnpStatusInfo()

  // Incoming connection verification status
  const hasReceivedIncoming = engineManager.engine?.hasReceivedIncomingConnection ?? false
  const incomingStatusInfo =
    upnpStatus === 'mapped'
      ? hasReceivedIncoming
        ? { text: 'Incoming: verified', color: 'var(--accent-success)' }
        : { text: 'Incoming: not yet verified', color: 'var(--text-secondary)' }
      : null

  return (
    <div>
      <Section title="Listening Port">
        <PortRow
          portAuto={settings.listeningPortAuto}
          port={settings.listeningPort}
          onAutoChange={handlePortAutoChange}
          onPortChange={(v) => config.set('listeningPort', v)}
          currentPort={engineManager.engine?.listeningPort}
          engineRunning={!!engineManager.engine}
        />
      </Section>

      <Section title="Port Forwarding">
        <label style={styles.toggleRow}>
          <div style={{ flex: 1 }}>
            <div>Enable UPnP</div>
            <div style={{ fontSize: 'var(--font-xs, 12px)', color: 'var(--text-secondary)' }}>
              Automatically configure router for incoming connections
            </div>
          </div>
          <div
            style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '2px' }}
          >
            {statusInfo.text && (
              <span
                style={{
                  fontSize: 'var(--font-xs, 12px)',
                  color: statusInfo.color,
                }}
              >
                {statusInfo.text}
              </span>
            )}
            {incomingStatusInfo && (
              <span
                style={{
                  fontSize: 'var(--font-xs, 12px)',
                  color: incomingStatusInfo.color,
                }}
              >
                {incomingStatusInfo.text}
              </span>
            )}
          </div>
          <input
            type="checkbox"
            checked={settings.upnpEnabled}
            onChange={(e) => config.set('upnpEnabled', e.target.checked)}
            style={{ marginLeft: 'var(--spacing-md, 12px)' }}
          />
        </label>
      </Section>

      <Section title="Encryption">
        <label style={styles.toggleRow}>
          <div style={{ flex: 1 }}>
            <div>Protocol encryption (MSE/PE)</div>
            <div style={{ fontSize: 'var(--font-xs, 12px)', color: 'var(--text-secondary)' }}>
              Encrypts BitTorrent protocol traffic
            </div>
          </div>
          <select
            value={settings.encryptionPolicy}
            onChange={(e) =>
              config.set(
                'encryptionPolicy',
                e.target.value as 'disabled' | 'allow' | 'prefer' | 'required',
              )
            }
            style={styles.select}
          >
            <option value="disabled">Disable</option>
            <option value="allow">Allow</option>
            <option value="prefer">Prefer</option>
            <option value="required">Require</option>
          </select>
        </label>
      </Section>

      <Section title="Speed Limits">
        <SpeedLimitRow
          label="Download"
          value={settings.downloadSpeedLimit}
          unlimited={settings.downloadSpeedUnlimited}
          onValueChange={handleDownloadLimitChange}
          onUnlimitedChange={handleDownloadUnlimitedChange}
        />
        <SpeedLimitRow
          label="Upload"
          value={settings.uploadSpeedLimit}
          unlimited={settings.uploadSpeedUnlimited}
          onValueChange={handleUploadLimitChange}
          onUnlimitedChange={handleUploadUnlimitedChange}
        />
      </Section>

      <Section title="Connection Limits">
        <NumberRow
          label="Max peers per torrent"
          value={settings.maxPeersPerTorrent}
          onChange={(v) => config.set('maxPeersPerTorrent', v)}
          min={1}
          max={500}
        />
        <NumberRow
          label="Global max peers"
          value={settings.maxGlobalPeers}
          onChange={(v) => config.set('maxGlobalPeers', v)}
          min={1}
          max={2000}
        />
        <NumberRow
          label="Max upload slots"
          value={settings.maxUploadSlots}
          onChange={(v) => config.set('maxUploadSlots', v)}
          min={0}
          max={50}
        />
        <NumberRow
          label="Pipeline depth"
          value={settings.maxPipelineDepth}
          onChange={(v) => config.set('maxPipelineDepth', v)}
          min={10}
          max={500}
        />
      </Section>

      <Section title="Queue">
        <NumberRow
          label="Max active downloads"
          value={settings.activeDownloads}
          onChange={(v) => config.set('activeDownloads', v)}
          min={1}
          max={20}
        />
      </Section>

      <Section title="Peer Discovery">
        <ToggleRow
          label="Enable DHT"
          sublabel="Distributed Hash Table for finding peers without trackers"
          checked={settings.dhtEnabled}
          onChange={(enabled) => config.set('dhtEnabled', enabled)}
        />
      </Section>
    </div>
  )
}

interface AdvancedTabProps extends TabProps {
  onResetAllSettings: () => void
  onClearAllData: (deleteFiles: boolean) => Promise<void>
  clearingData: boolean
}

// Log level options for global setting
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const
type LogLevelValue = (typeof LOG_LEVELS)[number]

const AdvancedTab: React.FC<AdvancedTabProps> = ({
  settings,
  config,
  onResetAllSettings,
  onClearAllData,
  clearingData,
}) => {
  // Clear all data dialog state
  const [showClearDataDialog, setShowClearDataDialog] = useState(false)
  const [deleteFilesChecked, setDeleteFilesChecked] = useState(false)

  const handleClearAllData = async () => {
    await onClearAllData(deleteFilesChecked)
    setShowClearDataDialog(false)
    setDeleteFilesChecked(false)
  }

  return (
    <div>
      <Section title="Logging">
        <div style={{ color: 'var(--text-secondary)', marginBottom: 'var(--spacing-md, 12px)' }}>
          Controls the verbosity of engine logs. More verbose levels (debug) may generate
          significant output.
        </div>
        <div style={styles.fieldRow}>
          <span style={{ flex: 1 }}>Global log level</span>
          <select
            value={settings.loggingLevel}
            onChange={(e) => config.set('loggingLevel', e.target.value as LogLevelValue)}
            style={styles.select}
          >
            {LOG_LEVELS.map((level) => (
              <option key={level} value={level}>
                {level.charAt(0).toUpperCase() + level.slice(1)}
              </option>
            ))}
          </select>
        </div>
      </Section>

      <Section title="Danger Zone">
        <div style={styles.dangerItem}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>Reset Settings</div>
            <div style={{ fontSize: 'var(--font-xs, 12px)', color: 'var(--text-secondary)' }}>
              Restore all settings to defaults. Your torrents and files are not affected.
            </div>
          </div>
          <button onClick={onResetAllSettings} style={styles.dangerButtonSmall}>
            Reset
          </button>
        </div>
        <div style={styles.dangerItem}>
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 500 }}>Clear All Data</div>
            <div style={{ fontSize: 'var(--font-xs, 12px)', color: 'var(--text-secondary)' }}>
              Remove all torrents and reset all settings. Like reinstalling the extension.
            </div>
          </div>
          <button
            onClick={() => setShowClearDataDialog(true)}
            style={styles.dangerButtonSmall}
            disabled={clearingData}
          >
            {clearingData ? 'Clearing...' : 'Clear All'}
          </button>
        </div>
      </Section>

      {/* Clear All Data Confirmation Dialog */}
      {showClearDataDialog && (
        <div style={styles.dialogBackdrop} onClick={() => setShowClearDataDialog(false)}>
          <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3 style={styles.dialogTitle}>Clear all data?</h3>
            <p style={styles.dialogMessage}>
              This will remove all torrents, settings, and UI preferences. This is like reinstalling
              the extension.
            </p>
            <label style={styles.dialogCheckbox}>
              <input
                type="checkbox"
                checked={deleteFilesChecked}
                onChange={(e) => setDeleteFilesChecked(e.target.checked)}
              />
              Also delete downloaded files
            </label>
            <div style={styles.dialogButtons}>
              <button
                onClick={() => setShowClearDataDialog(false)}
                style={styles.dialogButtonCancel}
              >
                Cancel
              </button>
              <button
                onClick={handleClearAllData}
                style={styles.dialogButtonDanger}
                disabled={clearingData}
              >
                {clearingData ? 'Clearing...' : 'Clear All'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============ Profiles Tab ============

function formatRelativeTime(epochSecs: number): string {
  const now = Date.now() / 1000
  const diff = now - epochSecs
  if (diff < 60) return 'just now'
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const ProfilesTab: React.FC<{ activeTab: SettingsTab }> = ({ activeTab }) => {
  const channel = useHostChannel()
  const [profiles, setProfiles] = useState<ProfileListEntry[]>([])
  const [loading, setLoading] = useState(true)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editName, setEditName] = useState('')
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)

  const currentProfileId = channel.getState().daemonInfo?.profileId

  // Load on tab activation, poll every 5s while active
  useEffect(() => {
    if (activeTab !== 'profiles') return
    let active = true
    async function fetchProfiles() {
      const list = await channel.listProfiles()
      if (active) {
        setProfiles(list)
        setLoading(false)
      }
    }
    fetchProfiles()
    const interval = setInterval(fetchProfiles, 5000)
    return () => {
      active = false
      clearInterval(interval)
    }
  }, [activeTab, channel])

  const handleRename = async (profileId: string) => {
    const trimmed = editName.trim()
    if (!trimmed) {
      setEditingId(null)
      return
    }
    const ok = await channel.renameProfile(profileId, trimmed)
    if (ok) {
      setProfiles((prev) =>
        prev.map((p) => (p.profileId === profileId ? { ...p, displayName: trimmed } : p)),
      )
    }
    setEditingId(null)
  }

  const handleSwitch = async (profileId: string) => {
    try {
      await channel.switchProfile(profileId)
    } catch (e) {
      standaloneAlert(`Failed to switch profile: ${e}`)
    }
  }

  const handleCreateNew = async () => {
    try {
      await channel.switchProfile(null)
    } catch (e) {
      standaloneAlert(`Failed to create profile: ${e}`)
    }
  }

  const handleDelete = async (profileId: string) => {
    const ok = await channel.deleteProfile(profileId)
    if (ok) {
      setProfiles((prev) => prev.filter((p) => p.profileId !== profileId))
    } else {
      standaloneAlert('Failed to remove profile')
    }
    setDeleteConfirmId(null)
  }

  return (
    <div>
      <Section title="Profiles">
        {loading ? (
          <div style={{ color: 'var(--text-secondary)' }}>Loading...</div>
        ) : profiles.length === 0 ? (
          <div style={{ color: 'var(--text-secondary)' }}>No profiles found.</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--spacing-xs, 4px)' }}>
            {profiles.map((profile) => {
              const isCurrent = profile.profileId === currentProfileId
              const isEditing = editingId === profile.profileId
              return (
                <div key={profile.profileId} style={styles.rootItem}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      {isEditing ? (
                        <input
                          type="text"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          onBlur={() => handleRename(profile.profileId)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleRename(profile.profileId)
                            if (e.key === 'Escape') setEditingId(null)
                          }}
                          autoFocus
                          style={styles.numberInput}
                        />
                      ) : (
                        <span>{profile.displayName || profile.profileId}</span>
                      )}
                      {isCurrent && (
                        <span
                          style={{
                            padding: '1px 6px',
                            background: 'var(--accent-primary)',
                            color: 'white',
                            borderRadius: '4px',
                            fontSize: 'var(--font-xs, 12px)',
                          }}
                        >
                          Current
                        </span>
                      )}
                      {profile.live && (
                        <span
                          style={{
                            width: '8px',
                            height: '8px',
                            borderRadius: '50%',
                            background: 'var(--accent-success, #22c55e)',
                            display: 'inline-block',
                          }}
                          title="Active"
                        />
                      )}
                    </div>
                    <div
                      style={{
                        fontSize: 'var(--font-xs, 12px)',
                        color: 'var(--text-secondary)',
                      }}
                    >
                      Last used {formatRelativeTime(profile.lastUsed)}
                      {profile.clientType ? ` \u00b7 ${profile.clientType}` : ''}
                    </div>
                  </div>
                  {!isEditing && (
                    <button
                      style={styles.iconButton}
                      onClick={() => {
                        setEditingId(profile.profileId)
                        setEditName(profile.displayName)
                      }}
                      title="Rename"
                    >
                      ✎
                    </button>
                  )}
                  {!isCurrent && (
                    <button
                      onClick={() => handleSwitch(profile.profileId)}
                      style={styles.checkUpdatesButton}
                    >
                      Switch
                    </button>
                  )}
                  {!isCurrent && !isEditing && (
                    <button
                      style={styles.iconButton}
                      onClick={() => setDeleteConfirmId(profile.profileId)}
                      title="Remove"
                    >
                      ✕
                    </button>
                  )}
                </div>
              )
            })}
          </div>
        )}
        <button onClick={handleCreateNew} style={styles.addButton}>
          + Create New Profile
        </button>
      </Section>
      {deleteConfirmId && (
        <div style={styles.dialogBackdrop} onClick={() => setDeleteConfirmId(null)}>
          <div style={styles.dialog} onClick={(e) => e.stopPropagation()}>
            <h3 style={styles.dialogTitle}>Remove profile?</h3>
            <p style={styles.dialogMessage}>
              This will delete the profile and its stored data. Torrents are not affected.
            </p>
            <div style={styles.dialogButtons}>
              <button style={styles.dialogButtonCancel} onClick={() => setDeleteConfirmId(null)}>
                Cancel
              </button>
              <button
                style={styles.dialogButtonDanger}
                onClick={() => handleDelete(deleteConfirmId)}
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ============ Reusable Components ============

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={styles.section}>
    <h3 style={styles.sectionTitle}>{title}</h3>
    {children}
  </div>
)

interface ToggleRowProps {
  label: string
  sublabel?: string
  checked: boolean
  onChange: (checked: boolean) => void
  disabled?: boolean
}

const ToggleRow: React.FC<ToggleRowProps> = ({ label, sublabel, checked, onChange, disabled }) => (
  <label
    style={{
      ...styles.toggleRow,
      opacity: disabled ? 0.5 : 1,
      cursor: disabled ? 'not-allowed' : 'pointer',
    }}
  >
    <div style={{ flex: 1 }}>
      <div>{label}</div>
      {sublabel && (
        <div style={{ fontSize: 'var(--font-xs, 12px)', color: 'var(--text-secondary)' }}>
          {sublabel}
        </div>
      )}
    </div>
    <input
      type="checkbox"
      checked={checked}
      onChange={(e) => !disabled && onChange(e.target.checked)}
      disabled={disabled}
    />
  </label>
)

interface PortRowProps {
  portAuto: boolean
  port: number
  onAutoChange: (auto: boolean) => void
  onPortChange: (port: number) => void
  currentPort?: number
  engineRunning: boolean
}

const PortRow: React.FC<PortRowProps> = ({
  portAuto,
  port,
  onAutoChange,
  onPortChange,
  currentPort,
  engineRunning,
}) => {
  // Track if user is actively editing
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  // Display either the edit value (while editing) or derived value (from props)
  const displayValue = isEditing ? editValue : port > 0 ? String(port) : ''

  const validatePort = (v: number): string | null => {
    if (v < 1024) {
      return 'Privileged ports (< 1024) are not allowed'
    }
    if (v > 65535) {
      return 'Port must be 65535 or less'
    }
    return null
  }

  const handleFocus = () => {
    setIsEditing(true)
    setEditValue(port > 0 ? String(port) : '')
  }

  const handleBlur = () => {
    setIsEditing(false)
    const v = Number(editValue)
    if (!Number.isFinite(v) || v <= 0) {
      setError(null)
      return
    }
    const validationError = validatePort(v)
    if (validationError) {
      setError(validationError)
      return
    }
    setError(null)
    onPortChange(v)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleBlur()
      ;(e.target as HTMLInputElement).blur()
    }
  }

  return (
    <>
      <label style={styles.toggleRow}>
        <div style={{ flex: 1 }}>
          <div>Choose port automatically</div>
          <div style={{ fontSize: 'var(--font-xs, 12px)', color: 'var(--text-secondary)' }}>
            Let the system assign an available port
          </div>
        </div>
        <input
          type="checkbox"
          checked={portAuto}
          onChange={(e) => onAutoChange(e.target.checked)}
        />
      </label>
      {!portAuto && (
        <div style={styles.fieldRow}>
          <span style={{ flex: 1 }}>Port</span>
          <input
            type="number"
            value={displayValue}
            onChange={(e) => {
              setEditValue(e.target.value)
              setError(null)
            }}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onKeyDown={handleKeyDown}
            min={1024}
            max={65535}
            style={styles.numberInput}
          />
        </div>
      )}
      {error && (
        <div
          style={{
            fontSize: 'var(--font-xs, 12px)',
            color: 'var(--accent-error)',
            marginTop: 'var(--spacing-xs, 4px)',
          }}
        >
          {error}
        </div>
      )}
      <div
        style={{
          fontSize: 'var(--font-xs, 12px)',
          color: 'var(--text-secondary)',
          marginTop: 'var(--spacing-sm, 8px)',
        }}
      >
        {engineRunning && currentPort && <div>Currently listening on port {currentPort}</div>}
        {!engineRunning && 'Changes require restart to take effect.'}
      </div>
    </>
  )
}

interface SpeedLimitRowProps {
  label: string
  value: number
  unlimited: boolean
  onValueChange: (value: number) => void
  onUnlimitedChange: (unlimited: boolean) => void
}

const SpeedLimitRow: React.FC<SpeedLimitRowProps> = ({
  label,
  value,
  unlimited,
  onValueChange,
  onUnlimitedChange,
}) => {
  const derivedValue = String(Math.round(value / 1024))

  // Track if user is actively editing (to prevent prop sync during edit)
  const [isEditing, setIsEditing] = useState(false)
  const [editValue, setEditValue] = useState(derivedValue)

  // Display either the edit value (while editing) or derived value (from props)
  const displayValue = isEditing ? editValue : derivedValue

  const handleFocus = () => {
    setIsEditing(true)
    setEditValue(derivedValue)
  }

  const handleBlur = () => {
    setIsEditing(false)
    const kb = Number(editValue)
    if (Number.isFinite(kb) && kb > 0) {
      onValueChange(kb * 1024)
    } else {
      // Invalid or zero - reset to current value
      setEditValue(derivedValue)
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleBlur()
      ;(e.target as HTMLInputElement).blur()
    }
  }

  return (
    <div style={styles.fieldRow}>
      <span style={{ minWidth: '80px' }}>{label}</span>
      <input
        type="number"
        value={displayValue}
        onChange={(e) => setEditValue(e.target.value)}
        onFocus={handleFocus}
        onBlur={handleBlur}
        onKeyDown={handleKeyDown}
        disabled={unlimited}
        placeholder="0"
        min={0}
        style={{ ...styles.numberInput, opacity: unlimited ? 0.5 : 1 }}
      />
      <span style={{ fontSize: 'var(--font-xs, 12px)' }}>KB/s</span>
      <label
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--spacing-xs, 4px)',
          marginLeft: 'var(--spacing-md, 12px)',
        }}
      >
        <input
          type="checkbox"
          checked={unlimited}
          onChange={(e) => onUnlimitedChange(e.target.checked)}
        />
        Unlimited
      </label>
    </div>
  )
}

interface NumberRowProps {
  label: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
}

const NumberRow: React.FC<NumberRowProps> = ({ label, value, onChange, min = 0, max = 9999 }) => {
  const [inputValue, setInputValue] = useState(String(value))

  // Sync from prop when it changes externally
  useEffect(() => {
    setInputValue(String(value))
  }, [value])

  const handleBlur = () => {
    const v = Number(inputValue)
    if (Number.isFinite(v)) {
      // Clamp to range and update
      const clamped = Math.max(min, Math.min(max, v))
      onChange(clamped)
      setInputValue(String(clamped))
    } else {
      // Invalid input, reset to current value
      setInputValue(String(value))
    }
  }

  return (
    <div style={styles.fieldRow}>
      <span style={{ flex: 1 }}>{label}</span>
      <input
        type="number"
        value={inputValue}
        onChange={(e) => setInputValue(e.target.value)}
        onBlur={handleBlur}
        min={min}
        max={max}
        style={styles.numberInput}
      />
    </div>
  )
}

// ============ Styles ============

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.5)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingTop: '80px',
    zIndex: 1000,
  },
  modal: {
    background: 'var(--bg-primary)',
    borderRadius: 'var(--spacing-sm, 8px)',
    width: '90%',
    maxWidth: '800px',
    minHeight: '500px',
    maxHeight: 'calc(100vh - 120px)',
    display: 'flex',
    flexDirection: 'column',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
    border: '1px solid var(--border-color)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--spacing-lg, 16px) var(--spacing-lg, 20px)',
    borderBottom: '1px solid var(--border-color)',
  },
  title: {
    margin: 0,
    fontSize: 'var(--font-lg, 18px)',
    fontWeight: 600,
  },
  closeButton: {
    background: 'none',
    border: 'none',
    fontSize: 'var(--font-xl, 24px)',
    cursor: 'pointer',
    color: 'var(--text-secondary)',
    padding: '0 var(--spacing-xs, 4px)',
    lineHeight: 1,
  },
  content: {
    display: 'flex',
    flex: 1,
    overflow: 'hidden',
  },
  sidebar: {
    width: '140px',
    borderRight: '1px solid var(--border-color)',
    padding: 'var(--spacing-sm, 8px)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--spacing-xs, 4px)',
    flexShrink: 0,
    background: 'var(--bg-secondary)',
  },
  tabButton: {
    background: 'transparent',
    border: 'none',
    padding: 'var(--spacing-sm, 10px) var(--spacing-md, 12px)',
    textAlign: 'left',
    cursor: 'pointer',
    borderRadius: '4px',
    color: 'var(--text-primary)',
    fontSize: 'var(--font-sm, 14px)',
  },
  tabButtonActive: {
    background: 'var(--accent-primary)',
    color: 'white',
  },
  tabContent: {
    flex: 1,
    padding: 'var(--spacing-lg, 20px)',
    overflowY: 'auto',
    background: 'var(--bg-primary)',
  },
  section: {
    marginBottom: 'var(--spacing-lg, 16px)',
    padding: 'var(--spacing-md, 12px)',
    background: 'var(--bg-secondary)',
    borderRadius: '6px',
    border: '1px solid var(--border-color)',
  },
  sectionTitle: {
    margin: '0 0 var(--spacing-md, 12px) 0',
    fontSize: 'var(--font-xs, 12px)',
    fontWeight: 600,
    textTransform: 'uppercase',
    color: 'var(--text-secondary)',
    letterSpacing: '0.5px',
  },
  warning: {
    padding: 'var(--spacing-md, 12px)',
    background: 'var(--bg-warning, rgba(234, 179, 8, 0.1))',
    border: '1px solid var(--border-warning, #eab308)',
    borderRadius: '4px',
    marginBottom: 'var(--spacing-md, 12px)',
  },
  rootItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-sm, 8px)',
    padding: 'var(--spacing-sm, 8px)',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-light)',
    borderRadius: '4px',
  },
  iconButton: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: 'var(--spacing-xs, 4px)',
    fontSize: 'var(--font-md, 16px)',
    opacity: 0.6,
  },
  defaultBadge: {
    padding: 'var(--spacing-xs, 4px) var(--spacing-sm, 8px)',
    background: 'var(--accent-primary)',
    color: 'white',
    borderRadius: '4px',
    fontSize: 'var(--font-xs, 12px)',
  },
  addButton: {
    marginTop: 'var(--spacing-md, 12px)',
    padding: 'var(--spacing-sm, 8px) var(--spacing-lg, 16px)',
    background: 'var(--accent-success)',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  checkUpdatesButton: {
    padding: 'var(--spacing-xs, 6px) var(--spacing-md, 12px)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-light)',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: 'var(--font-xs, 12px)',
    marginLeft: 'auto',
  },
  dangerButton: {
    padding: 'var(--spacing-sm, 8px) var(--spacing-lg, 16px)',
    background: 'var(--accent-error, #ef4444)',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  fieldRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-md, 12px)',
    marginBottom: 'var(--spacing-sm, 8px)',
    padding: 'var(--spacing-sm, 10px) var(--spacing-md, 12px)',
    background: 'var(--bg-tertiary)',
    borderRadius: '4px',
    border: '1px solid var(--border-light)',
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-md, 12px)',
    marginBottom: 'var(--spacing-sm, 8px)',
    padding: 'var(--spacing-sm, 10px) var(--spacing-md, 12px)',
    background: 'var(--bg-tertiary)',
    borderRadius: '4px',
    border: '1px solid var(--border-light)',
    cursor: 'pointer',
  },
  radioGroup: {
    display: 'flex',
    gap: 'var(--spacing-lg, 16px)',
  },
  radioLabel: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-xs, 6px)',
    cursor: 'pointer',
  },
  select: {
    padding: 'var(--spacing-xs, 6px) var(--spacing-sm, 10px)',
    borderRadius: '4px',
    border: '1px solid var(--border-color)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
  },
  numberInput: {
    width: '80px',
    padding: 'var(--spacing-xs, 6px) var(--spacing-sm, 10px)',
    borderRadius: '4px',
    border: '1px solid var(--border-color)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
  },
  dangerItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-md, 12px)',
    padding: 'var(--spacing-sm, 10px) var(--spacing-md, 12px)',
    background: 'var(--bg-tertiary)',
    borderRadius: '4px',
    border: '1px solid var(--border-light)',
    marginBottom: 'var(--spacing-sm, 8px)',
  },
  dangerButtonSmall: {
    padding: 'var(--spacing-xs, 6px) var(--spacing-md, 12px)',
    background: 'var(--accent-error, #ef4444)',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontSize: 'var(--font-sm, 14px)',
    whiteSpace: 'nowrap',
  },
  dialogBackdrop: {
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0, 0, 0, 0.6)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 2000,
  },
  dialog: {
    background: 'var(--bg-primary)',
    borderRadius: '8px',
    padding: 'var(--spacing-lg, 20px)',
    maxWidth: '400px',
    width: '90%',
    boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    border: '1px solid var(--border-color)',
  },
  dialogTitle: {
    margin: '0 0 var(--spacing-md, 12px) 0',
    fontSize: 'var(--font-lg, 18px)',
    fontWeight: 600,
  },
  dialogMessage: {
    margin: '0 0 var(--spacing-lg, 16px) 0',
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  dialogCheckbox: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--spacing-sm, 8px)',
    padding: 'var(--spacing-sm, 10px) var(--spacing-md, 12px)',
    background: 'var(--bg-warning, rgba(234, 179, 8, 0.1))',
    border: '1px solid var(--border-warning, #eab308)',
    borderRadius: '4px',
    marginBottom: 'var(--spacing-lg, 16px)',
    cursor: 'pointer',
  },
  dialogButtons: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: 'var(--spacing-sm, 8px)',
  },
  dialogButtonCancel: {
    padding: 'var(--spacing-sm, 8px) var(--spacing-lg, 16px)',
    background: 'var(--bg-secondary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  dialogButtonDanger: {
    padding: 'var(--spacing-sm, 8px) var(--spacing-lg, 16px)',
    background: 'var(--accent-error, #ef4444)',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
  },
  dialogButtonPrimary: {
    padding: 'var(--spacing-sm, 8px) var(--spacing-lg, 16px)',
    background: 'var(--accent-primary)',
    color: 'white',
    border: 'none',
    borderRadius: '4px',
    cursor: 'pointer',
    fontWeight: 600,
  },
}
