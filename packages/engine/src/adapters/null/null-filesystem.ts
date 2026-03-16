import {
  IFileSystem,
  IFileHandle,
  IFileStat,
  VerifyChunkResult,
  VerifyChunksRequest,
} from '../../interfaces/filesystem'

class NullFileHandle implements IFileHandle {
  constructor(
    private path: string,
    private getSize: (path: string) => number | undefined,
    private setSize: (path: string, size: number) => void,
  ) {}

  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    // Return zeros - shouldn't normally be called for write-only usage
    const currentSize = this.getSize(this.path) ?? 0
    const bytesRead = Math.min(length, Math.max(0, currentSize - position))
    buffer.fill(0, offset, offset + bytesRead)
    return { bytesRead }
  }

  async write(
    _buffer: Uint8Array,
    _offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }> {
    // Track size but discard data
    const currentSize = this.getSize(this.path) ?? 0
    this.setSize(this.path, Math.max(currentSize, position + length))
    return { bytesWritten: length }
  }

  async truncate(len: number): Promise<void> {
    this.setSize(this.path, len)
  }

  async sync(): Promise<void> {}
  async close(): Promise<void> {}
}

export class NullFileSystem implements IFileSystem {
  private sizes = new Map<string, number>()

  async open(path: string, mode: 'r' | 'w' | 'r+'): Promise<IFileHandle> {
    if (mode !== 'r' && !this.sizes.has(path)) {
      this.sizes.set(path, 0)
    }
    return new NullFileHandle(
      path,
      (filePath) => this.sizes.get(filePath),
      (filePath, size) => this.sizes.set(filePath, size),
    )
  }

  async stat(path: string): Promise<IFileStat> {
    const size = this.sizes.get(path)
    if (size === undefined) {
      throw new Error(`ENOENT: ${path}`)
    }
    return {
      size,
      mtime: new Date(),
      isDirectory: false,
      isFile: true,
    }
  }

  async mkdir(_path: string): Promise<void> {}

  async exists(path: string): Promise<boolean> {
    return this.sizes.has(path)
  }

  async readdir(path: string): Promise<string[]> {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const entries = new Set<string>()
    for (const filePath of this.sizes.keys()) {
      if (!filePath.startsWith(prefix)) continue
      const relative = filePath.slice(prefix.length)
      if (!relative) continue
      const nextSegment = relative.split('/')[0]
      if (nextSegment) {
        entries.add(nextSegment)
      }
    }
    return [...entries]
  }

  async delete(path: string): Promise<void> {
    this.sizes.delete(path)
  }

  async batchDelete(_directory: string, _entries: string[]): Promise<string[]> {
    return []
  }

  async listTree(path: string): Promise<Array<{ path: string; size: number }>> {
    const prefix = path.endsWith('/') ? path : `${path}/`
    const entries: Array<{ path: string; size: number }> = []
    for (const [filePath, size] of this.sizes.entries()) {
      if (!filePath.startsWith(prefix)) continue
      entries.push({
        path: filePath.slice(prefix.length),
        size,
      })
    }
    return entries
  }

  async getFreeDiskSpace(): Promise<number> {
    return Infinity
  }

  async verifyChunks(request: VerifyChunksRequest): Promise<Uint8Array> {
    const totalLength = request.files.reduce((sum, file) => sum + file.length, 0)
    const totalChunks = Math.ceil(totalLength / request.chunkSize)
    const startChunk = request.startChunk ?? 0
    const count = request.chunkCount ?? totalChunks - startChunk
    const results = new Uint8Array(count)
    results.fill(VerifyChunkResult.MISMATCH)

    let streamOffset = 0
    const files = request.files.map((file) => {
      const entry = {
        ...file,
        start: streamOffset,
        end: streamOffset + file.length,
        actualSize: this.sizes.get(file.path),
      }
      streamOffset += file.length
      return entry
    })

    for (let i = 0; i < count; i++) {
      const chunkStart = (startChunk + i) * request.chunkSize
      const chunkEnd = Math.min(totalLength, chunkStart + request.chunkSize)
      const hasMissingData = files.some((file) => {
        if (file.end <= chunkStart || file.start >= chunkEnd) return false
        if (file.actualSize === undefined) return true
        const neededEnd = Math.min(file.length, chunkEnd - file.start)
        return file.actualSize < neededEnd
      })
      if (hasMissingData) {
        results[i] = VerifyChunkResult.IO_ERROR
      }
    }

    return results
  }
}
