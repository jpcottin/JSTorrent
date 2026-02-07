import { ISessionStore } from '../../interfaces/session-store'

const STORE_NAME = 'kv'

export class IndexedDbSessionStore implements ISessionStore {
  private _dbPromise: Promise<IDBDatabase> | null = null

  constructor(private dbName: string = 'jstorrent-session') {}

  private openDb(): Promise<IDBDatabase> {
    if (!this._dbPromise) {
      this._dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(this.dbName, 1)
        request.onupgradeneeded = () => {
          request.result.createObjectStore(STORE_NAME)
        }
        request.onsuccess = () => resolve(request.result)
        request.onerror = () => reject(request.error)
      })
    }
    return this._dbPromise
  }

  private async tx<T>(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest<T>,
  ): Promise<T> {
    const db = await this.openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode)
      const req = fn(tx.objectStore(STORE_NAME))
      req.onsuccess = () => resolve(req.result)
      tx.onerror = () => reject(tx.error)
    })
  }

  async get(key: string): Promise<Uint8Array | null> {
    try {
      const value = await this.tx('readonly', (s) => s.get(key))
      return value instanceof Uint8Array ? value : null
    } catch (e) {
      console.warn('[IndexedDbSessionStore] get error:', e)
      return null
    }
  }

  async set(key: string, value: Uint8Array): Promise<void> {
    await this.tx('readwrite', (s) => s.put(value, key))
  }

  async delete(key: string): Promise<void> {
    try {
      await this.tx('readwrite', (s) => s.delete(key))
    } catch (e) {
      console.warn('[IndexedDbSessionStore] delete error:', e)
    }
  }

  async keys(prefix?: string): Promise<string[]> {
    try {
      const allKeys = await this.tx('readonly', (s) => s.getAllKeys())
      const stringKeys = allKeys.filter((k): k is string => typeof k === 'string')
      return prefix ? stringKeys.filter((k) => k.startsWith(prefix)) : stringKeys
    } catch (e) {
      console.warn('[IndexedDbSessionStore] keys error:', e)
      return []
    }
  }

  async clear(): Promise<void> {
    try {
      await this.tx('readwrite', (s) => s.clear())
    } catch (e) {
      console.warn('[IndexedDbSessionStore] clear error:', e)
    }
  }

  async getMulti(keys: string[]): Promise<Map<string, Uint8Array>> {
    if (keys.length === 0) return new Map()
    const db = await this.openDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const store = tx.objectStore(STORE_NAME)
      const result = new Map<string, Uint8Array>()
      for (const key of keys) {
        const req = store.get(key)
        req.onsuccess = () => {
          if (req.result instanceof Uint8Array) {
            result.set(key, req.result)
          }
        }
      }
      tx.oncomplete = () => resolve(result)
      tx.onerror = () => reject(tx.error)
    })
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const value = await this.tx('readonly', (s) => s.get(key))
      return (value as T) ?? null
    } catch (e) {
      console.warn('[IndexedDbSessionStore] getJson error:', e)
      return null
    }
  }

  async setJson<T>(key: string, value: T): Promise<void> {
    await this.tx('readwrite', (s) => s.put(value, key))
  }
}

/**
 * Clear the IndexedDB session database.
 * Standalone utility for use by TauriChannel.clearSessionStorage().
 */
export async function clearIndexedDbSessionStore(
  dbName: string = 'jstorrent-session',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, 1)
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME)
    }
    request.onsuccess = () => {
      const db = request.result
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).clear()
      tx.oncomplete = () => {
        db.close()
        resolve()
      }
      tx.onerror = () => {
        db.close()
        reject(tx.error)
      }
    }
    request.onerror = () => reject(request.error)
  })
}
