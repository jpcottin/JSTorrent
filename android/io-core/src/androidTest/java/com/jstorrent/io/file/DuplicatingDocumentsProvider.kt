package com.jstorrent.io.file

import android.database.Cursor
import android.database.MatrixCursor
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.DocumentsContract.Document
import android.provider.DocumentsContract.Root
import android.util.Log
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileNotFoundException

/**
 * A test DocumentsProvider that mimics the ExternalStorageProvider's directory
 * deduplication behavior. When createDocument() is called for a directory name
 * that already exists, it appends " (1)", " (2)", etc. — exactly like the real
 * ExternalStorageProvider does via AOSP's FileUtils.buildUniqueFile().
 *
 * This allows instrumented tests to exercise FileManagerImpl's findOrCreateDirectory()
 * code path with real content:// URIs, reproducing the race condition that causes
 * duplicate directories on real SAF without needing external storage permissions.
 *
 * Authority: com.jstorrent.io.test.documents
 * Root ID: test
 * Tree URI: content://com.jstorrent.io.test.documents/tree/test
 */
class DuplicatingDocumentsProvider : android.provider.DocumentsProvider() {

    companion object {
        const val AUTHORITY = "com.jstorrent.io.test.documents"
        const val ROOT_ID = "test"
        private const val TAG = "DuplicatingDocsProvider"

        private val DEFAULT_ROOT_PROJECTION = arrayOf(
            Root.COLUMN_ROOT_ID,
            Root.COLUMN_FLAGS,
            Root.COLUMN_TITLE,
            Root.COLUMN_DOCUMENT_ID,
        )

        private val DEFAULT_DOCUMENT_PROJECTION = arrayOf(
            Document.COLUMN_DOCUMENT_ID,
            Document.COLUMN_DISPLAY_NAME,
            Document.COLUMN_MIME_TYPE,
            Document.COLUMN_SIZE,
            Document.COLUMN_LAST_MODIFIED,
            Document.COLUMN_FLAGS,
        )
    }

    private lateinit var baseDir: File

    override fun onCreate(): Boolean {
        baseDir = File(context!!.filesDir, "test_documents_provider")
        baseDir.mkdirs()
        Log.i(TAG, "Provider created, baseDir=${baseDir.absolutePath}")
        return true
    }

    /** Map a document ID to a File. Root doc ID is "test". */
    private fun docIdToFile(documentId: String): File {
        return if (documentId == ROOT_ID) baseDir
        else File(baseDir, documentId)
    }

    /** Map a File back to a document ID. */
    private fun fileToDocId(file: File): String {
        val path = file.toRelativeString(baseDir)
        return if (path == ".") ROOT_ID else path
    }

    override fun queryRoots(projection: Array<out String>?): Cursor {
        val result = MatrixCursor(projection ?: DEFAULT_ROOT_PROJECTION)
        result.newRow().apply {
            add(Root.COLUMN_ROOT_ID, ROOT_ID)
            add(Root.COLUMN_FLAGS, Root.FLAG_SUPPORTS_CREATE or Root.FLAG_LOCAL_ONLY)
            add(Root.COLUMN_TITLE, "Test Storage")
            add(Root.COLUMN_DOCUMENT_ID, ROOT_ID)
        }
        return result
    }

    override fun queryDocument(documentId: String, projection: Array<out String>?): Cursor {
        val result = MatrixCursor(projection ?: DEFAULT_DOCUMENT_PROJECTION)
        val file = docIdToFile(documentId)
        addFileRow(result, file)
        return result
    }

    override fun queryChildDocuments(
        parentDocumentId: String,
        projection: Array<out String>?,
        sortOrder: String?
    ): Cursor {
        val result = MatrixCursor(projection ?: DEFAULT_DOCUMENT_PROJECTION)
        val parent = docIdToFile(parentDocumentId)
        parent.listFiles()?.forEach { file ->
            addFileRow(result, file)
        }
        return result
    }

