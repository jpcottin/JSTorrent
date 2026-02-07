/**
 * Abstraction for communicating with the Chrome extension service worker.
 *
 * In production (chrome-extension://), uses chrome.runtime.sendMessage directly.
 * In dev mode (localhost), uses chrome.runtime.sendMessage with extension ID
 * via externally_connectable.
 * In Tauri desktop app, provides a stub bridge (Chrome APIs not available).
 */

interface ImportMetaEnv {
  DEV_EXTENSION_ID?: string
}

interface ImportMeta {
  env?: ImportMetaEnv
}

export interface ExtensionBridge {
  /**
   * Send a message to the service worker and wait for response.
   */
  sendMessage<T = unknown>(message: unknown): Promise<T>

  /**
   * Send a message without waiting for response (fire and forget).
   */
  postMessage(message: unknown): void

  /**
   * Whether we're running in dev mode (localhost).
   */
  readonly isDevMode: boolean

  /**
   * The extension ID (only set in dev mode).
   */
  readonly extensionId: string | null

  /**
   * Whether we're running in a Tauri desktop app context.
   * When true, Chrome extension APIs are not available.
   */
  readonly isTauri: boolean
}

/**
 * Bridge for use inside the Chrome extension context.
 * Uses chrome.runtime.sendMessage directly.
 */
class InternalBridge implements ExtensionBridge {
  readonly isDevMode = false
  readonly extensionId = null
  readonly isTauri = false

  sendMessage<T = unknown>(message: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else {
          resolve(response as T)
        }
      })
    })
  }

  postMessage(message: unknown): void {
    chrome.runtime.sendMessage(message).catch(() => {
      // Ignore errors for fire-and-forget messages
    })
  }
}

/**
 * Bridge for use from localhost dev server.
 * Uses chrome.runtime.sendMessage with extension ID via externally_connectable.
 */
class ExternalBridge implements ExtensionBridge {
  readonly isDevMode = true
  readonly extensionId: string
  readonly isTauri = false

  constructor(extensionId: string) {
    this.extensionId = extensionId
  }

  sendMessage<T = unknown>(message: unknown): Promise<T> {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(this.extensionId, message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message))
        } else {
          resolve(response as T)
        }
      })
    })
  }

  postMessage(message: unknown): void {
    chrome.runtime.sendMessage(this.extensionId, message).catch(() => {
      // Ignore errors for fire-and-forget messages
    })
  }
}

/**
 * Bridge for Tauri desktop app context.
 * Chrome extension APIs are not available. Provides stub implementations
 * that reject/no-op gracefully. Will be wired to Tauri IPC later.
 */
class TauriBridge implements ExtensionBridge {
  readonly isDevMode = false
  readonly extensionId = null
  readonly isTauri = true

  sendMessage<T = unknown>(_message: unknown): Promise<T> {
    return Promise.reject(new Error('Not available in Tauri context'))
  }

  postMessage(_message: unknown): void {
    // No-op in Tauri context
  }
}

/**
 * Storage key for persisting extension ID in dev mode.
 */
const EXTENSION_ID_KEY = 'jstorrent_extension_id'

/**
 * Published Chrome Web Store extension ID.
 */
const PUBLISHED_EXTENSION_ID = 'dbokmlpefliilbjldladbimlcfgbolhk'

/**
 * Get extension ID from various sources.
 * Falls back to published Chrome Web Store extension ID.
 */
function getExtensionId(): string {
  // 1. Check Vite env variable
  const envExtensionId =
    typeof import.meta !== 'undefined'
      ? (import.meta as ImportMeta).env?.DEV_EXTENSION_ID
      : undefined
  if (envExtensionId) {
    return envExtensionId
  }

  // 2. Check localStorage (previously saved)
  try {
    const saved = localStorage.getItem(EXTENSION_ID_KEY)
    if (saved) return saved
  } catch {
    // localStorage might not be available
  }

  // 3. Check URL query param (useful for first-time setup)
  try {
    const params = new URLSearchParams(window.location.search)
    const fromUrl = params.get('extensionId')
    if (fromUrl) {
      // Save for future use
      localStorage.setItem(EXTENSION_ID_KEY, fromUrl)
      return fromUrl
    }
  } catch {
    // URL parsing might fail
  }

  // 4. Fall back to published extension ID
  return PUBLISHED_EXTENSION_ID
}

/**
 * Save extension ID to localStorage for future dev sessions.
 */
export function saveExtensionId(extensionId: string): void {
  try {
    localStorage.setItem(EXTENSION_ID_KEY, extensionId)
  } catch {
    // Ignore storage errors
  }
}

/**
 * Clear saved extension ID.
 */
export function clearExtensionId(): void {
  try {
    localStorage.removeItem(EXTENSION_ID_KEY)
  } catch {
    // Ignore storage errors
  }
}

/**
 * Check if we're running inside a Chrome extension context.
 */
function isExtensionContext(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime !== 'undefined' &&
    typeof chrome.runtime.id === 'string' &&
    chrome.runtime.id.length > 0
  )
}

/**
 * Check if we're running inside a Tauri desktop app.
 */
function isTauriContext(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Create the appropriate bridge based on context.
 *
 * - Tauri desktop app: returns TauriBridge (no Chrome APIs)
 * - Inside extension: returns InternalBridge
 * - External website/localhost: returns ExternalBridge with extension ID
 */
export function createBridge(): ExtensionBridge {
  // Tauri desktop app - no Chrome APIs available
  if (isTauriContext()) {
    console.log('[ExtensionBridge] Running in Tauri context')
    return new TauriBridge()
  }

  // Inside extension context - use internal bridge
  if (isExtensionContext()) {
    console.log('[ExtensionBridge] Running in extension context')
    return new InternalBridge()
  }

  // External context - use extension ID for external messaging
  const extensionId = getExtensionId()
  console.log(`[ExtensionBridge] External mode with extension ID: ${extensionId}`)
  return new ExternalBridge(extensionId)
}

// Singleton bridge instance
let bridgeInstance: ExtensionBridge | null = null

/**
 * Get the singleton bridge instance.
 * Creates it on first call.
 */
export function getBridge(): ExtensionBridge {
  if (!bridgeInstance) {
    bridgeInstance = createBridge()
  }
  return bridgeInstance
}

/**
 * Reset the bridge (useful for testing or reconnecting with different extension ID).
 */
export function resetBridge(): void {
  bridgeInstance = null
}
