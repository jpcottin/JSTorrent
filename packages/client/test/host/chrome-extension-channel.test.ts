import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ChromeExtensionChannel } from '../../src/host/chrome-extension-channel'
import type { HostState, NativeEvent, VideoPopupLaunchOptions } from '../../src/host/types'

// --- Chrome API mock setup ---

interface MockPort {
  name: string
  onMessage: { addListener: ReturnType<typeof vi.fn>; listeners: Array<(msg: unknown) => void> }
  onDisconnect: { addListener: ReturnType<typeof vi.fn>; listeners: Array<() => void> }
  postMessage: ReturnType<typeof vi.fn>
  disconnect: ReturnType<typeof vi.fn>
}

function createMockPort(name = 'ui'): MockPort {
  const messageListeners: Array<(msg: unknown) => void> = []
  const disconnectListeners: Array<() => void> = []
  return {
    name,
    onMessage: {
      addListener: vi.fn((cb) => messageListeners.push(cb)),
      listeners: messageListeners,
    },
    onDisconnect: {
      addListener: vi.fn((cb) => disconnectListeners.push(cb)),
      listeners: disconnectListeners,
    },
    postMessage: vi.fn(),
    disconnect: vi.fn(),
  }
}

let sendMessageCallback: ((response: unknown) => void) | null = null
let sendMessageResponse: unknown = undefined
let mockPort: MockPort

function setupChromeMock() {
  mockPort = createMockPort()

  const chromeMock = {
    runtime: {
      sendMessage: vi.fn((...args: unknown[]) => {
        // Handle both internal (msg, cb) and external (extensionId, msg, cb) signatures
        const callback = args[args.length - 1] as (response: unknown) => void
        sendMessageCallback = callback
        if (sendMessageResponse !== undefined) {
          callback(sendMessageResponse)
          sendMessageResponse = undefined
        }
        return Promise.resolve()
      }),
      connect: vi.fn(() => mockPort),
      lastError: null as { message: string } | null,
      getManifest: vi.fn(() => ({ version: '1.2.3' })),
      id: undefined as string | undefined,
    },
    permissions: {
      request: vi.fn((_permissions: unknown, callback: (granted: boolean) => void) => {
        callback(true)
      }),
    },
  }

  // @ts-expect-error -- mock chrome global
  globalThis.chrome = chromeMock

  return chromeMock
}

function teardownChromeMock() {
  // @ts-expect-error -- clean up mock
  delete globalThis.chrome
}

// Helper to resolve the next sendMessage call
function resolveSendMessage(response: unknown) {
  if (sendMessageCallback) {
    sendMessageCallback(response)
    sendMessageCallback = null
  } else {
    sendMessageResponse = response
  }
}

