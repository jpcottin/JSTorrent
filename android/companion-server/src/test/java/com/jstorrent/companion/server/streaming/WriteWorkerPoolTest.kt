package com.jstorrent.companion.server.streaming

import android.net.Uri
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.file.FileStat
import com.jstorrent.io.file.FileTreeEntry
import com.jstorrent.io.file.VerifyChunksFile
import com.jstorrent.io.hash.Hasher
import org.junit.Test
import org.mockito.kotlin.mock
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

class WriteWorkerPoolTest {

    @Test
    fun `submit blocks when resident write bytes reach budget`() {
        val firstWriteStarted = CountDownLatch(1)
        val releaseFirstWrite = CountDownLatch(1)
        val secondWriteStarted = CountDownLatch(1)
        val secondWriteFinished = CountDownLatch(1)
        val secondSubmitResult = AtomicBoolean(false)

        val fileManager = object : FileManager {
            override fun read(rootUri: Uri, relativePath: String, offset: Long, length: Int): ByteArray {
                throw UnsupportedOperationException()
            }

            override fun write(rootUri: Uri, relativePath: String, offset: Long, data: ByteArray) {
                if (relativePath == "first.bin") {
                    firstWriteStarted.countDown()
                    releaseFirstWrite.await(2, TimeUnit.SECONDS)
                }
            }

            override fun write(
                rootUri: Uri,
                relativePath: String,
                offset: Long,
                data: ByteArray,
                dataOffset: Int,
                dataLength: Int,
            ) {
                write(rootUri, relativePath, offset, data.copyOfRange(dataOffset, dataOffset + dataLength))
            }

            override fun exists(rootUri: Uri, relativePath: String): Boolean = false

            override fun getOrCreateFile(rootUri: Uri, relativePath: String) = null

            override fun clearCache() = Unit

            override fun stat(rootUri: Uri, relativePath: String): FileStat? = null

            override fun mkdir(rootUri: Uri, relativePath: String): Boolean = false

            override fun readdir(rootUri: Uri, relativePath: String): List<String> = emptyList()

            override fun delete(rootUri: Uri, relativePath: String): Boolean = false

            override fun listTree(rootUri: Uri, relativePath: String): List<FileTreeEntry> = emptyList()

            override fun batchDelete(rootUri: Uri, directory: String, entries: List<String>): List<String> =
                emptyList()

            override fun verifyChunks(
                rootUri: Uri,
                files: List<VerifyChunksFile>,
                chunkSize: Long,
                hashes: ByteArray,
                startChunk: Long,
                chunkCount: Long,
            ): ByteArray = ByteArray(chunkCount.toInt())

            override fun getFreeDiskSpace(rootUri: Uri): Long = Long.MAX_VALUE
        }

        val pool = WriteWorkerPool(
            fileManager = fileManager,
            workerCount = 1,
            maxBufferedBytes = 16,
            maxQueuedJobs = 8,
        )

        val rootUri: Uri = mock()
        val payload = ByteArray(16)
        val hashHex = Hasher.sha1Hex(payload)
        val first = WriteJob(rootUri, "first.bin", 0, payload.copyOf(), hashHex, "cb1")
        val second = WriteJob(rootUri, "second.bin", 16, payload.copyOf(), hashHex, "cb2")

        pool.start()
        try {
            assertTrue(pool.submit(first))
            assertTrue(firstWriteStarted.await(1, TimeUnit.SECONDS))
            assertEquals(16, pool.bufferedBytes())

            thread(start = true, name = "submit-second") {
                secondWriteStarted.countDown()
                secondSubmitResult.set(pool.submit(second))
                secondWriteFinished.countDown()
            }

            assertTrue(secondWriteStarted.await(1, TimeUnit.SECONDS))
            assertFalse(secondWriteFinished.await(200, TimeUnit.MILLISECONDS))

            releaseFirstWrite.countDown()

            assertTrue(secondWriteFinished.await(2, TimeUnit.SECONDS))
            assertTrue(secondSubmitResult.get())
        } finally {
            pool.stop()
        }
    }
}
