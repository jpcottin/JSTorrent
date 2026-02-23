import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  checkDaemonHealth,
  restartHealthCheck,
} from '../../../src/lib/daemon-bridge/shared/health-check'

function responseOf(ok: boolean): Response {
  return {
    ok,
    status: ok ? 200 : 500,
  } as Response
}

describe('health-check helper', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('checkDaemonHealth returns true for ok response and false otherwise', async () => {
    const fetchOk = vi.fn(async () => responseOf(true))
    await expect(checkDaemonHealth({ fetchImpl: fetchOk, host: 'h', port: 1 })).resolves.toBe(true)

    const fetchBad = vi.fn(async () => responseOf(false))
    await expect(checkDaemonHealth({ fetchImpl: fetchBad, host: 'h', port: 1 })).resolves.toBe(false)

    const fetchErr = vi.fn(async () => {
      throw new Error('network')
    })
    await expect(checkDaemonHealth({ fetchImpl: fetchErr, host: 'h', port: 1 })).resolves.toBe(false)
  })

  it('restartHealthCheck clears prior interval and triggers onUnhealthy', async () => {
    vi.useFakeTimers()

    const onUnhealthy = vi.fn()
    const fetchImpl = vi.fn(async () => responseOf(false))

    const oldInterval = setInterval(() => undefined, 9999)
    const clearSpy = vi.spyOn(globalThis, 'clearInterval')

    const newInterval = restartHealthCheck({
      existingInterval: oldInterval,
      fetchImpl,
      host: '127.0.0.1',
      port: 7800,
      onUnhealthy,
      intervalMs: 50,
    })

    expect(clearSpy).toHaveBeenCalledWith(oldInterval)

    await vi.advanceTimersByTimeAsync(50)
    await Promise.resolve()

    expect(fetchImpl).toHaveBeenCalledWith('http://127.0.0.1:7800/health')
    expect(onUnhealthy).toHaveBeenCalledTimes(1)

    clearInterval(newInterval)
  })
})
