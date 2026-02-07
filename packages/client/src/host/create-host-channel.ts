/**
 * Factory for creating the appropriate HostChannel based on runtime context.
 *
 * Migrated from chrome/extension-bridge.ts: getExtensionId, isExtensionContext, isTauriContext.
 */

import type { HostChannel } from './host-channel'
import { ChromeExtensionChannel } from './chrome-extension-channel'
import { TauriChannel } from './tauri-channel'

interface ImportMetaEnv {
  DEV_EXTENSION_ID?: string
}

interface ImportMeta {
  env?: ImportMetaEnv
}

/** Storage key for persisting extension ID in dev mode. */
const EXTENSION_ID_KEY = 'jstorrent_extension_id'

/** Published Chrome Web Store extension ID. */
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

/** Check if we're running inside a Chrome extension context. */
function isExtensionContext(): boolean {
  return (
    typeof chrome !== 'undefined' &&
    typeof chrome.runtime !== 'undefined' &&
    typeof chrome.runtime.id === 'string' &&
    chrome.runtime.id.length > 0
  )
}

/** Check if we're running inside a Tauri desktop app. */
function isTauriContext(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

/**
 * Create the appropriate HostChannel based on runtime context.
 *
 * - Tauri desktop app: throws (TauriChannel not yet implemented)
 * - Inside extension: ChromeExtensionChannel (internal mode, no extensionId)
 * - External website/localhost: ChromeExtensionChannel (external mode, with extensionId)
 */
export function createHostChannel(): HostChannel {
  if (isTauriContext()) {
    return new TauriChannel()
  }

  if (isExtensionContext()) {
    return new ChromeExtensionChannel() // internal mode
  }

  // External (website / dev server)
  const extensionId = getExtensionId()
  return new ChromeExtensionChannel(extensionId)
}

/** Save extension ID to localStorage for future dev sessions. */
export function saveExtensionId(extensionId: string): void {
  try {
    localStorage.setItem(EXTENSION_ID_KEY, extensionId)
  } catch {
    // Ignore storage errors
  }
}

/** Clear saved extension ID. */
export function clearExtensionId(): void {
  try {
    localStorage.removeItem(EXTENSION_ID_KEY)
  } catch {
    // Ignore storage errors
  }
}
