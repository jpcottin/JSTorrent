/**
 * Abstract File System Interfaces
 */

export interface IFileStat {
  size: number
  mtime: Date
  isDirectory: boolean
  isFile: boolean
}

export interface IFileHandle {
  /**
   * Read data from the file at a specific position.
   */
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>

  /**
   * Write data to the file at a specific position.
   */
  write(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesWritten: number }>

  /**
   * Truncate the file to a specific size.
   */
  truncate(len: number): Promise<void>

  /**
   * Flush changes to storage.
   */
  sync(): Promise<void>

  /**
   * Close the file handle.
   */
  close(): Promise<void>
}

export interface VerifyChunksRequest {
  /** Ordered list of files forming an implicitly concatenated byte stream. */
  files: Array<{ path: string; length: number }>
  /** Size of each chunk in bytes (piece length). */
  chunkSize: number
  /** Concatenated 20-byte SHA1 hashes, one per chunk. */
  hashes: Uint8Array
  /** First chunk index to verify (default 0). */
  startChunk?: number
  /** Number of chunks to verify (default: all remaining). */
  chunkCount?: number
}

/** Result codes for verifyChunks */
export const VerifyChunkResult = {
  MATCH: 0,
  MISMATCH: 1,
  IO_ERROR: 2,
} as const

export interface IFileSystem {
  /**
   * Open a file.
   */
  open(path: string, mode: 'r' | 'w' | 'r+'): Promise<IFileHandle>

  /**
   * Get file statistics.
   */
  stat(path: string): Promise<IFileStat>

  /**
   * Create a directory.
   */
  mkdir(path: string): Promise<void>

  /**
   * Check if a path exists.
   */
  exists(path: string): Promise<boolean>

  /**
   * Read directory contents.
   * Returns list of filenames (not full paths).
   */
  readdir(path: string): Promise<string[]>

  /**
   * Delete a file or directory.
   */
  delete(path: string): Promise<void>

  /**
   * Recursively list all files under a directory with their sizes.
   * Returns paths relative to the given path.
   * Returns empty array if path doesn't exist.
   */
  listTree(path: string): Promise<Array<{ path: string; size: number }>>

  /**
   * Verify chunks by reading file data and comparing SHA1 hashes on the backend.
   * Files are treated as an ordered, implicitly concatenated byte stream.
   * Backend reads sequentially, hashes each chunk, and returns result codes.
   *
   * @returns One byte per chunk: 0=MATCH, 1=MISMATCH, 2=IO_ERROR
   */
  verifyChunks(request: VerifyChunksRequest): Promise<Uint8Array>

  /**
   * Delete a list of entries (files or empty directories) within a directory.
   * Each entry is a name relative to the directory (not a nested path).
   * Missing entries are silently ignored (not reported as failures).
   *
   * @param directory Parent directory path
   * @param entries List of filenames/directory names to delete within the directory
   * @returns List of entry names that failed to delete (empty = all succeeded)
   */
  batchDelete(directory: string, entries: string[]): Promise<string[]>

  /**
   * Get free disk space on the volume containing this storage root.
   * Returns bytes available, or -1 if the backend does not support this operation.
   */
  getFreeDiskSpace(): Promise<number>

  /**
   * Atomically write a complete file (write to temp, then rename).
   * If the process crashes mid-write, the previous file content is preserved.
   */
  writeAtomic(path: string, data: Uint8Array): Promise<void>
}
