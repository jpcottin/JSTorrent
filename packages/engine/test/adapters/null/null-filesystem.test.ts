import { beforeEach, describe, expect, it } from 'vitest'
import { NullFileSystem } from '../../../src/adapters/null/null-filesystem'
import { VerifyChunkResult } from '../../../src/interfaces/filesystem'

describe('NullFileSystem', () => {
  let fs: NullFileSystem

  beforeEach(() => {
    fs = new NullFileSystem()
  })

  it('tracks file existence only after writes', async () => {
    expect(await fs.exists('file.bin')).toBe(false)
    await expect(fs.stat('file.bin')).rejects.toThrow(/ENOENT/)

    const handle = await fs.open('file.bin', 'w')
    await handle.write(new Uint8Array([1, 2, 3]), 0, 3, 0)
    await handle.close()

    expect(await fs.exists('file.bin')).toBe(true)
    await expect(fs.stat('file.bin')).resolves.toMatchObject({ size: 3 })
  })

  it('lists written files under their directory', async () => {
    const handle = await fs.open('root/sub/file.bin', 'w')
    await handle.write(new Uint8Array([1, 2, 3, 4]), 0, 4, 0)
    await handle.close()

    await expect(fs.readdir('root')).resolves.toEqual(['sub'])
    await expect(fs.listTree('root')).resolves.toEqual([{ path: 'sub/file.bin', size: 4 }])
  })

  it('reports IO_ERROR for missing chunks and MISMATCH for present chunks', async () => {
    const present = await fs.open('present.bin', 'w')
    await present.write(new Uint8Array([1, 2, 3, 4]), 0, 4, 0)
    await present.close()

    const results = await fs.verifyChunks({
      files: [
        { path: 'present.bin', length: 4 },
        { path: 'missing.bin', length: 4 },
      ],
      chunkSize: 4,
      hashes: new Uint8Array(40),
    })

    expect(results).toEqual(
      new Uint8Array([VerifyChunkResult.MISMATCH, VerifyChunkResult.IO_ERROR]),
    )
  })
})
