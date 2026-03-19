import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { NodeIoDaemonRootFileSystem } from '../../src/node-io-daemon/root-filesystem'

describe('NodeIoDaemonRootFileSystem', () => {
  let tmpDir: string
  let rootFs: NodeIoDaemonRootFileSystem

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jstorrent-node-io-root-'))
    rootFs = new NodeIoDaemonRootFileSystem(pathToFileURL(tmpDir).toString())
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('rejects lexical traversal outside the root', async () => {
    await expect(
      rootFs.write('../escape.txt', 0, new TextEncoder().encode('blocked')),
    ).rejects.toThrow(/Invalid root-relative path/)
  })

  it('rejects symlink traversal outside the root', async () => {
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'jstorrent-node-io-outside-'))
    try {
      await fs.symlink(outsideDir, path.join(tmpDir, 'escaped'))
      await expect(
        rootFs.write('escaped/secret.txt', 0, new TextEncoder().encode('blocked')),
      ).rejects.toThrow(/Path escapes root/)
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true })
    }
  })
})
