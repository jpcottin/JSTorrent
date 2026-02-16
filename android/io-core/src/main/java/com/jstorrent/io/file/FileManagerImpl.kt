package com.jstorrent.io.file

import android.content.Context
import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import android.provider.DocumentsContract
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.ByteBuffer
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

private const val TAG = "FileManagerImpl"

/**
 * Pooled file handle using FileChannel for lock-free positioned I/O.
 * FileChannel.write(buffer, position) and read(buffer, position) are atomic
 * positioned operations that don't use seek, enabling true concurrent access
 * to different positions without locking.
 */
private class PooledFileHandle(
    val path: String,
    val raf: RandomAccessFile,
    @Volatile var lastAccessTime: Long = System.currentTimeMillis()
) {
    val channel = raf.channel

    /** Last time we verified the file still exists at this path (to detect external deletion) */
    @Volatile var lastValidationTime: Long = System.currentTimeMillis()

    /**
     * Write data at the given position without seeking.
     * Uses FileChannel.write(buffer, position) which is atomic and thread-safe
     * for writes to different positions.
     */
    fun writeAt(offset: Long, data: ByteArray) {
        lastAccessTime = System.currentTimeMillis()
        val buffer = ByteBuffer.wrap(data)
        var written = 0
        while (buffer.hasRemaining()) {
            written += channel.write(buffer, offset + written)
        }
    }

    /**
     * Read data from the given position without seeking.
     * Uses FileChannel.read(buffer, position) which is atomic and thread-safe.
     */
    fun readAt(offset: Long, length: Int): ByteArray {
        lastAccessTime = System.currentTimeMillis()
        val buffer = ByteBuffer.allocate(length)
        var totalRead = 0
        while (buffer.hasRemaining()) {
            val read = channel.read(buffer, offset + totalRead)
            if (read == -1) break
            totalRead += read
        }
        if (totalRead < length) {
            throw IllegalStateException("Could not read $length bytes, only got $totalRead")
        }
        buffer.flip()
        return buffer.array()
    }

    fun close() {
        try {
            channel.close()
            raf.close()
        } catch (e: Exception) {
            Log.w(TAG, "Error closing file handle: $path", e)
        }
    }
}

/**
 * Pooled SAF file handle using FileChannel for lock-free positioned I/O.
 * Similar to PooledFileHandle but for SAF content:// URIs.
 *
 * Note: We need separate FileInputStream and FileOutputStream because:
 * - FileOutputStream.getChannel() returns a write-only channel (read returns 0)
 * - FileInputStream.getChannel() returns a read-only channel
 * Both channels share the same underlying file descriptor from the ParcelFileDescriptor.
 */
private class PooledSafHandle(
    val cacheKey: String,  // "$rootUri|$relativePath"
    val pfd: android.os.ParcelFileDescriptor,
    @Volatile var lastAccessTime: Long = System.currentTimeMillis()
) {
    // Separate streams for read and write operations
    // FileOutputStream channel is write-only, FileInputStream channel is read-only
    private val fos = FileOutputStream(pfd.fileDescriptor)
    private val fis = FileInputStream(pfd.fileDescriptor)
    private val writeChannel: java.nio.channels.FileChannel = fos.channel
    private val readChannel: java.nio.channels.FileChannel = fis.channel

    /**
     * Write data at the given position without seeking.
     * Uses FileChannel.write(buffer, position) which is atomic and thread-safe.
     */
    fun writeAt(offset: Long, data: ByteArray) {
        lastAccessTime = System.currentTimeMillis()
        val buffer = ByteBuffer.wrap(data)
        var written = 0
        while (buffer.hasRemaining()) {
            written += writeChannel.write(buffer, offset + written)
        }
    }

    /**
     * Read data from the given position without seeking.
     * Uses the read channel (from FileInputStream) for proper read support.
     */
    fun readAt(offset: Long, length: Int): ByteArray {
        lastAccessTime = System.currentTimeMillis()
        val buffer = ByteBuffer.allocate(length)
        var totalRead = 0
        while (buffer.hasRemaining()) {
            val read = readChannel.read(buffer, offset + totalRead)
            if (read == -1) break
            totalRead += read
        }
        if (totalRead < length) {
            throw IllegalStateException("Could not read $length bytes, only got $totalRead")
        }
        buffer.flip()
        return buffer.array()
    }

    fun close() {
        try {
            writeChannel.close()
            readChannel.close()
            fos.close()
            fis.close()
            pfd.close()
        } catch (e: Exception) {
            Log.w(TAG, "Error closing SAF handle: $cacheKey", e)
        }
    }
}

