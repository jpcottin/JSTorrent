import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ScopedNodeFileSystem } from '../../../src/adapters/node/scoped-node-filesystem'
import fs from 'fs/promises'
import path from 'path'
import os from 'os'

describe('ScopedNodeFileSystem.writeAtomic', () => {
  let tmpDir: string
  let nodeFs: ScopedNodeFileSystem

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jstorrent-writeatomic-'))
    nodeFs = new ScopedNodeFileSystem(tmpDir)
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true })
  })

  it('should create a new file', async () => {
    const data = new TextEncoder().encode('hello world')
    await nodeFs.writeAtomic('test.json', data)

    const content = await fs.readFile(path.join(tmpDir, 'test.json'), 'utf-8')
    expect(content).toBe('hello world')
  })

  it('should overwrite an existing file', async () => {
    await fs.writeFile(path.join(tmpDir, 'test.json'), 'old content')
    const data = new TextEncoder().encode('new content')
    await nodeFs.writeAtomic('test.json', data)

    const content = await fs.readFile(path.join(tmpDir, 'test.json'), 'utf-8')
    expect(content).toBe('new content')
  })

  it('should create parent directories', async () => {
    const data = new TextEncoder().encode('nested')
    await nodeFs.writeAtomic('sub/dir/test.json', data)

    const content = await fs.readFile(path.join(tmpDir, 'sub', 'dir', 'test.json'), 'utf-8')
    expect(content).toBe('nested')
  })

  it('should not leave temp files on success', async () => {
    const data = new TextEncoder().encode('clean')
    await nodeFs.writeAtomic('test.json', data)

    const entries = await fs.readdir(tmpDir)
    expect(entries).toEqual(['test.json'])
  })

  it('should handle dot-prefixed filenames', async () => {
    const data = new TextEncoder().encode('{"infohash":"abc"}')
    await nodeFs.writeAtomic('.abc123.jstorrent.json', data)

    const content = await fs.readFile(path.join(tmpDir, '.abc123.jstorrent.json'), 'utf-8')
    expect(content).toBe('{"infohash":"abc"}')
  })

  it('should handle empty data', async () => {
    await nodeFs.writeAtomic('empty.json', new Uint8Array(0))

    const stat = await fs.stat(path.join(tmpDir, 'empty.json'))
    expect(stat.size).toBe(0)
  })

  it('should reject path traversal outside the root', async () => {
    await expect(nodeFs.writeAtomic('../escape.txt', new TextEncoder().encode('nope'))).rejects.toThrow(
      /Invalid root-relative path|Path escapes root/,
    )
  })

  it('should reject writes through a symlink that escapes the root', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jstorrent-writeatomic-outside-'))
    try {
      await fs.symlink(outsideDir, path.join(tmpDir, 'escaped'))
      await expect(
        nodeFs.writeAtomic('escaped/secret.txt', new TextEncoder().encode('blocked')),
      ).rejects.toThrow(/Path escapes root/)
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })
})
