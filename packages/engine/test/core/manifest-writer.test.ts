import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import {
  buildManifestJson,
  ManifestWriter,
  type ManifestJson,
} from '../../src/core/manifest-writer'
import { InMemoryFileSystem } from '../../src/adapters/memory/memory-filesystem'
import type { BtEngine } from '../../src/core/bt-engine'
import type { Torrent } from '../../src/core/torrent'
import type { TorrentContentStorage } from '../../src/core/torrent-content-storage'
import type { IStorageHandle } from '../../src/io/storage-handle'
import type { InfoHashHex } from '../../src/utils/infohash'

function makeTorrent(opts: {
  infoHash: string
  name: string
  files: Array<{ path: string; length: number; offset: number }>
  hasMetadata?: boolean
  fileCompleteMap?: Record<number, boolean>
  announce?: string[]
  fs?: InMemoryFileSystem
}): Torrent {
  const memFs = opts.fs ?? new InMemoryFileSystem()
  const storage: IStorageHandle = {
    id: 'test-root',
    name: 'Test',
    getFileSystem: () => memFs,
  }
  const contentStorage = {
    storage,
    filesList: opts.files,
  } as unknown as TorrentContentStorage

  return {
    infoHashStr: opts.infoHash as InfoHashHex,
    infoHash: new Uint8Array(20),
    name: opts.name,
    hasMetadata: opts.hasMetadata ?? true,
    contentStorage,
    announce: opts.announce ?? ['udp://tracker.example.com:6969'],
    isFileComplete: (i: number) => opts.fileCompleteMap?.[i] ?? false,
  } as unknown as Torrent
}

describe('buildManifestJson', () => {
  it('should build JSON for a multi-file torrent', () => {
    const torrent = makeTorrent({
      infoHash: 'a'.repeat(40),
      name: 'Test Torrent',
      files: [
        { path: 'Test Torrent/Season 1/ep01.mkv', length: 1000, offset: 0 },
        { path: 'Test Torrent/Season 1/ep02.mkv', length: 2000, offset: 1000 },
      ],
      fileCompleteMap: { 0: true, 1: false },
    })

    const json = buildManifestJson(torrent)!
    expect(json).not.toBeNull()
    expect(json.infohash).toBe('a'.repeat(40))
    expect(json.magnet).toContain('btih')
    expect(json.files['Season 1/ep01.mkv']).toEqual({ index: 0, complete: true })
    expect(json.files['Season 1/ep02.mkv']).toEqual({ index: 1, complete: false })
  })

  it('should build JSON for a single-file torrent', () => {
    const torrent = makeTorrent({
      infoHash: 'b'.repeat(40),
      name: 'Movie.mkv',
      files: [{ path: 'Movie.mkv', length: 5000, offset: 0 }],
      fileCompleteMap: { 0: true },
    })

    const json = buildManifestJson(torrent)!
    expect(json.files['Movie.mkv']).toEqual({ index: 0, complete: true })
  })

  it('should return null if no metadata', () => {
    const torrent = makeTorrent({
      infoHash: 'c'.repeat(40),
      name: 'Unknown',
      files: [],
      hasMetadata: false,
    })

    expect(buildManifestJson(torrent)).toBeNull()
  })

  it('should return null if no files', () => {
    const torrent = makeTorrent({
      infoHash: 'd'.repeat(40),
      name: 'Empty',
      files: [],
    })

    expect(buildManifestJson(torrent)).toBeNull()
  })

  it('should include tracker announce URLs in magnet', () => {
    const torrent = makeTorrent({
      infoHash: 'e'.repeat(40),
      name: 'Tracked',
      files: [{ path: 'file.txt', length: 100, offset: 0 }],
      announce: ['udp://tracker1.example.com:6969', 'http://tracker2.example.com/announce'],
    })

    const json = buildManifestJson(torrent)!
    expect(json.magnet).toContain('tracker1')
    expect(json.magnet).toContain('tracker2')
  })
})

