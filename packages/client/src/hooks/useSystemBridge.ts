import { useState, useCallback, useMemo } from 'react'
import type { BtEngine } from '@jstorrent/engine'
import type { DaemonBridgeState, VersionStatus } from '../components/SystemBridgePanel'
import type { DownloadRoot } from '../types'
import type { DaemonStats, UsageMetrics } from '../host/types'
import { copyTextToClipboard } from '../utils/clipboard'

/** Which type of I/O backend the extension is connected to. */
export type BackendType = 'desktop' | 'android' | 'self'

/**
 * Per-backend minimum version requirements.
 * Update these before releasing an extension that depends on new backend features.
 *
 * - desktop.minSupported: Minimum Tauri desktop app version (desktopVersion field).
 * - android.minSupported: Minimum Android app version (version field from /status).
 * - recommended: Version that includes all latest improvements (non-blocking).
 */
export const VERSION_REQUIREMENTS: Record<
  'desktop' | 'android',
  { minSupported: string; recommended: string }
> = {
  desktop: { minSupported: '0.1.28', recommended: '0.1.28' },
  android: { minSupported: '1.0.22', recommended: '1.0.22' },
}

export type IndicatorColor = 'green' | 'yellow' | 'red'

export interface ReadinessStatus {
  ready: boolean
  indicator: {
    label: string
    color: IndicatorColor
  }
  issues: Array<'not_connected' | 'update_required' | 'no_root'>
  canSuggestUpdate: boolean
  pulse: boolean
}

/**
 * Compute readiness status from component states.
 */
function getReadiness(
  state: DaemonBridgeState,
  versionStatus: VersionStatus,
  roots: DownloadRoot[],
  _hasPendingTorrents: boolean,
  defaultRootKey: string | null,
): ReadinessStatus {
  const issues: Array<'not_connected' | 'update_required' | 'no_root'> = []

  const isConnected = state.status === 'connected'
  if (!isConnected) {
    issues.push('not_connected')
  }

  if (isConnected && versionStatus === 'update_required') {
    issues.push('update_required')
  }

  // Check for a usable root: must have at least one accessible root with a valid default selected
  const usableRoots = roots.filter((r) => r.last_stat_ok !== false)
  const hasUsableRoot = usableRoots.length > 0
  const hasValidDefault = defaultRootKey != null && roots.some((r) => r.key === defaultRootKey)
  const hasRoot = hasUsableRoot && hasValidDefault
  if (isConnected && !hasRoot) {
    issues.push('no_root')
  }

  const ready = issues.length === 0
  const canSuggestUpdate = isConnected && versionStatus === 'update_suggested'
  const indicator = computeIndicator(state, versionStatus, hasRoot, canSuggestUpdate)
  // Pulse when setup is needed (yellow "Setup" state) to draw user attention
  const pulse = indicator.label === 'Setup'

  return { ready, indicator, issues, canSuggestUpdate, pulse }
}

function computeIndicator(
  state: DaemonBridgeState,
  versionStatus: VersionStatus,
  hasRoot: boolean,
  canSuggestUpdate: boolean,
): { label: string; color: IndicatorColor } {
  if (state.status === 'connecting') return { label: 'Connecting...', color: 'yellow' }

  if (state.status === 'disconnected') {
    if (state.lastError) return { label: 'Offline', color: 'red' }
    return { label: 'Setup', color: 'yellow' }
  }

  if (state.status === 'connected' && versionStatus === 'update_required') {
    return { label: 'Update Required', color: 'red' }
  }
  if (state.status === 'connected' && !hasRoot) {
    return { label: 'Setup', color: 'yellow' }
  }
  if (state.status === 'connected' && canSuggestUpdate) {
    return { label: 'Update Available', color: 'green' }
  }
  if (state.status === 'connected') {
    return { label: 'Ready', color: 'green' }
  }

  return { label: 'Unknown', color: 'yellow' }
}

