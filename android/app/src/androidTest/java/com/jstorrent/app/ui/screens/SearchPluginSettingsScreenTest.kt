package com.jstorrent.app.ui.screens

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.jstorrent.app.search.InstalledPluginRecord
import com.jstorrent.app.search.RecommendedSearchPlugin
import com.jstorrent.app.search.SearchPluginManifest
import com.jstorrent.app.ui.theme.JSTorrentTheme
import com.jstorrent.app.viewmodel.SearchPluginSettingsUiState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class SearchPluginSettingsScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun screen_showsRecommendedInstalledAndAddSections() {
        composeTestRule.setContent {
            JSTorrentTheme {
                SearchPluginSettingsContent(
                    uiState = previewState(),
                    onNavigateBack = {},
                    onSourceUrlChanged = {},
                    onInstallFromUrl = {},
                    onInstallRecommended = {},
                    onSetPluginEnabled = { _, _ -> },
                    onRemovePlugin = {}
                )
            }
        }

        composeTestRule.onNodeWithText("Search Plugins").assertIsDisplayed()
        composeTestRule.onNodeWithText("Recommended").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("Installed").assertCountEquals(2)
        composeTestRule.onNodeWithText("Add from URL").assertIsDisplayed()
        composeTestRule.onAllNodesWithText("Internet Archive").assertCountEquals(2)
    }

    @Test
    fun addFromUrl_actionsInvokeCallbacks() {
        var changedValue = ""
        var installClicks = 0

        composeTestRule.setContent {
            JSTorrentTheme {
                SearchPluginSettingsContent(
                    uiState = previewState(sourceUrl = ""),
                    onNavigateBack = {},
                    onSourceUrlChanged = { changedValue = it },
                    onInstallFromUrl = { installClicks += 1 },
                    onInstallRecommended = {},
                    onSetPluginEnabled = { _, _ -> },
                    onRemovePlugin = {}
                )
            }
        }

        composeTestRule.onNodeWithText("Plugin URL").performTextInput("https://example.com/plugin.js")
        composeTestRule.onNodeWithText("Install").performClick()

        assertEquals("https://example.com/plugin.js", changedValue)
        assertEquals(1, installClicks)
    }

    private fun previewState(sourceUrl: String = "https://example.com/plugin.js"): SearchPluginSettingsUiState {
        return SearchPluginSettingsUiState(
            recommendedPlugins = listOf(
                RecommendedSearchPlugin(
                    manifest = SearchPluginManifest(
                        id = "org.archive.search",
                        name = "Internet Archive",
                        description = "Public-domain media search",
                        hosts = listOf("archive.org")
                    ),
                    sourceUrl = "https://example.com/archive.js"
                )
            ),
            installedPlugins = listOf(
                InstalledPluginRecord(
                    pluginId = "org.archive.search",
                    manifest = SearchPluginManifest(
                        id = "org.archive.search",
                        name = "Internet Archive",
                        description = "Public-domain media search",
                        hosts = listOf("archive.org")
                    ),
                    sourceHash = "abc",
                    installedAt = 1L,
                    updatedAt = 1L,
                    enabled = true,
                    code = "code"
                )
            ),
            sourceUrl = sourceUrl
        )
    }
}
