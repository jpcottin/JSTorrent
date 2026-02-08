/**
 * Chrome Extension ConfigHub Implementation
 *
 * Extends BaseConfigHub to persist settings via chrome.storage (through KV handlers)
 * and receive runtime values from DaemonBridge.
 */

import {
  BaseConfigHub,
  type ConfigKey,
  type ConfigType,
  getConfigCategory,
  configSchema,
} from '@jstorrent/engine'

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

// KV response type
// Note: KV_GET returns "value", KV_GET_MULTI returns "values"
interface KVResponse<T = unknown> {
  ok: boolean
  value?: T
  values?: Record<string, unknown> // KV_GET_MULTI returns this instead of value
  error?: string
}

// Settings key prefix - matches Android/native daemon ('config:')
const SETTINGS_KEY_PREFIX = 'config:'

/**
 * Send a KV message to the service worker.
 */
async function sendKVMessage<T>(
  extensionId: string | undefined,
  message: unknown,
): Promise<KVResponse<T>> {
  return new Promise((resolve, reject) => {
    if (!chrome?.runtime?.sendMessage) {
      reject(new Error('chrome.runtime.sendMessage not available'))
      return
    }

    const callback = (response: KVResponse<T>) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message))
      } else if (!response) {
        reject(new Error('No response from extension - is it installed?'))
      } else {
        resolve(response)
      }
    }

    if (extensionId) {
      chrome.runtime.sendMessage(extensionId, message, callback)
    } else {
      chrome.runtime.sendMessage(message, callback)
    }
  })
}

/**
 * ChromeConfigHub - Chrome extension implementation of ConfigHub.
 *
 * Storage:
 * - Settings are persisted to chrome.storage via KV message handlers
 * - Runtime values are ephemeral (not persisted)
 * - Storage roots come from DaemonBridge
 */
export class ChromeConfigHub extends BaseConfigHub {
  private extensionId?: string

  constructor(extensionId?: string) {
    super()
    this.extensionId = extensionId
  }

  /**
   * Load all persisted settings from chrome.storage.local.
   */
  protected async loadFromStorage(): Promise<Partial<ConfigType>> {
    console.log('[ChromeConfigHub] loadFromStorage called')
    const result: Partial<ConfigType> = {}

    // Get all setting keys (category === 'setting') plus defaultRootKey (storage category)
    const settingKeys = (Object.keys(configSchema) as ConfigKey[]).filter(
      (key) => getConfigCategory(key) === 'setting',
    )
    const allKeys = [
      ...settingKeys.map((k) => SETTINGS_KEY_PREFIX + k),
      SETTINGS_KEY_PREFIX + 'defaultRootKey',
    ]

    const response = await sendKVMessage<Record<string, unknown>>(this.extensionId, {
      type: 'KV_GET_MULTI',
      keys: allKeys,
      keyPrefix: '',
    })

    if (!response.ok || !response.values) {
      console.warn('[ChromeConfigHub] Failed to load settings:', response.error)
      return result
    }

    const stored = response.values

    // Map stored values back to ConfigHub keys
    for (const configKey of settingKeys) {
      const value = stored[SETTINGS_KEY_PREFIX + configKey]
      if (value !== undefined) {
        ;(result as Record<string, unknown>)[configKey] = value
      }
    }

    // Handle defaultRootKey (storage category)
    const defaultRootKey = stored[SETTINGS_KEY_PREFIX + 'defaultRootKey']
    if (defaultRootKey !== undefined) {
      result.defaultRootKey = defaultRootKey as string | null
    }

    console.log('[ChromeConfigHub] Loaded settings:', {
      downloadSpeedLimit: result.downloadSpeedLimit,
      uploadSpeedLimit: result.uploadSpeedLimit,
    })

    return result
  }

  /**
   * Save a single value to chrome.storage.local.
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

    await sendKVMessage(this.extensionId, {
      type: 'KV_SET',
      key: SETTINGS_KEY_PREFIX + key,
      value,
      keyPrefix: '',
    })
  }

  /**
   * Update a runtime value (no persistence, just cache + notify).
   * Used by DaemonBridge integration to push runtime state changes.
   */
  setRuntime<K extends ConfigKey>(key: K, value: ConfigType[K]): void {
    const category = getConfigCategory(key)
    if (category !== 'runtime' && key !== 'storageRoots') {
      console.warn(`[ChromeConfigHub] setRuntime called for non-runtime key: ${key}`)
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
    // Access the private keySubscribers via protected method
    const subscribers = this.getKeySubscribers(key)
    if (subscribers) {
      for (const cb of subscribers) {
        try {
          cb(value, oldValue)
        } catch (e) {
          console.error(`[ChromeConfigHub] Subscriber error for '${key}':`, e)
        }
      }
    }

    // Also notify global subscribers
    this.notifyGlobalSubscribers(key, value, oldValue)
  }

  /**
   * Get subscribers for a key (access to protected base class state).
   */
  private getKeySubscribers(
    key: ConfigKey,
  ): Set<(value: unknown, oldValue: unknown) => void> | undefined {
    // We need to access the private keySubscribers from BaseConfigHub
    // This is a workaround - ideally BaseConfigHub would expose a protected method
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
          console.error(`[ChromeConfigHub] Global subscriber error for '${key}':`, e)
        }
      }
    }
  }
}
