package com.jstorrent.quickjs

import java.nio.file.Files
import java.nio.file.Path
import java.nio.charset.StandardCharsets
import kotlin.test.Test
import kotlin.test.assertTrue

class EngineBundleAssetTest {

    @Test
    fun engineBundleAssetContainsPlaybackRpcNames() {
        val bundlePath = sequenceOf(
            Path.of("src", "main", "assets", "engine.bundle.js"),
            Path.of("quickjs-engine", "src", "main", "assets", "engine.bundle.js")
        ).firstOrNull { Files.exists(it) }
            ?: error("Could not locate engine.bundle.js from ${Path.of("").toAbsolutePath()}")
        val bundleContent = String(Files.readAllBytes(bundlePath), StandardCharsets.UTF_8)

        assertTrue(bundleContent.contains("__jstorrent_playback_open"))
        assertTrue(bundleContent.contains("__jstorrent_playback_read"))
        assertTrue(bundleContent.contains("__jstorrent_playback_close"))
    }
}
