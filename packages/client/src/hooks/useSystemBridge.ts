import { useState, useCallback, useMemo } from 'react'
import type { DaemonBridgeState, VersionStatus } from '../components/SystemBridgePanel'
import type { DownloadRoot } from '../types'
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
  desktop: { minSupported: '0.1.23', recommended: '0.1.23' },
  android: { minSupported: '1.0.16', recommended: '1.0.16' },
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
): ReadinessStatus {
  const issues: Array<'not_connected' | 'update_required' | 'no_root'> = []

  const isConnected = state.status === 'connected'
  if (!isConnected) {
    issues.push('not_connected')
  }

  if (isConnected && versionStatus === 'update_required') {
    issues.push('update_required')
  }

  const hasRoot = roots.length > 0
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
  if (state.platform === 'chromeos') return 'android'
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
  /** Get URL for filing a bug report on GitHub */
  getBugReportUrl: () => string
}

/**
 * Hook for managing System Bridge UI state.
 *
 * Takes bridge state and actions as dependencies, computes readiness,
 * and manages panel open/closed state.
 */
export function useSystemBridge(config: UseSystemBridgeConfig): UseSystemBridgeResult {
  const { state, roots, hasPendingTorrents, extensionVersion } = config

  const [panelOpen, setPanelOpen] = useState(false)

  const backendType = getBackendType(state)
  const daemonVersion = getRelevantVersion(state, backendType)
  const versionStatus = useMemo(
    () => getVersionStatus(daemonVersion, backendType),
    [daemonVersion, backendType],
  )

  // Compute readiness
  const readiness = useMemo(
    () => getReadiness(state, versionStatus, roots, hasPendingTorrents),
    [state, versionStatus, roots, hasPendingTorrents],
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

  // Generate bug report URL with pre-filled info
  const getBugReportUrl = useCallback(() => {
    const extVersion = extensionVersion ?? 'unknown'

    const body = `**Environment:**
- Extension: v${extVersion}
- Companion: v${daemonVersion ?? 'not connected'} (${backendType})
- Platform: ${state.platform}
- Status: ${state.status}
- User-Agent: ${navigator.userAgent}
${state.lastError ? `- Last Error: ${state.lastError}` : ''}

**Description:**
[Describe the issue here]

**Steps to reproduce:**
1.
2.
3.

**Expected behavior:**


**Actual behavior:**

`
    const url = new URL('https://github.com/kzahel/jstorrent/issues/new')
    url.searchParams.set('body', body)
    return url.toString()
  }, [state, backendType, daemonVersion, extensionVersion])

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
