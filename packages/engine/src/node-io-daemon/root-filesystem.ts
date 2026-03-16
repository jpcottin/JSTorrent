import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export interface NodeIoDaemonRootFsEntry {
  path: string
  size: number
}

export interface NodeIoDaemonFileStat {
  size: number
  mtime: number
  is_directory: boolean
  is_file: boolean
}

export class NodeIoDaemonRootFileSystem {
  constructor(private readonly rootUri: string) {}

  async stat(relativePath: string): Promise<NodeIoDaemonFileStat> {
    const stats = await fs.stat(this.resolve(relativePath))
    return {
      size: stats.size,
      mtime: stats.mtimeMs,
      is_directory: stats.isDirectory(),
      is_file: stats.isFile(),
    }
  }

  async exists(relativePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(relativePath))
      return true
    } catch {
      return false
    }
  }

  async ensureDir(relativePath: string): Promise<void> {
    await fs.mkdir(this.resolve(relativePath), { recursive: true })
  }

  async delete(relativePath: string): Promise<void> {
    try {
      await fs.rm(this.resolve(relativePath), { recursive: true, force: false })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new NodeIoDaemonFileNotFoundError(relativePath)
      }
      throw error
    }
  }

  async batchDelete(directory: string, entries: string[]): Promise<string[]> {
    const absoluteDirectory = this.resolve(directory)
    const failed: string[] = []

    for (const entry of entries) {
      if (entry.includes('/') || entry.includes('\\') || entry.includes('..')) {
        failed.push(entry)
        continue
      }

      const absoluteEntryPath = path.join(absoluteDirectory, entry)
      try {
        await fs.rm(absoluteEntryPath, { recursive: true, force: false })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          continue
        }
        failed.push(entry)
      }
    }

    return failed
  }

  async truncate(relativePath: string, length: number): Promise<void> {
    const absolutePath = this.resolve(relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    const handle = await this.openForWrite(absolutePath)
    try {
      await handle.truncate(length)
    } finally {
      await handle.close()
    }
  }

  async read(relativePath: string, offset: number, length: number): Promise<Uint8Array> {
    const handle = await fs.open(this.resolve(relativePath), 'r')
    try {
      const buffer = Buffer.alloc(length)
      const result = await handle.read(buffer, 0, length, offset)
      return new Uint8Array(buffer.subarray(0, result.bytesRead))
    } finally {
      await handle.close()
    }
  }

  async write(
    relativePath: string,
    offset: number,
    data: Uint8Array,
    expectedSha1Hex?: string | null,
  ): Promise<void> {
    if (expectedSha1Hex) {
      const actualSha1Hex = createHash('sha1').update(data).digest('hex')
      if (actualSha1Hex !== expectedSha1Hex.toLowerCase()) {
        throw new NodeIoDaemonHashMismatchError(relativePath)
      }
    }

    const absolutePath = this.resolve(relativePath)
    await fs.mkdir(path.dirname(absolutePath), { recursive: true })
    const handle = await this.openForWrite(absolutePath)
    try {
      await handle.write(data, 0, data.length, offset)
      await handle.sync()
    } finally {
      await handle.close()
    }
  }

  async writeBatch(
    writes: Array<{
      path: string
      position: number
      data: Uint8Array
      expectedHashHex: string
    }>,
  ): Promise<void> {
    for (const write of writes) {
      await this.write(write.path, write.position, write.data, write.expectedHashHex)
    }
  }

  async list(relativePath: string): Promise<string[]> {
    try {
      return await fs.readdir(this.resolve(relativePath))
    } catch {
      return []
    }
  }

  async listTree(relativePath: string): Promise<NodeIoDaemonRootFsEntry[]> {
    const results: NodeIoDaemonRootFsEntry[] = []
    await this.walk(relativePath, relativePath, results)
    return results
  }

  private async walk(
    currentRelativePath: string,
    baseRelativePath: string,
    results: NodeIoDaemonRootFsEntry[],
  ): Promise<void> {
    const absolutePath = this.resolve(currentRelativePath)
    let entries: string[]
    try {
      entries = await fs.readdir(absolutePath)
    } catch {
      return
    }

    for (const entry of entries) {
      const childRelativePath = currentRelativePath ? `${currentRelativePath}/${entry}` : entry
      const childAbsolutePath = this.resolve(childRelativePath)
      const stats = await fs.stat(childAbsolutePath)
      if (stats.isDirectory()) {
        await this.walk(childRelativePath, baseRelativePath, results)
      } else if (stats.isFile()) {
        const displayPath =
          baseRelativePath.length > 0
            ? path.posix.relative(baseRelativePath, childRelativePath)
            : childRelativePath
        results.push({ path: displayPath, size: stats.size })
      }
    }
  }

  async getFreeDiskSpace(): Promise<number> {
    const rootPath = fileURLToPath(this.rootUri)
    const stats = await fs.statfs(rootPath)
    return stats.bfree * stats.bsize
  }

  private resolve(relativePath: string): string {
    const normalized = path.posix.normalize(relativePath)
    if (normalized.startsWith('../') || normalized === '..' || path.posix.isAbsolute(normalized)) {
      throw new Error(`Invalid root-relative path: ${relativePath}`)
    }

    const rootPath = fileURLToPath(this.rootUri)
    return path.resolve(rootPath, normalized)
  }

  private async openForWrite(absolutePath: string): Promise<fs.FileHandle> {
    try {
      return await fs.open(absolutePath, 'r+')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error
      }
      const handle = await fs.open(absolutePath, 'w+')
      return handle
    }
  }
}

export class NodeIoDaemonHashMismatchError extends Error {
  constructor(path: string) {
    super(`SHA1 mismatch for ${path}`)
    this.name = 'NodeIoDaemonHashMismatchError'
  }
}

export class NodeIoDaemonFileNotFoundError extends Error {
  constructor(path: string) {
    super(`File not found: ${path}`)
    this.name = 'NodeIoDaemonFileNotFoundError'
  }
}
