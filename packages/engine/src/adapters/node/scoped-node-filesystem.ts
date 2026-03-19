import { NodeFileSystem } from './node-filesystem'
import * as fs from 'fs/promises'
import type { VerifyChunksRequest } from '../../interfaces/filesystem'
import { resolvePathWithinRoot } from './root-path-safety'

export class ScopedNodeFileSystem extends NodeFileSystem {
  constructor(private root: string) {
    super()
  }

  private async resolve(p: string): Promise<string> {
    return resolvePathWithinRoot(this.root, p)
  }

  // Override methods to resolve paths relative to root
  // Note: NodeFileSystem methods are async

  async open(filePath: string, mode: 'r' | 'w' | 'r+') {
    return super.open(await this.resolve(filePath), mode)
  }

  async stat(filePath: string) {
    return super.stat(await this.resolve(filePath))
  }

  async mkdir(dirPath: string) {
    return super.mkdir(await this.resolve(dirPath))
  }

  async exists(filePath: string) {
    return super.exists(await this.resolve(filePath))
  }

  async listTree(dirPath: string) {
    return super.listTree(await this.resolve(dirPath))
  }

  async batchDelete(directory: string, entries: string[]) {
    return super.batchDelete(await this.resolve(directory), entries)
  }

  async getFreeDiskSpace(): Promise<number> {
    const stats = await fs.statfs(this.root)
    return stats.bfree * stats.bsize
  }

  async writeAtomic(filePath: string, data: Uint8Array) {
    return super.writeAtomic(await this.resolve(filePath), data)
  }

  async verifyChunks(request: VerifyChunksRequest) {
    const files = await Promise.all(
      request.files.map(async (file) => ({ ...file, path: await this.resolve(file.path) })),
    )
    return super.verifyChunks({
      ...request,
      files,
    })
  }
}