/**
 * Compare two semver version strings.
 * Returns: -1 if a < b, 0 if a == b, 1 if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map((n) => parseInt(n, 10) || 0)
  const partsB = b.split('.').map((n) => parseInt(n, 10) || 0)

  const maxLen = Math.max(partsA.length, partsB.length)
  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] ?? 0
    const numB = partsB[i] ?? 0
    if (numA < numB) return -1
    if (numA > numB) return 1
  }
  return 0
}

/** Determine which backend type based on platform. */
function getBackendType(state: DaemonBridgeState): BackendType {
  if (state.platform === 'tauri') return 'self'
  if (state.platform === 'chromeos') {
    // Crostini standalone daemon is the desktop io-daemon, not the Android companion
    if (state.daemonInfo?.host === 'penguin.linux.test') return 'desktop'
    return 'android'
  }
  return 'desktop'
}

/**
 * Extract the relevant product version to check, based on backend type.
 * - desktop: Tauri app version (desktopVersion). undefined for Crostini standalone.
 * - android: Android app version (version from /status).
 * - self: always undefined (no check needed — we ARE the app).
 */
function getRelevantVersion(
  state: DaemonBridgeState,
  backendType: BackendType,
): string | undefined {
  if (state.status !== 'connected' || !state.daemonInfo) return undefined
  if (backendType === 'self') return undefined
  if (backendType === 'desktop') return state.daemonInfo.desktopVersion ?? undefined
  return state.daemonInfo.version ?? undefined
}

/**
 * Get version compatibility status for a backend.
 */
function getVersionStatus(version: string | undefined, backendType: BackendType): VersionStatus {
  if (backendType === 'self') return 'compatible'
  if (version === undefined || version === 'unknown') return 'compatible'

  const req = VERSION_REQUIREMENTS[backendType]
  if (compareVersions(version, req.minSupported) < 0) {
    return 'update_required'
  }
  if (compareVersions(version, req.recommended) < 0) {
    return 'update_suggested'
  }
  return 'compatible'
}

export interface UseSystemBridgeConfig {
  /** Current DaemonBridge state */
  state: DaemonBridgeState
  /** Download roots from daemon */
  roots: DownloadRoot[]
  /** Default root key from settings */
  defaultRootKey: string | null
  /** Whether there are torrents waiting for connection */
  hasPendingTorrents: boolean
  /** Extension/app version string for bug reports */
  extensionVersion?: string | null
  /** Fetch daemon stats (for bug report diagnostics) */
  getStats: () => Promise<DaemonStats | null>
  /** Fetch usage metrics (for bug report diagnostics) */
  getMetrics: () => Promise<UsageMetrics | null>
  /** Callbacks for bridge actions */
  onRetry: () => void
  onLaunch: () => void
  onCancel: () => void
  onAddFolder: () => void
  onSetDefaultRoot: (key: string) => void
}

export interface UseSystemBridgeResult {
  /** Whether the panel is open */
  panelOpen: boolean
  /** Open the panel */
  openPanel: () => void
  /** Close the panel */
  closePanel: () => void
  /** Toggle the panel */
  togglePanel: () => void
  /** Readiness status */
  readiness: ReadinessStatus
  /** Version status */
  versionStatus: VersionStatus
  /** Backend type (desktop, android, or self) */
  backendType: BackendType
  /** Product version of the connected backend (desktopVersion for desktop, version for android) */
  daemonVersion: string | undefined
  /** Copy debug info to clipboard */
  copyDebugInfo: () => Promise<void>
  /** Get URL for feedback.html with pre-filled diagnostics (async — collects at click time) */
  getBugReportUrl: () => Promise<string>
}

/**
 * Hook for managing System Bridge UI state.
 *
 * Takes bridge state and actions as dependencies, computes readiness,
 * and manages panel open/closed state.
 */
