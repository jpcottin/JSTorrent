import {
  IFileSystem,
  IFileHandle,
  IFileStat,
  VerifyChunksRequest,
} from '../../interfaces/filesystem'
import { DaemonConnection } from './daemon-connection'
import { DaemonFileHandle } from './daemon-file-handle'

export class DaemonFileSystem implements IFileSystem {
  constructor(
    private connection: DaemonConnection,
    private rootKey: string,
    private nullStorage: boolean = false,
  ) {}

  async open(path: string, _mode: 'r' | 'w' | 'r+'): Promise<IFileHandle> {
    // For 'w' or 'r+', we might want to ensure the file exists or is created.
    // The current io-daemon `write_file` handles creation.
    // `read_file` errors if not found.
    // We can just return the handle and let the operations fail if needed,
    // or we could do a stat check here.
    // For now, just return the handle.
    return new DaemonFileHandle(this.connection, path, this.rootKey, this.nullStorage)
  }

  async stat(path: string): Promise<IFileStat> {
    const stat = await this.connection.request<{
      size: number
      mtime: number
      is_directory: boolean
      is_file: boolean
    }>('GET', '/ops/stat', {
      path,
      root_key: this.rootKey,
    })

    return {
      size: stat.size,
      mtime: new Date(stat.mtime),
      isDirectory: stat.is_directory,
      isFile: stat.is_file,
    }
  }

  async mkdir(path: string): Promise<void> {
    await this.connection.request('POST', '/files/ensure_dir', undefined, {
      path,
      root_key: this.rootKey,
    })
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.connection.request<{ exists: boolean }>('GET', '/ops/exists', {
      path,
      root_key: this.rootKey,
    })
    return result.exists
  }

  async readdir(path: string): Promise<string[]> {
    return this.connection.request<string[]>('GET', '/ops/list', {
      path,
      root_key: this.rootKey,
    })
  }

  async delete(path: string): Promise<void> {
    await this.connection.request('POST', '/ops/delete', undefined, {
      path,
      root_key: this.rootKey,
    })
  }

  async batchDelete(directory: string, entries: string[]): Promise<string[]> {
    return this.connection.request<string[]>('POST', '/ops/batch_delete', undefined, {
      root_key: this.rootKey,
      directory,
      entries,
    })
  }

  async listTree(path: string): Promise<Array<{ path: string; size: number }>> {
    return this.connection.request<Array<{ path: string; size: number }>>('GET', '/ops/list_tree', {
      path,
      root_key: this.rootKey,
    })
  }

  async getFreeDiskSpace(): Promise<number> {
    const result = await this.connection.request<{ free_space: number }>('GET', '/ops/free_space', {
      root_key: this.rootKey,
    })
    return result.free_space
  }

  async verifyChunks(request: VerifyChunksRequest): Promise<Uint8Array> {
    // Encode hashes as base64 for JSON transport
    let hashesBase64: string
    if (typeof Buffer !== 'undefined') {
      hashesBase64 = Buffer.from(request.hashes).toString('base64')
    } else {
      // Browser: manual base64
      let binary = ''
      for (let i = 0; i < request.hashes.length; i++) {
        binary += String.fromCharCode(request.hashes[i])
      }
      hashesBase64 = btoa(binary)
    }

    const body = JSON.stringify({
      root_key: this.rootKey,
      files: request.files,
      chunk_size: request.chunkSize,
      hashes: hashesBase64,
      start_chunk: request.startChunk ?? 0,
      chunk_count:
        request.chunkCount ??
        Math.ceil(request.files.reduce((s, f) => s + f.length, 0) / request.chunkSize) -
          (request.startChunk ?? 0),
    })

    return this.connection.requestBinary(
      'POST',
      '/ops/verify_chunks',
      undefined,
      new TextEncoder().encode(body),
      { 'Content-Type': 'application/json' },
    )
  }
}
