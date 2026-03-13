package com.jstorrent.app.viewmodel

import android.content.Context
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.jstorrent.app.search.AndroidSearchPluginSandboxHost
import com.jstorrent.app.search.InstalledPluginRecord
import com.jstorrent.app.search.RecommendedSearchPlugin
import com.jstorrent.app.search.SearchDisplayResult
import com.jstorrent.app.search.SearchPluginExecutionRuntime
import com.jstorrent.app.search.SearchPluginFetchInput
import com.jstorrent.app.search.SearchPluginFetchPolicy
import com.jstorrent.app.search.SearchPluginFetcher
import com.jstorrent.app.search.SearchPluginRepository
import com.jstorrent.app.search.SearchPluginSearchInput
import com.jstorrent.app.search.SearchPluginSettingsStore
import com.jstorrent.app.search.SearchRunSummary
import com.jstorrent.app.search.sanitizeDraftRunResult
import com.jstorrent.app.util.Formatters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import java.util.Base64

data class SearchUiState(
    val query: String = "",
    val category: String? = null,
    val categoryOptions: List<String> = emptyList(),
    val enabledPlugins: List<InstalledPluginRecord> = emptyList(),
    val results: List<SearchDisplayResult> = emptyList(),
    val runSummaries: List<SearchRunSummary> = emptyList(),
    val recommendedPlugins: List<RecommendedSearchPlugin> = emptyList(),
    val isSearching: Boolean = false,
    val searchedOnce: Boolean = false,
    val addingResultIds: Set<String> = emptySet(),
    val statusMessage: String? = null,
    val errorMessage: String? = null
)