export function useSystemBridge(config: UseSystemBridgeConfig): UseSystemBridgeResult {
  const { state, roots, defaultRootKey, hasPendingTorrents, extensionVersion } = config

  const [panelOpen, setPanelOpen] = useState(false)

  const backendType = getBackendType(state)
  const daemonVersion = getRelevantVersion(state, backendType)
  const versionStatus = useMemo(
    () => getVersionStatus(daemonVersion, backendType),
    [daemonVersion, backendType],
  )

  // Compute readiness
  const readiness = useMemo(
    () => getReadiness(state, versionStatus, roots, hasPendingTorrents, defaultRootKey),
    [state, versionStatus, roots, hasPendingTorrents, defaultRootKey],
  )

  // Panel actions
  const openPanel = useCallback(() => setPanelOpen(true), [])
  const closePanel = useCallback(() => setPanelOpen(false), [])
  const togglePanel = useCallback(() => setPanelOpen((prev) => !prev), [])

  // Debug info copy
  const copyDebugInfo = useCallback(async () => {
    const info = {
      status: state.status,
      platform: state.platform,
      backendType,
      version: daemonVersion,
      versionStatus,
      ready: readiness.ready,
      issues: readiness.issues,
      roots: roots.length,
      lastError: state.lastError,
    }
    const text = `JSTorrent Debug Info\n${JSON.stringify(info, null, 2)}`
    await copyTextToClipboard(text)
  }, [state, backendType, daemonVersion, versionStatus, readiness, roots])

  // Generate feedback URL with pre-filled diagnostics (collected at click time)
  const getBugReportUrl = useCallback(async () => {
    const url = new URL('https://jstorrent.com/feedback.html')
    const p = url.searchParams

    // Environment
    p.set('platform', state.platform)
    p.set('v', extensionVersion ?? 'unknown')
    p.set('backend', backendType)
    if (daemonVersion) p.set('backendV', daemonVersion)
    p.set('status', state.status)

    // Chrome version from UA
    const chromeMatch = navigator.userAgent.match(/Chrome\/(\d+)/)
    if (chromeMatch) p.set('chrome', chromeMatch[1])
    p.set('ua', navigator.userAgent)

    if (state.lastError) p.set('error', state.lastError)

    // Engine state (sync reads from window.engine)
    const engineParams = collectEngineParams()
    for (const [k, v] of Object.entries(engineParams)) p.set(k, v)

    // Daemon stats (async)
    try {
      const stats = await config.getStats()
      if (stats) p.set('uptime', formatUptime(stats.uptime_secs))
    } catch {
      // ignore
    }

    // Usage metrics (async, extension-only — returns null on Tauri)
    try {
      const m = await config.getMetrics()
      if (m) {
        p.set('sessions', String(m.sessionsStarted))
        p.set('added', String(m.torrentsAdded))
        p.set('completed', String(m.completedDownloads))
        if (m.devices > 0) p.set('devices', String(m.devices))
        if (m.daysInstalled != null) p.set('days', String(m.daysInstalled))
      }
    } catch {
      // ignore
    }

    return url.toString()
  }, [state, backendType, daemonVersion, extensionVersion, config])

  return {
    panelOpen,
    openPanel,
    closePanel,
    togglePanel,
    readiness,
    versionStatus,
    backendType,
    daemonVersion,
    copyDebugInfo,
    getBugReportUrl,
  }
}

// === Bug report diagnostic helpers (module-level, no React deps) ===

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  return `${h}h ${m}m`
}

function collectEngineParams(): Record<string, string> {
  const engine = window.engine as BtEngine | undefined
  if (!engine) return {}

  const torrents = engine.torrents
  const active = torrents.filter((t) => t.userState === 'active').length
  const errored = torrents.filter((t) => t.errorMessage).length

  const params: Record<string, string> = {
    torrents: String(torrents.length),
    active: String(active),
    peers: String(engine.numConnections),
    dht: engine.dhtEnabled ? `on (${engine.dhtNode?.getNodeCount() ?? '?'} nodes)` : 'off',
    upnp: engine.upnpStatus + (engine.hasReceivedIncomingConnection ? ' (incoming OK)' : ''),
    port: String(engine.listeningPort),
  }
  if (errored > 0) params.errored = String(errored)
  return params
}
