import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestDesktopTakeOver } from '../../../src/lib/daemon-bridge/desktop/takeover'
import { createMockNativePort } from '../../helpers/mock-native-port'

const daemonInfoPayload = {
  port: 7810,
  token: 'tok',
  version: '1.2.3',
  roots: [],
}

describe('desktop-takeover', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns false without native port', async () => {
    const ok = await requestDesktopTakeOver({
      nativePort: null,
      runtimeId: 'ext-id',
      clientVersion: '1.0.0',
      profileId: null,
      isDaemonInfoMessage: () => false,
      onSuccess: vi.fn(),
    })

    expect(ok).toBe(false)
  })

  it('posts takeover message and resolves true on DaemonInfo', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('take-1')

    const port = createMockNativePort()
    const onSuccess = vi.fn()

    const promise = requestDesktopTakeOver({
      nativePort: port as unknown as chrome.runtime.Port,
      runtimeId: 'ext-id',
      clientVersion: '3.4.5',
      profileId: 'p1',
      isDaemonInfoMessage: (msg) => (msg as { type?: string }).type === 'DaemonInfo',
      onSuccess,
      timeoutMs: 100,
    })

    expect(port.postMessage).toHaveBeenCalledWith({
      op: 'takeOver',
      extensionId: 'ext-id',
      profileId: 'p1',
      clientType: 'extension',
      clientVersion: '3.4.5',
      id: 'take-1',
    })

    port.emitMessage({ type: 'DaemonInfo', payload: daemonInfoPayload })
    await expect(promise).resolves.toBe(true)

    expect(onSuccess).toHaveBeenCalledWith(daemonInfoPayload)
  })

  it('ignores non-matching messages', async () => {
    vi.useFakeTimers()

    const port = createMockNativePort()
    const promise = requestDesktopTakeOver({
      nativePort: port as unknown as chrome.runtime.Port,
      runtimeId: 'ext-id',
      clientVersion: '1.0.0',
      profileId: null,
      isDaemonInfoMessage: (msg) => (msg as { type?: string }).type === 'DaemonInfo',
      onSuccess: vi.fn(),
      timeoutMs: 25,
    })

    port.emitMessage({ type: 'Other', payload: {} })

    const rejected = expect(promise).resolves.toBe(false)
    await vi.advanceTimersByTimeAsync(25)
    await rejected
  })
})
