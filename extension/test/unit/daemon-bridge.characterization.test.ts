import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DaemonBridge } from '../../src/lib/daemon-bridge'
import type { DaemonInfo, DownloadRoot } from '../../src/lib/native-connection'
import { installMockChromeFull } from '../helpers/mock-chrome-full'

function createDaemonInfo(overrides: Partial<DaemonInfo> = {}): DaemonInfo {
  return {
    port: 7810,
    token: 'token-123',
    version: '1.2.3',
    roots: [],
    ...overrides,
  }
}

async function emitHandshakeSuccess(
  connectNative: ReturnType<typeof vi.fn>,
  emitMessage: (msg: unknown) => void,
  payload: DaemonInfo,
): Promise<void> {
  await vi.waitFor(() => {
    expect(connectNative).toHaveBeenCalledTimes(1)
  })
  emitMessage({ type: 'DaemonInfo', payload })
}

describe('DaemonBridge characterization', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        return {
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => '',
        } as Response
      }),
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    Reflect.deleteProperty(globalThis, 'chrome')
  })

  it('de-duplicates concurrent connect() calls', async () => {
    const { nativePort, chrome } = installMockChromeFull()
    const bridge = new DaemonBridge()

    const p1 = bridge.connect()
    const p2 = bridge.connect()

    await emitHandshakeSuccess(
      chrome.runtime.connectNative as ReturnType<typeof vi.fn>,
      nativePort.emitMessage,
      createDaemonInfo(),
    )

    await expect(p1).resolves.toBe(true)
    await expect(p2).resolves.toBe(true)
    expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(1)

    bridge.disconnect()
  })

  it('returns true from connect() without reconnecting when already connected', async () => {
    const { nativePort, chrome } = installMockChromeFull()
    const bridge = new DaemonBridge()

    const initialConnect = bridge.connect()
    await emitHandshakeSuccess(
      chrome.runtime.connectNative as ReturnType<typeof vi.fn>,
      nativePort.emitMessage,
      createDaemonInfo(),
    )
    await expect(initialConnect).resolves.toBe(true)

    await expect(bridge.connect()).resolves.toBe(true)
    expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(1)

    bridge.disconnect()
  })

  it('disconnect() clears connection state fields', async () => {
    const roots: DownloadRoot[] = [
      {
        key: 'downloads',
        path: '/Downloads',
        display_name: 'Downloads',
        removable: true,
        last_stat_ok: true,
        last_checked: 100,
      },
    ]

    const { nativePort, chrome } = installMockChromeFull()
    const bridge = new DaemonBridge()

    const connectPromise = bridge.connect()
    await emitHandshakeSuccess(
      chrome.runtime.connectNative as ReturnType<typeof vi.fn>,
      nativePort.emitMessage,
      createDaemonInfo({ roots }),
    )
    await expect(connectPromise).resolves.toBe(true)

    bridge.disconnect()

    const state = bridge.getState()
    expect(state.status).toBe('disconnected')
    expect(state.daemonInfo).toBeNull()
    expect(state.roots).toEqual([])
  })

  it('persists hasConnected and lastConnectedTime after successful connect', async () => {
    const now = 1700000000123
    vi.spyOn(Date, 'now').mockReturnValue(now)

    const { nativePort, chrome } = installMockChromeFull()
    const bridge = new DaemonBridge()

    const connectPromise = bridge.connect()
    await emitHandshakeSuccess(
      chrome.runtime.connectNative as ReturnType<typeof vi.fn>,
      nativePort.emitMessage,
      createDaemonInfo(),
    )
    await expect(connectPromise).resolves.toBe(true)

    await expect(bridge.hasEverConnected()).resolves.toBe(true)
    await expect(bridge.getLastConnectedTime()).resolves.toBe(now)

    bridge.disconnect()
  })

  it('persists profileId from profile_in_use so takeover targets the incumbent profile', async () => {
    vi.spyOn(crypto, 'randomUUID')
      .mockReturnValueOnce('11111111-1111-4111-8111-111111111111')
      .mockReturnValueOnce('22222222-2222-4222-8222-222222222222')

    const { nativePort, chrome, storageData } = installMockChromeFull()
    const bridge = new DaemonBridge()

    const connectPromise = bridge.connect()
    await vi.waitFor(() => {
      expect(chrome.runtime.connectNative).toHaveBeenCalledTimes(1)
    })

    nativePort.emitMessage({
      ok: false,
      error: 'profile_in_use',
      payload: {
        profileId: 'desktop-profile-1',
        clientType: 'tauri',
        clientVersion: '2.0.0',
        pid: 42,
        started: 1700000000000,
      },
    })

    await expect(connectPromise).resolves.toBe(false)
    expect(storageData.profileId).toBe('desktop-profile-1')

    const takeOverPromise = bridge.takeOver()
    await vi.waitFor(() => {
      expect(nativePort.postMessage).toHaveBeenLastCalledWith(
        expect.objectContaining({
          op: 'takeOver',
          profileId: 'desktop-profile-1',
          clientType: 'extension',
        }),
      )
    })

    nativePort.emitMessage({
      type: 'DaemonInfo',
      payload: createDaemonInfo({ profileId: 'desktop-profile-1' }),
    })

    await expect(takeOverPromise).resolves.toBe(true)
  })
})