class SearchViewModel(
    private val store: SearchPluginSettingsStore,
    private val runtime: SearchPluginExecutionRuntime,
    private val fetcher: SearchPluginFetcher,
    private val addTorrent: (String) -> Unit,
    private val onClearedCallback: () -> Unit = {}
) : ViewModel() {

    private var searchJob: Job? = null

    private val _uiState = MutableStateFlow(
        SearchUiState(
            recommendedPlugins = store.recommendedPlugins()
        )
    )
    val uiState: StateFlow<SearchUiState> = _uiState.asStateFlow()

    init {
        refreshEnabledPlugins()
    }

    fun onQueryChanged(value: String) {
        _uiState.value = _uiState.value.copy(
            query = value,
            errorMessage = null,
            statusMessage = null
        )
    }

    fun onCategoryChanged(value: String?) {
        _uiState.value = _uiState.value.copy(
            category = value,
            errorMessage = null,
            statusMessage = null
        )
    }

    fun refreshEnabledPlugins() {
        viewModelScope.launch {
            runCatching {
                store.listInstalledPlugins()
            }.onSuccess { plugins ->
                val enabledPlugins = plugins.filter { it.enabled }
                val categories = enabledPlugins
                    .flatMap { it.manifest.categories.orEmpty() }
                    .map { it.trim() }
                    .filter { it.isNotEmpty() }
                    .distinct()
                    .sorted()
                val currentCategory = _uiState.value.category
                    ?.takeIf { it in categories }
                _uiState.value = _uiState.value.copy(
                    enabledPlugins = enabledPlugins,
                    categoryOptions = categories,
                    category = currentCategory,
                    recommendedPlugins = store.recommendedPlugins()
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    errorMessage = error.message ?: "Failed to load search plugins"
                )
            }
        }
    }

    fun installRecommendedPlugin(plugin: RecommendedSearchPlugin) {
        viewModelScope.launch {
            _uiState.value = _uiState.value.copy(errorMessage = null, statusMessage = null)
            runCatching {
                store.installFromUrl(plugin.sourceUrl)
                store.listInstalledPlugins()
            }.onSuccess { plugins ->
                val enabledPlugins = plugins.filter { it.enabled }
                _uiState.value = _uiState.value.copy(
                    enabledPlugins = enabledPlugins,
                    categoryOptions = enabledPlugins.flatMap { it.manifest.categories.orEmpty() }.distinct().sorted(),
                    recommendedPlugins = store.recommendedPlugins(),
                    statusMessage = "${plugin.manifest.name} installed"
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    errorMessage = error.message ?: "Failed to install plugin"
                )
            }
        }
    }

    fun search() {
        val state = _uiState.value
        val query = state.query.trim()
        if (query.isEmpty()) {
            _uiState.value = state.copy(errorMessage = "Enter a search query")
            return
        }
        if (state.enabledPlugins.isEmpty()) {
            _uiState.value = state.copy(errorMessage = "No search plugins are enabled")
            return
        }

        searchJob?.cancel()
        searchJob = viewModelScope.launch {
            _uiState.value = state.copy(
                isSearching = true,
                searchedOnce = true,
                results = emptyList(),
                runSummaries = emptyList(),
                errorMessage = null,
                statusMessage = null
            )

            val input = SearchPluginSearchInput(
                query = query,
                category = state.category
            )

            val summaries = mutableListOf<SearchRunSummary>()
            val results = mutableListOf<SearchDisplayResult>()

            state.enabledPlugins.forEach { plugin ->
                val draft = runCatching {
                    runtime.runDraft(plugin.code, input)
                }.mapCatching { result ->
                    sanitizeDraftRunResult(result)
                }.getOrElse { error ->
                    com.jstorrent.app.search.SearchPluginDraftRunResult(
                        manifest = plugin.manifest,
                        trace = com.jstorrent.app.search.SearchPluginRunTrace(
                            ok = false,
                            durationMs = 0L,
                            results = emptyList(),
                            logs = emptyList(),
                            requests = emptyList(),
                            error = com.jstorrent.app.search.SearchPluginRunError(
                                phase = "search",
                                name = error.javaClass.simpleName,
                                message = error.message ?: "Search failed"
                            )
                        )
                    )
                }
                summaries += SearchRunSummary(
                    pluginId = plugin.pluginId,
                    pluginName = plugin.manifest.name,
                    ok = draft.trace.ok,
                    durationMs = draft.trace.durationMs,
                    resultCount = draft.trace.results.size,
                    errorMessage = draft.trace.error?.message
                )
                draft.trace.results.forEach { result ->
                    results += SearchDisplayResult(
                        pluginId = plugin.pluginId,
                        pluginName = plugin.manifest.name,
                        allowedHosts = plugin.manifest.hosts,
                        result = result
                    )
                }
            }

            try {
                _uiState.value = _uiState.value.copy(
                    isSearching = false,
                    results = sortResults(results),
                    runSummaries = summaries,
                    errorMessage = when {
                        results.isEmpty() && summaries.all { !it.ok && it.errorMessage != null } -> {
                            summaries.firstNotNullOfOrNull { it.errorMessage }
                        }
                        results.isEmpty() && summaries.any { !it.ok && it.errorMessage != null } -> {
                            "No results. One or more plugins failed."
                        }
                        else -> null
                    }
                )
            } catch (error: CancellationException) {
                throw error
            }
        }.also { job ->
            job.invokeOnCompletion { error ->
                if (error is CancellationException && _uiState.value.isSearching) {
                    _uiState.value = _uiState.value.copy(isSearching = false)
                }
            }
        }
    }

    fun addResult(displayResult: SearchDisplayResult) {
        viewModelScope.launch {
            val stableId = displayResult.stableId
            _uiState.value = _uiState.value.copy(
                addingResultIds = _uiState.value.addingResultIds + stableId,
                errorMessage = null,
                statusMessage = null
            )

            runCatching {
                when {
                    !displayResult.result.magnetUrl.isNullOrBlank() -> {
                        addTorrent(displayResult.result.magnetUrl)
                    }

                    !displayResult.result.torrentUrl.isNullOrBlank() -> {
                        val response = fetcher.fetch(
                            input = SearchPluginFetchInput(
                                url = displayResult.result.torrentUrl,
                                method = "GET"
                            ),
                            policy = SearchPluginFetchPolicy(displayResult.allowedHosts)
                        )
                        require(response.bodyBytes.isNotEmpty()) {
                            "Torrent download was empty"
                        }
                        addTorrent(Base64.getEncoder().encodeToString(response.bodyBytes))
                    }

                    else -> {
                        throw IllegalArgumentException("Search result has no magnet or torrent URL")
                    }
                }
            }.onSuccess {
                _uiState.value = _uiState.value.copy(
                    addingResultIds = _uiState.value.addingResultIds - stableId,
                    statusMessage = "Added ${displayResult.result.name}"
                )
            }.onFailure { error ->
                _uiState.value = _uiState.value.copy(
                    addingResultIds = _uiState.value.addingResultIds - stableId,
                    errorMessage = error.message ?: "Failed to add search result"
                )
            }
        }
    }

    fun clearMessages() {
        _uiState.value = _uiState.value.copy(
            statusMessage = null,
            errorMessage = null
        )
    }

    override fun onCleared() {
        searchJob?.cancel()
        onClearedCallback()
        super.onCleared()
    }

    companion object {
        fun sortResults(results: List<SearchDisplayResult>): List<SearchDisplayResult> {
            return results.sortedWith(
                compareByDescending<SearchDisplayResult> { it.result.seeds ?: -1L }
                    .thenByDescending { it.result.publishedAt ?: -1L }
                    .thenBy { it.result.name.lowercase() }
            )
        }

        fun formatResultMeta(result: SearchDisplayResult): String {
            val parts = buildList {
                add(result.pluginName)
                result.result.size?.let { add(Formatters.formatBytes(it)) }
                result.result.seeds?.let { add("${it} seeds") }
                result.result.publishedAt?.let { add(Formatters.formatDateTime(it)) }
            }
            return parts.joinToString(" • ")
        }
    }

    class Factory(
        private val context: Context,
        private val addTorrent: (String) -> Unit
    ) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T {
            if (modelClass.isAssignableFrom(SearchViewModel::class.java)) {
                val host = AndroidSearchPluginSandboxHost(context.applicationContext)
                val repository = SearchPluginRepository(
                    context = context.applicationContext,
                    runtime = host
                )
                return SearchViewModel(
                    store = repository,
                    runtime = host,
                    fetcher = com.jstorrent.app.search.SearchPluginFetchMediator(),
                    addTorrent = addTorrent,
                    onClearedCallback = host::dispose
                ) as T
            }
            throw IllegalArgumentException("Unknown ViewModel class: ${modelClass.name}")
        }
    }
}
