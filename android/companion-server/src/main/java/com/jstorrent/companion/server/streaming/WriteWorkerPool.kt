package com.jstorrent.companion.server.streaming

import android.net.Uri
import android.util.Log
import com.jstorrent.companion.server.BatchWriteResults
import com.jstorrent.companion.server.WriteResultCode
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.hash.Hasher
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
 * - Byte-bounded blocking queue (backpressures when resident write bytes are full)
 * - Fixed number of worker threads
 * - Each worker: verify hash -> write to disk -> report result
 *
 * Memory bound = queued bytes + running worker bytes
 */
class WriteWorkerPool(
    private val fileManager: FileManager,
    private val workerCount: Int = 6,
    private val maxBufferedBytes: Long = DEFAULT_MAX_BUFFERED_BYTES,
    private val maxQueuedJobs: Int = DEFAULT_MAX_QUEUED_JOBS,
) {
    companion object {
        private const val TAG = "WriteWorkerPool"
        const val DEFAULT_MAX_BUFFERED_BYTES: Long = 32L * 1024L * 1024L
        const val DEFAULT_MAX_QUEUED_JOBS: Int = 64
    }

    private val queue = ArrayDeque<WriteJob>()
    private val queueLock = Object()
    private val running = AtomicBoolean(false)
    private val workers = mutableListOf<Thread>()
    private var bufferedBytes: Long = 0

    /**
     * Start the worker pool.
     */
    fun start() {
        if (!running.compareAndSet(false, true)) {
            Log.w(TAG, "Worker pool already running")
            return
        }

        Log.i(
            TAG,
            "Starting worker pool: $workerCount workers, maxBufferedBytes=$maxBufferedBytes, maxQueuedJobs=$maxQueuedJobs"
        )

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
        synchronized(queueLock) {
            queueLock.notifyAll()
        }

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
        val remaining: Int
        val remainingBytes: Long
        synchronized(queueLock) {
            remaining = queue.size
            remainingBytes = queue.sumOf { it.data.size.toLong() }
            queue.clear()
            bufferedBytes = maxOf(0L, bufferedBytes - remainingBytes)
            queueLock.notifyAll()
        }
        if (remaining > 0) {
            Log.w(TAG, "Discarded $remaining jobs ($remainingBytes bytes) on shutdown")
        }

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
            val jobBytes = job.data.size.toLong()
            synchronized(queueLock) {
                while (running.get() &&
                    (bufferedBytes + jobBytes > maxBufferedBytes || queue.size >= maxQueuedJobs)
                ) {
                    queueLock.wait()
                }
                if (!running.get()) {
                    return false
                }
                queue.addLast(job)
                bufferedBytes += jobBytes
                queueLock.notifyAll()
                return true
            }
        } catch (e: InterruptedException) {
            Thread.currentThread().interrupt()
            return false
        }
    }

    /**
     * Check if there's space in the queue (non-blocking).
     */
    fun hasCapacity(): Boolean = synchronized(queueLock) {
        bufferedBytes < maxBufferedBytes && queue.size < maxQueuedJobs
    }

    /**
     * Current queue depth.
     */
    fun queueSize(): Int = synchronized(queueLock) { queue.size }

    /**
     * Current resident bytes in queued + running jobs.
     */
    fun bufferedBytes(): Long = synchronized(queueLock) { bufferedBytes }

    private fun workerLoop() {
        Log.d(TAG, "Worker started: ${Thread.currentThread().name}")

        while (true) {
            try {
                val job = takeJob() ?: break
                try {
                    processJob(job)
                } finally {
                    synchronized(queueLock) {
                        bufferedBytes = maxOf(0L, bufferedBytes - job.data.size.toLong())
                        queueLock.notifyAll()
                    }
                }
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

    private fun takeJob(): WriteJob? {
        synchronized(queueLock) {
            while (queue.isEmpty()) {
                if (!running.get()) {
                    return null
                }
                queueLock.wait(TimeUnit.MILLISECONDS.toMillis(100))
            }
            return queue.removeFirst()
        }
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
