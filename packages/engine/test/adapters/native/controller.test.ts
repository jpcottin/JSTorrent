import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupController } from '../../../src/adapters/native/controller'
import type { BtEngine } from '../../../src/core/bt-engine'
import type { Torrent } from '../../../src/core/torrent'
import type { StorageRootManager } from '../../../src/storage/storage-root-manager'

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

describe('native controller add_torrent options', () => {
  const infoHash = 'a'.repeat(40)
  const magnet = `magnet:?xt=urn:btih:${infoHash}`

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('__jstorrent_on_error', vi.fn())
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__jstorrent_cmd_add_torrent
  })

  function createEngine(addTorrent: BtEngine['addTorrent']) {
    const engine = {
      addTorrent,
    } as unknown as BtEngine

    setupController(
      () => engine,
      () => true,
    )

    return (globalThis as Record<string, unknown>).__jstorrent_cmd_add_torrent as (
      magnetOrBase64: string,
      optionsJson?: string,
    ) => Promise<{ ok: boolean; infoHash?: string; isDuplicate?: boolean }>
  }

  it('passes userState option to engine.addTorrent', async () => {
    const mockTorrent = {
      name: 'test',
      infoHash: new Uint8Array(20),
    } as unknown as Torrent
    const addTorrent = vi.fn(async () => ({ torrent: mockTorrent, isDuplicate: false }))
    const command = createEngine(addTorrent as unknown as BtEngine['addTorrent'])

    await command(magnet, JSON.stringify({ userState: 'awaitingFileSelection' }))

    expect(addTorrent).toHaveBeenCalledWith(magnet, { userState: 'awaitingFileSelection' })
  })

  it('passes empty options when no optionsJson provided', async () => {
    const mockTorrent = {
      name: 'test',
      infoHash: new Uint8Array(20),
    } as unknown as Torrent
    const addTorrent = vi.fn(async () => ({ torrent: mockTorrent, isDuplicate: false }))
    const command = createEngine(addTorrent as unknown as BtEngine['addTorrent'])

    await command(magnet)

    expect(addTorrent).toHaveBeenCalledWith(magnet, {})
  })
})

describe('native controller set_torrent_root', () => {
  const infoHash = 'a'.repeat(40)
  const rootKey = 'root-abc'

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.stubGlobal('__jstorrent_on_error', vi.fn())
  })

  afterEach(() => {
    delete (globalThis as Record<string, unknown>).__jstorrent_cmd_set_torrent_root
  })

  function createEngine(setRootForTorrent: StorageRootManager['setRootForTorrent']) {
    const engine = {
      storageRootManager: { setRootForTorrent },
    } as unknown as BtEngine

    setupController(
      () => engine,
      () => true,
    )

    return (globalThis as Record<string, unknown>).__jstorrent_cmd_set_torrent_root as (
      hash: string,
      key: string,
    ) => string
  }

  it('calls storageRootManager.setRootForTorrent and returns ok', () => {
    const setRootForTorrent = vi.fn(() => true)
    const command = createEngine(setRootForTorrent)

    const result = JSON.parse(command(infoHash, rootKey))

    expect(setRootForTorrent).toHaveBeenCalledWith(infoHash, rootKey)
    expect(result).toEqual({ ok: true })
  })

  it('returns ok: false when root key does not exist', () => {
    const setRootForTorrent = vi.fn(() => false)
    const command = createEngine(setRootForTorrent)

    const result = JSON.parse(command(infoHash, rootKey))

    expect(setRootForTorrent).toHaveBeenCalledWith(infoHash, rootKey)
    expect(result).toEqual({ ok: false })
  })
})
