package com.jstorrent.io.file

import android.net.Uri
import androidx.documentfile.provider.DocumentFile

/**
 * File statistics returned by [FileManager.stat].
 */
data class FileStat(
    val size: Long,
    val mtime: Long,
    val isDirectory: Boolean,
    val isFile: Boolean,
)

/**
 * Entry in a recursive file listing returned by [FileManager.listTree].
 */
data class FileTreeEntry(
    val path: String,
    val size: Long,
)

/**
 * File entry for [FileManager.verifyChunks] — path and declared length
 * in the concatenated byte stream.
 */
data class VerifyChunksFile(
    val path: String,
    val length: Long,
)

/**
 * Manages file read/write operations using Android's Storage Access Framework (SAF).
 *
 * This interface abstracts file I/O operations, allowing different implementations
 * for HTTP/WebSocket server (companion mode) and JSI bindings (standalone mode).
 *
 * All paths are relative to a SAF tree root URI. The implementation handles:
 * - DocumentFile traversal and caching
 * - Creating parent directories as needed
 * - Random-access read/write via ParcelFileDescriptor
 *
 * Thread safety: Implementations must be thread-safe.
 */
interface FileManager {
    /**
     * Read bytes from a file at the specified offset.
     *
     * @param rootUri SAF tree URI for the download root
     * @param relativePath Path relative to root (e.g., "Movies/film.mp4")
     * @param offset Byte offset to start reading from
     * @param length Number of bytes to read
     * @return Byte array containing exactly [length] bytes
     * @throws FileManagerException.FileNotFound if file doesn't exist
     * @throws FileManagerException.CannotOpenFile if file can't be opened for reading
     * @throws FileManagerException.InsufficientData if fewer than [length] bytes available
     * @throws FileManagerException.ReadError on I/O error
     */
    fun read(rootUri: Uri, relativePath: String, offset: Long, length: Int): ByteArray

    /**
     * Write bytes to a file at the specified offset.
     *
     * Creates the file and parent directories if they don't exist.
     *
     * @param rootUri SAF tree URI for the download root
     * @param relativePath Path relative to root (e.g., "Movies/film.mp4")
     * @param offset Byte offset to start writing at
     * @param data Bytes to write
     * @throws FileManagerException.CannotCreateFile if file/directories can't be created
     * @throws FileManagerException.CannotOpenFile if file can't be opened for writing
     * @throws FileManagerException.DiskFull if storage is full
     * @throws FileManagerException.WriteError on I/O error
     */
    fun write(rootUri: Uri, relativePath: String, offset: Long, data: ByteArray)

    /**
     * Check if a file exists at the given path.
     *
     * @param rootUri SAF tree URI for the download root
     * @param relativePath Path relative to root
     * @return true if file exists, false otherwise
     */
    fun exists(rootUri: Uri, relativePath: String): Boolean

    /**
     * Get or create a DocumentFile at the given path.
     *
     * Creates parent directories as needed. Useful when the caller needs
     * direct access to the DocumentFile (e.g., for URI access).
     *
     * @param rootUri SAF tree URI for the download root
     * @param relativePath Path relative to root
     * @return DocumentFile for the file, or null if creation failed
     */
    fun getOrCreateFile(rootUri: Uri, relativePath: String): DocumentFile?

    /**
     * Clear the internal DocumentFile cache.
     *
     * Call this if you know files have been modified externally or
     * if you want to free memory.
     */
    fun clearCache()

    /**
     * Get file or directory statistics.
     *
     * @param rootUri SAF tree URI for the root
     * @param relativePath Path relative to root (empty string for root itself)
     * @return File statistics, or null if path doesn't exist
     */
    fun stat(rootUri: Uri, relativePath: String): FileStat?

    /**
     * Create a directory at the given path.
     *
     * Creates parent directories as needed.
     *
     * @param rootUri SAF tree URI for the root
     * @param relativePath Path relative to root
     * @return true if directory was created or already exists, false on failure
     */
    fun mkdir(rootUri: Uri, relativePath: String): Boolean

    /**
     * List contents of a directory.
     *
     * @param rootUri SAF tree URI for the root
     * @param relativePath Path relative to root (empty string for root itself)
     * @return List of filenames (not full paths), or empty list if path doesn't exist or isn't a directory
     */
    fun readdir(rootUri: Uri, relativePath: String): List<String>

    /**
     * Delete a file or directory.
     *
     * For directories, deletes recursively.
     *
     * @param rootUri SAF tree URI for the root
     * @param relativePath Path relative to root
     * @return true if deleted successfully, false if doesn't exist or deletion failed
     */
    fun delete(rootUri: Uri, relativePath: String): Boolean

    /**
     * Recursively list all files under a directory with their sizes.
     *
     * Returns paths relative to the given path. Returns empty list if
     * path doesn't exist or isn't a directory.
     *
     * For SAF URIs, uses ContentResolver.query() for efficient batch listing
     * instead of DocumentFile.listFiles() which is O(n) queries per directory.
     *
     * @param rootUri SAF tree URI for the root
     * @param relativePath Path relative to root
     * @return List of files with relative paths and sizes
     */
    fun listTree(rootUri: Uri, relativePath: String): List<FileTreeEntry>

    /**
     * Delete a list of entries (files or empty directories) within a directory.
     * Each entry is a name relative to the directory (not a nested path).
     * Missing entries are silently ignored (not reported as failures).
     *
     * @param rootUri SAF tree URI for the root
     * @param directory Directory path relative to root
     * @param entries List of filenames/directory names to delete within the directory
     * @return List of entry names that failed to delete (empty = all succeeded)
     */
    fun batchDelete(rootUri: Uri, directory: String, entries: List<String>): List<String>

    /**
     * Verify chunks by reading files as a concatenated byte stream and comparing
     * SHA1 hashes. Returns one byte per chunk: 0=match, 1=mismatch, 2=io_error.
     *
     * @param rootUri SAF tree URI for the root
     * @param files Ordered list of files forming the concatenated stream
     * @param chunkSize Size of each chunk in bytes
     * @param hashes Concatenated 20-byte SHA1 hashes, one per chunk
     * @param startChunk First chunk index to verify
     * @param chunkCount Number of chunks to verify
     * @return ByteArray with one result byte per chunk
     */
    fun verifyChunks(
        rootUri: Uri,
        files: List<VerifyChunksFile>,
        chunkSize: Long,
        hashes: ByteArray,
        startChunk: Long,
        chunkCount: Long,
    ): ByteArray
}
