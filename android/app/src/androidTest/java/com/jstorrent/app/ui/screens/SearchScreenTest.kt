package com.jstorrent.app.ui.screens

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import com.jstorrent.app.search.RecommendedSearchPlugin
import com.jstorrent.app.search.SearchPluginManifest
import com.jstorrent.app.ui.theme.JSTorrentTheme
import com.jstorrent.app.viewmodel.SearchUiState
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test

class SearchScreenTest {

    @get:Rule
    val composeTestRule = createComposeRule()

    @Test
    fun emptyState_showsInstallAndManageActions() {
        composeTestRule.setContent {
            JSTorrentTheme {
                SearchScreenContent(
                    uiState = SearchUiState(
                        recommendedPlugins = listOf(
                            RecommendedSearchPlugin(
                                manifest = SearchPluginManifest(
                                    id = "org.archive.search",
                                    name = "Internet Archive",
                                    hosts = listOf("archive.org")
                                ),
                                sourceUrl = "https://example.com/archive.js"
                            )
                        )
                    ),
                    onNavigateBack = {},
                    onManageSearchPlugins = {},
                    onQueryChanged = {},
                    onCategoryChanged = {},
                    onSearch = {},
                    onInstallRecommended = {},
                    onAddResult = {}
                )
            }
        }

        composeTestRule.onNodeWithText("No search plugins are enabled").assertIsDisplayed()
        composeTestRule.onNodeWithText("Install Internet Archive").assertIsDisplayed()
        composeTestRule.onNodeWithText("Manage Search Plugins").assertIsDisplayed()
    }

    @Test
    fun searchForm_callbacksFire() {
        var query = ""
        var searches = 0

        composeTestRule.setContent {
            JSTorrentTheme {
                SearchScreenContent(
                    uiState = SearchUiState(enabledPlugins = emptyList()),
                    onNavigateBack = {},
                    onManageSearchPlugins = {},
                    onQueryChanged = { query = it },
                    onCategoryChanged = {},
                    onSearch = { searches += 1 },
                    onInstallRecommended = {},
                    onAddResult = {}
                )
            }
        }

        composeTestRule.onNodeWithText("Search query").performTextInput("ubuntu")
        composeTestRule.onNodeWithContentDescription("Run search").performClick()

        assertEquals("ubuntu", query)
        assertEquals(1, searches)
    }
}
