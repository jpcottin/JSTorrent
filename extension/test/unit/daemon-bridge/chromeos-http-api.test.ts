import { describe, expect, it, vi } from 'vitest'
import {
  fetchChromeosStatus,
  findChromeosDaemonPort,
  requestChromeosPairing,
  type ChromeStorageLike,
} from '../../../src/lib/daemon-bridge/chromeos/http-api'

function responseOf(status: number, jsonBody: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
  } as Response
}

describe('chromeos http-api', () => {
  it('fetchChromeosStatus posts with headers and returns parsed status', async () => {
    const fetchImpl = vi.fn(async () => responseOf(200, { paired: true, port: 7800 }))

    const status = await fetchChromeosStatus({
      fetchImpl,
      host: '100.115.92.2',
      port: 7800,
      headers: { 'X-Test': '1' },
    })

    expect(fetchImpl).toHaveBeenCalledWith('http://100.115.92.2:7800/status', {
      method: 'POST',
      headers: { 'X-Test': '1' },
    })
    expect(status).toEqual({ paired: true, port: 7800 })
  })

  it('fetchChromeosStatus throws on non-ok response', async () => {
    const fetchImpl = vi.fn(async () => responseOf(503, {}))

    await expect(
      fetchChromeosStatus({
        fetchImpl,
        host: '100.115.92.2',
        port: 7800,
        headers: {},
      }),
    ).rejects.toThrow('Status failed: 503')
  })

  it('requestChromeosPairing handles approved, conflict, and pending/network failure', async () => {
    const fetchApproved = vi.fn(async () => responseOf(200, { status: 'approved' }))
    await expect(
      requestChromeosPairing({
        fetchImpl: fetchApproved,
        host: 'h',
        port: 1,
        headers: { A: 'B' },
        token: 'tok',
      }),
    ).resolves.toBe('approved')

    const fetchConflict = vi.fn(async () => responseOf(409, { status: 'conflict' }))
    await expect(
      requestChromeosPairing({
        fetchImpl: fetchConflict,
        host: 'h',
        port: 1,
        headers: {},
        token: 'tok',
      }),
    ).resolves.toBe('conflict')

    const fetchPending = vi.fn(async () => responseOf(500, {}))
    await expect(
      requestChromeosPairing({
        fetchImpl: fetchPending,
        host: 'h',
        port: 1,
        headers: {},
        token: 'tok',
      }),
    ).resolves.toBe('pending')

    const fetchError = vi.fn(async () => {
      throw new Error('network')
    })
    await expect(
      requestChromeosPairing({
        fetchImpl: fetchError,
        host: 'h',
        port: 1,
        headers: {},
        token: 'tok',
      }),
    ).resolves.toBe('pending')
  })

  it('findChromeosDaemonPort tries stored host first and persists successful host/port', async () => {
    const storage: ChromeStorageLike = {
      get: vi.fn(async () => ({
        'android:daemonPort': 7814,
        'android:daemonHost': 'penguin.linux.test',
      })),
      set: vi.fn(async () => undefined),
    }

    const seenUrls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      seenUrls.push(url)
      if (url === 'http://penguin.linux.test:7814/health') {
        return responseOf(200, {})
      }
      return responseOf(404, {})
    })

    const found = await findChromeosDaemonPort({
      storage,
      fetchImpl,
      storageKeyPort: 'android:daemonPort',
      storageKeyHost: 'android:daemonHost',
      hosts: ['100.115.92.2', 'penguin.linux.test'],
      fallbackPorts: [7800, 7805],
      timeoutMs: 10,
    })

    expect(found).toEqual({ host: 'penguin.linux.test', port: 7814 })
    expect(seenUrls[0]).toBe('http://penguin.linux.test:7814/health')
    expect(storage.set).toHaveBeenCalledWith({
      'android:daemonPort': 7814,
      'android:daemonHost': 'penguin.linux.test',
    })
  })
})
