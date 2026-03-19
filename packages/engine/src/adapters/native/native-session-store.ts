/**
 * Native Session Store
 *
 * Implements ISessionStore using native storage bindings.
 * All values are stored as JSON in SQLite for consistency with
 * the WebSocket KV bridge used in companion mode.
 */

import type { ISessionStore } from '../../interfaces/session-store'
import './bindings.d.ts'

const SESSION_PREFIX = 'session:'

/**
 * Convert Uint8Array to base64 string.
 */
function toBase64(buffer: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < buffer.length; i++) {
    binary += String.fromCharCode(buffer[i])
  }
  return btoa(binary)
}

function normalizeBase64(base64: string): string {
  return base64.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/')
}

/**
 * Convert base64 string back to Uint8Array.
 */
function fromBase64(base64: string): Uint8Array {
  const binary = atob(normalizeBase64(base64))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export class NativeSessionStore implements ISessionStore {
  private prefixKey(key: string): string {
    return SESSION_PREFIX + key
  }

  /**
   * Get binary data by key.
   * Stored as JSON string (base64 encoded).
   */
  async get(key: string): Promise<Uint8Array | null> {
    try {
      const stored = __jstorrent_storage_get(this.prefixKey(key))
      if (stored != null) {
        // Parse JSON to get the base64 string, then decode
        const base64 = JSON.parse(stored) as string
        return fromBase64(base64)
      }
    } catch (e) {
      console.warn('[NativeSessionStore] get error:', e)
    }
    return null
  }

  /**
   * Set binary data by key.
   * Stored as JSON string (base64 encoded).
   */
  async set(key: string, value: Uint8Array): Promise<void> {
    try {
      // Convert to base64, then JSON-stringify to store as JSON string
      __jstorrent_storage_set(this.prefixKey(key), JSON.stringify(toBase64(value)))
    } catch (e) {
      console.error('[NativeSessionStore] set error:', e)
      throw e
    }
  }

  /**
   * Delete a key.
   */
  async delete(key: string): Promise<void> {
    try {
      __jstorrent_storage_delete(this.prefixKey(key))
    } catch (e) {
      console.warn('[NativeSessionStore] delete error:', e)
    }
  }

  /**
   * Get all keys with optional prefix.
   */
  async keys(prefix?: string): Promise<string[]> {
    try {
      const fullPrefix = SESSION_PREFIX + (prefix ?? '')
      const result = __jstorrent_storage_keys(fullPrefix)
      const allKeys = JSON.parse(result) as string[]
      // Remove the session prefix from keys before returning
      return allKeys.map((k) => k.slice(SESSION_PREFIX.length))
    } catch (e) {
      console.warn('[NativeSessionStore] keys error:', e)
    }
    return []
  }

  /**
   * Clear all session data.
   */
  async clear(): Promise<void> {
    try {
      // Get all session keys and delete them
      const result = __jstorrent_storage_keys(SESSION_PREFIX)
      const sessionKeys = JSON.parse(result) as string[]
      for (const key of sessionKeys) {
        __jstorrent_storage_delete(key)
      }
    } catch (e) {
      console.warn('[NativeSessionStore] clear error:', e)
    }
  }

  /**
   * Get JSON data by key.
   */
  async getJson<T>(key: string): Promise<T | null> {
    try {
      const stored = __jstorrent_storage_get(this.prefixKey(key))
      if (stored != null) {
        return JSON.parse(stored) as T
      }
    } catch (e) {
      console.warn('[NativeSessionStore] getJson error:', e)
    }
    return null
  }

  /**
   * Set JSON data by key.
   */
  async setJson<T>(key: string, value: T): Promise<void> {
    try {
      __jstorrent_storage_set(this.prefixKey(key), JSON.stringify(value))
    } catch (e) {
      console.error('[NativeSessionStore] setJson error:', e)
      throw e
    }
  }
}
