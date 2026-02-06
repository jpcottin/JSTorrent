package com.jstorrent.app

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jstorrent.app.e2e.TestMagnets
import org.junit.Test
import org.junit.runner.RunWith
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking

private const val TAG = "ForegroundNotificationServiceTest"

/**
 * Instrumentation test for ForegroundNotificationService.
 *
 * Run with: ./gradlew :app:connectedAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.jstorrent.app.ForegroundNotificationServiceTest
 */
@RunWith(AndroidJUnit4::class)
class ForegroundNotificationServiceTest {

    @Test
    fun testForegroundNotificationServiceStartsAndLoads() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as JSTorrentApplication
        Log.i(TAG, "Starting engine test")

        // Initialize engine via Application (with null storage mode for in-memory)
        app.initializeEngine(storageMode = "null")
        Log.i(TAG, "Engine initialized via Application")

        val controller = app.engineController
        requireNotNull(controller) { "Controller should be available when engine is loaded" }
        assert(controller.isLoaded.value) { "Engine failed to load" }
        Log.i(TAG, "SUCCESS: Engine loaded")

        // Try adding a torrent using deterministic test data
        val magnetLink = TestMagnets.buildMagnetLink(
            infoHash = TestMagnets.InfoHashes.TEST_100MB,
            displayName = TestMagnets.DisplayNames.TEST_100MB
        )
        controller.addTorrent(magnetLink)
        Log.i(TAG, "addTorrent called with test magnet: $magnetLink")

        // Wait a bit for the torrent to be processed
        Thread.sleep(2000)

        // Query torrent list
        val torrents = controller.getTorrentList()
        Log.i(TAG, "getTorrentList returned ${torrents.size} torrents")
        torrents.forEach { t ->
            Log.i(TAG, "Torrent: name=${t.name}, infoHash=${t.infoHash}, status=${t.status}")
        }

        // Verify the torrent was added with the expected info hash
        val expectedHash = TestMagnets.InfoHashes.TEST_100MB
        val addedTorrent = torrents.find {
            it.infoHash.equals(expectedHash, ignoreCase = true)
        }
        assert(addedTorrent != null) {
            "Expected torrent with hash $expectedHash not found in list"
        }
        Log.i(TAG, "Verified torrent added: ${addedTorrent?.name}")

        // Check state flow
        val state = controller.state.value
        Log.i(TAG, "State flow value: ${state?.torrents?.size ?: 0} torrents")
        state?.torrents?.forEach { t ->
            Log.i(TAG, "State torrent: name=${t.name}, progress=${t.progress}")
        }

        // Clean up - remove the test torrent
        controller.removeTorrent(expectedHash, deleteFiles = true)
        Log.i(TAG, "Removed test torrent")

        // Shutdown engine
        app.shutdownEngine()
        Log.i(TAG, "Engine shut down")
    }

    @Test
    fun testAsyncMethods() = runBlocking {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as JSTorrentApplication
        Log.i(TAG, "Starting async methods test")

        // Initialize engine via Application (with null storage mode for in-memory)
        app.initializeEngine(storageMode = "null")
        Log.i(TAG, "Engine initialized via Application")

        val controller = app.engineController
        requireNotNull(controller) { "Controller should be available when engine is loaded" }
        assert(controller.isLoaded.value) { "Engine not loaded" }
        Log.i(TAG, "Engine loaded, testing async methods")

        // Test async add
        val magnetLink = TestMagnets.buildMagnetLink(
            infoHash = TestMagnets.InfoHashes.TEST_100MB,
            displayName = TestMagnets.DisplayNames.TEST_100MB
        )
        controller.addTorrentAsync(magnetLink)
        Log.i(TAG, "addTorrentAsync called with test magnet")
        delay(2000)

        // Test async query
        val torrents = controller.getTorrentListAsync()
        val infoHash = TestMagnets.InfoHashes.TEST_100MB
        Log.i(TAG, "getTorrentListAsync returned ${torrents.size} torrents")
        assert(torrents.any { it.infoHash.equals(infoHash, ignoreCase = true) }) {
            "Expected torrent with hash $infoHash not found"
        }

        // Test async file query
        val files = controller.getFilesAsync(infoHash)
        Log.i(TAG, "getFilesAsync returned ${files.size} files")

        // Test async pause/resume
        controller.pauseTorrentAsync(infoHash)
        Log.i(TAG, "pauseTorrentAsync called")
        delay(500)

        controller.resumeTorrentAsync(infoHash)
        Log.i(TAG, "resumeTorrentAsync called")
        delay(500)

        // Test async remove
        controller.removeTorrentAsync(infoHash, deleteFiles = true)
        Log.i(TAG, "removeTorrentAsync called")
        delay(500)

        // Verify removal
        val torrentsAfterRemove = controller.getTorrentListAsync()
        assert(torrentsAfterRemove.none { it.infoHash.equals(infoHash, ignoreCase = true) }) {
            "Torrent should have been removed"
        }
        Log.i(TAG, "Verified torrent removed")

        // Cleanup
        app.shutdownEngine()
        Log.i(TAG, "Async methods test completed successfully")
        Unit
    }
}
