package com.jstorrent.app.service

import android.content.Context
import com.jstorrent.app.settings.SettingsStore
import org.junit.Assert.assertEquals
import org.junit.Test
import org.mockito.kotlin.doReturn
import org.mockito.kotlin.mock

class ServiceLifecycleManagerTest {

    private val context: Context = mock()

    @Test
    fun `active playback session prevents engine shutdown when app backgrounds`() {
        val settingsStore = mock<SettingsStore> {
            on { backgroundDownloadsEnabled } doReturn false
            on { whenDownloadsComplete } doReturn "stop_and_close"
        }
        var shutdownCalls = 0
        val manager = ServiceLifecycleManager(
            context = context,
            settingsStore = settingsStore,
            onShutdownForBackground = { shutdownCalls++ }
        )

        manager.onActivityStart()
        manager.onPlaybackSessionStarted()
        manager.onActivityStop()

        assertEquals(0, shutdownCalls)
    }

    @Test
    fun `stopping active playback in background allows engine shutdown`() {
        val settingsStore = mock<SettingsStore> {
            on { backgroundDownloadsEnabled } doReturn false
            on { whenDownloadsComplete } doReturn "stop_and_close"
        }
        var shutdownCalls = 0
        val manager = ServiceLifecycleManager(
            context = context,
            settingsStore = settingsStore,
            onShutdownForBackground = { shutdownCalls++ }
        )

        manager.onActivityStart()
        manager.onPlaybackSessionStarted()
        manager.onActivityStop()
        manager.onPlaybackSessionStopped()

        assertEquals(1, shutdownCalls)
    }
}
