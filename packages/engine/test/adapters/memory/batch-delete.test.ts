import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryFileSystem } from '../../../src/adapters/memory/memory-filesystem'

describe('InMemoryFileSystem.batchDelete', () => {
  let fs: InMemoryFileSystem

  beforeEach(() => {
    fs = new InMemoryFileSystem()
  })

  it('should delete multiple files in a directory', async () => {
    await fs.mkdir('torrent')
    await fs.open('torrent/a.txt', 'w')
    await fs.open('torrent/b.txt', 'w')
    await fs.open('torrent/c.txt', 'w')

    const failed = await fs.batchDelete('torrent', ['a.txt', 'b.txt', 'c.txt'])
    expect(failed).toEqual([])
    expect(await fs.exists('torrent/a.txt')).toBe(false)
    expect(await fs.exists('torrent/b.txt')).toBe(false)
    expect(await fs.exists('torrent/c.txt')).toBe(false)
  })

  it('should silently ignore missing entries', async () => {
    await fs.mkdir('torrent')
    await fs.open('torrent/a.txt', 'w')

    const failed = await fs.batchDelete('torrent', ['a.txt', 'nonexistent.txt'])
    expect(failed).toEqual([])
    expect(await fs.exists('torrent/a.txt')).toBe(false)
  })

  it('should return empty array for empty entries list', async () => {
    const failed = await fs.batchDelete('torrent', [])
    expect(failed).toEqual([])
  })

  it('should fail on non-empty subdirectories', async () => {
    await fs.mkdir('torrent')
    await fs.mkdir('torrent/subdir')
    await fs.open('torrent/subdir/file.txt', 'w')

    // Trying to delete subdir while it still has files should fail
    const failed = await fs.batchDelete('torrent', ['subdir'])
    expect(failed).toEqual(['subdir'])
    // File should still exist
    expect(await fs.exists('torrent/subdir/file.txt')).toBe(true)
  })

  it('should work with empty directory prefix', async () => {
    await fs.open('file1.txt', 'w')
    await fs.open('file2.txt', 'w')

    const failed = await fs.batchDelete('', ['file1.txt', 'file2.txt'])
    expect(failed).toEqual([])
    expect(await fs.exists('file1.txt')).toBe(false)
    expect(await fs.exists('file2.txt')).toBe(false)
  })

  it('should support bottom-up deletion pattern', async () => {
    // Simulate engine's bottom-up tree walk
    await fs.mkdir('Movie')
    await fs.mkdir('Movie/extras')
    await fs.mkdir('Movie/subs')
    await fs.open('Movie/extras/behind.mkv', 'w')
    await fs.open('Movie/extras/trailer.mkv', 'w')
    await fs.open('Movie/subs/en.srt', 'w')
    await fs.open('Movie/movie.mkv', 'w')

    // Level 2: delete files in deepest dirs
    expect(await fs.batchDelete('Movie/extras', ['behind.mkv', 'trailer.mkv'])).toEqual([])
    expect(await fs.batchDelete('Movie/subs', ['en.srt'])).toEqual([])

    // Level 1: delete files + now-empty subdirs
    expect(await fs.batchDelete('Movie', ['movie.mkv', 'extras', 'subs'])).toEqual([])
  })
})
