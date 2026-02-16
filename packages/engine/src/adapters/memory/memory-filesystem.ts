import { createHash } from 'crypto'
import {
  IFileSystem,
  IFileHandle,
  IFileStat,
  VerifyChunksRequest,
} from '../../interfaces/filesystem'

class MemoryFileHandle implements IFileHandle {
  constructor(
    private fs: InMemoryFileSystem,
    private path: string,
  ) {}

  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    const fileData = this.fs.files.get(this.path)
    if (!fileData) throw new Error('File not found')

    const end = Math.min(position + length, fileData.length)
    const bytesRead = end - position

    if (bytesRead <= 0) return { bytesRead: 0 }

    buffer.set(fileData.slice(position, end), offset)
    return { bytesRead }
  }

  async write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }> {
    let fileData = this.fs.files.get(this.path) || new Uint8Array(0)

    const requiredSize = position + length
    if (fileData.length < requiredSize) {
      const newBuffer = new Uint8Array(requiredSize)
      newBuffer.set(fileData)
      fileData = newBuffer
    }

    fileData.set(buffer.slice(offset, offset + length), position)
    this.fs.files.set(this.path, fileData)

    return { bytesWritten: length }
  }

  async truncate(len: number): Promise<void> {
    const fileData = this.fs.files.get(this.path)
    if (fileData) {
      this.fs.files.set(this.path, fileData.slice(0, len))
    }
  }

  async sync(): Promise<void> {}
  async close(): Promise<void> {}
}

export class InMemoryFileSystem implements IFileSystem {
  public files = new Map<string, Uint8Array>()

  async open(path: string, mode: 'r' | 'w' | 'r+'): Promise<IFileHandle> {
    if (mode === 'r' && !this.files.has(path)) {
      throw new Error(`File not found: ${path}`)
    }
    if (!this.files.has(path)) {
      this.files.set(path, new Uint8Array(0))
    }
    return new MemoryFileHandle(this, path)
  }

  async stat(path: string): Promise<IFileStat> {
    const file = this.files.get(path)
    if (file) {
      return {
        size: file.length,
        mtime: new Date(),
        isDirectory: false,
        isFile: true,
      }
    }

    // Check if it's a directory
    const prefix = path.endsWith('/') ? path : `${path}/`
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) {
        return {
          size: 0,
          mtime: new Date(),
          isDirectory: true,
          isFile: false,
        }
      }
    }

    throw new Error(`File not found: ${path}`)
  }

  async mkdir(_path: string): Promise<void> {
    // No-op for flat memory FS
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }

  async readdir(dirPath: string): Promise<string[]> {
    // Naive implementation for flat map: find keys starting with dirPath
    // This assumes paths are normalized and use / separator
    const entries = new Set<string>()
    const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`

    for (const path of this.files.keys()) {
      if (path.startsWith(prefix)) {
        const relative = path.slice(prefix.length)
        const parts = relative.split('/')
        if (parts.length > 0) {
          entries.add(parts[0])
        }
      }
    }
    return Array.from(entries)
  }

  async readFile(path: string): Promise<Uint8Array> {
    const file = this.files.get(path)
    if (!file) throw new Error(`File not found: ${path}`)
    return file
  }

  async delete(path: string): Promise<void> {
    this.files.delete(path)
  }

  async verifyChunks(request: VerifyChunksRequest): Promise<Uint8Array> {
    const { files, chunkSize, hashes } = request
    const totalLength = files.reduce((sum, f) => sum + f.length, 0)
    const totalChunks = Math.ceil(totalLength / chunkSize)
    const startChunk = request.startChunk ?? 0
    const chunkCount = request.chunkCount ?? totalChunks - startChunk

    const results = new Uint8Array(chunkCount)

    // Advance cursor to start position
    let fileIdx = 0
    let offsetInFile = 0
    let globalOffset = 0
    const startOffset = startChunk * chunkSize

    while (fileIdx < files.length && globalOffset + files[fileIdx].length <= startOffset) {
      globalOffset += files[fileIdx].length
      fileIdx++
    }
    if (fileIdx < files.length) {
      offsetInFile = startOffset - globalOffset
      globalOffset = startOffset
    }

    for (let i = 0; i < chunkCount; i++) {
      const thisChunkSize = Math.min(chunkSize, totalLength - globalOffset)
      if (thisChunkSize <= 0) {
        results[i] = 2
        continue
      }

      const sha1 = createHash('sha1')
      let remaining = thisChunkSize
      let ioError = false

      while (remaining > 0 && fileIdx < files.length) {
        const file = files[fileIdx]
        const data = this.files.get(file.path)
        if (!data) {
          ioError = true
          const skip = Math.min(remaining, file.length - offsetInFile)
          remaining -= skip
          globalOffset += skip
          fileIdx++
          offsetInFile = 0
          continue
        }

        const bytesAvailInFile = file.length - offsetInFile
        const toRead = Math.min(remaining, bytesAvailInFile)
        const end = Math.min(offsetInFile + toRead, data.length)
        const bytesRead = end - offsetInFile

        if (bytesRead > 0) {
          sha1.update(data.subarray(offsetInFile, end))
        }
        if (bytesRead < toRead) {
          ioError = true
          break
        }

        remaining -= toRead
        offsetInFile += toRead
        globalOffset += toRead

        if (offsetInFile >= file.length) {
          fileIdx++
          offsetInFile = 0
        }
      }

      if (ioError) {
        results[i] = 2
        globalOffset += remaining
        while (remaining > 0 && fileIdx < files.length) {
          const skip = Math.min(remaining, files[fileIdx].length - offsetInFile)
          remaining -= skip
          offsetInFile += skip
          if (offsetInFile >= files[fileIdx].length) {
            fileIdx++
            offsetInFile = 0
          }
        }
      } else {
        const hash = sha1.digest()
        const hashIdx = (startChunk + i) * 20
        const expected = hashes.subarray(hashIdx, hashIdx + 20)
        results[i] = hash.every((b, j) => b === expected[j]) ? 0 : 1
      }
    }

    return results
  }

  async listTree(dirPath: string): Promise<Array<{ path: string; size: number }>> {
    const results: Array<{ path: string; size: number }> = []
    const prefix = dirPath.endsWith('/') ? dirPath : `${dirPath}/`

    for (const [filePath, data] of this.files) {
      if (filePath.startsWith(prefix)) {
        results.push({
          path: filePath.slice(prefix.length),
          size: data.length,
        })
      }
    }

    return results
  }
}
