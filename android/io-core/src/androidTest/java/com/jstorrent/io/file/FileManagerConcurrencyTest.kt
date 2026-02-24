package com.jstorrent.io.file

import android.net.Uri
import android.util.Log
import androidx.documentfile.provider.DocumentFile
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * Concurrency tests for FileManagerImpl to verify that concurrent directory
 * creation does not produce duplicates or deadlocks.
 *
 * Two categories:
 * 1. file:// URI tests — verify the locking infrastructure doesn't deadlock
 *    and concurrent operations succeed (Java's File.mkdirs() is idempotent,
 *    so these can't reproduce the SAF deduplication race).
 * 2. content:// URI test — uses [DuplicatingDocumentsProvider], a custom
 *    DocumentsProvider that mimics ExternalStorageProvider's deduplication
 *    behavior (createDirectory always creates "name (1)" if "name" exists).
 *    This exercises the real findOrCreateDirectory() SAF code path and can
 *    reproduce the race condition that the per-directory lock fixes.
 */
@RunWith(AndroidJUnit4::class)
class FileManagerConcurrencyTest {

    companion object {
        private const val TAG = "FileManagerConcurrency"
    }

    private lateinit var fileManager: FileManagerImpl
    private lateinit var testDir: File
    private lateinit var rootUri: Uri

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        fileManager = FileManagerImpl(context)

        testDir = File(context.filesDir, "concurrency_test_${System.currentTimeMillis()}")
        testDir.mkdirs()
        rootUri = Uri.parse("file://${testDir.absolutePath}")

        Log.i(TAG, "Test directory: ${testDir.absolutePath}")
    }

    @After
    fun tearDown() {
        fileManager.closeAllHandles()
        testDir.deleteRecursively()
    }

    /**
     * Multiple threads writing different files that share the same parent directory.
     * This is the torrent download scenario where e.g. "Big Buck Bunny/movie.mp4"
     * and "Big Buck Bunny/subs.srt" are written concurrently.
     */
    @Test
    fun concurrentWritesSameDirectory_noDeadlockOrDuplicates() {
        val dirName = "Shared Directory"
        val threadCount = 10
        val filesPerThread = 5
        val testData = ByteArray(1024) { it.toByte() }

        val executor = Executors.newFixedThreadPool(threadCount)
        val startLatch = CountDownLatch(1)
        val doneLatch = CountDownLatch(threadCount)
        val errors = ConcurrentLinkedQueue<Throwable>()

        for (t in 0 until threadCount) {
            executor.submit {
                try {
                    startLatch.await(5, TimeUnit.SECONDS)
                    for (f in 0 until filesPerThread) {
                        val path = "$dirName/file_t${t}_f${f}.bin"
                        fileManager.write(rootUri, path, 0L, testData)
                    }
                } catch (e: Throwable) {
                    Log.e(TAG, "Thread $t failed", e)
                    errors.add(e)
                } finally {
                    doneLatch.countDown()
                }
            }
        }

        startLatch.countDown()
        assertTrue("All threads should complete within 30s",
            doneLatch.await(30, TimeUnit.SECONDS))
        executor.shutdown()

        assertTrue("No errors expected, got: ${errors.map { it.message }}",
            errors.isEmpty())

        val sharedDir = File(testDir, dirName)
        assertTrue("Shared directory should exist", sharedDir.exists())
        assertTrue("Shared directory should be a directory", sharedDir.isDirectory)

        // Verify no duplicate directories
        val siblings = testDir.listFiles() ?: emptyArray()
        val matchingDirs = siblings.filter { it.name.startsWith(dirName) }
        assertEquals("Should have exactly one '$dirName' directory, " +
            "found: ${matchingDirs.map { it.name }}", 1, matchingDirs.size)

        // Verify all files exist
        val expectedFileCount = threadCount * filesPerThread
        val actualFiles = sharedDir.listFiles() ?: emptyArray()
        assertEquals("All $expectedFileCount files should be present",
            expectedFileCount, actualFiles.size)

        for (t in 0 until threadCount) {
            for (f in 0 until filesPerThread) {
                val file = File(sharedDir, "file_t${t}_f${f}.bin")
                assertTrue("file_t${t}_f${f}.bin should exist", file.exists())
                assertEquals("File size should match", testData.size.toLong(), file.length())
            }
        }
    }

    /**
     * Many threads all calling mkdir for the same deep path concurrently.
     */
    @Test
    fun concurrentMkdir_samePath_noDeadlock() {
        val dirPath = "deep/nested/directory/structure"
        val threadCount = 20
        val startLatch = CountDownLatch(1)
        val doneLatch = CountDownLatch(threadCount)
        val results = ConcurrentLinkedQueue<Boolean>()
        val errors = ConcurrentLinkedQueue<Throwable>()

        val executor = Executors.newFixedThreadPool(threadCount)

        for (t in 0 until threadCount) {
            executor.submit {
                try {
                    startLatch.await(5, TimeUnit.SECONDS)
                    results.add(fileManager.mkdir(rootUri, dirPath))
                } catch (e: Throwable) {
                    errors.add(e)
                } finally {
                    doneLatch.countDown()
                }
            }
        }

        startLatch.countDown()
        assertTrue("All threads should complete within 30s",
            doneLatch.await(30, TimeUnit.SECONDS))
        executor.shutdown()

        assertTrue("No errors expected", errors.isEmpty())
        assertEquals("All mkdir calls should return", threadCount, results.size)
        assertTrue("All results should be true", results.all { it })

        val dir = File(testDir, dirPath.replace('/', File.separatorChar))
        assertTrue("Directory should exist", dir.exists())
        assertTrue("Should be a directory", dir.isDirectory)
    }

    /**
     * Concurrent writes to files in deeply nested directories that share
     * intermediate path components. Exercises per-segment locking to ensure
     * intermediate directories are each created exactly once.
     */
    @Test
    fun concurrentWrites_sharedIntermediateDirectories_noDeadlock() {
        val paths = listOf(
            "torrent/season1/episode01/video.bin",
            "torrent/season1/episode01/subs.bin",
            "torrent/season1/episode02/video.bin",
            "torrent/season1/episode02/subs.bin",
            "torrent/season2/episode01/video.bin",
            "torrent/season2/episode01/subs.bin",
            "torrent/extras/behind-scenes.bin",
            "torrent/extras/trailer.bin",
        )

        val testData = ByteArray(512) { it.toByte() }
        val startLatch = CountDownLatch(1)
        val doneLatch = CountDownLatch(paths.size)
        val errors = ConcurrentLinkedQueue<Throwable>()

        val executor = Executors.newFixedThreadPool(paths.size)

        for ((idx, path) in paths.withIndex()) {
            executor.submit {
                try {
                    startLatch.await(5, TimeUnit.SECONDS)
                    fileManager.write(rootUri, path, 0L, testData)
                } catch (e: Throwable) {
                    Log.e(TAG, "Thread $idx ($path) failed", e)
                    errors.add(e)
                } finally {
                    doneLatch.countDown()
                }
            }
        }

        startLatch.countDown()
        assertTrue("All threads should complete within 30s",
            doneLatch.await(30, TimeUnit.SECONDS))
        executor.shutdown()

        assertTrue("No errors: ${errors.map { it.message }}", errors.isEmpty())

        for (path in paths) {
            val file = File(testDir, path)
            assertTrue("$path should exist", file.exists())
            assertEquals("$path size", testData.size.toLong(), file.length())
        }

        assertNoDuplicateDirectories(testDir)
    }

    /**
     * Mix of concurrent write and mkdir calls for overlapping paths.
     * write() creates directories implicitly; mkdir() creates them explicitly.
     */
    @Test
    fun concurrentWriteAndMkdir_noDeadlock() {
        val sharedDir = "shared/path"
        val threadCount = 10
        val startLatch = CountDownLatch(1)
        val doneLatch = CountDownLatch(threadCount * 2)
        val errors = ConcurrentLinkedQueue<Throwable>()
        val testData = ByteArray(256) { it.toByte() }

        val executor = Executors.newFixedThreadPool(threadCount * 2)

        // Half the threads call mkdir
        for (t in 0 until threadCount) {
            executor.submit {
                try {
                    startLatch.await(5, TimeUnit.SECONDS)
                    fileManager.mkdir(rootUri, sharedDir)
                } catch (e: Throwable) {
                    errors.add(e)
                } finally {
                    doneLatch.countDown()
                }
            }
        }

        // Half the threads call write (which implicitly creates directories)
        for (t in 0 until threadCount) {
            executor.submit {
                try {
                    startLatch.await(5, TimeUnit.SECONDS)
                    fileManager.write(rootUri, "$sharedDir/file_$t.bin", 0L, testData)
                } catch (e: Throwable) {
                    errors.add(e)
                } finally {
                    doneLatch.countDown()
                }
            }
        }

        startLatch.countDown()
        assertTrue("All threads should complete within 30s",
            doneLatch.await(30, TimeUnit.SECONDS))
        executor.shutdown()

        assertTrue("No errors: ${errors.map { it.message }}", errors.isEmpty())

        val dir = File(testDir, sharedDir.replace('/', File.separatorChar))
        assertTrue("Shared directory should exist", dir.isDirectory)

        for (t in 0 until threadCount) {
            val file = File(dir, "file_$t.bin")
            assertTrue("file_$t.bin should exist", file.exists())
        }
    }

    // =========================================================================
    // SAF (content://) concurrency tests
    //
    // Uses DuplicatingDocumentsProvider — a custom DocumentsProvider registered
    // in the test APK that mimics ExternalStorageProvider's behavior: when
    // createDocument() is called for a directory name that already exists, it
    // deduplicates to "name (1)", "name (2)", etc.
    //
    // This exercises the exact same findOrCreateDirectory() code path with real
    // content:// URIs, without requiring external storage permissions.
    // =========================================================================

    /** Tree URI pointing to our test DocumentsProvider's root. */
    private val safTreeUri = Uri.parse(
        "content://${DuplicatingDocumentsProvider.AUTHORITY}/tree/${DuplicatingDocumentsProvider.ROOT_ID}"
    )

    /**
     * Clean up all content under the test provider's root directory.
     */
    private fun cleanSafTestDir() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = DocumentFile.fromTreeUri(context, safTreeUri) ?: return
        root.listFiles().forEach { it.delete() }
    }

    /**
     * Concurrent writes to the same parent directory via content:// URI backed
     * by DuplicatingDocumentsProvider. The provider's createDocument() deduplicates
     * directory names to "name (1)" etc., exactly like the real
     * ExternalStorageProvider. Without the per-directory lock in
     * findOrCreateDirectory(), this test produces duplicate directories.
     */
    @Test
    fun saf_concurrentWritesSameDirectory_noDuplicates() {
        cleanSafTestDir()

        val dirName = "RaceTest"
        val threadCount = 8
        val testData = ByteArray(64) { it.toByte() }

        val executor = Executors.newFixedThreadPool(threadCount)
        val startLatch = CountDownLatch(1)
        val doneLatch = CountDownLatch(threadCount)
        val errors = ConcurrentLinkedQueue<Throwable>()

        for (t in 0 until threadCount) {
            executor.submit {
                try {
                    startLatch.await(5, TimeUnit.SECONDS)
                    fileManager.write(safTreeUri, "$dirName/file_$t.bin", 0L, testData)
                } catch (e: Throwable) {
                    Log.e(TAG, "SAF thread $t failed", e)
                    errors.add(e)
                } finally {
                    doneLatch.countDown()
                }
            }
        }

        startLatch.countDown()
        assertTrue("All threads should complete within 60s",
            doneLatch.await(60, TimeUnit.SECONDS))
        executor.shutdown()

        assertTrue("No errors expected, got: ${errors.map { it.message }}",
            errors.isEmpty())

        // Verify via SAF: only one "RaceTest" directory, no "RaceTest (1)" etc.
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val root = DocumentFile.fromTreeUri(context, safTreeUri)
        assertNotNull("SAF root should be accessible", root)

        val children = root!!.listFiles()
        val matchingDirs = children.filter {
            it.isDirectory && it.name?.startsWith(dirName) == true
        }
        assertEquals(
            "Should have exactly one '$dirName' directory via SAF, " +
                "found: ${matchingDirs.map { it.name }}",
            1, matchingDirs.size
        )
        assertEquals("Directory name should be exact", dirName, matchingDirs[0].name)

        // Verify all files exist inside
        val raceDir = matchingDirs[0]
        val files = raceDir.listFiles()
        assertEquals("All $threadCount files should be present", threadCount, files.size)

        // Clean up
        cleanSafTestDir()
    }

    /**
     * Recursively verify no directory has a SAF-style deduplicated sibling
     * like "name (1)", "name (2)", etc.
     */
    private fun assertNoDuplicateDirectories(dir: File) {
        val children = dir.listFiles() ?: return
        val dirs = children.filter { it.isDirectory }

        for (d in dirs) {
            val deduped = Regex("^(.+) \\(\\d+\\)$").matchEntire(d.name)
            if (deduped != null) {
                throw AssertionError(
                    "Found duplicate directory '${d.name}' " +
                    "(base: '${deduped.groupValues[1]}') in ${dir.absolutePath}. " +
                    "All dirs: ${dirs.map { it.name }}"
                )
            }
            assertNoDuplicateDirectories(d)
        }
    }
}
