import { NodeFileSystem } from './node-filesystem'
import * as path from 'path'
import type { VerifyChunksRequest } from '../../interfaces/filesystem'

export class ScopedNodeFileSystem extends NodeFileSystem {
  constructor(private root: string) {
    super()
  }

  private resolve(p: string): string {
    return path.resolve(this.root, p)
  }

  // Override methods to resolve paths relative to root
  // Note: NodeFileSystem methods are async

  async open(filePath: string, mode: 'r' | 'w' | 'r+') {
    return super.open(this.resolve(filePath), mode)
  }

  async stat(filePath: string) {
    return super.stat(this.resolve(filePath))
  }

  async mkdir(dirPath: string) {
    return super.mkdir(this.resolve(dirPath))
  }

  async exists(filePath: string) {
    return super.exists(this.resolve(filePath))
  }

  async listTree(dirPath: string) {
    return super.listTree(this.resolve(dirPath))
  }

  async batchDelete(directory: string, entries: string[]) {
    return super.batchDelete(this.resolve(directory), entries)
  }

  async verifyChunks(request: VerifyChunksRequest) {
    return super.verifyChunks({
      ...request,
      files: request.files.map((f) => ({ ...f, path: this.resolve(f.path) })),
    })
  }
}
