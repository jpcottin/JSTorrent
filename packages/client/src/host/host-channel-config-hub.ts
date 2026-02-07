/**
 * HostChannel-backed ConfigHub Implementation
 *
 * Same structure as ChromeConfigHub but uses HostChannel KV operations
 * instead of direct chrome.runtime.sendMessage calls.
 */

import {
  BaseConfigHub,
  type ConfigKey,
  type ConfigType,
  getConfigCategory,
  getConfigStorageClass,
  configSchema,
} from '@jstorrent/engine'
import type { HostChannel } from './host-channel'

/**
 * Deep equality check for config values (handles arrays and objects).
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a === null || b === null) return a === b
  if (typeof a !== typeof b) return false

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => deepEqual(v, b[i]))
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as object)
    const keysB = Object.keys(b as object)
    if (keysA.length !== keysB.length) return false
    return keysA.every((k) =>
      deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
    )
  }

  return false
}

// Settings key prefix - matches Android/native daemon ('config:')
const SETTINGS_KEY_PREFIX = 'config:'

/**
 * HostChannelConfigHub - ConfigHub implementation backed by HostChannel KV.
 *
 * Storage:
 * - Settings are persisted via HostChannel KV operations
 * - Runtime values are ephemeral (not persisted)
 * - Storage roots come from DaemonBridge
 */
export class HostChannelConfigHub extends BaseConfigHub {
  private channel: HostChannel

  constructor(channel: HostChannel) {
    super()
    this.channel = channel
  }

  /**
   * Load all persisted settings from storage.
   */
  protected async loadFromStorage(): Promise<Partial<ConfigType>> {
    console.log('[HostChannelConfigHub] loadFromStorage called')
    const result: Partial<ConfigType> = {}

    // Get all setting keys (category === 'setting')
    const settingKeys = (Object.keys(configSchema) as ConfigKey[]).filter(
      (key) => getConfigCategory(key) === 'setting',
    )

    // Group keys by their storage area (sync vs local)
    const syncKeys: string[] = []
    const localKeys: string[] = []

    for (const configKey of settingKeys) {
      const storageClass = getConfigStorageClass(configKey) ?? 'sync'
      const prefixedKey = SETTINGS_KEY_PREFIX + configKey

      if (storageClass === 'local') {
        localKeys.push(prefixedKey)
      } else {
        syncKeys.push(prefixedKey)
      }
    }

    // Also fetch defaultRootKey (storage category, uses 'local')
    localKeys.push(SETTINGS_KEY_PREFIX + 'defaultRootKey')

    // Fetch values from both storage areas
    let stored: Record<string, unknown> = {}

    // Fetch sync storage
    if (syncKeys.length > 0) {
      try {
        const syncValues = await this.channel.kvGetMulti(syncKeys, {
          keyPrefix: '',
          area: 'sync',
        })
        stored = { ...stored, ...syncValues }
      } catch (e) {
        console.warn('[HostChannelConfigHub] Failed to load sync settings:', e)
      }
    }

    // Fetch local storage
    if (localKeys.length > 0) {
      try {
        const localValues = await this.channel.kvGetMulti(localKeys, {
          keyPrefix: '',
          area: 'local',
        })
        stored = { ...stored, ...localValues }
      } catch (e) {
        console.warn('[HostChannelConfigHub] Failed to load local settings:', e)
      }
    }

    // Map stored values back to ConfigHub keys
    for (const configKey of settingKeys) {
      const storageKey = SETTINGS_KEY_PREFIX + configKey
      const value = stored[storageKey]

      if (value !== undefined) {
        ;(result as Record<string, unknown>)[configKey] = value
      }
    }

    // Handle defaultRootKey (storage category)
    const defaultRootKey = stored[SETTINGS_KEY_PREFIX + 'defaultRootKey']
    if (defaultRootKey !== undefined) {
      result.defaultRootKey = defaultRootKey as string | null
    }

    console.log('[HostChannelConfigHub] Loaded settings:', {
      downloadSpeedLimit: result.downloadSpeedLimit,
      uploadSpeedLimit: result.uploadSpeedLimit,
    })

    return result
  }

  /**
   * Save a single value to storage.
   */
  protected async saveToStorage<K extends ConfigKey>(key: K, value: ConfigType[K]): Promise<void> {
    const category = getConfigCategory(key)

    // Runtime values are never persisted
    if (category === 'runtime') {
      return
    }

    // Storage roots are managed by DaemonBridge, not persisted here
    if (key === 'storageRoots') {
      return
    }

    const storageClass = getConfigStorageClass(key) ?? 'sync'

    await this.channel.kvSet(SETTINGS_KEY_PREFIX + key, value, {
      keyPrefix: '',
      area: storageClass,
    })
  }

  /**
   * Update a runtime value (no persistence, just cache + notify).
   */
  setRuntime<K extends ConfigKey>(key: K, value: ConfigType[K]): void {
    const category = getConfigCategory(key)
    if (category !== 'runtime' && key !== 'storageRoots') {
      console.warn(`[HostChannelConfigHub] setRuntime called for non-runtime key: ${key}`)
    }

    const oldValue = this.cache[key]

    // Skip if unchanged (use deep equality for arrays)
    if (deepEqual(value, oldValue)) {
      return
    }

    // Update cache
    ;(this.cache as Record<ConfigKey, unknown>)[key] = value

    // Notify subscribers
    this.notifyRuntimeSubscribers(key, value, oldValue)
  }

  /**
   * Notify subscribers of a runtime value change.
   */
  private notifyRuntimeSubscribers(key: ConfigKey, value: unknown, oldValue: unknown): void {
    const subscribers = this.getKeySubscribers(key)
    if (subscribers) {
      for (const cb of subscribers) {
        try {
          cb(value, oldValue)
        } catch (e) {
          console.error(`[HostChannelConfigHub] Subscriber error for '${key}':`, e)
        }
      }
    }

    this.notifyGlobalSubscribers(key, value, oldValue)
  }

  /**
   * Get subscribers for a key (access to protected base class state).
   */
  private getKeySubscribers(
    key: ConfigKey,
  ): Set<(value: unknown, oldValue: unknown) => void> | undefined {
    return (
      this as unknown as { keySubscribers: Map<ConfigKey, Set<unknown>> }
    ).keySubscribers?.get(key) as Set<(value: unknown, oldValue: unknown) => void> | undefined
  }

  /**
   * Notify global subscribers.
   */
  private notifyGlobalSubscribers(key: ConfigKey, value: unknown, oldValue: unknown): void {
    const allSubscribers = (this as unknown as { allSubscribers: Set<unknown> }).allSubscribers
    if (allSubscribers) {
      for (const cb of allSubscribers) {
        try {
          ;(cb as (key: ConfigKey, value: unknown, oldValue: unknown) => void)(key, value, oldValue)
        } catch (e) {
          console.error(`[HostChannelConfigHub] Global subscriber error for '${key}':`, e)
        }
      }
    }
  }
}
