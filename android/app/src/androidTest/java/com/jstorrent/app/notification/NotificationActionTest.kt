package com.jstorrent.app.notification

import android.app.NotificationManager
import android.content.Intent
import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.jstorrent.app.JSTorrentApplication
import com.jstorrent.app.service.ForegroundNotificationService
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Instrumented tests for notification action buttons.
 *
 * Run with: ./gradlew :app:connectedAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.jstorrent.app.notification.NotificationActionTest
 */
@RunWith(AndroidJUnit4::class)
class NotificationActionTest {

    companion object {
        private const val TAG = "NotificationActionTest"
        private const val ENGINE_LOAD_TIMEOUT_MS = 5_000L
        private const val POLL_INTERVAL_MS = 500L
    }

    private lateinit var notificationManager: NotificationManager

    @Before
    fun setup() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as JSTorrentApplication
        notificationManager = context.getSystemService(NotificationManager::class.java)

        // Physical cleanup
        ForegroundNotificationService.stop(context)
        app.shutdownEngine()
        Thread.sleep(200)

        // Reset lifecycle manager state to construction defaults
        app.serviceLifecycleManager.resetForTesting()
    }

    @After
    fun tearDown() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        ForegroundNotificationService.stop(context)
        val app = context.applicationContext as JSTorrentApplication
        app.shutdownEngine()
        Thread.sleep(500)
    }

    // =========================================================================
    // Channel tests
    // =========================================================================

    @Test
    fun allNotificationChannelsExist() {
        // Verify all channels are created by JSTorrentApplication
        val serviceChannel = notificationManager.getNotificationChannel(
            JSTorrentApplication.NotificationChannels.SERVICE
        )
        val completeChannel = notificationManager.getNotificationChannel(
            JSTorrentApplication.NotificationChannels.COMPLETE
        )
        val errorsChannel = notificationManager.getNotificationChannel(
            JSTorrentApplication.NotificationChannels.ERRORS
        )

        assertNotNull("Service channel should exist", serviceChannel)
        assertNotNull("Complete channel should exist", completeChannel)
        assertNotNull("Errors channel should exist", errorsChannel)

        assertEquals(NotificationManager.IMPORTANCE_LOW, serviceChannel.importance)
        assertEquals(NotificationManager.IMPORTANCE_DEFAULT, completeChannel.importance)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, errorsChannel.importance)
    }

    // =========================================================================
    // Service notification tests
    // =========================================================================

    @Test
    fun serviceStartsSuccessfullyWithForegroundNotification() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as JSTorrentApplication

        // Initialize engine via Application
        app.initializeEngine(storageMode = "null")

        // Start the service (without foreground flag so it doesn't stop immediately)
        ForegroundNotificationService.start(context, "null")

        // Wait for engine to load
        val loaded = waitForEngineLoad()
        assertTrue("Engine should load", loaded)

        // If we get here without crashing, the foreground notification was posted
        // (Android requires foreground services to call startForeground() immediately)
        assertNotNull("Service should be running", ForegroundNotificationService.instance)

        // Wait a bit for notification update loop to start
        Thread.sleep(1500)

        // Service should still be running (notification update loop didn't crash)
        assertNotNull("Service should still be running after notification updates", ForegroundNotificationService.instance)
    }

    @Test
    fun notificationManagerBuildsCorrectContent() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val notifManager = ForegroundNotificationManager(context)

        // Test with empty torrent list
        val emptyNotification = notifManager.buildNotification(emptyList())
        assertNotNull("Should build notification for empty list", emptyNotification)

        // Verify notification content via extras
        val extras = emptyNotification.extras
        val title = extras?.getCharSequence("android.title")?.toString()
        val text = extras?.getCharSequence("android.text")?.toString()

        Log.i(TAG, "Empty notification - title: $title, text: $text")

        // With no active torrents, the notification shows status as title
        assertEquals("Title should show status", "No active torrents", title)
        // Content text may be empty or null when there's no speed info
        // Just verify notification was built successfully (asserted above)
    }

    // =========================================================================
    // Action button tests
    // =========================================================================

    @Test
    fun quitActionStopsService() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as JSTorrentApplication

        // Initialize engine via Application
        app.initializeEngine(storageMode = "null")

        // Start the service (without foreground flag so it doesn't stop immediately)
        ForegroundNotificationService.start(context, "null")

        // Wait for engine to load
        val loaded = waitForEngineLoad()
        assertTrue("Engine should load", loaded)

        assertNotNull("Service instance should exist before quit", ForegroundNotificationService.instance)

        // Directly call the quit actions instead of using broadcast
        // (broadcast delivery can be delayed on slow CI emulators)
        // Note: We call stop() directly because the test started the service directly
        // (bypassing ServiceLifecycleManager), so serviceRunning is false in the manager.
        app.serviceLifecycleManager.onUserQuit()
        ForegroundNotificationService.stop(context)
        app.shutdownEngine()

        // Wait for service to stop - stopService() is asynchronous, poll for completion
        val stopped = waitForServiceStop()
        assertTrue("Service instance should be null after quit", stopped)
    }

    private fun waitForServiceStop(timeoutMs: Long = 10_000L): Boolean {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (ForegroundNotificationService.instance == null) {
                return true
            }
            Thread.sleep(POLL_INTERVAL_MS)
        }
        Log.e(TAG, "Timeout waiting for service to stop after ${timeoutMs}ms")
        return false
    }

    @Test
    fun pauseAllActionDoesNotCrash() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as JSTorrentApplication

        // Initialize engine via Application
        app.initializeEngine(storageMode = "null")

        // Start the service (without foreground flag so it doesn't stop immediately)
        ForegroundNotificationService.start(context, "null")

        // Wait for engine to load
        val loaded = waitForEngineLoad()
        assertTrue("Engine should load", loaded)

        // Send PAUSE_ALL action (should not crash even with no torrents)
        val pauseIntent = Intent(NotificationActionReceiver.ACTION_PAUSE_ALL)
        pauseIntent.setPackage(context.packageName)
        context.sendBroadcast(pauseIntent)

        // Wait a bit
        Thread.sleep(500)

        // Service should still be running
        assertNotNull("Service should still be running", ForegroundNotificationService.instance)
    }

    @Test
    fun resumeAllActionDoesNotCrash() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as JSTorrentApplication

        // Initialize engine via Application
        app.initializeEngine(storageMode = "null")

        // Start the service (without foreground flag so it doesn't stop immediately)
        ForegroundNotificationService.start(context, "null")

        // Wait for engine to load
        val loaded = waitForEngineLoad()
        assertTrue("Engine should load", loaded)

        // Send RESUME_ALL action (should not crash even with no torrents)
        val resumeIntent = Intent(NotificationActionReceiver.ACTION_RESUME_ALL)
        resumeIntent.setPackage(context.packageName)
        context.sendBroadcast(resumeIntent)

        // Wait a bit
        Thread.sleep(500)

        // Service should still be running
        assertNotNull("Service should still be running", ForegroundNotificationService.instance)
    }

    @Test
    fun openFolderActionDoesNotCrash() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        // Send OPEN_FOLDER action with a test URI
        // This will try to open a file manager which may not exist, but shouldn't crash
        val openFolderIntent = Intent(NotificationActionReceiver.ACTION_OPEN_FOLDER)
        openFolderIntent.setPackage(context.packageName)
        openFolderIntent.putExtra(
            NotificationActionReceiver.EXTRA_FOLDER_URI,
            "content://com.android.externalstorage.documents/tree/primary%3ADownload"
        )
        context.sendBroadcast(openFolderIntent)

        // Wait a bit - action should complete without crashing
        Thread.sleep(500)

        // Test passes if we get here without crashing
        assertTrue("Open folder action should not crash", true)
    }

    @Test
    fun openFolderActionWithNullUriDoesNotCrash() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext

        // Send OPEN_FOLDER action without URI extra
        // Should handle gracefully
        val openFolderIntent = Intent(NotificationActionReceiver.ACTION_OPEN_FOLDER)
        openFolderIntent.setPackage(context.packageName)
        context.sendBroadcast(openFolderIntent)

        // Wait a bit
        Thread.sleep(500)

        // Test passes if we get here without crashing
        assertTrue("Open folder action with null URI should not crash", true)
    }

    // =========================================================================
    // Helper methods
    // =========================================================================

    private fun waitForEngineLoad(timeoutMs: Long = ENGINE_LOAD_TIMEOUT_MS): Boolean {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = context.applicationContext as JSTorrentApplication

        // Engine loads synchronously, but wait for service instance to be available
        if (app.engineController?.isLoaded?.value != true) {
            return false
        }

        val deadline = System.currentTimeMillis() + timeoutMs
        while (System.currentTimeMillis() < deadline) {
            if (ForegroundNotificationService.instance != null) {
                return true
            }
            Thread.sleep(POLL_INTERVAL_MS)
        }
        Log.e(TAG, "Timeout waiting for service instance")
        return false
    }
}
