package com.jstorrent.companion.server

import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Tests for BatchWriteResults - the shared queue for batch write results.
 */
class BatchWriteResultsTest {

    /**
     * Test that addResult and drain work correctly
     */
    @Test
    fun `addResult and drain works correctly`() {
        // Clear any existing results
        BatchWriteResults.drain()

        // Add some results
        BatchWriteResults.addResult("cb1", 1024, WriteResultCode.SUCCESS)
        BatchWriteResults.addResult("cb2", -1, WriteResultCode.HASH_MISMATCH)
        BatchWriteResults.addResult("cb3", -1, WriteResultCode.IO_ERROR)

        // Drain should return all results
        val results = BatchWriteResults.drain()
        assertEquals(3, results.size)

        // Verify first result
        assertEquals("cb1", results[0].callbackId)
        assertEquals(1024, results[0].bytesWritten)
        assertEquals(WriteResultCode.SUCCESS, results[0].resultCode)

        // Verify second result
        assertEquals("cb2", results[1].callbackId)
        assertEquals(-1, results[1].bytesWritten)
        assertEquals(WriteResultCode.HASH_MISMATCH, results[1].resultCode)

        // Verify third result
        assertEquals("cb3", results[2].callbackId)
        assertEquals(-1, results[2].bytesWritten)
        assertEquals(WriteResultCode.IO_ERROR, results[2].resultCode)

        // Queue should be empty now
        assertTrue(BatchWriteResults.drain().isEmpty())
    }

    /**
     * Test that drain returns empty list when queue is empty
     */
    @Test
    fun `drain returns empty list when queue is empty`() {
        // Clear any existing results
        BatchWriteResults.drain()

        val results = BatchWriteResults.drain()
        assertTrue(results.isEmpty())
    }

    /**
     * Test notify callback is called on addResult
     */
    @Test
    fun `notify callback is called on addResult`() {
        // Clear any existing results
        BatchWriteResults.drain()

        var callbackCount = 0
        BatchWriteResults.setNotifyCallback { callbackCount++ }

        BatchWriteResults.addResult("cb1", 100, WriteResultCode.SUCCESS)
        assertEquals(1, callbackCount)

        BatchWriteResults.addResult("cb2", 200, WriteResultCode.SUCCESS)
        assertEquals(2, callbackCount)

        // Clean up
        BatchWriteResults.drain()
        BatchWriteResults.setNotifyCallback {}
    }

    /**
     * Test unpackVerifiedWriteBatch with valid batch
     */
    @Test
    fun `unpackVerifiedWriteBatch parses valid batch`() {
        // Create a batch with 2 writes
        val rootKey = "abc123"
        val path1 = "file1.dat"
        val path2 = "dir/file2.dat"
        val data1 = byteArrayOf(1, 2, 3, 4)
        val data2 = byteArrayOf(5, 6, 7)
        val hashHex = "0123456789abcdef0123456789abcdef01234567" // 40 chars
        val callbackId1 = "cb1"
        val callbackId2 = "cb2"

        // Calculate size
        val write1Size = 1 + rootKey.length + 2 + path1.length + 8 + 4 + data1.size + 40 + 1 + callbackId1.length
        val write2Size = 1 + rootKey.length + 2 + path2.length + 8 + 4 + data2.size + 40 + 1 + callbackId2.length
        val totalSize = 4 + write1Size + write2Size

        val buffer = ByteBuffer.allocate(totalSize).order(ByteOrder.LITTLE_ENDIAN)

        // count
        buffer.putInt(2)

        // Write 1
        buffer.put(rootKey.length.toByte())
        buffer.put(rootKey.toByteArray())
        buffer.putShort(path1.length.toShort())
        buffer.put(path1.toByteArray())
        buffer.putInt(1000) // position low
        buffer.putInt(0)    // position high
        buffer.putInt(data1.size)
        buffer.put(data1)
        buffer.put(hashHex.toByteArray())
        buffer.put(callbackId1.length.toByte())
        buffer.put(callbackId1.toByteArray())

        // Write 2
        buffer.put(rootKey.length.toByte())
        buffer.put(rootKey.toByteArray())
        buffer.putShort(path2.length.toShort())
        buffer.put(path2.toByteArray())
        buffer.putInt(2000) // position low
        buffer.putInt(0)    // position high
        buffer.putInt(data2.size)
        buffer.put(data2)
        buffer.put(hashHex.toByteArray())
        buffer.put(callbackId2.length.toByte())
        buffer.put(callbackId2.toByteArray())

        // Unpack
        val writes = unpackVerifiedWriteBatch(buffer.array())

        assertEquals(2, writes.size)

        // Verify write 1
        assertEquals(rootKey, writes[0].rootKey)
        assertEquals(path1, writes[0].path)
        assertEquals(1000L, writes[0].position)
        assertTrue(data1.contentEquals(writes[0].data))
        assertEquals(hashHex, writes[0].expectedHashHex)
        assertEquals(callbackId1, writes[0].callbackId)

        // Verify write 2
        assertEquals(rootKey, writes[1].rootKey)
        assertEquals(path2, writes[1].path)
        assertEquals(2000L, writes[1].position)
        assertTrue(data2.contentEquals(writes[1].data))
        assertEquals(hashHex, writes[1].expectedHashHex)
        assertEquals(callbackId2, writes[1].callbackId)
    }

    /**
     * Test unpackVerifiedWriteBatch with empty batch
     */
    @Test
    fun `unpackVerifiedWriteBatch handles empty batch`() {
        val buffer = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
        buffer.putInt(0) // count = 0

        val writes = unpackVerifiedWriteBatch(buffer.array())
        assertTrue(writes.isEmpty())
    }

    /**
     * Test unpackVerifiedWriteBatch rejects invalid count
     */
    @Test(expected = IllegalArgumentException::class)
    fun `unpackVerifiedWriteBatch rejects negative count`() {
        val buffer = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
        buffer.putInt(-1) // negative count

        unpackVerifiedWriteBatch(buffer.array())
    }

    /**
     * Test unpackVerifiedWriteBatch rejects too large count
     */
    @Test(expected = IllegalArgumentException::class)
    fun `unpackVerifiedWriteBatch rejects count over 10000`() {
        val buffer = ByteBuffer.allocate(4).order(ByteOrder.LITTLE_ENDIAN)
        buffer.putInt(10001) // count over limit

        unpackVerifiedWriteBatch(buffer.array())
    }
}