describe('ChromeExtensionChannel', () => {
  let chromeMock: ReturnType<typeof setupChromeMock>

  beforeEach(() => {
    chromeMock = setupChromeMock()
    sendMessageCallback = null
    sendMessageResponse = undefined
  })

  afterEach(() => {
    teardownChromeMock()
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('creates in internal mode without extensionId', () => {
      const channel = new ChromeExtensionChannel()
      expect(channel).toBeDefined()
      expect(channel.getState().status).toBe('connecting')
    })

    it('creates in external mode with extensionId', () => {
      const channel = new ChromeExtensionChannel('test-ext-id')
      expect(channel).toBeDefined()
    })
  })

  describe('connect()', () => {
    it('fetches initial state via GET_BRIDGE_STATE', async () => {
      const initialState: HostState = {
        status: 'connected',
        platform: 'desktop',
        daemonInfo: { port: 12345, token: 'tok', roots: [] },
        roots: [],
        lastError: null,
      }

      // Pre-set response for sendMessage
      sendMessageResponse = { ok: true, state: initialState }

      const channel = new ChromeExtensionChannel()
      await channel.connect()

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'GET_BRIDGE_STATE' },
        expect.any(Function),
      )
      expect(channel.getState()).toEqual(initialState)

      channel.disconnect()
    })

    it('opens a port with name "ui"', async () => {
      sendMessageResponse = { ok: false }

      const channel = new ChromeExtensionChannel()
      await channel.connect()

      expect(chromeMock.runtime.connect).toHaveBeenCalledWith({ name: 'ui' })

      channel.disconnect()
    })

    it('opens a port with extensionId in external mode', async () => {
      sendMessageResponse = { ok: false }

      const channel = new ChromeExtensionChannel('my-ext-id')
      await channel.connect()

      expect(chromeMock.runtime.connect).toHaveBeenCalledWith('my-ext-id', { name: 'ui' })

      channel.disconnect()
    })

    it('handles GET_BRIDGE_STATE failure gracefully', async () => {
      chromeMock.runtime.sendMessage = vi.fn((...args: unknown[]) => {
        const callback = args[args.length - 1] as (response: unknown) => void
        chromeMock.runtime.lastError = { message: 'Extension not found' }
        callback(undefined)
        chromeMock.runtime.lastError = null
        return Promise.resolve()
      })

      const channel = new ChromeExtensionChannel()
      // Should not throw
      await channel.connect()
      expect(channel.getState().status).toBe('connecting')

      channel.disconnect()
    })
  })

  describe('onStateChanged()', () => {
    it('notifies listeners on BRIDGE_STATE_CHANGED port message', async () => {
      sendMessageResponse = { ok: false }

      const channel = new ChromeExtensionChannel()
      const stateChanges: HostState[] = []
      channel.onStateChanged((state) => stateChanges.push(state))

      await channel.connect()

      const newState: HostState = {
        status: 'connected',
        platform: 'desktop',
        daemonInfo: { port: 5555, token: 'abc', roots: [] },
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
        lastError: null,
      }

      // Simulate port message
      mockPort.onMessage.listeners[0]({ type: 'BRIDGE_STATE_CHANGED', state: newState })

      expect(stateChanges).toHaveLength(1)
      expect(stateChanges[0]).toEqual(newState)
      expect(channel.getState()).toEqual(newState)

      channel.disconnect()
    })

    it('unsubscribes when returned function is called', async () => {
      sendMessageResponse = { ok: false }

      const channel = new ChromeExtensionChannel()
      const stateChanges: HostState[] = []
      const unsub = channel.onStateChanged((state) => stateChanges.push(state))

      await channel.connect()

      unsub()

      mockPort.onMessage.listeners[0]({
        type: 'BRIDGE_STATE_CHANGED',
        state: {
          status: 'connected',
          platform: 'desktop',
          daemonInfo: null,
          roots: [],
          lastError: null,
        },
      })

      expect(stateChanges).toHaveLength(0)

      channel.disconnect()
    })
  })

  describe('onEvent()', () => {
    it('notifies listeners on native events from port', async () => {
      sendMessageResponse = { ok: false }

      const channel = new ChromeExtensionChannel()
      const events: NativeEvent[] = []
      channel.onEvent((event) => events.push(event))

      await channel.connect()

      mockPort.onMessage.listeners[0]({
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
      sendMessageResponse = { ok: false }

      const channel = new ChromeExtensionChannel()
      const events: NativeEvent[] = []
      channel.onEvent((event) => events.push(event))

      await channel.connect()

      mockPort.onMessage.listeners[0]({
        event: 'TorrentAdded',
        payload: { name: 'test.torrent', infohash: 'abc123' },
      })

      expect(events).toHaveLength(1)
      expect(events[0].event).toBe('TorrentAdded')

      channel.disconnect()
    })
  })

  describe('CLOSE message', () => {
    it('calls window.close() on CLOSE message', async () => {
      sendMessageResponse = { ok: false }
      const closeSpy = vi.spyOn(window, 'close').mockImplementation(() => {})

      const channel = new ChromeExtensionChannel()
      await channel.connect()

      mockPort.onMessage.listeners[0]({ type: 'CLOSE' })

      expect(closeSpy).toHaveBeenCalled()

      channel.disconnect()
    })
  })

  describe('KV operations', () => {
    it('kvGet sends correct message shape', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      // Set up response for the next sendMessage call
      sendMessageResponse = { ok: true, value: 'hello' }
      const result = await channel.kvGet('testKey')

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'KV_GET', key: 'testKey', keyPrefix: 'session:' },
        expect.any(Function),
      )
      expect(result).toBe('hello')

      channel.disconnect()
    })

    it('kvGet uses custom opts', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true, value: 42 }
      await channel.kvGet('key', { keyPrefix: 'config:' })

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'KV_GET', key: 'key', keyPrefix: 'config:' },
        expect.any(Function),
      )

      channel.disconnect()
    })

    it('kvGet returns undefined on failure', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: false, error: 'not found' }
      const result = await channel.kvGet('missing')
      expect(result).toBeUndefined()

      channel.disconnect()
    })

    it('kvGetMulti sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true, values: { a: 1, b: 2 } }
      const result = await channel.kvGetMulti(['a', 'b'])

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'KV_GET_MULTI', keys: ['a', 'b'], keyPrefix: 'session:' },
        expect.any(Function),
      )
      expect(result).toEqual({ a: 1, b: 2 })

      channel.disconnect()
    })

    it('kvSet sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true }
      await channel.kvSet('myKey', { foo: 'bar' }, { keyPrefix: 'config:' })

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        {
          type: 'KV_SET',
          key: 'myKey',
          value: { foo: 'bar' },
          keyPrefix: 'config:',
        },
        expect.any(Function),
      )

      channel.disconnect()
    })

    it('kvDelete sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true }
      await channel.kvDelete('delKey')

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'KV_DELETE', key: 'delKey', keyPrefix: 'session:' },
        expect.any(Function),
      )

      channel.disconnect()
    })

    it('kvKeys sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true, keys: ['a', 'b', 'c'] }
      const result = await channel.kvKeys('prefix:')

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'KV_KEYS', prefix: 'prefix:', keyPrefix: 'session:' },
        expect.any(Function),
      )
      expect(result).toEqual(['a', 'b', 'c'])

      channel.disconnect()
    })

    it('kvClear sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true }
      await channel.kvClear('prefix:')

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'KV_CLEAR', prefix: 'prefix:', keyPrefix: 'session:' },
        expect.any(Function),
      )

      channel.disconnect()
    })
  })

  describe('File operations', () => {
    it('pickDownloadFolder returns root on success', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      const root = {
        key: 'k1',
        path: '/home/downloads',
        display_name: 'Downloads',
        removable: true,
        last_stat_ok: true,
        last_checked: 0,
      }
      sendMessageResponse = { ok: true, root }
      const result = await channel.pickDownloadFolder()

      expect(result).toEqual(root)

      channel.disconnect()
    })

    it('pickDownloadFolder returns null on cancel', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: false }
      const result = await channel.pickDownloadFolder()
      expect(result).toBeNull()

      channel.disconnect()
    })

    it('removeDownloadRoot sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true }
      await channel.removeDownloadRoot('root-key')

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'REMOVE_DOWNLOAD_ROOT', key: 'root-key' },
        expect.any(Function),
      )

      channel.disconnect()
    })

    it('openFile sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true }
      await channel.openFile('rootA', 'path/to/file.mkv')

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'OPEN_FILE', rootKey: 'rootA', path: 'path/to/file.mkv' },
        expect.any(Function),
      )

      channel.disconnect()
    })

    it('revealInFolder sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true }
      await channel.revealInFolder('rootB', 'dir/file.txt')

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'REVEAL_IN_FOLDER', rootKey: 'rootB', path: 'dir/file.txt' },
        expect.any(Function),
      )

      channel.disconnect()
    })
  })

  describe('notify()', () => {
    it('sends notification via sendMessage', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      channel.notify({ type: 'visibility', visible: true })

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'notification:visibility',
        visible: true,
      })

      channel.disconnect()
    })

    it('sends torrent-complete notification', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      channel.notify({ type: 'torrent-complete', infoHash: 'abc', name: 'test.torrent' })

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'notification:torrent-complete',
        infoHash: 'abc',
        name: 'test.torrent',
      })

      channel.disconnect()
    })
  })

  describe('Host actions', () => {
    it('retryConnection reconnects port and sends RETRY_CONNECTION', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      // Reset connect mock to track retries
      chromeMock.runtime.connect.mockClear()
      const newPort = createMockPort()
      chromeMock.runtime.connect.mockReturnValue(newPort)

      channel.retryConnection()

      expect(chromeMock.runtime.connect).toHaveBeenCalled()

      channel.disconnect()
    })

    it('triggerLaunch sends TRIGGER_LAUNCH', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      channel.triggerLaunch()

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'TRIGGER_LAUNCH' })

      channel.disconnect()
    })

    it('openVideoPlayerPopup sends popup launch details', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      const options: VideoPopupLaunchOptions = {
        sessionId: 'session-1',
        fileName: 'movie.mkv',
        fileSize: 123,
        fileOffset: 456,
        pieceLength: 16384,
      }

      sendMessageResponse = { ok: true }
      await expect(channel.openVideoPlayerPopup(options)).resolves.toBe(true)

      expect(chromeMock.runtime.sendMessage).toHaveBeenLastCalledWith(
        {
          type: 'OPEN_VIDEO_PLAYER_POPUP',
          ...options,
        },
        expect.any(Function),
      )

      channel.disconnect()
    })
  })

  describe('getStats()', () => {
    it('returns stats on success', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

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
      sendMessageResponse = { ok: true, stats }
      const result = await channel.getStats()
      expect(result).toEqual(stats)

      channel.disconnect()
    })

    it('returns null on failure', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: false }
      const result = await channel.getStats()
      expect(result).toBeNull()

      channel.disconnect()
    })
  })

  describe('getDaemonInfo()', () => {
    it('returns daemon info on success', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      const daemonInfo = { port: 9999, token: 'secret', roots: [] }
      sendMessageResponse = { ok: true, daemonInfo }
      const result = await channel.getDaemonInfo()
      expect(result).toEqual(daemonInfo)

      channel.disconnect()
    })
  })

  describe('clearSessionStorage()', () => {
    it('sends CLEAR_SESSION_STORAGE message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      sendMessageResponse = { ok: true }
      await channel.clearSessionStorage()

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith(
        { type: 'CLEAR_SESSION_STORAGE' },
        expect.any(Function),
      )

      channel.disconnect()
    })
  })

  describe('notifyClosing()', () => {
    it('sends UI_CLOSING via sendMessage', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      channel.notifyClosing()

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'UI_CLOSING' })

      channel.disconnect()
    })
  })

  describe('App info', () => {
    it('getVersion returns manifest version', () => {
      const channel = new ChromeExtensionChannel()
      expect(channel.getVersion()).toBe('1.2.3')
    })

    it('isDevMode returns true when no update_url', () => {
      const channel = new ChromeExtensionChannel()
      expect(channel.isDevMode()).toBe(true)
    })

    it('isDevMode returns false when update_url present', () => {
      chromeMock.runtime.getManifest.mockReturnValue({
        version: '1.0.0',
        update_url: 'https://clients2.google.com/service/update2/crx',
      })
      const channel = new ChromeExtensionChannel()
      expect(channel.isDevMode()).toBe(false)
    })

    it('requestPermission calls chrome.permissions.request', async () => {
      const channel = new ChromeExtensionChannel()
      const result = await channel.requestPermission('power')
      expect(chromeMock.permissions.request).toHaveBeenCalledWith(
        { permissions: ['power'] },
        expect.any(Function),
      )
      expect(result).toBe(true)
    })
  })

  describe('capabilities', () => {
    it('returns correct capabilities for Chrome extension', () => {
      const channel = new ChromeExtensionChannel()
      expect(channel.capabilities).toEqual({
        rootsManageable: true,
        hasSync: true,
        hasNativeNotifications: true,
        hasBackgroundPersistence: false,
      })
    })
  })

  describe('ChromeOS-specific methods', () => {
    it('openChromeOSIntent sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      channel.openChromeOSIntent()

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({ type: 'CHROMEOS_OPEN_INTENT' })

      channel.disconnect()
    })

    it('resetChromeOSPairing sends correct message', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      channel.resetChromeOSPairing()

      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'CHROMEOS_RESET_PAIRING',
      })

      channel.disconnect()
    })

    it('onChromeOSBootstrapStateChanged fires on CHROMEOS_BOOTSTRAP_STATE', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      const states: unknown[] = []
      channel.onChromeOSBootstrapStateChanged((state) => states.push(state))

      await channel.connect()

      const bootstrapState = {
        phase: 'connected' as const,
        port: 5678,
        problem: 'none' as const,
        message: 'Connected to Android',
      }
      mockPort.onMessage.listeners[0]({
        type: 'CHROMEOS_BOOTSTRAP_STATE',
        state: bootstrapState,
      })

      expect(states).toHaveLength(1)
      expect(states[0]).toEqual(bootstrapState)
      expect(channel.getChromeOSBootstrapState()).toEqual(bootstrapState)

      channel.disconnect()
    })
  })

  describe('disconnect()', () => {
    it('cleans up port and listeners', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      channel.disconnect()

      expect(mockPort.disconnect).toHaveBeenCalled()
    })
  })

  describe('External mode (with extensionId)', () => {
    it('sends messages with extensionId', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel('ext-123')
      await channel.connect()

      sendMessageResponse = { ok: true, value: 'test' }
      await channel.kvGet('key')

      // Should have been called with extensionId as first arg
      const calls = chromeMock.runtime.sendMessage.mock.calls
      const kvCall = calls.find(
        (c) => typeof c[1] === 'object' && (c[1] as Record<string, unknown>).type === 'KV_GET',
      )
      expect(kvCall).toBeDefined()
      expect(kvCall![0]).toBe('ext-123')

      channel.disconnect()
    })

    it('connects port with extensionId', async () => {
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel('ext-456')
      await channel.connect()

      expect(chromeMock.runtime.connect).toHaveBeenCalledWith('ext-456', { name: 'ui' })

      channel.disconnect()
    })
  })

  describe('Port reconnection', () => {
    it('schedules reconnect when port disconnects while tab visible', async () => {
      vi.useFakeTimers()
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      // Reset connect mock
      chromeMock.runtime.connect.mockClear()
      const newPort = createMockPort()
      chromeMock.runtime.connect.mockReturnValue(newPort)

      // Simulate port disconnect
      mockPort.onDisconnect.listeners[0]()

      // Should schedule reconnect after 100ms
      expect(chromeMock.runtime.connect).not.toHaveBeenCalled()

      vi.advanceTimersByTime(100)

      expect(chromeMock.runtime.connect).toHaveBeenCalledTimes(1)

      channel.disconnect()
      vi.useRealTimers()
    })

    it('does not reconnect after disconnect() is called', async () => {
      vi.useFakeTimers()
      sendMessageResponse = { ok: false }
      const channel = new ChromeExtensionChannel()
      await channel.connect()

      channel.disconnect()

      chromeMock.runtime.connect.mockClear()

      // Simulate port disconnect firing after our disconnect
      if (mockPort.onDisconnect.listeners.length > 0) {
        mockPort.onDisconnect.listeners[0]()
      }

      vi.advanceTimersByTime(1000)
      expect(chromeMock.runtime.connect).not.toHaveBeenCalled()

      vi.useRealTimers()
    })
  })

  describe('postMessage fallback', () => {
    it('falls back to sendMessage when port is not connected', () => {
      // Don't connect, so no port
      const channel = new ChromeExtensionChannel()
      channel.notify({ type: 'visibility', visible: false })

      // Should fall back to sendMessage
      expect(chromeMock.runtime.sendMessage).toHaveBeenCalledWith({
        type: 'notification:visibility',
        visible: false,
      })
    })
  })
})
