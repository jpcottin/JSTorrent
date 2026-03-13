/**
 * Bundle Entry Point
 *
 * This is the entry point for the native engine bundle.
 * It imports polyfills, creates the engine, and sets up the controller.
 */

// Import polyfills first
import './polyfills'

// Import preset and controller
import { createNativeEngine, NativeEngineConfig } from '../../presets/native'
import { setupController, flushCommandQueue } from './controller'
import { NativeConfigHub } from './native-config-hub'
import { initSubscriptionManager, setupSubscriptionBindings } from './subscriptions'
import type { BtEngine } from '../../core/bt-engine'
import type { PlatformType } from '../../config'
import type { StorageRoot } from '../../storage/storage-root-manager'

// Global engine instance
let engine: BtEngine | null = null
let engineReady = false

// Register controller functions early (before async init completes)
// These will check if engine is ready before executing
setupController(
  () => engine,
  () => engineReady,
)

/**
 * API exposed to native layer via globalThis.jstorrent
 */
const jstorrentApi = {
  /**
   * Initialize the engine with configuration.
   * Must be called before any other methods.
   *
   * Note: This returns immediately but engine init continues in background.
   * The engine will only accept commands after session restore completes
   * (engineReady=true), preventing lost commands and UI flicker.
   */
  init(config: {
    contentRoots: Array<{
      key: string
      label: string
      path?: string
    }>
    defaultContentRoot?: string
    port?: number
    platformType?: PlatformType
    storageMode?: 'native' | 'null'
    /**
     * Whether the engine should remain suspended after initialization.
     * When true, engine.resume() is NOT called after session restore.
     * Use this for WiFi-only/VPN-only mode when network conditions don't allow downloads.
     */
    shouldRemainSuspended?: boolean
  }): void {
    if (engine) {
      throw new Error('Engine already initialized')
    }

    // Start async initialization
    ;(async () => {
      try {
        // Create and initialize ConfigHub first
        const configHub = new NativeConfigHub()
        await configHub.init()
        console.log('JSTorrent: ConfigHub initialized')

        // Convert content roots to StorageRoot format
        const storageRoots: StorageRoot[] = config.contentRoots.map((r) => ({
          key: r.key,
          label: r.label,
          path: r.path ?? '',
        }))

        // Push initial roots to ConfigHub
        if (storageRoots.length > 0) {
          configHub.setRuntime('storageRoots', storageRoots)
        }
        if (config.defaultContentRoot) {
          configHub.setRuntime('defaultRootKey', config.defaultContentRoot)
        }

        // Default to Android for existing native hosts, but allow iOS to
        // declare its own standalone profile explicitly.
        configHub.setRuntime('platformType', config.platformType ?? 'android-standalone')

        const nativeConfig: NativeEngineConfig = {
          contentRoots: storageRoots,
          defaultContentRoot: config.defaultContentRoot,
          port:
            config.port ?? (configHub.listeningPortAuto.get() ? 0 : configHub.listeningPort.get()),
          storageMode: config.storageMode,
          startSuspended: true, // Start suspended to restore session first
          config: configHub,
          onLog: (entry) => {
            // Forward logs to console (which is polyfilled to native)
            const level = entry.level || 'info'
            const message = `[engine] ${entry.message}`
            if (level === 'error') {
              console.error(message)
            } else if (level === 'warn') {
              console.warn(message)
            } else {
              console.log(message)
            }
          },
        }

        engine = createNativeEngine(nativeConfig)

        // Initialize subscription manager (before session restore)
        // This sets up the subscription bindings that Kotlin will call after engineReady=true
        // Pass isReady callback to delay pushes until session restore completes
        const subscriptionManager = initSubscriptionManager(
          engine,
          (payload) => {
            __jstorrent_on_state_update(payload)
          },
          () => engineReady,
        )
        setupSubscriptionBindings(subscriptionManager)

        // Restore session BEFORE marking engine ready
        // This ensures:
        // 1. Commands (resume, pause) won't be lost (torrent exists when command arrives)
        // 2. First state push includes restored torrents (no UI flicker)
        // Startup sequence:
        // 1. Engine created in suspended state
        // 2. Subscription bindings registered
        // 3. Session restored (torrents re-added)
        // 4. Engine marked ready (commands now accepted)
        // 5. Engine resumed (networking starts, subscriptions start pushing)
        try {
          const restored = await engine.restoreSession()
          if (restored > 0) {
            console.log(`JSTorrent: Restored ${restored} torrents from session`)
          }
        } catch (e) {
          console.error('JSTorrent: Failed to restore session:', e)
        }

        // Now safe to mark engine as ready - session is restored, torrents exist
        engineReady = true

        // Flush any commands that were queued while engine was starting
        // This handles the race condition where user taps resume before session restore completes
        flushCommandQueue()

        // Resume engine after restoration, unless shouldRemainSuspended is true
        // (e.g., WiFi-only mode enabled but WiFi not connected)
        if (config.shouldRemainSuspended) {
          console.log(
            'JSTorrent engine initialized (remaining suspended due to network restrictions)',
          )
        } else {
          engine.resume()
          console.log('JSTorrent engine initialized')
        }
      } catch (e) {
        console.error('JSTorrent: Failed to initialize engine:', e)
        __jstorrent_on_error(JSON.stringify({ error: String(e) }))
      }
    })()
  },

  /**
   * Get the engine instance (for advanced use).
   */
  getEngine(): BtEngine | null {
    return engine
  },

  /**
   * Check if the engine is initialized.
   */
  isInitialized(): boolean {
    return engine !== null
  },

  /**
   * Shutdown the engine.
   */
  async shutdown(): Promise<void> {
    if (engine) {
      await engine.destroy()
      engine = null
    }

    console.log('JSTorrent engine shut down')
  },
}

// Expose to global scope for native layer
;(globalThis as Record<string, unknown>).jstorrent = jstorrentApi

// Also export for potential module usage
export { jstorrentApi }
export type { NativeEngineConfig }