describe('ManifestWriter', () => {
  let memFs: InMemoryFileSystem
  let writer: ManifestWriter
  let engine: BtEngine

  beforeEach(() => {
    vi.useFakeTimers()
    memFs = new InMemoryFileSystem()
    engine = { torrents: [] } as unknown as BtEngine
    writer = new ManifestWriter(engine)
  })

  afterEach(() => {
    writer.dispose()
    vi.useRealTimers()
  })

  function addTorrent(opts: {
    infoHash: string
    name: string
    files: Array<{ path: string; length: number; offset: number }>
    fileCompleteMap?: Record<number, boolean>
  }): Torrent {
    const torrent = makeTorrent({ ...opts, fs: memFs })
    ;(engine.torrents as Torrent[]).push(torrent)
    return torrent
  }

  it('should write manifest immediately with writeNow', async () => {
    const torrent = addTorrent({
      infoHash: 'a'.repeat(40),
      name: 'Multi',
      files: [
        { path: 'Multi/file1.mkv', length: 1000, offset: 0 },
        { path: 'Multi/file2.mkv', length: 2000, offset: 1000 },
      ],
    })

    await writer.writeNow(torrent)

    const manifestPath = `Multi/.${'a'.repeat(40)}.jstorrent.json`
    expect(memFs.files.has(manifestPath)).toBe(true)

    const content = JSON.parse(
      new TextDecoder().decode(memFs.files.get(manifestPath)!),
    ) as ManifestJson
    expect(content.infohash).toBe('a'.repeat(40))
    expect(content.files['file1.mkv']).toEqual({ index: 0, complete: false })
    expect(content.files['file2.mkv']).toEqual({ index: 1, complete: false })
  })

  it('should write single-file manifest in root', async () => {
    const torrent = addTorrent({
      infoHash: 'b'.repeat(40),
      name: 'Movie.mkv',
      files: [{ path: 'Movie.mkv', length: 5000, offset: 0 }],
      fileCompleteMap: { 0: true },
    })

    await writer.writeNow(torrent)

    const manifestPath = `.${'b'.repeat(40)}.jstorrent.json`
    expect(memFs.files.has(manifestPath)).toBe(true)
  })

  it('should debounce writes with scheduleSave', async () => {
    const torrent = addTorrent({
      infoHash: 'c'.repeat(40),
      name: 'Debounced',
      files: [{ path: 'Debounced/file.mkv', length: 1000, offset: 0 }],
    })

    writer.scheduleSave(torrent)
    writer.scheduleSave(torrent)
    writer.scheduleSave(torrent)

    // Not written yet
    const manifestPath = `Debounced/.${'c'.repeat(40)}.jstorrent.json`
    expect(memFs.files.has(manifestPath)).toBe(false)

    // Advance timer past debounce interval
    await vi.advanceTimersByTimeAsync(1100)

    expect(memFs.files.has(manifestPath)).toBe(true)
  })

  it('should flush pending saves on shutdown', async () => {
    const torrent = addTorrent({
      infoHash: 'd'.repeat(40),
      name: 'Flushed',
      files: [{ path: 'Flushed/file.mkv', length: 1000, offset: 0 }],
    })

    writer.scheduleSave(torrent)

    // Flush without waiting for timer
    await writer.flushPendingSaves()

    const manifestPath = `Flushed/.${'d'.repeat(40)}.jstorrent.json`
    expect(memFs.files.has(manifestPath)).toBe(true)
  })

  it('should delete manifest on torrent remove', async () => {
    await memFs.mkdir('Removed')
    const torrent = addTorrent({
      infoHash: 'e'.repeat(40),
      name: 'Removed',
      files: [{ path: 'Removed/file.mkv', length: 1000, offset: 0 }],
    })

    // Write first
    await writer.writeNow(torrent)
    const manifestPath = `Removed/.${'e'.repeat(40)}.jstorrent.json`
    expect(memFs.files.has(manifestPath)).toBe(true)

    // Delete
    await writer.deleteManifest(torrent)
    expect(memFs.files.has(manifestPath)).toBe(false)
  })

  it('should handle delete when no manifest exists', async () => {
    const torrent = addTorrent({
      infoHash: 'f'.repeat(40),
      name: 'NeverWritten',
      files: [{ path: 'NeverWritten/file.mkv', length: 1000, offset: 0 }],
    })

    // Should not throw
    await writer.deleteManifest(torrent)
  })

  it('should coalesce multiple torrents in debounce window', async () => {
    const torrent1 = addTorrent({
      infoHash: 'a'.repeat(40),
      name: 'T1',
      files: [{ path: 'T1/file.mkv', length: 1000, offset: 0 }],
    })
    const torrent2 = addTorrent({
      infoHash: 'b'.repeat(40),
      name: 'T2',
      files: [{ path: 'T2/file.mkv', length: 1000, offset: 0 }],
    })

    writer.scheduleSave(torrent1)
    writer.scheduleSave(torrent2)

    await vi.advanceTimersByTimeAsync(1100)

    expect(memFs.files.has(`T1/.${'a'.repeat(40)}.jstorrent.json`)).toBe(true)
    expect(memFs.files.has(`T2/.${'b'.repeat(40)}.jstorrent.json`)).toBe(true)
  })
})