    private fun addFileRow(cursor: MatrixCursor, file: File) {
        val docId = fileToDocId(file)
        val mimeType = if (file.isDirectory) Document.MIME_TYPE_DIR
        else getMimeType(file.name)
        val flags = if (file.isDirectory) {
            Document.FLAG_DIR_SUPPORTS_CREATE or Document.FLAG_SUPPORTS_DELETE
        } else {
            Document.FLAG_SUPPORTS_WRITE or Document.FLAG_SUPPORTS_DELETE
        }

        cursor.newRow().apply {
            add(Document.COLUMN_DOCUMENT_ID, docId)
            add(Document.COLUMN_DISPLAY_NAME, file.name)
            add(Document.COLUMN_MIME_TYPE, mimeType)
            add(Document.COLUMN_SIZE, if (file.isFile) file.length() else 0L)
            add(Document.COLUMN_LAST_MODIFIED, file.lastModified())
            add(Document.COLUMN_FLAGS, flags)
        }
    }

    override fun openDocument(
        documentId: String,
        mode: String,
        signal: CancellationSignal?
    ): ParcelFileDescriptor {
        val file = docIdToFile(documentId)
        val accessMode = ParcelFileDescriptor.parseMode(mode)
        return ParcelFileDescriptor.open(file, accessMode)
    }

    /**
     * Create a new document. For directories, this mimics ExternalStorageProvider's
     * deduplication: if a directory with the same display name already exists in the
     * parent, the new directory gets a suffixed name like "name (1)", "name (2)", etc.
     *
     * This is the exact behavior that causes the SAF race condition bug — two threads
     * both calling createDocument for the same directory name both succeed, but the
     * second one gets a deduplicated name.
     */
    override fun createDocument(
        parentDocumentId: String,
        mimeType: String,
        displayName: String
    ): String {
        val parent = docIdToFile(parentDocumentId)
        val isDir = mimeType == Document.MIME_TYPE_DIR

        // Mimic AOSP FileUtils.buildUniqueFile() deduplication
        val target = buildUniqueFile(parent, displayName, isDir)

        val success = if (isDir) target.mkdir() else target.createNewFile()
        if (!success) {
            throw FileNotFoundException("Failed to create ${if (isDir) "directory" else "file"}: ${target.absolutePath}")
        }

        val docId = fileToDocId(target)
        Log.d(TAG, "createDocument: parent=$parentDocumentId, requested=$displayName, " +
            "actual=${target.name}, docId=$docId")

        // Notify the system of the change
        val parentUri = DocumentsContract.buildChildDocumentsUri(AUTHORITY, parentDocumentId)
        context?.contentResolver?.notifyChange(parentUri, null)

        return docId
    }

    override fun deleteDocument(documentId: String) {
        val file = docIdToFile(documentId)
        if (file.isDirectory) {
            file.deleteRecursively()
        } else {
            file.delete()
        }
        // Notify parent
        val parentDocId = file.parentFile?.let { fileToDocId(it) } ?: ROOT_ID
        val parentUri = DocumentsContract.buildChildDocumentsUri(AUTHORITY, parentDocId)
        context?.contentResolver?.notifyChange(parentUri, null)
    }

    override fun isChildDocument(parentDocumentId: String, documentId: String): Boolean {
        val parent = docIdToFile(parentDocumentId)
        val child = docIdToFile(documentId)
        return child.absolutePath.startsWith(parent.absolutePath + File.separator)
    }

    /**
     * Mimic AOSP's FileUtils.buildUniqueFile(): if a file/directory with
     * [displayName] already exists in [parent], append " (1)", " (2)", etc.
     * until a unique name is found.
     *
     * This intentionally does NOT lock — the real ExternalStorageProvider doesn't
     * either, which is why the race condition exists.
     */
    private fun buildUniqueFile(parent: File, displayName: String, isDir: Boolean): File {
        var candidate = File(parent, displayName)
        if (!candidate.exists()) return candidate

        // Deduplicate with " (N)" suffix, just like AOSP
        var n = 1
        while (true) {
            val name = if (isDir) {
                "$displayName ($n)"
            } else {
                val dot = displayName.lastIndexOf('.')
                if (dot >= 0) {
                    "${displayName.substring(0, dot)} ($n)${displayName.substring(dot)}"
                } else {
                    "$displayName ($n)"
                }
            }
            candidate = File(parent, name)
            if (!candidate.exists()) return candidate
            n++
        }
    }

    private fun getMimeType(name: String): String {
        val ext = name.substringAfterLast('.', "")
        return if (ext.isNotEmpty()) {
            MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext) ?: "application/octet-stream"
        } else {
            "application/octet-stream"
        }
    }

    /** Delete all content under the root, keeping the root directory itself. */
    fun cleanRoot() {
        baseDir.listFiles()?.forEach { it.deleteRecursively() }
    }
}
