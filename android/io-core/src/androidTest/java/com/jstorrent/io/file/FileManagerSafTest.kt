package com.jstorrent.io.file

import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Tests for FileManagerImpl operations via SAF (content://) URIs.
 *
 * Uses [DuplicatingDocumentsProvider] to exercise the SAF code path without
 * requiring external storage permissions. This catches bugs that only manifest
 * with content:// URIs (not file:// URIs), such as exists() not recognizing
 * directories.
 */
@RunWith(AndroidJUnit4::class)
class FileManagerSafTest {

    private lateinit var fileManager: FileManagerImpl

    private val safTreeUri = Uri.parse(
        "content://${DuplicatingDocumentsProvider.AUTHORITY}/tree/${DuplicatingDocumentsProvider.ROOT_ID}"
    )

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        fileManager = FileManagerImpl(context)
        cleanSafTestDir()
    }

    @After
    fun tearDown() {
        fileManager.closeAllHandles()
        cleanSafTestDir()
    }

    private fun cleanSafTestDir() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = DocumentFile.fromTreeUri(context, safTreeUri) ?: return
        root.listFiles().forEach { it.delete() }
    }

    // =========================================================================
    // exists() tests
    // =========================================================================

    @Test
    fun existsReturnsTrueForFile() {
        val testData = ByteArray(64) { it.toByte() }
        fileManager.write(safTreeUri, "test-file.bin", 0L, testData)

        assertTrue("exists() should return true for a file", fileManager.exists(safTreeUri, "test-file.bin"))
    }

    @Test
    fun existsReturnsFalseForMissingFile() {
        assertFalse("exists() should return false for missing file", fileManager.exists(safTreeUri, "no-such-file.bin"))
    }

    @Test
    fun existsReturnsTrueForDirectory() {
        fileManager.mkdir(safTreeUri, "test-dir")

        assertTrue("exists() should return true for a directory", fileManager.exists(safTreeUri, "test-dir"))
    }

    @Test
    fun existsReturnsFalseForMissingDirectory() {
        assertFalse("exists() should return false for missing dir", fileManager.exists(safTreeUri, "no-such-dir"))
    }

    @Test
    fun existsReturnsTrueForNestedDirectory() {
        fileManager.mkdir(safTreeUri, "parent/child/grandchild")

        assertTrue("exists() should find nested dir", fileManager.exists(safTreeUri, "parent/child/grandchild"))
        assertTrue("exists() should find intermediate dir", fileManager.exists(safTreeUri, "parent/child"))
        assertTrue("exists() should find top dir", fileManager.exists(safTreeUri, "parent"))
    }

    @Test
    fun existsReturnsTrueForFileInDirectory() {
        val testData = ByteArray(32) { it.toByte() }
        fileManager.write(safTreeUri, "dir/nested-file.bin", 0L, testData)

        assertTrue("exists() should find the directory", fileManager.exists(safTreeUri, "dir"))
        assertTrue("exists() should find the file", fileManager.exists(safTreeUri, "dir/nested-file.bin"))
    }

    // =========================================================================
    // batchDelete() tests
    // =========================================================================

    @Test
    fun batchDeleteRemovesFiles() {
        val testData = ByteArray(32) { it.toByte() }
        fileManager.write(safTreeUri, "batch-dir/file1.bin", 0L, testData)
        fileManager.write(safTreeUri, "batch-dir/file2.bin", 0L, testData)
        fileManager.write(safTreeUri, "batch-dir/file3.bin", 0L, testData)

        val failed = fileManager.batchDelete(safTreeUri, "batch-dir", listOf("file1.bin", "file2.bin", "file3.bin"))

        assertEquals("No files should fail to delete", emptyList<String>(), failed)
        assertFalse("file1 should be gone", fileManager.exists(safTreeUri, "batch-dir/file1.bin"))
        assertFalse("file2 should be gone", fileManager.exists(safTreeUri, "batch-dir/file2.bin"))
        assertFalse("file3 should be gone", fileManager.exists(safTreeUri, "batch-dir/file3.bin"))
    }

    @Test
    fun batchDeleteIgnoresMissingEntries() {
        val testData = ByteArray(32) { it.toByte() }
        fileManager.write(safTreeUri, "sparse-dir/exists.bin", 0L, testData)

        val failed = fileManager.batchDelete(safTreeUri, "sparse-dir", listOf("exists.bin", "missing.bin"))

        assertEquals("Missing entries should not be reported as failures", emptyList<String>(), failed)
        assertFalse("existing file should be deleted", fileManager.exists(safTreeUri, "sparse-dir/exists.bin"))
    }

    @Test
    fun batchDeleteRemovesEmptySubdirectory() {
        val testData = ByteArray(32) { it.toByte() }
        fileManager.write(safTreeUri, "parent/sub/file.bin", 0L, testData)

        // First delete the file inside the subdirectory
        fileManager.batchDelete(safTreeUri, "parent/sub", listOf("file.bin"))
        // Then delete the now-empty subdirectory from its parent
        val failed = fileManager.batchDelete(safTreeUri, "parent", listOf("sub"))

        assertEquals("Empty subdir should be deletable", emptyList<String>(), failed)
        assertFalse("subdir should be gone", fileManager.exists(safTreeUri, "parent/sub"))
    }
}
