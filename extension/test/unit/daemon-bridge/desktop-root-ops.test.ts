import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  pickDownloadFolderDesktop,
  removeDownloadRootDesktop,
} from '../../../src/lib/daemon-bridge/desktop/root-ops'
import { createMockNativePort } from '../../helpers/mock-native-port'

describe('desktop root-ops', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('pickDownloadFolderDesktop returns root on RootAdded response', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('req-1')

    const port = createMockNativePort()
    const promise = pickDownloadFolderDesktop(port)

    expect(port.postMessage).toHaveBeenCalledWith({ op: 'pickDownloadDirectory', id: 'req-1' })

    port.emitMessage({
      id: 'req-1',
      ok: true,
      type: 'RootAdded',
      payload: {
        root: {
          key: 'downloads',
          path: '/Downloads',
          display_name: 'Downloads',
          removable: true,
          last_stat_ok: true,
          last_checked: 1,
        },
      },
    })

    await expect(promise).resolves.toEqual({
      key: 'downloads',
      path: '/Downloads',
      display_name: 'Downloads',
      removable: true,
      last_stat_ok: true,
      last_checked: 1,
    })
  })

  it('pickDownloadFolderDesktop returns null on non-matching response', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('req-2')

    const port = createMockNativePort()
    const promise = pickDownloadFolderDesktop(port)

    port.emitMessage({ id: 'req-2', ok: false, error: 'cancelled' })

    await expect(promise).resolves.toBeNull()
  })

  it('removeDownloadRootDesktop returns ok true on RootRemoved', async () => {
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('req-3')

    const port = createMockNativePort()
    const promise = removeDownloadRootDesktop(port, 'r1')

    expect(port.postMessage).toHaveBeenCalledWith({
      op: 'deleteDownloadRoot',
      key: 'r1',
      id: 'req-3',
    })

    port.emitMessage({ id: 'req-3', ok: true, type: 'RootRemoved', payload: { key: 'r1' } })

    await expect(promise).resolves.toEqual({
      ok: true,
      response: { id: 'req-3', ok: true, type: 'RootRemoved', payload: { key: 'r1' } },
    })
  })

  it('removeDownloadRootDesktop classifies timeout and not_connected failures', async () => {
    const timeoutResult = await removeDownloadRootDesktop(null, 'r1')
    expect(timeoutResult).toEqual({
      ok: false,
      reason: 'not_connected',
      response: { ok: false, error: 'Not connected' },
    })

    vi.useFakeTimers()
    vi.spyOn(crypto, 'randomUUID').mockReturnValue('req-4')

    const port = createMockNativePort()
    const promise = removeDownloadRootDesktop(port, 'r2')

    await vi.advanceTimersByTimeAsync(10000)

    await expect(promise).resolves.toEqual({
      ok: false,
      reason: 'timeout',
      response: { ok: false, error: 'Request timed out' },
    })
  })
})
