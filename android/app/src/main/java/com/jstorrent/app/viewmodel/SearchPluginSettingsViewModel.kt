package com.jstorrent.app.viewmodel

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jstorrent.app.search.AndroidSearchPluginSandboxHost
import com.jstorrent.app.search.InstalledPluginRecord
import com.jstorrent.app.search.RecommendedSearchPlugin
import com.jstorrent.app.search.SearchPluginRepository
import com.jstorrent.app.search.SearchPluginSettingsStore
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

data class SearchPluginSettingsUiState(
    val recommendedPlugins: List<RecommendedSearchPlugin> = emptyList(),
    val installedPlugins: List<InstalledPluginRecord> = emptyList(),
    val sourceUrl: String = "",
    val isLoading: Boolean = false,
    val statusMessage: String? = null,
    val errorMessage: String? = null
)

class SearchPluginSettingsViewModel(
    private val store: SearchPluginSettingsStore,
    private val onClearedCallback: () -> Unit = {}
) : ViewModel() {

    private val _uiState = MutableStateFlow(
        SearchPluginSettingsUiState(
            recommendedPlugins = store.recommendedPlugins(),
            isLoading = true
        )
    )
    val uiState: StateFlow<SearchPluginSettingsUiState> = _uiState.asStateFlow()

    init {
        refreshPlugins()
    }

    fun refreshPlugins() {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(isLoading = true, errorMessage = null)
            runCatching {
                store.listInstalledPlugins()
            }.onSuccess { plugins ->
                _uiState.value = _uiState.value.copy(
                    installedPlugins = plugins,
                    recommendedPlugins = store.recommendedPlugins(),
                    isLoading = false
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    errorMessage = error.message ?: "Failed to load search plugins"
                )
            }
        }
    }

    fun onSourceUrlChanged(value: String) {
        _uiState.value = _uiState.value.copy(
            sourceUrl = value,
            errorMessage = null,
            statusMessage = null
        )
    }

    fun installFromUrl() {
        val url = _uiState.value.sourceUrl.trim()
        if (url.isEmpty()) {
            _uiState.value = _uiState.value.copy(
                errorMessage = "Enter a plugin URL"
            )
            return
        }

        launchPluginOperation(
            successMessage = "Plugin installed"
        ) {
            store.installFromUrl(url)
            _uiState.value = _uiState.value.copy(sourceUrl = "")
        }
    }

    fun installRecommendedPlugin(plugin: RecommendedSearchPlugin) {
        launchPluginOperation(
            successMessage = "${plugin.manifest.name} installed"
        ) {
            store.installFromUrl(plugin.sourceUrl)
        }
    }

    fun setPluginEnabled(pluginId: String, enabled: Boolean) {
        val pluginName = _uiState.value.installedPlugins
            .firstOrNull { it.pluginId == pluginId }
            ?.manifest
            ?.name
            ?: "Plugin"
        launchPluginOperation(
            successMessage = if (enabled) "$pluginName enabled" else "$pluginName disabled"
        ) {
            store.setPluginEnabled(pluginId, enabled)
        }
    }

    fun removePlugin(pluginId: String) {
        val pluginName = _uiState.value.installedPlugins
            .firstOrNull { it.pluginId == pluginId }
            ?.manifest
            ?.name
            ?: "Plugin"
        launchPluginOperation(
            successMessage = "$pluginName removed"
        ) {
            store.removePlugin(pluginId)
        }
    }

    fun clearMessages() {
        _uiState.value = _uiState.value.copy(
            statusMessage = null,
            errorMessage = null
        )
    }

    override fun onCleared() {
        onClearedCallback()
        super.onCleared()
    }

    private fun launchPluginOperation(
        successMessage: String,
        action: suspend () -> Unit
    ) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(
                isLoading = true,
                errorMessage = null,
                statusMessage = null
            )
            runCatching {
                action()
                store.listInstalledPlugins()
            }.onSuccess { plugins ->
                _uiState.value = _uiState.value.copy(
                    installedPlugins = plugins,
                    recommendedPlugins = store.recommendedPlugins(),
                    isLoading = false,
                    statusMessage = successMessage
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    isLoading = false,
                    errorMessage = error.message ?: "Search plugin action failed"
                )
            }
        }
    }

    class Factory(
        private val context: Context
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            if (modelClass.isAssignableFrom(SearchPluginSettingsViewModel::class.java)) {
                val host = AndroidSearchPluginSandboxHost(context.applicationContext)
                val repository = SearchPluginRepository(
                    context = context.applicationContext,
                    runtime = host
                )
                return SearchPluginSettingsViewModel(
                    store = repository,
                    onClearedCallback = host::dispose
                ) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
    }
}
