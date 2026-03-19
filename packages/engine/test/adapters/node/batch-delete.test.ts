import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ScopedNodeFileSystem } from '../../../src/adapters/node/scoped-node-filesystem'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

describe('ScopedNodeFileSystem.batchDelete', () => {
  let tmpDir: string
  let nodeFs: ScopedNodeFileSystem

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jstorrent-batchdelete-'))
    nodeFs = new ScopedNodeFileSystem(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true })
  })

  it('should delete multiple files in a directory', async () => {
    await fs.mkdir(path.join(tmpDir, 'torrent'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'torrent', 'a.txt'), 'hello')
    await fs.writeFile(path.join(tmpDir, 'torrent', 'b.txt'), 'world')

    const failed = await nodeFs.batchDelete('torrent', ['a.txt', 'b.txt'])
    expect(failed).toEqual([])
    expect(await nodeFs.exists('torrent/a.txt')).toBe(false)
    expect(await nodeFs.exists('torrent/b.txt')).toBe(false)
  })

  it('should silently ignore missing entries', async () => {
    await fs.mkdir(path.join(tmpDir, 'torrent'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'torrent', 'a.txt'), 'hello')

    const failed = await nodeFs.batchDelete('torrent', ['a.txt', 'nonexistent.txt'])
    expect(failed).toEqual([])
  })

  it('should delete empty subdirectories', async () => {
    await fs.mkdir(path.join(tmpDir, 'torrent', 'emptydir'), { recursive: true })

    const failed = await nodeFs.batchDelete('torrent', ['emptydir'])
    expect(failed).toEqual([])
    expect(await nodeFs.exists('torrent/emptydir')).toBe(false)
  })

  it('should fail on non-empty subdirectories', async () => {
    await fs.mkdir(path.join(tmpDir, 'torrent', 'subdir'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'torrent', 'subdir', 'file.txt'), 'data')

    const failed = await nodeFs.batchDelete('torrent', ['subdir'])
    expect(failed).toEqual(['subdir'])
    // Directory and contents should still exist
    expect(await nodeFs.exists('torrent/subdir/file.txt')).toBe(true)
  })

  it('should return empty array for empty entries list', async () => {
    const failed = await nodeFs.batchDelete('torrent', [])
    expect(failed).toEqual([])
  })

  it('should support bottom-up deletion pattern', async () => {
    // Create a torrent directory structure
    await fs.mkdir(path.join(tmpDir, 'Movie', 'extras'), { recursive: true })
    await fs.mkdir(path.join(tmpDir, 'Movie', 'subs'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'Movie', 'movie.mkv'), Buffer.alloc(100))
    await fs.writeFile(path.join(tmpDir, 'Movie', 'extras', 'behind.mkv'), Buffer.alloc(50))
    await fs.writeFile(path.join(tmpDir, 'Movie', 'extras', 'trailer.mkv'), Buffer.alloc(50))
    await fs.writeFile(path.join(tmpDir, 'Movie', 'subs', 'en.srt'), Buffer.alloc(10))

    // Level 2: delete files in deepest dirs
    expect(await nodeFs.batchDelete('Movie/extras', ['behind.mkv', 'trailer.mkv'])).toEqual([])
    expect(await nodeFs.batchDelete('Movie/subs', ['en.srt'])).toEqual([])

    // Level 1: delete files + now-empty subdirs
    expect(await nodeFs.batchDelete('Movie', ['movie.mkv', 'extras', 'subs'])).toEqual([])

    // Root dir should now be empty (but still exists)
    expect(await nodeFs.exists('Movie')).toBe(true)
    // Verify all content is gone
    expect(await nodeFs.exists('Movie/movie.mkv')).toBe(false)
    expect(await nodeFs.exists('Movie/extras')).toBe(false)
    expect(await nodeFs.exists('Movie/subs')).toBe(false)
  })

  it('should reject nested batch delete entries', async () => {
    await fs.mkdir(path.join(tmpDir, 'torrent'), { recursive: true })
    const failed = await nodeFs.batchDelete('torrent', ['../escape.txt', 'nested/file.txt'])
    expect(failed).toEqual(['../escape.txt', 'nested/file.txt'])
  })
})
