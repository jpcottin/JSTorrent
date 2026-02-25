package com.jstorrent.io.file

import android.net.Uri
import androidx.documentfile.provider.DocumentFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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

    // =========================================================================
    // stat() tests
    // =========================================================================

    @Test
    fun statReturnsFileInfo() {
        val testData = ByteArray(42) { it.toByte() }
        fileManager.write(safTreeUri, "stat-file.bin", 0L, testData)

        val stat = fileManager.stat(safTreeUri, "stat-file.bin")
        assertNotNull("stat should return non-null for existing file", stat)
        assertEquals("size should match", 42L, stat!!.size)
        assertTrue("isFile should be true", stat.isFile)
        assertFalse("isDirectory should be false", stat.isDirectory)
    }

    @Test
    fun statReturnsDirectoryInfo() {
        fileManager.mkdir(safTreeUri, "stat-dir")

        val stat = fileManager.stat(safTreeUri, "stat-dir")
        assertNotNull("stat should return non-null for existing directory", stat)
        assertTrue("isDirectory should be true", stat!!.isDirectory)
        assertFalse("isFile should be false", stat.isFile)
    }

    @Test
    fun statReturnsNullForMissing() {
        val stat = fileManager.stat(safTreeUri, "no-such-path")
        assertNull("stat should return null for missing path", stat)
    }

    // =========================================================================
    // readdir() tests
    // =========================================================================

    @Test
    fun readdirListsDirectoryContents() {
        val testData = ByteArray(16) { it.toByte() }
        fileManager.write(safTreeUri, "ls-dir/aaa.bin", 0L, testData)
        fileManager.write(safTreeUri, "ls-dir/bbb.bin", 0L, testData)
        fileManager.mkdir(safTreeUri, "ls-dir/subdir")

        val entries = fileManager.readdir(safTreeUri, "ls-dir").sorted()
        assertEquals("Should list 3 entries", listOf("aaa.bin", "bbb.bin", "subdir"), entries)
    }

    @Test
    fun readdirReturnsEmptyForMissingDir() {
        val entries = fileManager.readdir(safTreeUri, "nonexistent")
        assertEquals("Should return empty for missing dir", emptyList<String>(), entries)
    }

    @Test
    fun readdirReturnsEmptyForFile() {
        val testData = ByteArray(16) { it.toByte() }
        fileManager.write(safTreeUri, "not-a-dir.bin", 0L, testData)

        val entries = fileManager.readdir(safTreeUri, "not-a-dir.bin")
        assertEquals("Should return empty for a file", emptyList<String>(), entries)
    }

    // =========================================================================
    // delete() tests
    // =========================================================================

    @Test
    fun deleteRemovesFile() {
        val testData = ByteArray(16) { it.toByte() }
        fileManager.write(safTreeUri, "del-file.bin", 0L, testData)
        assertTrue("file should exist before delete", fileManager.exists(safTreeUri, "del-file.bin"))

        val result = fileManager.delete(safTreeUri, "del-file.bin")
        assertTrue("delete should return true", result)
        assertFalse("file should be gone", fileManager.exists(safTreeUri, "del-file.bin"))
    }

    @Test
    fun deleteRemovesEmptyDirectory() {
        fileManager.mkdir(safTreeUri, "del-empty-dir")
        assertTrue("dir should exist", fileManager.exists(safTreeUri, "del-empty-dir"))

        val result = fileManager.delete(safTreeUri, "del-empty-dir")
        assertTrue("delete should return true", result)
        assertFalse("dir should be gone", fileManager.exists(safTreeUri, "del-empty-dir"))
    }

    @Test
    fun deleteReturnsFalseForMissing() {
        val result = fileManager.delete(safTreeUri, "no-such-thing")
        assertFalse("delete should return false for missing path", result)
    }

    // =========================================================================
    // listTree() tests
    // =========================================================================

    @Test
    fun listTreeReturnsAllFilesRecursively() {
        val testData = ByteArray(10) { it.toByte() }
        fileManager.write(safTreeUri, "tree/a.bin", 0L, testData)
        fileManager.write(safTreeUri, "tree/sub/b.bin", 0L, ByteArray(20))
        fileManager.write(safTreeUri, "tree/sub/deep/c.bin", 0L, ByteArray(30))

        val entries = fileManager.listTree(safTreeUri, "tree")
            .sortedBy { it.path }

        assertEquals("Should find 3 files", 3, entries.size)
        assertEquals("a.bin", entries[0].path)
        assertEquals(10L, entries[0].size)
        assertEquals("sub/b.bin", entries[1].path)
        assertEquals(20L, entries[1].size)
        assertEquals("sub/deep/c.bin", entries[2].path)
        assertEquals(30L, entries[2].size)
    }

    @Test
    fun listTreeReturnsEmptyForMissing() {
        val entries = fileManager.listTree(safTreeUri, "nonexistent")
        assertEquals("Should return empty for missing dir", emptyList<FileTreeEntry>(), entries)
    }

    // =========================================================================
    // read/write round-trip tests
    // =========================================================================

    @Test
    fun writeAndReadRoundTrips() {
        val testData = ByteArray(256) { (it % 256).toByte() }
        fileManager.write(safTreeUri, "rw-test.bin", 0L, testData)

        val readBack = fileManager.read(safTreeUri, "rw-test.bin", 0L, 256)
        assertArrayEquals("Read data should match written data", testData, readBack)
    }

    @Test
    fun writeAtOffsetAndReadBack() {
        fileManager.write(safTreeUri, "offset-test.bin", 0L, ByteArray(10) { 0xAA.toByte() })
        fileManager.write(safTreeUri, "offset-test.bin", 5L, ByteArray(5) { 0xBB.toByte() })

        val readBack = fileManager.read(safTreeUri, "offset-test.bin", 0L, 10)
        // First 5 bytes: 0xAA, last 5 bytes: 0xBB
        for (i in 0 until 5) assertEquals("byte $i should be 0xAA", 0xAA.toByte(), readBack[i])
        for (i in 5 until 10) assertEquals("byte $i should be 0xBB", 0xBB.toByte(), readBack[i])
    }

    @Test
    fun writeCreatesParentDirectories() {
        val testData = ByteArray(8) { it.toByte() }
        fileManager.write(safTreeUri, "auto/created/dirs/file.bin", 0L, testData)

        assertTrue("file should exist", fileManager.exists(safTreeUri, "auto/created/dirs/file.bin"))
        assertTrue("parent dir should exist", fileManager.exists(safTreeUri, "auto/created/dirs"))
        assertTrue("grandparent dir should exist", fileManager.exists(safTreeUri, "auto/created"))
    }
}
