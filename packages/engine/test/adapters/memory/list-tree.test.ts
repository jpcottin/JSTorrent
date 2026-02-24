import { describe, it, expect, beforeEach } from 'vitest'
import { InMemoryFileSystem } from '../../../src/adapters/memory/memory-filesystem'

describe('InMemoryFileSystem.listTree', () => {
  let fs: InMemoryFileSystem

  beforeEach(() => {
    fs = new InMemoryFileSystem()
  })

  it('should return empty array for nonexistent path', async () => {
    const result = await fs.listTree('nonexistent')
    expect(result).toEqual([])
  })

  it('should list files with sizes', async () => {
    await fs.mkdir('root')
    const h1 = await fs.open('root/file1.txt', 'w')
    await h1.write(new Uint8Array(100), 0, 100, 0)
    await h1.close()
    const h2 = await fs.open('root/file2.txt', 'w')
    await h2.write(new Uint8Array(200), 0, 200, 0)
    await h2.close()

    const result = await fs.listTree('root')
    expect(result).toEqual(
      expect.arrayContaining([
        { path: 'file1.txt', size: 100 },
        { path: 'file2.txt', size: 200 },
      ]),
    )
    expect(result).toHaveLength(2)
  })

  it('should recurse into subdirectories', async () => {
    await fs.mkdir('root')
    await fs.mkdir('root/sub')
    await fs.mkdir('root/sub/deep')
    const h = await fs.open('root/sub/deep/file.bin', 'w')
    await h.write(new Uint8Array(50), 0, 50, 0)
    await h.close()

    const result = await fs.listTree('root')
    expect(result).toEqual([{ path: 'sub/deep/file.bin', size: 50 }])
  })

  it('should return empty array for empty directory', async () => {
    await fs.mkdir('root')
    await fs.mkdir('root/empty')
    const result = await fs.listTree('root/empty')
    expect(result).toEqual([])
  })
})
