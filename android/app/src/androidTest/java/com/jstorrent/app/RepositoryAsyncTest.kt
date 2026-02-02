package com.jstorrent.app

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jstorrent.app.viewmodel.EngineServiceRepository
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.system.measureTimeMillis

private const val TAG = "RepositoryAsyncTest"

/**
 * Instrumentation tests for async repository methods.
 *
 * Verifies that commands (addTorrent, pauseTorrent, etc.) are fire-and-forget and don't block.
 *
 * NOTE: Query methods (getTorrentList, getFiles, etc.) were removed from TorrentRepository
 * as part of migration to subscription-based data flow. Data is now pushed via subscriptions
 * rather than pulled via RPC queries.
 *
 * Run with:
 * ./gradlew :app:connectedAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.jstorrent.app.RepositoryAsyncTest
 */
@RunWith(AndroidJUnit4::class)
class RepositoryAsyncTest {

    private lateinit var repository: EngineServiceRepository

    @Before
    fun setup() {
        runBlocking {
            val context = InstrumentationRegistry.getInstrumentation().targetContext
            val app = context.applicationContext as JSTorrentApplication
            Log.i(TAG, "Initializing engine via Application")

            // Initialize engine via Application (with null storage mode for in-memory)
            app.initializeEngine(storageMode = "null")

            // Wait for engine to be fully loaded
            repeat(30) {
                if (app.engineController?.isLoaded?.value == true) return@repeat
                delay(500)
            }
            assertTrue("Engine not loaded", app.engineController?.isLoaded?.value == true)

            repository = EngineServiceRepository(app)
            Log.i(TAG, "Engine loaded, repository created")
        }
    }

    @After
    fun teardown() {
        // Give pending fire-and-forget operations time to complete.
        // Tests using runTest have virtual time, so async operations may still
        // be in flight when the test completes. A small real delay prevents
        // "Engine closed while awaiting promise" errors.
        Thread.sleep(100)

        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as JSTorrentApplication
        app.shutdownEngine()
        Log.i(TAG, "Engine shutdown")
    }

    @Test
    fun addTorrent_returnsImmediately() {
        // Command should return immediately (fire-and-forget)
        val elapsed = measureTimeMillis {
            runBlocking(Dispatchers.Main) {
                repository.addTorrent("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567")
            }
        }
        Log.i(TAG, "addTorrent took ${elapsed}ms")
        assertTrue("addTorrent should return in <50ms, took ${elapsed}ms", elapsed < 50)
    }

    @Test
    fun pauseTorrent_returnsImmediately() {
        val elapsed = measureTimeMillis {
            runBlocking(Dispatchers.Main) {
                repository.pauseTorrent("0123456789abcdef0123456789abcdef01234567")
            }
        }
        Log.i(TAG, "pauseTorrent took ${elapsed}ms")
        assertTrue("pauseTorrent should return in <50ms, took ${elapsed}ms", elapsed < 50)
    }

    @Test
    fun resumeTorrent_returnsImmediately() {
        val elapsed = measureTimeMillis {
            runBlocking(Dispatchers.Main) {
                repository.resumeTorrent("0123456789abcdef0123456789abcdef01234567")
            }
        }
        Log.i(TAG, "resumeTorrent took ${elapsed}ms")
        assertTrue("resumeTorrent should return in <50ms, took ${elapsed}ms", elapsed < 50)
    }

    @Test
    fun removeTorrent_returnsImmediately() {
        val elapsed = measureTimeMillis {
            runBlocking(Dispatchers.Main) {
                repository.removeTorrent("0123456789abcdef0123456789abcdef01234567", false)
            }
        }
        Log.i(TAG, "removeTorrent took ${elapsed}ms")
        assertTrue("removeTorrent should return in <50ms, took ${elapsed}ms", elapsed < 50)
    }

    // NOTE: getTorrentList and getFiles tests removed - these methods were removed from
    // TorrentRepository interface as part of migration to subscription-based data flow.
    // Data is now pushed via subscriptions rather than pulled via RPC queries.

    @Test
    fun pauseAll_doesNotBlock() {
        // pauseAll iterates torrents internally - should not block
        val elapsed = measureTimeMillis {
            runBlocking(Dispatchers.Main) {
                repository.pauseAll()
            }
        }
        Log.i(TAG, "pauseAll took ${elapsed}ms")
        assertTrue("pauseAll should return in <50ms, took ${elapsed}ms", elapsed < 50)
    }

    @Test
    fun resumeAll_doesNotBlock() {
        // resumeAll iterates torrents internally - should not block
        val elapsed = measureTimeMillis {
            runBlocking(Dispatchers.Main) {
                repository.resumeAll()
            }
        }
        Log.i(TAG, "resumeAll took ${elapsed}ms")
        assertTrue("resumeAll should return in <50ms, took ${elapsed}ms", elapsed < 50)
    }
}
