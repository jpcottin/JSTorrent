import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  sendNativeRequest,
  sendNativeRequestFull,
} from '../../../src/lib/daemon-bridge/desktop/native-requests'
import { createMockNativePort } from '../../helpers/mock-native-port'

describe('desktop native-requests', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('returns Not connected when native port is missing', async () => {
    await expect(sendNativeRequest(null, 'op', {})).resolves.toEqual({
      ok: false,
      error: 'Not connected',
    })
  })

  it('sends request and resolves full response on matching id', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('r-e-q-0-1')

    const port = createMockNativePort()
    const promise = sendNativeRequestFull(port, 'handshake', { profileId: 'p1' })

    expect(port.postMessage).toHaveBeenCalledWith({
      op: 'handshake',
      profileId: 'p1',
      id: 'r-e-q-0-1',
    })

    port.emitMessage({ id: 'other', ok: true })
    port.emitMessage({ id: 'r-e-q-0-1', ok: true, type: 'DaemonInfo', payload: { port: 7800 } })

    await expect(promise).resolves.toEqual({
      id: 'r-e-q-0-1',
      ok: true,
      type: 'DaemonInfo',
      payload: { port: 7800 },
    })
  })

  it('returns simplified response shape for sendNativeRequest', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('r-e-q-0-2')

    const port = createMockNativePort()
    const promise = sendNativeRequest(port, 'installUpdate', {})

    port.emitMessage({ id: 'r-e-q-0-2', ok: false, error: 'Update failed', extra: 123 })

    await expect(promise).resolves.toEqual({ ok: false, error: 'Update failed' })
  })

  it('times out unresolved requests', async () => {
    vi.useFakeTimers()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('r-e-q-0-3')

    const port = createMockNativePort()
    const promise = sendNativeRequestFull(port, 'listProfiles', {}, 25)

    await vi.advanceTimersByTimeAsync(25)

    await expect(promise).resolves.toEqual({ ok: false, error: 'Request timed out' })
  })
})
