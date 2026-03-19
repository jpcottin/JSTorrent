/**
 * Native File System
 *
 * Implements IFileSystem using stateless native bindings.
 * Each instance is scoped to a specific storage root.
 */

import type {
  IFileSystem,
  IFileHandle,
  IFileStat,
  VerifyChunksRequest,
} from '../../interfaces/filesystem'
import { NativeFileHandle } from './native-file-handle'
import './bindings.d.ts'

export class NativeFileSystem implements IFileSystem {
  constructor(private readonly rootKey: string) {}

  /**
   * Open a file.
   * Returns a stateless handle that stores (rootKey, path).
   * The mode parameter is ignored - actual file operations determine read/write behavior.
   */
  async open(path: string, _mode: 'r' | 'w' | 'r+'): Promise<IFileHandle> {
    // Stateless - just return a handle that stores the path
    // The actual file operations happen on read/write
    return new NativeFileHandle(this.rootKey, path)
  }

  /**
   * Get file statistics.
   */
  async stat(path: string): Promise<IFileStat> {
    const result = __jstorrent_file_stat(this.rootKey, path)

    if (!result) {
      throw new Error(`File not found: ${path}`)
    }

    const stat = JSON.parse(result) as {
      size: number
      mtime: number | string
      isDirectory: boolean
      isFile: boolean
    }

    return {
      size: stat.size,
      mtime: new Date(stat.mtime),
      isDirectory: stat.isDirectory,
      isFile: stat.isFile,
    }
  }

  /**
   * Create a directory.
   */
  async mkdir(path: string): Promise<void> {
    // QuickJS FFI returns all values as strings — "false" is truthy in JS
    const result = __jstorrent_file_mkdir(this.rootKey, path)

    if (result !== true && result !== 'true') {
      throw new Error(`Failed to create directory: ${path}`)
    }
  }

  /**
   * Check if a path exists.
   */
  async exists(path: string): Promise<boolean> {
    // QuickJS FFI returns all values as strings — "false" is truthy in JS
    const result = __jstorrent_file_exists(this.rootKey, path)
    return result === true || result === 'true'
  }

  /**
   * Read directory contents.
   * Returns list of filenames (not full paths).
   */
  async readdir(path: string): Promise<string[]> {
    const result = __jstorrent_file_readdir(this.rootKey, path)
    return JSON.parse(result) as string[]
  }

  /**
   * Delete a file or directory.
   */
  async delete(path: string): Promise<void> {
    // QuickJS FFI returns all values as strings — "false" is truthy in JS
    const result = __jstorrent_file_delete(this.rootKey, path)

    if (result !== true && result !== 'true') {
      throw new Error(`Failed to delete: ${path}`)
    }
  }

  async batchDelete(directory: string, entries: string[]): Promise<string[]> {
    const requestJson = JSON.stringify({ directory, entries })
    const result = __jstorrent_file_batch_delete(this.rootKey, requestJson)
    return JSON.parse(result) as string[]
  }

  /**
   * Recursively list all files under a directory with their sizes.
   * Uses dedicated __jstorrent_file_list_tree JNI call for efficiency.
   */
  async listTree(dirPath: string): Promise<Array<{ path: string; size: number }>> {
    const result = __jstorrent_file_list_tree(this.rootKey, dirPath)
    return JSON.parse(result) as Array<{ path: string; size: number }>
  }

  async writeAtomic(path: string, data: Uint8Array): Promise<void> {
    // QuickJS FFI returns all values as strings — "false" is truthy in JS
    const result = __jstorrent_file_write_atomic(this.rootKey, path, data.buffer as ArrayBuffer)
    if (result !== true && result !== 'true') {
      throw new Error(`writeAtomic failed: ${path}`)
    }
  }

  /**
   * Get free disk space on the volume containing this storage root.
   */
  async getFreeDiskSpace(): Promise<number> {
    const result = __jstorrent_file_free_space(this.rootKey)
    if (result === null || result === undefined) {
      return -1
    }
    const parsed = typeof result === 'number' ? result : Number(result)
    return Number.isFinite(parsed) ? parsed : -1
  }

  /**
   * Verify chunks using native JNI call.
   * Sends file layout + hashes, backend reads and hashes locally.
   */
  async verifyChunks(request: VerifyChunksRequest): Promise<Uint8Array> {
    // Encode hashes as base64 for JSON transport
    const bytes = request.hashes
    let binary = ''
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i])
    }
    const hashesBase64 = btoa(binary)

    const requestJson = JSON.stringify({
      files: request.files,
      chunkSize: request.chunkSize,
      hashes: hashesBase64,
      startChunk: request.startChunk ?? 0,
      chunkCount:
        request.chunkCount ??
        Math.ceil(request.files.reduce((s, f) => s + f.length, 0) / request.chunkSize) -
          (request.startChunk ?? 0),
    })
    const result = __jstorrent_file_verify_chunks(this.rootKey, requestJson)
    return new Uint8Array(result)
  }
}
