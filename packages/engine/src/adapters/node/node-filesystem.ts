import * as fs from 'fs/promises'
import * as path from 'path'
import { createHash } from 'crypto'
import {
  IFileSystem,
  IFileHandle,
  IFileStat,
  VerifyChunksRequest,
} from '../../interfaces/filesystem'

export class NodeFileHandle implements IFileHandle {
  constructor(private handle: fs.FileHandle) {}

  async read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }> {
    const result = await this.handle.read(buffer, offset, length, position)
    return { bytesRead: result.bytesRead }
  }

  async write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }> {
    const result = await this.handle.write(buffer, offset, length, position)
    return { bytesWritten: result.bytesWritten }
  }

  async truncate(len: number): Promise<void> {
    await this.handle.truncate(len)
  }

  async sync(): Promise<void> {
    await this.handle.sync()
  }

  async close(): Promise<void> {
    await this.handle.close()
  }
}

export class NodeFileSystem implements IFileSystem {
  async open(filePath: string, mode: 'r' | 'w' | 'r+'): Promise<IFileHandle> {
    // Map modes to Node.js flags
    let flags = 'r'
    if (mode === 'w') flags = 'w+' // Open for reading and writing, file created (if it does not exist) or truncated (if it exists).
    if (mode === 'r+') flags = 'r+' // Open file for reading and writing. An exception occurs if the file does not exist.

    // Ensure directory exists if writing
    if (mode !== 'r') {
      await fs.mkdir(path.dirname(filePath), { recursive: true })

      // If mode is r+, ensure file exists to avoid ENOENT
      if (mode === 'r+') {
        try {
          await fs.access(filePath)
        } catch {
          // File doesn't exist, create it (empty)
          const handle = await fs.open(filePath, 'w')
          await handle.close()
        }
      }
    }

    const handle = await fs.open(filePath, flags)
    return new NodeFileHandle(handle)
  }

  async stat(filePath: string): Promise<IFileStat> {
    const stats = await fs.stat(filePath)
    return {
      size: stats.size,
      mtime: stats.mtime,
      isDirectory: stats.isDirectory(),
      isFile: stats.isFile(),
    }
  }

  async mkdir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true })
  }

  async exists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath)
      return true
    } catch {
      return false
    }
  }

  async readdir(dirPath: string): Promise<string[]> {
    return fs.readdir(dirPath)
  }

  async delete(filePath: string): Promise<void> {
    await fs.rm(filePath, { recursive: true, force: true })
  }

  async verifyChunks(request: VerifyChunksRequest): Promise<Uint8Array> {
    const { files, chunkSize, hashes } = request
    const totalLength = files.reduce((sum, f) => sum + f.length, 0)
    const totalChunks = Math.ceil(totalLength / chunkSize)
    const startChunk = request.startChunk ?? 0
    const chunkCount = request.chunkCount ?? totalChunks - startChunk

    const results = new Uint8Array(chunkCount)

    // Open all file handles up front
    const handles: (fs.FileHandle | null)[] = []
    for (const file of files) {
      try {
        handles.push(await fs.open(file.path, 'r'))
      } catch {
        handles.push(null)
      }
    }

    try {
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

      const readBuf = Buffer.alloc(Math.min(chunkSize, 256 * 1024))

      for (let i = 0; i < chunkCount; i++) {
        const thisChunkSize = Math.min(chunkSize, totalLength - globalOffset)
        if (thisChunkSize <= 0) {
          results[i] = 2 // IO_ERROR
          continue
        }

        const sha1 = createHash('sha1')
        let remaining = thisChunkSize
        let ioError = false

        while (remaining > 0 && fileIdx < files.length) {
          const file = files[fileIdx]
          const handle = handles[fileIdx]
          if (!handle) {
            ioError = true
            // Skip past this file's remaining bytes
            const skip = Math.min(remaining, file.length - offsetInFile)
            remaining -= skip
            globalOffset += skip
            fileIdx++
            offsetInFile = 0
            continue
          }

          const bytesAvailInFile = file.length - offsetInFile
          const toRead = Math.min(remaining, bytesAvailInFile, readBuf.length)

          try {
            const { bytesRead } = await handle.read(readBuf, 0, toRead, offsetInFile)
            if (bytesRead > 0) {
              sha1.update(readBuf.subarray(0, bytesRead))
            }
            if (bytesRead < toRead) {
              ioError = true
              break
            }
          } catch {
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
          results[i] = 2 // IO_ERROR
          // Advance cursor past the rest of this chunk
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
    } finally {
      for (const handle of handles) {
        if (handle) await handle.close().catch(() => {})
      }
    }

    return results
  }

  async listTree(dirPath: string): Promise<Array<{ path: string; size: number }>> {
    const results: Array<{ path: string; size: number }> = []
    const walk = async (dir: string, prefix: string): Promise<void> => {
      let entries: string[]
      try {
        entries = await fs.readdir(dir)
      } catch {
        return
      }
      for (const name of entries) {
        const fullPath = path.join(dir, name)
        const relative = prefix ? `${prefix}/${name}` : name
        try {
          const stats = await fs.stat(fullPath)
          if (stats.isDirectory()) {
            await walk(fullPath, relative)
          } else if (stats.isFile()) {
            results.push({ path: relative, size: stats.size })
          }
        } catch {
          // Skip entries that can't be stat'd
        }
      }
    }
    await walk(dirPath, '')
    return results
  }
}
