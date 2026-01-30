package com.jstorrent.companion.server.streaming

import android.net.Uri
import android.util.Log
import com.jstorrent.companion.server.BatchWriteResults
import com.jstorrent.companion.server.WriteResultCode
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.hash.Hasher
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean

/**
 * A write job to be processed by the worker pool.
 */
data class WriteJob(
    val rootUri: Uri,
    val path: String,
    val position: Long,
    val data: ByteArray,
    val expectedHashHex: String,
    val callbackId: String,
)

/**
 * Worker pool for processing verified writes.
 *
 * Architecture:
 * - Bounded blocking queue (backpressures when full)
 * - Fixed number of worker threads
 * - Each worker: verify hash -> write to disk -> report result
 *
 * Memory bound = queueCapacity × avgPieceSize (not total batch size)
 */
class WriteWorkerPool(
    private val fileManager: FileManager,
    private val workerCount: Int = 4,
    private val queueCapacity: Int = 8,
) {
    companion object {
        private const val TAG = "WriteWorkerPool"
    }

    private val queue = ArrayBlockingQueue<WriteJob>(queueCapacity)
    private val running = AtomicBoolean(false)
    private val workers = mutableListOf<Thread>()

    /**
     * Start the worker pool.
     */
    fun start() {
        if (!running.compareAndSet(false, true)) {
            Log.w(TAG, "Worker pool already running")
            return
        }

        Log.i(TAG, "Starting worker pool: $workerCount workers, queue capacity $queueCapacity")

        for (i in 0 until workerCount) {
            val worker = Thread({
                workerLoop()
            }, "WriteWorker-$i")
            worker.start()
            workers.add(worker)
        }
    }

    /**
     * Stop the worker pool.
     * Waits for queue to drain and workers to finish.
     */
    fun stop() {
        if (!running.compareAndSet(true, false)) {
            return
        }

        Log.i(TAG, "Stopping worker pool...")

        // Interrupt workers waiting on queue
        workers.forEach { it.interrupt() }

        // Wait for workers to finish
        workers.forEach { thread ->
            try {
                thread.join(5000)
            } catch (e: InterruptedException) {
                // Ignore
            }
        }
        workers.clear()

        // Drain any remaining jobs
        val remaining = queue.size
        if (remaining > 0) {
            Log.w(TAG, "Discarded $remaining jobs on shutdown")
        }
        queue.clear()

        Log.i(TAG, "Worker pool stopped")
    }

    /**
     * Submit a write job to the queue.
     * Blocks if queue is full (backpressure).
     *
     * @return true if submitted, false if pool is stopped
     */
    fun submit(job: WriteJob): Boolean {
        if (!running.get()) {
            return false
        }

        try {
            // Block until space available (backpressure)
            queue.put(job)
            return true
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return false
        }
    }

    /**
     * Check if there's space in the queue (non-blocking).
     */
    fun hasCapacity(): Boolean = queue.remainingCapacity() > 0

    /**
     * Current queue depth.
     */
    fun queueSize(): Int = queue.size

    private fun workerLoop() {
        Log.d(TAG, "Worker started: ${Thread.currentThread().name}")

        while (running.get()) {
            try {
                // Wait for job with timeout (allows checking running flag)
                val job = queue.poll(100, TimeUnit.MILLISECONDS) ?: continue

                processJob(job)
            } catch (e: InterruptedException) {
                // Check running flag and exit if stopped
                if (!running.get()) break
                Thread.currentThread().interrupt()
            } catch (e: Exception) {
                Log.e(TAG, "Worker error", e)
            }
        }

        Log.d(TAG, "Worker stopped: ${Thread.currentThread().name}")
    }

    private fun processJob(job: WriteJob) {
        try {
            // Verify hash
            val actualHash = Hasher.sha1Hex(job.data)
            if (!actualHash.equals(job.expectedHashHex, ignoreCase = true)) {
                Log.w(TAG, "Hash mismatch for ${job.path}@${job.position}: expected=${job.expectedHashHex}, actual=$actualHash")
                BatchWriteResults.addResult(job.callbackId, -1, WriteResultCode.HASH_MISMATCH)
                return
            }

            // Write to disk
            fileManager.write(job.rootUri, job.path, job.position, job.data)

            // Report success
            BatchWriteResults.addResult(job.callbackId, job.data.size, WriteResultCode.SUCCESS)

        } catch (e: Exception) {
            Log.e(TAG, "Write failed for ${job.path}@${job.position}", e)
            BatchWriteResults.addResult(job.callbackId, -1, WriteResultCode.IO_ERROR)
        }
    }
}
