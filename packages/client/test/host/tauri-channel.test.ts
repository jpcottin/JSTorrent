import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import 'fake-indexeddb/auto'
import { TauriChannel } from '../../src/host/tauri-channel'
import type { HostState, NativeEvent } from '../../src/host/types'
import { IndexedDbSessionStore } from '@jstorrent/engine'

// --- Tauri internals mock ---

let invokeHandler: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>
let eventHandlers: Map<string, Array<(event: { payload: unknown }) => void>>
let nextCallbackId = 1

function setupTauriMock() {
  eventHandlers = new Map()
  nextCallbackId = 1
  const registeredCallbacks = new Map<number, (...args: unknown[]) => void>()

  invokeHandler = vi.fn(async () => ({}))

  const internals = {
    invoke: vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === 'plugin:event|listen') {
        const event = args?.event as string
        const handlerId = args?.handler as number
        const callback = registeredCallbacks.get(handlerId)
        if (callback) {
          const handlers = eventHandlers.get(event) ?? []
          handlers.push((e) => callback(e))
          eventHandlers.set(event, handlers)
        }
        return handlerId // return eventId for unlisten
      }
      if (cmd === 'plugin:event|unlisten') {
        const event = args?.event as string
        eventHandlers.delete(event)
        return undefined
      }
      return invokeHandler(cmd, args)
    }),
    transformCallback: vi.fn((callback: (...args: unknown[]) => void) => {
      const id = nextCallbackId++
      registeredCallbacks.set(id, callback)
      return id
    }),
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(window as any).__TAURI_INTERNALS__ = internals
  return internals
}

function teardownTauriMock() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (window as any).__TAURI_INTERNALS__
}

/** Emit a Tauri event to all registered listeners. */
function emitTauriEvent(event: string, payload: unknown) {
  const handlers = eventHandlers.get(event) ?? []
  for (const handler of handlers) {
    handler({ payload })
  }
}

