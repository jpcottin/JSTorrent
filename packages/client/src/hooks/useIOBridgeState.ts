import { useState, useEffect, useCallback, useRef } from 'react'
import { useHostChannel } from '../host/HostChannelContext'
import { ChromeExtensionChannel } from '../host/chrome-extension-channel'
import type { BootstrapState } from '../../../../extension/src/lib/chromeos-bootstrap'
import type { PortStatus, DaemonBridgeState, DaemonStats } from '../host/types'

export type {
  PortStatus,
  Platform,
  ConnectionStatus,
  DownloadRoot,
  DaemonInfo,
  DaemonBridgeState,
  DaemonStats,
} from '../host/types'

export interface UseIOBridgeStateConfig {
  /** Callback for native events (TorrentAdded, MagnetAdded) */
  onNativeEvent?: (event: string, payload: unknown) => void
}

export interface UseIOBridgeStateResult {
  state: DaemonBridgeState
  isConnected: boolean
  hasEverConnected: boolean
  retry: () => void
  launch: () => void
  cancel: () => void
  /** Take over from desktop Tauri app (kills Tauri, extension takes control) */
  takeOverFromDesktop: () => void
  /** Fetch daemon stats for debug panel */
  getStats: () => Promise<DaemonStats | null>
  /** ChromeOS bootstrap state (only relevant on ChromeOS) */
  chromeosBootstrapState: BootstrapState | null
  chromeosHasEverConnected: boolean
  /** Port connection status (UI to Service Worker) */
  portStatus: PortStatus
}

/**
 * Hook to subscribe to DaemonBridge state via HostChannel.
 *
 * Returns current state and action callbacks.
 * Also handles native events (TorrentAdded, MagnetAdded) via the channel.
 */
export function useIOBridgeState(config: UseIOBridgeStateConfig = {}): UseIOBridgeStateResult {
  const { onNativeEvent } = config
  const channel = useHostChannel()
  const [state, setState] = useState<DaemonBridgeState>(() => channel.getState())
  const [hasEverConnected, setHasEverConnected] = useState(
    () => channel.getState().status === 'connected',
  )
  const [chromeosBootstrapState, setChromeosBootstrapState] = useState<BootstrapState | null>(() =>
    channel instanceof ChromeExtensionChannel ? channel.getChromeOSBootstrapState() : null,
  )
  const [chromeosHasEverConnected, setChromeosHasEverConnected] = useState(false)
  const onNativeEventRef = useRef(onNativeEvent)

  // Keep ref updated
  useEffect(() => {
    onNativeEventRef.current = onNativeEvent
  }, [onNativeEvent])

  // Subscribe to state changes and events via HostChannel
  useEffect(() => {
    const unsubState = channel.onStateChanged((newState) => {
      setState(newState)
      if (newState.status === 'connected') setHasEverConnected(true)
    })

    const unsubEvent = channel.onEvent((event) => {
      if (onNativeEventRef.current) {
        onNativeEventRef.current(event.event, event.payload)
      }
    })

    // Subscribe to ChromeOS bootstrap state if available
    let unsubBootstrap: (() => void) | undefined
    if (channel instanceof ChromeExtensionChannel) {
      const chromeChannel = channel
      unsubBootstrap = chromeChannel.onChromeOSBootstrapStateChanged((bootstrapState) => {
        setChromeosBootstrapState(bootstrapState)
        if (bootstrapState.phase === 'connected') {
          setChromeosHasEverConnected(true)
        }
      })
    }

    return () => {
      unsubState()
      unsubEvent()
      unsubBootstrap?.()
    }
  }, [channel])

  // Action callbacks
  const retry = useCallback(() => channel.retryConnection(), [channel])
  const launch = useCallback(() => channel.triggerLaunch(), [channel])
  const cancel = useCallback(() => {
    // Cancel is no longer used in simplified bridge, but keep for API compatibility
  }, [])
  const takeOverFromDesktop = useCallback(() => {
    if (channel instanceof ChromeExtensionChannel) {
      channel.takeOverFromDesktop()
    }
  }, [channel])
  const getStats = useCallback(() => channel.getStats(), [channel])

  return {
    state,
    isConnected: state.status === 'connected',
    hasEverConnected,
    retry,
    launch,
    cancel,
    takeOverFromDesktop,
    getStats,
    chromeosBootstrapState,
    chromeosHasEverConnected,
    portStatus: state.status === 'connected' ? 'connected' : 'disconnected',
  }
}
