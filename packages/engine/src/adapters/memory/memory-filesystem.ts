// eslint-disable-next-line import/no-nodejs-modules
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
  private dirs = new Set<string>([''])

  private parentDir(path: string): string {
    const lastSlash = path.lastIndexOf('/')
    return lastSlash === -1 ? '' : path.substring(0, lastSlash)
  }

  private ensureParentDir(path: string): void {
    const parent = this.parentDir(path)
    if (!this.dirs.has(parent)) {
      throw new Error(`ENOENT: parent directory does not exist: ${parent}`)
    }
  }

  async open(path: string, mode: 'r' | 'w' | 'r+'): Promise<IFileHandle> {
    if (mode === 'r' && !this.files.has(path)) {
      throw new Error(`File not found: ${path}`)
    }
    if ((mode === 'w' || mode === 'r+') && !this.files.has(path)) {
      this.ensureParentDir(path)
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

    if (this.dirs.has(path)) {
      return {
        size: 0,
        mtime: new Date(),
        isDirectory: true,
        isFile: false,
      }
    }

    throw new Error(`File not found: ${path}`)
  }

  async mkdir(dirPath: string): Promise<void> {
    if (this.files.has(dirPath)) {
      throw new Error(`EEXIST: path is a file, not a directory: ${dirPath}`)
    }
    this.ensureParentDir(dirPath)
    this.dirs.add(dirPath)
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path) || this.dirs.has(path)
  }

  async readdir(dirPath: string): Promise<string[]> {
    if (!this.dirs.has(dirPath)) {
      throw new Error(`ENOENT: directory does not exist: ${dirPath}`)
    }
    const entries = new Set<string>()
    const prefix = dirPath === '' ? '' : `${dirPath}/`

    for (const filePath of this.files.keys()) {
      if (prefix === '' ? !filePath.includes('/') : filePath.startsWith(prefix)) {
        const relative = prefix === '' ? filePath : filePath.slice(prefix.length)
        const firstSegment = relative.split('/')[0]
        if (firstSegment !== '') {
          entries.add(firstSegment)
        }
      }
    }

    for (const dir of this.dirs) {
      if (dir === dirPath) continue
      if (prefix === '' ? !dir.includes('/') : dir.startsWith(prefix)) {
        const relative = prefix === '' ? dir : dir.slice(prefix.length)
        const firstSegment = relative.split('/')[0]
        if (firstSegment !== '') {
          entries.add(firstSegment)
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
    if (this.files.delete(path)) return

    if (this.dirs.has(path)) {
      const prefix = `${path}/`
      for (const key of this.files.keys()) {
        if (key.startsWith(prefix)) {
          throw new Error(`Directory not empty: ${path}`)
        }
      }
      for (const dir of this.dirs) {
        if (dir !== path && dir.startsWith(prefix)) {
          throw new Error(`Directory not empty: ${path}`)
        }
      }
      this.dirs.delete(path)
      return
    }

    throw new Error(`ENOENT: no such file or directory: ${path}`)
  }

  async batchDelete(directory: string, entries: string[]): Promise<string[]> {
    const failed: string[] = []
    const prefix = directory ? `${directory}/` : ''
    for (const entry of entries) {
      const fullPath = `${prefix}${entry}`
      // Try as file first
      if (this.files.has(fullPath)) {
        this.files.delete(fullPath)
        continue
      }
      // Try as directory in dirs set
      if (this.dirs.has(fullPath)) {
        const dirPrefix = `${fullPath}/`
        let isEmpty = true
        for (const key of this.files.keys()) {
          if (key.startsWith(dirPrefix)) {
            isEmpty = false
            break
          }
        }
        if (isEmpty) {
          for (const dir of this.dirs) {
            if (dir !== fullPath && dir.startsWith(dirPrefix)) {
              isEmpty = false
              break
            }
          }
        }
        if (isEmpty) {
          this.dirs.delete(fullPath)
        } else {
          failed.push(entry)
        }
        continue
      }
      // If neither file nor directory exists, silently ignore (missing = ok)
    }
    return failed
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
        const expected = hashes.subarray(i * 20, (i + 1) * 20)
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