/**
 * SAF-based FileManager implementation with LRU caching.
 * Also supports file:// URIs using standard Java File I/O.
 *
 * @param context Android context for SAF operations (ContentResolver access)
 * @param maxCacheSize Maximum number of DocumentFile references to cache (default: 200)
 */
class FileManagerImpl(
    private val context: Context,
    maxCacheSize: Int = 200,
    private val maxFileHandles: Int = 32,
    private val handleIdleTimeoutMs: Long = 30_000L
) : FileManager {

    /**
     * LRU cache for DocumentFile references to avoid repeated SAF traversals.
     * Key format: "$rootUri|$relativePath"
     */
    private val documentFileCache = object : LinkedHashMap<String, DocumentFile>(100, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, DocumentFile>?): Boolean {
            return size > maxCacheSize
        }
    }
    private val cacheLock = Any()

    /**
     * Per-path locks to prevent race conditions during file creation.
     * Multiple concurrent writes to the same path will wait for creation to complete.
     */
    private val creationLocks = ConcurrentHashMap<String, ReentrantLock>()

    /**
     * Pool of open file handles for native file:// writes.
     * Key: absolute file path
     */
    private val fileHandlePool = LinkedHashMap<String, PooledFileHandle>(maxFileHandles, 0.75f, true)
    private val fileHandleLock = ReentrantLock()
    @Volatile private var lastEvictionCheck = System.currentTimeMillis()

    /**
     * Pool of open SAF file handles.
     * Key: "$rootUri|$relativePath"
     */
    private val safHandlePool = LinkedHashMap<String, PooledSafHandle>(maxFileHandles, 0.75f, true)
    private val safHandleLock = ReentrantLock()
    @Volatile private var lastSafEvictionCheck = System.currentTimeMillis()

    /**
     * Check if URI is a file:// scheme that should use native File I/O.
     */
    private fun isFileUri(uri: Uri): Boolean = uri.scheme == "file"

    /**
     * Convert file:// URI to File object.
     */
    private fun uriToFile(uri: Uri): File? = uri.path?.let { File(it) }

    override fun read(rootUri: Uri, relativePath: String, offset: Long, length: Int): ByteArray {
        // Handle file:// URIs with native File I/O
        if (isFileUri(rootUri)) {
            return readNative(rootUri, relativePath, offset, length)
        }

        try {
            // Use read-only handle getter that doesn't create files
            val handle = getPooledSafHandleForRead(rootUri, relativePath)
            return handle.readAt(offset, length)
        } catch (e: FileManagerException) {
            throw e
        } catch (e: IllegalStateException) {
            throw FileManagerException.InsufficientData(relativePath, length, 0)
        } catch (e: Exception) {
            Log.e(TAG, "Error reading file: ${e.message}", e)
            throw FileManagerException.ReadError(relativePath, e)
        }
    }

    override fun write(rootUri: Uri, relativePath: String, offset: Long, data: ByteArray) {
        // Handle file:// URIs with native File I/O
        if (isFileUri(rootUri)) {
            return writeNative(rootUri, relativePath, offset, data)
        }

        try {
            val handle = getPooledSafHandle(rootUri, relativePath)
            handle.writeAt(offset, data)
        } catch (e: FileManagerException) {
            throw e
        } catch (e: Exception) {
            Log.e(TAG, "Error writing file: ${e.message}", e)
            val msg = e.message ?: ""
            when {
                msg.contains("ENOSPC") || msg.contains("No space") -> {
                    throw FileManagerException.DiskFull(relativePath)
                }
                msg.contains("EACCES") || msg.contains("EPERM") ||
                        msg.contains("Permission denied") -> {
                    throw FileManagerException.PermissionDenied(relativePath)
                }
                else -> {
                    throw FileManagerException.WriteError(relativePath, e)
                }
            }
        }
    }

    override fun exists(rootUri: Uri, relativePath: String): Boolean {
        if (isFileUri(rootUri)) {
            return existsNative(rootUri, relativePath)
        }
        return getCachedFile(rootUri, relativePath) != null
    }

    override fun getOrCreateFile(rootUri: Uri, relativePath: String): DocumentFile? {
        // Try cache first
        getCachedFile(rootUri, relativePath)?.let { return it }

        // Create if not found
        val file = createFile(rootUri, relativePath) ?: return null
        cacheFile(rootUri, relativePath, file)
        return file
    }

    override fun clearCache() {
        synchronized(cacheLock) {
            documentFileCache.clear()
        }
    }

    override fun stat(rootUri: Uri, relativePath: String): FileStat? {
        if (isFileUri(rootUri)) {
            return statNative(rootUri, relativePath)
        }
        val doc = resolvePath(rootUri, relativePath) ?: return null
        return FileStat(
            size = doc.length(),
            mtime = doc.lastModified(),
            isDirectory = doc.isDirectory,
            isFile = doc.isFile,
        )
    }

    override fun mkdir(rootUri: Uri, relativePath: String): Boolean {
        if (isFileUri(rootUri)) {
            return mkdirNative(rootUri, relativePath)
        }
        if (relativePath.isEmpty() || relativePath == "/") {
            // Root already exists
            return true
        }

        var current = DocumentFile.fromTreeUri(context, rootUri) ?: return false

        val segments = relativePath.trimStart('/').split('/').filter { it.isNotEmpty() }
        for (segment in segments) {
            val existing = current.findFile(segment)
            current = when {
                existing?.isDirectory == true -> existing
                existing != null -> return false // File exists, not a directory
                else -> current.createDirectory(segment) ?: return false
            }
        }
        return true
    }

    override fun readdir(rootUri: Uri, relativePath: String): List<String> {
        if (isFileUri(rootUri)) {
            return readdirNative(rootUri, relativePath)
        }
        val doc = resolvePath(rootUri, relativePath) ?: return emptyList()
        if (!doc.isDirectory) return emptyList()
        return doc.listFiles().mapNotNull { it.name }
    }

    override fun listTree(rootUri: Uri, relativePath: String): List<FileTreeEntry> {
        if (isFileUri(rootUri)) {
            return listTreeNative(rootUri, relativePath)
        }
        return listTreeSaf(rootUri, relativePath)
    }

    override fun verifyChunks(
        rootUri: Uri,
        files: List<VerifyChunksFile>,
        chunkSize: Long,
        hashes: ByteArray,
        startChunk: Long,
        chunkCount: Long,
    ): ByteArray {
        val MATCH: Byte = 0
        val MISMATCH: Byte = 1
        val IO_ERROR: Byte = 2

        val count = chunkCount.toInt()
        val results = ByteArray(count)
        val totalLength = files.sumOf { it.length }

        // Cumulative end offsets
        val fileEnds = LongArray(files.size)
        var cum = 0L
        for (i in files.indices) {
            cum += files[i].length
            fileEnds[i] = cum
        }

        val md = java.security.MessageDigest.getInstance("SHA-1")
        val readBufSize = minOf(chunkSize, 256L * 1024L).toInt()

        var streamPos = startChunk * chunkSize
        var curFileIdx = 0

        // Skip to starting file
        while (curFileIdx < files.size && streamPos >= fileEnds[curFileIdx]) {
            curFileIdx++
        }

        for (chunkI in 0 until count) {
            val chunkLen = minOf(chunkSize, (totalLength - streamPos).coerceAtLeast(0))

            if (chunkLen == 0L) {
                results[chunkI] = IO_ERROR
                streamPos += chunkSize
                continue
            }

            md.reset()
            var bytesHashed = 0L
            var ioError = false

            while (bytesHashed < chunkLen && !ioError) {
                if (curFileIdx >= files.size) {
                    ioError = true
                    break
                }

                val fileStart = if (curFileIdx > 0) fileEnds[curFileIdx - 1] else 0L
                val posInFile = streamPos + bytesHashed - fileStart
                val fileRemaining = files[curFileIdx].length - posInFile
                val chunkRemaining = chunkLen - bytesHashed
                val toRead = minOf(fileRemaining, chunkRemaining, readBufSize.toLong()).toInt()

                if (toRead == 0) {
                    curFileIdx++
                    continue
                }

                try {
                    val data = read(rootUri, files[curFileIdx].path, posInFile, toRead)
                    md.update(data, 0, data.size)
                    bytesHashed += data.size

                    if (posInFile + data.size >= files[curFileIdx].length) {
                        curFileIdx++
                    }
                } catch (e: Exception) {
                    ioError = true
                }
            }

            if (ioError) {
                results[chunkI] = IO_ERROR
                streamPos += chunkSize
                curFileIdx = 0
                while (curFileIdx < files.size && streamPos >= fileEnds[curFileIdx]) {
                    curFileIdx++
                }
            } else {
                val actualHash = md.digest()
                val expectedHash = hashes.copyOfRange(chunkI * 20, (chunkI + 1) * 20)
                results[chunkI] = if (actualHash.contentEquals(expectedHash)) MATCH else MISMATCH
                streamPos += chunkSize
            }
        }

        return results
    }

    override fun delete(rootUri: Uri, relativePath: String): Boolean {
        if (isFileUri(rootUri)) {
            return deleteNative(rootUri, relativePath)
        }

        // Close any pooled handle for this file before deleting
        val cacheKey = "$rootUri|$relativePath"
        safHandleLock.withLock {
            safHandlePool.remove(cacheKey)?.close()
        }

        val doc = resolvePath(rootUri, relativePath) ?: return false
        val deleted = doc.delete()
        if (deleted) {
            // Invalidate cache entries for this path and descendants
            val cachePrefix = "$rootUri|$relativePath"
            synchronized(cacheLock) {
                documentFileCache.keys.removeAll { it.startsWith(cachePrefix) }
            }
            // Also close any handles for descendants
            safHandleLock.withLock {
                val toClose = safHandlePool.keys.filter { it.startsWith(cachePrefix) }
                for (key in toClose) {
                    safHandlePool.remove(key)?.close()
                }
            }
        }
        return deleted
    }

    // =========================================================================
    // Internal helpers
    // =========================================================================

    /**
     * Get a cached DocumentFile, or resolve and cache it if not in cache.
     * Returns null if file doesn't exist.
     */
    private fun getCachedFile(rootUri: Uri, relativePath: String): DocumentFile? {
        val cacheKey = "$rootUri|$relativePath"

        // Get cached entry without holding lock during SAF calls
        val cached = synchronized(cacheLock) {
            documentFileCache[cacheKey]
        }

        // Verify it still exists (SAF call - do NOT hold lock)
        if (cached != null) {
            if (cached.exists()) {
                return cached
            } else {
                // Stale entry - remove from cache
                synchronized(cacheLock) {
                    documentFileCache.remove(cacheKey)
                }
            }
        }

        // Cache miss - do the traversal (no lock held)
        val file = resolveFile(rootUri, relativePath)
        if (file != null) {
            synchronized(cacheLock) {
                documentFileCache[cacheKey] = file
            }
        }
        return file
    }

    /**
     * Add a file to the cache.
     */
    private fun cacheFile(rootUri: Uri, relativePath: String, file: DocumentFile) {
        val cacheKey = "$rootUri|$relativePath"
        synchronized(cacheLock) {
            documentFileCache[cacheKey] = file
        }
    }

    /**
     * Resolve a relative path under a SAF tree URI to a DocumentFile (file only).
     * Returns null if path doesn't exist or is not a file.
     */
    private fun resolveFile(rootUri: Uri, relativePath: String): DocumentFile? {
        val doc = resolvePath(rootUri, relativePath) ?: return null
        return if (doc.isFile) doc else null
    }

    /**
     * Resolve a relative path under a SAF tree URI to a DocumentFile (file or directory).
     * Returns null if path doesn't exist.
     */
    private fun resolvePath(rootUri: Uri, relativePath: String): DocumentFile? {
        var current = DocumentFile.fromTreeUri(context, rootUri) ?: return null

        if (relativePath.isEmpty() || relativePath == "/") {
            return current
        }

        val segments = relativePath.trimStart('/').split('/').filter { it.isNotEmpty() }
        for (segment in segments) {
            current = current.findFile(segment) ?: return null
        }

        return current
    }

    /**
     * Create a file at the given path under a SAF tree.
     * Creates parent directories as needed.
     */
    private fun createFile(rootUri: Uri, relativePath: String): DocumentFile? {
        var current = DocumentFile.fromTreeUri(context, rootUri) ?: return null

        val segments = relativePath.trimStart('/').split('/')
        val fileName = segments.lastOrNull() ?: return null
        val dirSegments = segments.dropLast(1)

        // Create/navigate directories
        for (segment in dirSegments) {
            val existing = current.findFile(segment)
            current = if (existing != null && existing.isDirectory) {
                existing
            } else {
                current.createDirectory(segment) ?: return null
            }
        }

        // Get or create file
        val existingFile = current.findFile(fileName)
        return if (existingFile != null && existingFile.isFile) {
            existingFile
        } else {
            // Guess MIME type from extension
            val mimeType = guessMimeType(fileName)
            current.createFile(mimeType, fileName)
        }
    }

    /**
     * Guess MIME type from file extension.
     */
    private fun guessMimeType(fileName: String): String {
        return when {
            fileName.endsWith(".mp4") -> "video/mp4"
            fileName.endsWith(".mkv") -> "video/x-matroska"
            fileName.endsWith(".avi") -> "video/x-msvideo"
            fileName.endsWith(".mp3") -> "audio/mpeg"
            fileName.endsWith(".flac") -> "audio/flac"
            fileName.endsWith(".zip") -> "application/zip"
            fileName.endsWith(".rar") -> "application/x-rar-compressed"
            fileName.endsWith(".torrent") -> "application/x-bittorrent"
            else -> "application/octet-stream"
        }
    }

    // =========================================================================
    // SAF Handle Pool helpers
    // =========================================================================

    /**
     * Get or create a pooled SAF file handle.
     * Creates file and parent directories if needed.
     */
    private fun getPooledSafHandle(rootUri: Uri, relativePath: String): PooledSafHandle {
        val cacheKey = "$rootUri|$relativePath"

        safHandleLock.withLock {
            // Check if already in pool
            safHandlePool[cacheKey]?.let { return it }

            // Evict idle handles if pool is full
            maybeEvictSafHandles()

            // Get or create the DocumentFile (release lock during SAF operations)
        }

        // Do file creation outside the pool lock to avoid holding lock during SAF calls
        var file = getCachedFile(rootUri, relativePath)
        if (file == null) {
            // Use per-path lock to prevent race during file creation
            val lock = creationLocks.computeIfAbsent(cacheKey) { ReentrantLock() }
            lock.withLock {
                file = getCachedFile(rootUri, relativePath)
                if (file == null) {
                    file = createFile(rootUri, relativePath)
                        ?: throw FileManagerException.CannotCreateFile(relativePath)
                    cacheFile(rootUri, relativePath, file)
                }
            }
            if (!lock.hasQueuedThreads()) {
                creationLocks.remove(cacheKey, lock)
            }
        }

        // Open ParcelFileDescriptor in read-write mode
        val pfd = context.contentResolver.openFileDescriptor(file!!.uri, "rw")
            ?: throw FileManagerException.CannotOpenFile(relativePath)

        val handle = PooledSafHandle(cacheKey, pfd)

        // Add to pool with lock
        safHandleLock.withLock {
            // Check again if another thread added it while we were creating
            safHandlePool[cacheKey]?.let {
                // Another thread beat us, close our handle and use theirs
                handle.close()
                return it
            }
            safHandlePool[cacheKey] = handle
        }

        return handle
    }

    /**
     * Get a pooled SAF file handle for reading only.
     * Does NOT create the file - throws FileNotFound if file doesn't exist.
     * This is used by read() to avoid creating empty files during recheck.
     */
    private fun getPooledSafHandleForRead(rootUri: Uri, relativePath: String): PooledSafHandle {
        val cacheKey = "$rootUri|$relativePath"

        safHandleLock.withLock {
            // Check if already in pool
            safHandlePool[cacheKey]?.let { return it }

            // Evict idle handles if pool is full
            maybeEvictSafHandles()
        }

        // Check if file exists (do NOT create it)
        val file = getCachedFile(rootUri, relativePath)
            ?: throw FileManagerException.FileNotFound(relativePath)

        // Open ParcelFileDescriptor in read-write mode (for pool compatibility)
        // Using "rw" allows the handle to be reused for writes later
        val pfd = context.contentResolver.openFileDescriptor(file.uri, "rw")
            ?: throw FileManagerException.CannotOpenFile(relativePath)

        val handle = PooledSafHandle(cacheKey, pfd)

        // Add to pool with lock
        safHandleLock.withLock {
            // Check again if another thread added it while we were creating
            safHandlePool[cacheKey]?.let {
                // Another thread beat us, close our handle and use theirs
                handle.close()
                return it
            }
            safHandlePool[cacheKey] = handle
        }

        return handle
    }

    /**
     * Evict SAF handles that haven't been used recently or if pool is too large.
     * Must be called with safHandleLock held.
     */
    private fun maybeEvictSafHandles() {
        val now = System.currentTimeMillis()

        // Only check every second
        if (now - lastSafEvictionCheck < 1000) return
        lastSafEvictionCheck = now

        val toEvict = mutableListOf<String>()

        for ((key, handle) in safHandlePool) {
            if (now - handle.lastAccessTime > handleIdleTimeoutMs) {
                toEvict.add(key)
            }
        }

        // Also evict oldest if over capacity
        while (safHandlePool.size - toEvict.size >= maxFileHandles) {
            val oldest = safHandlePool.entries.firstOrNull { it.key !in toEvict }
            if (oldest != null) {
                toEvict.add(oldest.key)
            } else {
                break
            }
        }

        for (key in toEvict) {
            safHandlePool.remove(key)?.close()
        }

        if (toEvict.isNotEmpty()) {
            Log.d(TAG, "Evicted ${toEvict.size} SAF handles, pool size: ${safHandlePool.size}")
        }
    }

    // =========================================================================
    // Native File I/O helpers (for file:// URIs)
    // =========================================================================

    /**
     * Resolve a file:// URI + relative path to a File object.
     */
    private fun resolveNativeFile(rootUri: Uri, relativePath: String): File {
        val root = uriToFile(rootUri) ?: throw FileManagerException.CannotOpenFile(relativePath)
        return if (relativePath.isEmpty() || relativePath == "/") {
            root
        } else {
            File(root, relativePath.trimStart('/'))
        }
    }

    /**
     * Get or create a pooled file handle for the given file.
     * Creates parent directories and file if needed.
     *
     * Periodically validates that cached handles still point to existing files
     * to detect external deletion (e.g., user deleted files via file manager).
     */
    private fun getPooledHandle(file: File, createIfMissing: Boolean): PooledFileHandle {
        val path = file.absolutePath
        val now = System.currentTimeMillis()

        fileHandleLock.withLock {
            // Check if already in pool
            val cached = fileHandlePool[path]
            if (cached != null) {
                // Only validate existence periodically (every 10s) to avoid stat() overhead
                // This catches external deletion without impacting normal download performance
                val needsValidation = now - cached.lastValidationTime > 10_000
                if (needsValidation) {
                    if (file.exists()) {
                        cached.lastValidationTime = now
                        return cached
                    } else {
                        // File was deleted externally - close stale handle
                        Log.d(TAG, "Closing stale handle for deleted file: $path")
                        fileHandlePool.remove(path)?.close()
                    }
                } else {
                    // Recently validated, trust the cache
                    return cached
                }
            }

            // Evict idle handles if pool is full
            maybeEvictHandles()

            // Create parent directories if needed
            if (createIfMissing) {
                file.parentFile?.mkdirs()
            }

            // Open new handle
            val raf = RandomAccessFile(file, "rw")
            val handle = PooledFileHandle(path, raf)
            fileHandlePool[path] = handle
            return handle
        }
    }

    /**
     * Pre-allocate file to avoid per-write block allocation overhead.
     * This is a no-op if the file is already at least the requested size.
     */
    fun preallocate(rootUri: Uri, relativePath: String, size: Long) {
        if (!isFileUri(rootUri)) {
            // SAF doesn't support pre-allocation
            return
        }
        val file = resolveNativeFile(rootUri, relativePath)
        try {
            file.parentFile?.mkdirs()
            val handle = getPooledHandle(file, createIfMissing = true)
            if (file.length() < size) {
                handle.raf.setLength(size)
                Log.d(TAG, "Pre-allocated ${size / (1024 * 1024)}MB for ${file.name}")
            }
        } catch (e: Exception) {
            Log.w(TAG, "Pre-allocation failed for $relativePath: ${e.message}")
        }
    }

    /**
     * Evict handles that haven't been used recently or if pool is too large.
     */
    private fun maybeEvictHandles() {
        val now = System.currentTimeMillis()

        // Only check every second
        if (now - lastEvictionCheck < 1000) return
        lastEvictionCheck = now

        val toEvict = mutableListOf<String>()

        for ((path, handle) in fileHandlePool) {
            // Evict if idle too long
            if (now - handle.lastAccessTime > handleIdleTimeoutMs) {
                toEvict.add(path)
            }
        }

        // Also evict oldest if over capacity
        while (fileHandlePool.size - toEvict.size >= maxFileHandles) {
            val oldest = fileHandlePool.entries.firstOrNull { it.key !in toEvict }
            if (oldest != null) {
                toEvict.add(oldest.key)
            } else {
                break
            }
        }

        for (path in toEvict) {
            fileHandlePool.remove(path)?.close()
        }

        if (toEvict.isNotEmpty()) {
            Log.d(TAG, "Evicted ${toEvict.size} file handles, pool size: ${fileHandlePool.size}")
        }
    }

    /**
     * Close all pooled file handles (both native and SAF).
     */
    fun closeAllHandles() {
        fileHandleLock.withLock {
            for ((_, handle) in fileHandlePool) {
                handle.close()
            }
            fileHandlePool.clear()
        }

        safHandleLock.withLock {
            for ((_, handle) in safHandlePool) {
                handle.close()
            }
            safHandlePool.clear()
        }

        Log.d(TAG, "Closed all file handles")
    }

    private fun readNative(rootUri: Uri, relativePath: String, offset: Long, length: Int): ByteArray {
        val file = resolveNativeFile(rootUri, relativePath)
        if (!file.exists()) {
            throw FileManagerException.FileNotFound(relativePath)
        }
        try {
            // Use pooled handle for reads too
            val handle = getPooledHandle(file, createIfMissing = false)
            return handle.readAt(offset, length)
        } catch (e: FileManagerException) {
            throw e
        } catch (e: IllegalStateException) {
            throw FileManagerException.InsufficientData(relativePath, length, 0)
        } catch (e: Exception) {
            Log.e(TAG, "Native read failed: ${e.message}", e)
            throw FileManagerException.ReadError(relativePath, e)
        }
    }

    private fun writeNative(rootUri: Uri, relativePath: String, offset: Long, data: ByteArray) {
        val file = resolveNativeFile(rootUri, relativePath)
        try {
            val handle = getPooledHandle(file, createIfMissing = true)
            handle.writeAt(offset, data)
        } catch (e: Exception) {
            Log.e(TAG, "Native write failed: ${e.message}", e)
            when {
                e.message?.contains("ENOSPC") == true ||
                        e.message?.contains("No space") == true -> {
                    throw FileManagerException.DiskFull(relativePath)
                }
                else -> {
                    throw FileManagerException.WriteError(relativePath, e)
                }
            }
        }
    }

    private fun existsNative(rootUri: Uri, relativePath: String): Boolean {
        return resolveNativeFile(rootUri, relativePath).exists()
    }

    private fun statNative(rootUri: Uri, relativePath: String): FileStat? {
        val file = resolveNativeFile(rootUri, relativePath)
        if (!file.exists()) return null
        return FileStat(
            size = file.length(),
            mtime = file.lastModified(),
            isDirectory = file.isDirectory,
            isFile = file.isFile,
        )
    }

    private fun mkdirNative(rootUri: Uri, relativePath: String): Boolean {
        if (relativePath.isEmpty() || relativePath == "/") {
            return true
        }
        val dir = resolveNativeFile(rootUri, relativePath)
        return dir.exists() || dir.mkdirs()
    }

    private fun readdirNative(rootUri: Uri, relativePath: String): List<String> {
        val dir = resolveNativeFile(rootUri, relativePath)
        if (!dir.isDirectory) return emptyList()
        return dir.listFiles()?.mapNotNull { it.name } ?: emptyList()
    }

    private fun deleteNative(rootUri: Uri, relativePath: String): Boolean {
        val file = resolveNativeFile(rootUri, relativePath)
        if (!file.exists()) return false

        // Close any pooled handles for this path (and descendants if directory) before deleting
        val pathToClose = file.absolutePath
        fileHandleLock.withLock {
            if (file.isDirectory) {
                // For directories, close all handles under this path
                val toClose = fileHandlePool.keys.filter { it.startsWith(pathToClose) }
                for (key in toClose) {
                    fileHandlePool.remove(key)?.close()
                }
                if (toClose.isNotEmpty()) {
                    Log.d(TAG, "Closed ${toClose.size} pooled handles before directory delete: $relativePath")
                }
            } else {
                // For single file, just close its handle
                fileHandlePool.remove(pathToClose)?.close()
            }
        }

        return if (file.isDirectory) {
            file.deleteRecursively()
        } else {
            file.delete()
        }
    }

    private fun listTreeNative(rootUri: Uri, relativePath: String): List<FileTreeEntry> {
        val dir = resolveNativeFile(rootUri, relativePath)
        if (!dir.isDirectory) return emptyList()
        val results = mutableListOf<FileTreeEntry>()
        walkNativeTree(dir, "", results)
        return results
    }

    private fun walkNativeTree(dir: File, prefix: String, results: MutableList<FileTreeEntry>) {
        val children = dir.listFiles() ?: return
        for (child in children) {
            val relative = if (prefix.isEmpty()) child.name else "$prefix/${child.name}"
            if (child.isDirectory) {
                walkNativeTree(child, relative, results)
            } else if (child.isFile) {
                results.add(FileTreeEntry(relative, child.length()))
            }
        }
    }

    private fun listTreeSaf(rootUri: Uri, relativePath: String): List<FileTreeEntry> {
        val startDocId = if (relativePath.isEmpty() || relativePath == "/") {
            DocumentsContract.getTreeDocumentId(rootUri)
        } else {
            val doc = resolvePath(rootUri, relativePath) ?: return emptyList()
            if (!doc.isDirectory) return emptyList()
            DocumentsContract.getDocumentId(doc.uri)
        }

        val results = mutableListOf<FileTreeEntry>()
        walkSafTree(rootUri, startDocId, "", results)
        return results
    }

    private fun walkSafTree(
        treeUri: Uri,
        parentDocId: String,
        prefix: String,
        results: MutableList<FileTreeEntry>
    ) {
        val childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId)
        context.contentResolver.query(
            childrenUri,
            arrayOf(
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            ),
            null, null, null
        )?.use { cursor ->
            val idIdx = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DOCUMENT_ID)
            val nameIdx = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_DISPLAY_NAME)
            val sizeIdx = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_SIZE)
            val mimeIdx = cursor.getColumnIndexOrThrow(DocumentsContract.Document.COLUMN_MIME_TYPE)

            while (cursor.moveToNext()) {
                val docId = cursor.getString(idIdx) ?: continue
                val name = cursor.getString(nameIdx) ?: continue
                val size = cursor.getLong(sizeIdx)
                val mimeType = cursor.getString(mimeIdx)
                val relative = if (prefix.isEmpty()) name else "$prefix/$name"

                if (mimeType == DocumentsContract.Document.MIME_TYPE_DIR) {
                    walkSafTree(treeUri, docId, relative, results)
                } else {
                    results.add(FileTreeEntry(relative, size))
                }
            }
        }
    }
}
