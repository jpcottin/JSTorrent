import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupController } from '../../../src/adapters/native/controller'
import type { BtEngine } from '../../../src/core/bt-engine'
import type { Torrent } from '../../../src/core/torrent'

vi.stubGlobal('__jstorrent_on_error', vi.fn())

describe('native controller set_file_priorities', () => {
  const infoHash = 'a'.repeat(40)

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('__jstorrent_on_error', vi.fn())
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__jstorrent_cmd_set_file_priorities
  })

  it('returns a promise that resolves after torrent.setFilePrioritiesAsync completes', async () => {
    let resolveApply: ((value: number) => void) | undefined
    const applyPromise = new Promise<number>((resolve) => {
      resolveApply = resolve
    })
    const setFilePrioritiesAsync = vi.fn(() => applyPromise)

    const torrent = {
      setFilePrioritiesAsync,
    } as unknown as Torrent
    const engine = {
      getTorrent: vi.fn((hash: string) => (hash === infoHash ? torrent : undefined)),
    } as unknown as BtEngine

    setupController(
      () => engine,
      () => true,
    )

    const command = (globalThis as Record<string, unknown>).__jstorrent_cmd_set_file_priorities as (
      hash: string,
      prioritiesJson: string,
    ) => Promise<{ ok: boolean; applied?: number }>

    const resultPromise = command(infoHash, JSON.stringify({ '7': 0 }))
    expect(setFilePrioritiesAsync).toHaveBeenCalledWith(new Map([[7, 0]]))

    let settled = false
    void resultPromise.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)

    resolveApply?.(1)
    await expect(resultPromise).resolves.toEqual({ ok: true, applied: 1 })
  })
})
