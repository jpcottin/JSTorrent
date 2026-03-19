package com.jstorrent.app

import android.util.Log
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

private const val TAG = "RemoteTorrentUrlIntakeTest"

@RunWith(AndroidJUnit4::class)
class RemoteTorrentUrlIntakeTest {

    private lateinit var app: JSTorrentApplication

    @Before
    fun setup() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        app = context.applicationContext as JSTorrentApplication
        app.shutdownEngine()
        Log.i(TAG, "Engine shutdown for clean test state")
    }

    @After
    fun teardown() {
        app.shutdownEngine()
        Log.i(TAG, "Engine shutdown after test")
    }

    @Test
    fun pastedRemoteTorrentUrl_reportsCurrentFailure() = runBlocking {
        val controller = app.ensureEngineStarted(storageMode = "null")

        repeat(30) {
            if (controller.isLoaded.value) return@repeat
            delay(100)
        }
        assertTrue("Engine should be loaded", controller.isLoaded.value)

        val torrentUrl = "https://webtorrent.io/torrents/big-buck-bunny.torrent"
        val result = controller.addTorrentAsync(torrentUrl)

        repeat(20) {
            if (controller.lastError.value != null) return@repeat
            delay(100)
        }

        val lastError = controller.lastError.value
        Log.i(TAG, "addTorrentAsync result=$result lastError=$lastError")

        assertFalse("Remote .torrent URL should currently fail on Android add path", result.ok)
        assertNotNull("Expected engine to surface an error for remote .torrent URL", lastError)
        assertTrue(
            "Expected remote URL rejection error, got: $lastError",
            lastError!!.contains("Remote torrent URLs are not supported here")
        )
    }
}
