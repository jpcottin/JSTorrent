import { describe, expect, it, vi } from 'vitest'
import {
  ensureChromeosPairedAndConnect,
  type PairingStatus,
} from '../../../src/lib/daemon-bridge/chromeos/pairing'

function status(overrides: Partial<PairingStatus> = {}): PairingStatus {
  return {
    paired: false,
    extensionId: null,
    installId: null,
    version: '1.0.0',
    ...overrides,
  }
}

describe('chromeos pairing flow', () => {
  it('completes immediately when already paired for current client', async () => {
    const fetchStatus = vi.fn(async () =>
      status({ paired: true, extensionId: 'ext-1', installId: 'ins-1', ioPort: 7801 }),
    )
    const requestPairing = vi.fn(async () => 'pending' as const)
    const completeConnection = vi.fn(async () => undefined)

    const result = await ensureChromeosPairedAndConnect({
      host: 'h',
      port: 1,
      extensionId: 'ext-1',
      installId: 'ins-1',
      fetchStatus,
      requestPairing,
      completeConnection,
      wait: async () => undefined,
    })

    expect(result).toBe('connected')
    expect(requestPairing).not.toHaveBeenCalled()
    expect(completeConnection).toHaveBeenCalledTimes(1)
  })

  it('handles approved pairing by refetching status and completing', async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(
        status({ paired: true, extensionId: 'ext', installId: 'ins', version: '2.0', ioPort: 9 }),
      )
    const requestPairing = vi.fn(async () => 'approved' as const)
    const completeConnection = vi.fn(async () => undefined)

    const result = await ensureChromeosPairedAndConnect({
      host: 'h',
      port: 1,
      extensionId: 'ext',
      installId: 'ins',
      fetchStatus,
      requestPairing,
      completeConnection,
      wait: async () => undefined,
    })

    expect(result).toBe('connected')
    expect(fetchStatus).toHaveBeenCalledTimes(2)
    expect(completeConnection).toHaveBeenCalledTimes(1)
  })

  it('retries on conflict, then succeeds', async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockResolvedValueOnce(
        status({ paired: true, extensionId: 'ext', installId: 'ins', version: '2.1', ioPort: 8 }),
      )
    const requestPairing = vi
      .fn()
      .mockResolvedValueOnce('conflict' as const)
      .mockResolvedValueOnce('pending' as const)
    const completeConnection = vi.fn(async () => undefined)
    const wait = vi.fn(async () => undefined)

    const result = await ensureChromeosPairedAndConnect({
      host: 'h',
      port: 1,
      extensionId: 'ext',
      installId: 'ins',
      fetchStatus,
      requestPairing,
      completeConnection,
      wait,
      maxPollAttempts: 1,
    })

    expect(result).toBe('connected')
    expect(wait).toHaveBeenCalledWith(2000)
    expect(completeConnection).toHaveBeenCalledTimes(1)
  })

  it('polls pending state and returns timeout if never paired', async () => {
    const fetchStatus = vi.fn(async () => status())
    const requestPairing = vi.fn(async () => 'pending' as const)
    const completeConnection = vi.fn(async () => undefined)
    const wait = vi.fn(async () => undefined)

    const result = await ensureChromeosPairedAndConnect({
      host: 'h',
      port: 1,
      extensionId: 'ext',
      installId: 'ins',
      fetchStatus,
      requestPairing,
      completeConnection,
      wait,
      maxPollAttempts: 3,
      pollIntervalMs: 50,
    })

    expect(result).toBe('timeout')
    expect(wait).toHaveBeenCalledTimes(3)
    expect(completeConnection).not.toHaveBeenCalled()
  })

  it('continues polling across fetch errors and succeeds when status eventually matches', async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(status())
      .mockRejectedValueOnce(new Error('temp'))
      .mockResolvedValueOnce(
        status({ paired: true, extensionId: 'ext', installId: 'ins', ioPort: 7 }),
      )
    const requestPairing = vi.fn(async () => 'pending' as const)
    const completeConnection = vi.fn(async () => undefined)

    const result = await ensureChromeosPairedAndConnect({
      host: 'h',
      port: 1,
      extensionId: 'ext',
      installId: 'ins',
      fetchStatus,
      requestPairing,
      completeConnection,
      wait: async () => undefined,
      maxPollAttempts: 3,
    })

    expect(result).toBe('connected')
    expect(completeConnection).toHaveBeenCalledTimes(1)
  })
})
