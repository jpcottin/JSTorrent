import { afterEach, describe, expect, it, vi } from 'vitest'
import { connectDesktopHandshake } from '../../../src/lib/daemon-bridge/desktop/desktop-connector'
import { createMockNativePort } from '../../helpers/mock-native-port'

const daemonInfo = {
  port: 7800,
  token: 'tok',
  version: '1.0.0',
  roots: [],
}

describe('desktop-connector', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('sends handshake and resolves on daemon info', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('hs-1')

    const port = createMockNativePort()
    const onConnected = vi.fn()
    const onHandshakeBuilt = vi.fn()

    const promise = connectDesktopHandshake({
      connectNative: () => port as unknown as chrome.runtime.Port,
      getDisconnectError: () => 'Disconnected',
      runtimeId: 'ext-id',
      clientVersion: '9.9.9',
      storedProfileId: 'profile-a',
      isDaemonInfoMessage: (msg) => (msg as { type?: string }).type === 'DaemonInfo',
      isProfileInUseMessage: (msg) => (msg as { error?: string }).error === 'profile_in_use',
      onConnected,
      onProfileInUse: vi.fn(),
      onDisconnectedAfterConnected: vi.fn(),
      onPostConnectionMessage: vi.fn(),
      onHandshakeBuilt,
      timeoutMs: 100,
    })

    expect(port.postMessage).toHaveBeenCalledWith({
      op: 'handshake',
      extensionId: 'ext-id',
      profileId: 'profile-a',
      clientType: 'extension',
      clientVersion: '9.9.9',
      id: 'hs-1',
    })
    expect(onHandshakeBuilt).toHaveBeenCalledTimes(1)

    port.emitMessage({ type: 'DaemonInfo', payload: daemonInfo })
    await expect(promise).resolves.toBeUndefined()

    expect(onConnected).toHaveBeenCalledWith(port, daemonInfo)
  })

  it('rejects on profile_in_use and surfaces metadata', async () => {
    const port = createMockNativePort()
    const onProfileInUse = vi.fn()

    const promise = connectDesktopHandshake({
      connectNative: () => port as unknown as chrome.runtime.Port,
      getDisconnectError: () => 'Disconnected',
      runtimeId: 'ext-id',
      clientVersion: '1.0.0',
      storedProfileId: null,
      isDaemonInfoMessage: (msg) => (msg as { type?: string }).type === 'DaemonInfo',
      isProfileInUseMessage: (msg) => (msg as { error?: string }).error === 'profile_in_use',
      onConnected: vi.fn(),
      onProfileInUse,
      onDisconnectedAfterConnected: vi.fn(),
      onPostConnectionMessage: vi.fn(),
      timeoutMs: 100,
    })

    port.emitMessage({
      ok: false,
      error: 'profile_in_use',
      payload: {
        clientType: 'tauri',
        clientVersion: '2.0.0',
        browserName: 'Chrome',
        pid: 42,
        started: 1700000000000,
      },
    })

    await expect(promise).rejects.toThrow('profile_in_use')
    expect(onProfileInUse).toHaveBeenCalledWith(
      port,
      expect.objectContaining({
        clientType: 'tauri',
        clientVersion: '2.0.0',
        browserName: 'Chrome',
        pid: 42,
      }),
    )
  })

  it('invokes post-connection message handler after handshake', async () => {
    const port = createMockNativePort()
    const onPostConnectionMessage = vi.fn()

    const promise = connectDesktopHandshake({
      connectNative: () => port as unknown as chrome.runtime.Port,
      getDisconnectError: () => 'Disconnected',
      runtimeId: 'ext-id',
      clientVersion: '1.0.0',
      storedProfileId: null,
      isDaemonInfoMessage: (msg) => (msg as { type?: string }).type === 'DaemonInfo',
      isProfileInUseMessage: (msg) => (msg as { error?: string }).error === 'profile_in_use',
      onConnected: vi.fn(),
      onProfileInUse: vi.fn(),
      onDisconnectedAfterConnected: vi.fn(),
      onPostConnectionMessage,
      timeoutMs: 100,
    })

    port.emitMessage({ type: 'DaemonInfo', payload: daemonInfo })
    await promise

    const event = { event: 'TorrentAdded', payload: { infoHash: 'abc' } }
    port.emitMessage(event)

    expect(onPostConnectionMessage).toHaveBeenCalledWith(event)
  })

  it('calls disconnect callback when port disconnects after success', async () => {
    const port = createMockNativePort()
    const onDisconnectedAfterConnected = vi.fn()

    const promise = connectDesktopHandshake({
      connectNative: () => port as unknown as chrome.runtime.Port,
      getDisconnectError: () => 'Disconnected',
      runtimeId: 'ext-id',
      clientVersion: '1.0.0',
      storedProfileId: null,
      isDaemonInfoMessage: (msg) => (msg as { type?: string }).type === 'DaemonInfo',
      isProfileInUseMessage: (msg) => (msg as { error?: string }).error === 'profile_in_use',
      onConnected: vi.fn(),
      onProfileInUse: vi.fn(),
      onDisconnectedAfterConnected,
      onPostConnectionMessage: vi.fn(),
      timeoutMs: 100,
    })

    port.emitMessage({ type: 'DaemonInfo', payload: daemonInfo })
    await promise

    port.emitDisconnect()
    expect(onDisconnectedAfterConnected).toHaveBeenCalledTimes(1)
  })

  it('times out handshake and disconnects port', async () => {
    vi.useFakeTimers()

    const port = createMockNativePort()
    const promise = connectDesktopHandshake({
      connectNative: () => port as unknown as chrome.runtime.Port,
      getDisconnectError: () => 'Disconnected',
      runtimeId: 'ext-id',
      clientVersion: '1.0.0',
      storedProfileId: null,
      isDaemonInfoMessage: (msg) => (msg as { type?: string }).type === 'DaemonInfo',
      isProfileInUseMessage: (msg) => (msg as { error?: string }).error === 'profile_in_use',
      onConnected: vi.fn(),
      onProfileInUse: vi.fn(),
      onDisconnectedAfterConnected: vi.fn(),
      onPostConnectionMessage: vi.fn(),
      timeoutMs: 25,
    })

    const rejected = expect(promise).rejects.toThrow('Handshake timeout')
    await vi.advanceTimersByTimeAsync(25)

    await rejected
    expect(port.disconnect).toHaveBeenCalledTimes(1)
  })
})
