import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { TauriChannel } from '../../src/host/tauri-channel'
import type { HostState, NativeEvent } from '../../src/host/types'

// --- localStorage mock (happy-dom's localStorage is incomplete) ---

function createMockLocalStorage(): Storage {
  const store = new Map<string, string>()
  return {
    getItem(key: string) {
      return store.get(key) ?? null
    },
    setItem(key: string, value: string) {
      store.set(key, value)
    },
    removeItem(key: string) {
      store.delete(key)
    },
    key(index: number) {
      return [...store.keys()][index] ?? null
    },
    get length() {
      return store.size
    },
    clear() {
      store.clear()
    },
  }
}

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

let mockStorage: Storage
let originalLocalStorage: Storage

describe('TauriChannel', () => {
  let tauriMock: ReturnType<typeof setupTauriMock>

  beforeEach(() => {
    tauriMock = setupTauriMock()
    mockStorage = createMockLocalStorage()
    originalLocalStorage = globalThis.localStorage
    Object.defineProperty(globalThis, 'localStorage', { value: mockStorage, configurable: true })
  })

  afterEach(() => {
    teardownTauriMock()
    vi.restoreAllMocks()
    Object.defineProperty(globalThis, 'localStorage', {
      value: originalLocalStorage,
      configurable: true,
    })
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
    it('kvGet reads from localStorage with jst: prefix', async () => {
      localStorage.setItem('jst:session:myKey', JSON.stringify('hello'))

      const channel = new TauriChannel()
      const result = await channel.kvGet('myKey')
      expect(result).toBe('hello')
    })

    it('kvGet returns undefined for missing key', async () => {
      const channel = new TauriChannel()
      const result = await channel.kvGet('nonexistent')
      expect(result).toBeUndefined()
    })

    it('kvGet uses custom keyPrefix', async () => {
      localStorage.setItem('jst:config:theme', JSON.stringify('dark'))

      const channel = new TauriChannel()
      const result = await channel.kvGet('theme', { keyPrefix: 'config:' })
      expect(result).toBe('dark')
    })

    it('kvGet ignores area (treated as local)', async () => {
      localStorage.setItem('jst:config:setting', JSON.stringify(42))

      const channel = new TauriChannel()
      const result = await channel.kvGet('setting', { keyPrefix: 'config:', area: 'sync' })
      expect(result).toBe(42)
    })

    it('kvGetMulti reads multiple keys', async () => {
      localStorage.setItem('jst:session:a', JSON.stringify(1))
      localStorage.setItem('jst:session:b', JSON.stringify(2))

      const channel = new TauriChannel()
      const result = await channel.kvGetMulti(['a', 'b', 'c'])
      expect(result).toEqual({ a: 1, b: 2 })
    })

    it('kvSet writes to localStorage', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('key1', { foo: 'bar' })
      expect(localStorage.getItem('jst:session:key1')).toBe(JSON.stringify({ foo: 'bar' }))
    })

    it('kvSet uses custom keyPrefix', async () => {
      const channel = new TauriChannel()
      await channel.kvSet('theme', 'dark', { keyPrefix: 'config:' })
      expect(localStorage.getItem('jst:config:theme')).toBe(JSON.stringify('dark'))
    })

    it('kvDelete removes from localStorage', async () => {
      localStorage.setItem('jst:session:delMe', JSON.stringify('value'))

      const channel = new TauriChannel()
      await channel.kvDelete('delMe')
      expect(localStorage.getItem('jst:session:delMe')).toBeNull()
    })

    it('kvKeys returns keys matching prefix', async () => {
      localStorage.setItem('jst:session:torrent:a', JSON.stringify(1))
      localStorage.setItem('jst:session:torrent:b', JSON.stringify(2))
      localStorage.setItem('jst:session:other', JSON.stringify(3))
      localStorage.setItem('jst:config:setting', JSON.stringify(4))

      const channel = new TauriChannel()
      const keys = await channel.kvKeys('torrent:')
      expect(keys.sort()).toEqual(['torrent:a', 'torrent:b'])
    })

    it('kvKeys returns all session keys when no prefix', async () => {
      localStorage.setItem('jst:session:a', JSON.stringify(1))
      localStorage.setItem('jst:session:b', JSON.stringify(2))
      localStorage.setItem('jst:config:c', JSON.stringify(3))

      const channel = new TauriChannel()
      const keys = await channel.kvKeys()
      expect(keys.sort()).toEqual(['a', 'b'])
    })

    it('kvClear removes keys matching prefix', async () => {
      localStorage.setItem('jst:session:torrent:a', JSON.stringify(1))
      localStorage.setItem('jst:session:torrent:b', JSON.stringify(2))
      localStorage.setItem('jst:session:other', JSON.stringify(3))

      const channel = new TauriChannel()
      await channel.kvClear('torrent:')

      expect(localStorage.getItem('jst:session:torrent:a')).toBeNull()
      expect(localStorage.getItem('jst:session:torrent:b')).toBeNull()
      expect(localStorage.getItem('jst:session:other')).toBe(JSON.stringify(3))
    })

    it('kvClear removes all session keys when no prefix', async () => {
      localStorage.setItem('jst:session:a', JSON.stringify(1))
      localStorage.setItem('jst:session:b', JSON.stringify(2))
      localStorage.setItem('jst:config:c', JSON.stringify(3))

      const channel = new TauriChannel()
      await channel.kvClear()

      expect(localStorage.getItem('jst:session:a')).toBeNull()
      expect(localStorage.getItem('jst:session:b')).toBeNull()
      expect(localStorage.getItem('jst:config:c')).toBe(JSON.stringify(3))
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
    it('removes only jst:session: keys from localStorage', async () => {
      localStorage.setItem('jst:session:a', JSON.stringify(1))
      localStorage.setItem('jst:session:b', JSON.stringify(2))
      localStorage.setItem('jst:config:c', JSON.stringify(3))
      localStorage.setItem('other', 'value')

      const channel = new TauriChannel()
      await channel.clearSessionStorage()

      expect(localStorage.getItem('jst:session:a')).toBeNull()
      expect(localStorage.getItem('jst:session:b')).toBeNull()
      expect(localStorage.getItem('jst:config:c')).toBe(JSON.stringify(3))
      expect(localStorage.getItem('other')).toBe('value')
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
        hasNativeNotifications: false,
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
