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
})
