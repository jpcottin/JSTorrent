package com.jstorrent.app.player

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VideoFileDetectorTest {

    @Test
    fun `isLikelyVideoFile matches common video extensions case insensitively`() {
        assertTrue(VideoFileDetector.isLikelyVideoFile("movie.mp4"))
        assertTrue(VideoFileDetector.isLikelyVideoFile("Movie.MKV"))
        assertTrue(VideoFileDetector.isLikelyVideoFile("folder/clip.WebM"))
        assertTrue(VideoFileDetector.isLikelyVideoFile("sample.m4v"))
    }

    @Test
    fun `isLikelyVideoFile rejects non-video files`() {
        assertFalse(VideoFileDetector.isLikelyVideoFile("subtitle.srt"))
        assertFalse(VideoFileDetector.isLikelyVideoFile("archive.zip"))
        assertFalse(VideoFileDetector.isLikelyVideoFile("README"))
    }
}