describe('TauriChannel', () => {
  let tauriMock: ReturnType<typeof setupTauriMock>

  beforeEach(async () => {
    tauriMock = setupTauriMock()
    // Clear the shared IndexedDB store between tests for isolation.
    // We wait for tx.oncomplete (not just req.onsuccess) to ensure the clear
    // is committed before the test starts, since fake-indexeddb doesn't
    // guarantee cross-connection visibility for uncommitted transactions.
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('jstorrent-session', 1)
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains('kv')) {
          req.result.createObjectStore('kv')
        }
      }
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readwrite')
        tx.objectStore('kv').clear()
        tx.oncomplete = () => resolve()
        tx.onerror = () => reject(tx.error)
      }
      req.onerror = () => reject(req.error)
    })
  })

  afterEach(() => {
    teardownTauriMock()
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('creates with initial connecting state', () => {
      const channel = new TauriChannel()
      expect(channel.getState()).toEqual({
        status: 'connecting',
        platform: 'tauri',
        daemonInfo: null,
        roots: [],
        lastError: null,
      })
    })
  })

  describe('connect()', () => {
    it('sends handshake and updates state on success', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: {
              port: 54321,
              token: 'test-token',
              version: '0.2.0',
              roots: [
                {
                  key: 'r1',
                  path: '/downloads',
                  display_name: 'Downloads',
                  removable: true,
                  last_stat_ok: true,
                  last_checked: 0,
                },
              ],
            },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      await channel.connect()

      expect(tauriMock.invoke).toHaveBeenCalledWith('host_handshake', undefined)
      expect(channel.getState().status).toBe('connected')
      expect(channel.getState().platform).toBe('tauri')
      expect(channel.getState().daemonInfo).toEqual({
        port: 54321,
        token: 'test-token',
        version: '0.2.0',
        roots: [
          {
            key: 'r1',
            path: '/downloads',
            display_name: 'Downloads',
            removable: true,
            last_stat_ok: true,
            last_checked: 0,
          },
        ],
        host: '127.0.0.1',
      })
      expect(channel.getState().roots).toHaveLength(1)
      expect(channel.getState().lastError).toBeNull()

      channel.disconnect()
    })

    it('sets disconnected state on handshake failure', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return { ok: false, error: 'System bridge not found' }
        }
        return {}
      })

      const channel = new TauriChannel()
      await channel.connect()

      expect(channel.getState().status).toBe('disconnected')
      expect(channel.getState().lastError).toBe('System bridge not found')

      channel.disconnect()
    })

    it('sets disconnected state on invoke exception', async () => {
      invokeHandler = vi.fn(async () => {
        throw new Error('IPC failed')
      })

      const channel = new TauriChannel()
      await channel.connect()

      expect(channel.getState().status).toBe('disconnected')
      expect(channel.getState().lastError).toBe('Error: IPC failed')

      channel.disconnect()
    })

    it('registers event listener for host-event', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      await channel.connect()

      expect(tauriMock.invoke).toHaveBeenCalledWith(
        'plugin:event|listen',
        expect.objectContaining({
          event: 'host-event',
          target: { kind: 'Any' },
        }),
      )

      channel.disconnect()
    })
  })

  describe('onStateChanged()', () => {
    it('notifies listeners when state changes during connect', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      const states: HostState[] = []
      channel.onStateChanged((state) => states.push(state))

      await channel.connect()

      expect(states).toHaveLength(1)
      expect(states[0].status).toBe('connected')

      channel.disconnect()
    })

    it('unsubscribes when returned function is called', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      const states: HostState[] = []
      const unsub = channel.onStateChanged((state) => states.push(state))
      unsub()

      await channel.connect()

      expect(states).toHaveLength(0)

      channel.disconnect()
    })
  })

  describe('onEvent()', () => {
    it('notifies listeners on MagnetAdded event', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      const events: NativeEvent[] = []
      channel.onEvent((event) => events.push(event))

      await channel.connect()

      emitTauriEvent('host-event', {
        event: 'MagnetAdded',
        payload: { link: 'magnet:?xt=urn:btih:abc' },
      })

      expect(events).toHaveLength(1)
      expect(events[0]).toEqual({
        event: 'MagnetAdded',
        payload: { link: 'magnet:?xt=urn:btih:abc' },
      })

      channel.disconnect()
    })

    it('handles TorrentAdded events', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      const events: NativeEvent[] = []
      channel.onEvent((event) => events.push(event))

      await channel.connect()

      emitTauriEvent('host-event', {
        event: 'TorrentAdded',
        payload: { name: 'test.torrent', infohash: 'abc123' },
      })

      expect(events).toHaveLength(1)
      expect(events[0].event).toBe('TorrentAdded')

      channel.disconnect()
    })

    it('unsubscribes event listener', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      const events: NativeEvent[] = []
      const unsub = channel.onEvent((event) => events.push(event))

      await channel.connect()
      unsub()

      emitTauriEvent('host-event', {
        event: 'MagnetAdded',
        payload: { link: 'magnet:?xt=urn:btih:abc' },
      })

      expect(events).toHaveLength(0)

      channel.disconnect()
    })
  })

  describe('KV operations', () => {
    it('kvSet and kvGet round-trip through IndexedDB', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('myKey', 'hello')
      const result = await channel.kvGet('myKey')
      expect(result).toBe('hello')
    })

    it('kvGet returns undefined for missing key', async () => {
      const channel = new TauriChannel()
      const result = await channel.kvGet('nonexistent')
      expect(result).toBeUndefined()
    })

    it('kvGet uses custom keyPrefix', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('theme', 'dark', { keyPrefix: 'config:' })
      const result = await channel.kvGet('theme', { keyPrefix: 'config:' })
      expect(result).toBe('dark')
    })

    it('kvSet stores objects', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('key1', { foo: 'bar' })
      const result = await channel.kvGet('key1')
      expect(result).toEqual({ foo: 'bar' })
    })

    it('kvGetMulti reads multiple keys', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('a', 1)
      await channel.kvSet('b', 2)
      const result = await channel.kvGetMulti(['a', 'b', 'c'])
      expect(result).toEqual({ a: 1, b: 2 })
    })

    it('kvDelete removes key', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('delMe', 'value')
      await channel.kvDelete('delMe')
      const result = await channel.kvGet('delMe')
      expect(result).toBeUndefined()
    })

    it('kvKeys returns keys matching prefix', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('torrent:a', 1)
      await channel.kvSet('torrent:b', 2)
      await channel.kvSet('other', 3)
      // Also write a config key (different keyPrefix namespace)
      await channel.kvSet('setting', 4, { keyPrefix: 'config:' })

      const keys = await channel.kvKeys('torrent:')
      expect(keys.sort()).toEqual(['torrent:a', 'torrent:b'])
    })

    it('kvKeys returns all session keys when no prefix', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('a', 1)
      await channel.kvSet('b', 2)
      await channel.kvSet('c', 3, { keyPrefix: 'config:' })

      const keys = await channel.kvKeys()
      expect(keys.sort()).toEqual(['a', 'b'])
    })

    it('kvClear removes keys matching prefix', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('torrent:a', 1)
      await channel.kvSet('torrent:b', 2)
      await channel.kvSet('other', 3)

      await channel.kvClear('torrent:')

      expect(await channel.kvGet('torrent:a')).toBeUndefined()
      expect(await channel.kvGet('torrent:b')).toBeUndefined()
      expect(await channel.kvGet('other')).toBe(3)
    })

    it('kvClear removes all session keys when no prefix', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('a', 1)
      await channel.kvSet('b', 2)
      await channel.kvSet('c', 3, { keyPrefix: 'config:' })

      await channel.kvClear()

      expect(await channel.kvGet('a')).toBeUndefined()
      expect(await channel.kvGet('b')).toBeUndefined()
      expect(await channel.kvGet('c', { keyPrefix: 'config:' })).toBe(3)
    })

    it('config and session keys are isolated', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('theme', 'dark', { keyPrefix: 'config:' })
      await channel.kvSet('theme', 'session-value')

      expect(await channel.kvGet('theme', { keyPrefix: 'config:' })).toBe('dark')
      expect(await channel.kvGet('theme')).toBe('session-value')
    })

    it('shares IndexedDB with session store', async () => {
      // Write via TauriChannel KV (commits via tx.oncomplete)
      const channel = new TauriChannel()
      await channel.kvSet('shared', { from: 'kv' }, { keyPrefix: 'config:' })

      // Read via IndexedDbSessionStore — same DB, same object store
      const store = new IndexedDbSessionStore()
      const result = await store.getJson('config:shared')
      expect(result).toEqual({ from: 'kv' })
    })
  })

  describe('File operations', () => {
    it('pickDownloadFolder invokes host_message and updates roots', async () => {
      const root = {
        key: 'k1',
        path: '/home/downloads',
        display_name: 'Downloads',
        removable: true,
        last_stat_ok: true,
        last_checked: 0,
      }

      invokeHandler = vi.fn(async (cmd, args) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        if (cmd === 'host_message') {
          const msg = args?.message as Record<string, unknown>
          if (msg?.op === 'pickDownloadDirectory') {
            return { ok: true, type: 'RootAdded', payload: { root } }
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      await channel.connect()

      const result = await channel.pickDownloadFolder()
      expect(result).toEqual(root)
      expect(channel.getState().roots).toHaveLength(1)
      expect(channel.getState().roots[0]).toEqual(root)

      channel.disconnect()
    })

    it('pickDownloadFolder returns null on cancel', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return { ok: false }
      })

      const channel = new TauriChannel()
      await channel.connect()

      const result = await channel.pickDownloadFolder()
      expect(result).toBeNull()

      channel.disconnect()
    })

    it('removeDownloadRoot invokes host_message and updates state', async () => {
      const roots = [
        {
          key: 'r1',
          path: '/a',
          display_name: 'A',
          removable: true,
          last_stat_ok: true,
          last_checked: 0,
        },
        {
          key: 'r2',
          path: '/b',
          display_name: 'B',
          removable: true,
          last_stat_ok: true,
          last_checked: 0,
        },
      ]

      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots },
          }
        }
        return { ok: true }
      })

      const channel = new TauriChannel()
      await channel.connect()
      expect(channel.getState().roots).toHaveLength(2)

      await channel.removeDownloadRoot('r1')

      expect(tauriMock.invoke).toHaveBeenCalledWith('host_message', {
        message: { op: 'deleteDownloadRoot', key: 'r1' },
      })
      expect(channel.getState().roots).toHaveLength(1)
      expect(channel.getState().roots[0].key).toBe('r2')

      channel.disconnect()
    })

    it('openFile invokes host_message', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return { ok: true }
      })

      const channel = new TauriChannel()
      await channel.connect()

      await channel.openFile('rootA', 'path/to/file.mkv')

      expect(tauriMock.invoke).toHaveBeenCalledWith('host_message', {
        message: { op: 'openFile', rootKey: 'rootA', path: 'path/to/file.mkv' },
      })

      channel.disconnect()
    })

    it('revealInFolder invokes host_message', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return { ok: true }
      })

      const channel = new TauriChannel()
      await channel.connect()

      await channel.revealInFolder('rootB', 'dir/file.txt')

      expect(tauriMock.invoke).toHaveBeenCalledWith('host_message', {
        message: { op: 'revealInFolder', rootKey: 'rootB', path: 'dir/file.txt' },
      })

      channel.disconnect()
    })
  })

  describe('notify()', () => {
    it('is a no-op (does not throw)', () => {
      const channel = new TauriChannel()
      expect(() => channel.notify({ type: 'visibility', visible: true })).not.toThrow()
      expect(() =>
        channel.notify({ type: 'torrent-complete', infoHash: 'abc', name: 'test' }),
      ).not.toThrow()
    })
  })

  describe('Host actions', () => {
    it('retryConnection re-runs connect', async () => {
      let callCount = 0
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          callCount++
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      await channel.connect()
      expect(callCount).toBe(1)

      channel.retryConnection()
      // Wait for the async retry
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(callCount).toBe(2)

      channel.disconnect()
    })

    it('triggerLaunch is a no-op', () => {
      const channel = new TauriChannel()
      expect(() => channel.triggerLaunch()).not.toThrow()
    })
  })

  describe('getStats()', () => {
    it('returns null when not connected', async () => {
      const channel = new TauriChannel()
      const result = await channel.getStats()
      expect(result).toBeNull()
    })

    it('fetches stats from daemon when connected', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 54321, token: 'test-token', roots: [] },
          }
        }
        return {}
      })

      const stats = {
        tcp_sockets: 5,
        pending_connects: 2,
        pending_tcp: 0,
        udp_sockets: 3,
        tcp_servers: 1,
        ws_connections: 0,
        bytes_sent: 1000,
        bytes_received: 5000,
        uptime_secs: 120,
      }

      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => stats,
      } as Response)

      const channel = new TauriChannel()
      await channel.connect()

      const result = await channel.getStats()
      expect(result).toEqual(stats)
      expect(fetchSpy).toHaveBeenCalledWith('http://127.0.0.1:54321/stats', {
        headers: { 'X-JST-Auth': 'test-token' },
      })

      channel.disconnect()
    })

    it('returns null on fetch error', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 54321, token: 'test-token', roots: [] },
          }
        }
        return {}
      })

      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network error'))

      const channel = new TauriChannel()
      await channel.connect()

      const result = await channel.getStats()
      expect(result).toBeNull()

      channel.disconnect()
    })
  })

  describe('getDaemonInfo()', () => {
    it('returns cached daemon info', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 9999, token: 'secret', version: '1.0.0', roots: [] },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      await channel.connect()

      const result = await channel.getDaemonInfo()
      expect(result).toEqual({
        port: 9999,
        token: 'secret',
        version: '1.0.0',
        roots: [],
        host: '127.0.0.1',
      })

      channel.disconnect()
    })

    it('returns null when not connected', async () => {
      const channel = new TauriChannel()
      const result = await channel.getDaemonInfo()
      expect(result).toBeNull()
    })
  })

  describe('clearSessionStorage()', () => {
    it('clears IndexedDB session store', async () => {
      const store = new IndexedDbSessionStore()
      await store.set('key1', new Uint8Array([1, 2, 3]))
      await store.setJson('key2', { data: true })

      const channel = new TauriChannel()
      await channel.clearSessionStorage()

      const store2 = new IndexedDbSessionStore()
      expect(await store2.get('key1')).toBeNull()
      expect(await store2.getJson('key2')).toBeNull()
    })
  })

  describe('notifyClosing()', () => {
    it('is a no-op', () => {
      const channel = new TauriChannel()
      expect(() => channel.notifyClosing()).not.toThrow()
    })
  })

  describe('App info', () => {
    it('isDevMode returns boolean', () => {
      const channel = new TauriChannel()
      expect(typeof channel.isDevMode()).toBe('boolean')
    })

    it('requestPermission always returns true', async () => {
      const channel = new TauriChannel()
      const result = await channel.requestPermission('power')
      expect(result).toBe(true)
    })
  })

  describe('capabilities', () => {
    it('returns correct capabilities for Tauri', () => {
      const channel = new TauriChannel()
      expect(channel.capabilities).toEqual({
        rootsManageable: true,
        hasSync: false,
        hasNativeNotifications: true,
        hasBackgroundPersistence: true,
      })
    })
  })

  describe('disconnect()', () => {
    it('unlistens from Tauri events', async () => {
      invokeHandler = vi.fn(async (cmd) => {
        if (cmd === 'host_handshake') {
          return {
            ok: true,
            type: 'DaemonInfo',
            payload: { port: 1234, token: 'tok', roots: [] },
          }
        }
        return {}
      })

      const channel = new TauriChannel()
      await channel.connect()

      channel.disconnect()

      // After disconnect, the event unlisten should have been called
      expect(tauriMock.invoke).toHaveBeenCalledWith(
        'plugin:event|unlisten',
        expect.objectContaining({ event: 'host-event' }),
      )
    })
  })
})
