/**
 * @jstorrent/client
 *
 * Full client exports including Chrome extension specific code.
 * For Chrome-free usage, import from '@jstorrent/client/core' instead.
 */

// Re-export everything from core (Chrome-free)
export * from './core'

// Host channel (replaces getBridge/notificationBridge singletons)
export { createHostChannel, HostChannelProvider, useHostChannel } from './host'
export { DaemonEngineManager } from './engine-manager/daemon-engine-manager'
export { createNotificationBridge } from './chrome/notification-bridge'
export type { ProgressStats } from './chrome/notification-bridge'

// App (the Chrome-specific wrapper that uses engineManager)
export { App } from './App'

// Components (may have Chrome dependencies via imports)
export { SystemIndicator } from './components/SystemIndicator'
export type { SystemIndicatorProps } from './components/SystemIndicator'
export { SystemBridgePanel } from './components/SystemBridgePanel'
export type {
  SystemBridgePanelProps,
  DaemonBridgeState,
  VersionStatus,
  ConnectionStatus,
  Platform,
  ProfileInUseInfo,
} from './components/SystemBridgePanel'
