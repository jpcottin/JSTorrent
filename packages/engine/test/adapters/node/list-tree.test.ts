import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ScopedNodeFileSystem } from '../../../src/adapters/node/scoped-node-filesystem'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

describe('ScopedNodeFileSystem.listTree', () => {
  let tmpDir: string
  let nodeFs: ScopedNodeFileSystem

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jstorrent-listtree-'))
    nodeFs = new ScopedNodeFileSystem(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true })
  })

  it('should list nested files with correct sizes', async () => {
    await fs.mkdir(path.join(tmpDir, 'torrent', 'subdir'), { recursive: true })
    await fs.writeFile(path.join(tmpDir, 'torrent', 'a.txt'), 'hello') // 5 bytes
    await fs.writeFile(path.join(tmpDir, 'torrent', 'subdir', 'b.bin'), Buffer.alloc(1024))

    const result = await nodeFs.listTree('torrent')
    expect(result).toEqual(
      expect.arrayContaining([
        { path: 'a.txt', size: 5 },
        { path: 'subdir/b.bin', size: 1024 },
      ]),
    )
    expect(result).toHaveLength(2)
  })

  it('should return empty array for nonexistent path', async () => {
    const result = await nodeFs.listTree('does-not-exist')
    expect(result).toEqual([])
  })
})
