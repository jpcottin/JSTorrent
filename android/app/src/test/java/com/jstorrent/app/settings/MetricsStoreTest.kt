package com.jstorrent.app.settings

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Unit tests for MetricsStore logic.
 * Tests pure functions without Android dependencies.
 */
class MetricsStoreTest {

    // =========================================================================
    // shouldShowReviewPrompt tests
    // =========================================================================

    @Test
    fun `should show when all criteria met`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 5,
            daysInstalled = 10,
            daysSinceLastPrompt = Int.MAX_VALUE, // Never shown
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertTrue(result)
    }

    @Test
    fun `should not show when review declined`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 100,
            daysInstalled = 365,
            daysSinceLastPrompt = Int.MAX_VALUE,
            reviewDeclined = true,
            reviewCompleted = false
        )
        assertFalse(result)
    }

    @Test
    fun `should not show when review completed`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 100,
            daysInstalled = 365,
            daysSinceLastPrompt = Int.MAX_VALUE,
            reviewDeclined = false,
            reviewCompleted = true
        )
        assertFalse(result)
    }

    @Test
    fun `should not show when downloads below threshold`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = MetricsStore.MIN_DOWNLOADS_FOR_REVIEW - 1,
            daysInstalled = 100,
            daysSinceLastPrompt = Int.MAX_VALUE,
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertFalse(result)
    }

    @Test
    fun `should show when downloads exactly at threshold`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = MetricsStore.MIN_DOWNLOADS_FOR_REVIEW,
            daysInstalled = 100,
            daysSinceLastPrompt = Int.MAX_VALUE,
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertTrue(result)
    }

    @Test
    fun `should not show when days installed below threshold`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 100,
            daysInstalled = MetricsStore.MIN_DAYS_FOR_REVIEW - 1,
            daysSinceLastPrompt = Int.MAX_VALUE,
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertFalse(result)
    }

    @Test
    fun `should show when days installed exactly at threshold`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 100,
            daysInstalled = MetricsStore.MIN_DAYS_FOR_REVIEW,
            daysSinceLastPrompt = Int.MAX_VALUE,
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertTrue(result)
    }

    @Test
    fun `should not show when prompt shown recently`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 100,
            daysInstalled = 100,
            daysSinceLastPrompt = MetricsStore.DAYS_BETWEEN_PROMPTS - 1,
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertFalse(result)
    }

    @Test
    fun `should show when exactly DAYS_BETWEEN_PROMPTS since last prompt`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 100,
            daysInstalled = 100,
            daysSinceLastPrompt = MetricsStore.DAYS_BETWEEN_PROMPTS,
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertTrue(result)
    }

    @Test
    fun `should show when never prompted before`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 10,
            daysInstalled = 30,
            daysSinceLastPrompt = Int.MAX_VALUE, // Never shown
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertTrue(result)
    }

    @Test
    fun `zero downloads should not show`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 0,
            daysInstalled = 365,
            daysSinceLastPrompt = Int.MAX_VALUE,
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertFalse(result)
    }

    @Test
    fun `day zero should not show`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 100,
            daysInstalled = 0,
            daysSinceLastPrompt = Int.MAX_VALUE,
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertFalse(result)
    }

    @Test
    fun `both declined and completed should not show`() {
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = 100,
            daysInstalled = 365,
            daysSinceLastPrompt = Int.MAX_VALUE,
            reviewDeclined = true,
            reviewCompleted = true
        )
        assertFalse(result)
    }

    @Test
    fun `minimum viable user should show`() {
        // User who just barely meets all criteria
        val result = MetricsStore.shouldShowReviewPrompt(
            completedDownloads = MetricsStore.MIN_DOWNLOADS_FOR_REVIEW,
            daysInstalled = MetricsStore.MIN_DAYS_FOR_REVIEW,
            daysSinceLastPrompt = MetricsStore.DAYS_BETWEEN_PROMPTS,
            reviewDeclined = false,
            reviewCompleted = false
        )
        assertTrue(result)
    }
}
