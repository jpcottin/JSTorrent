package com.jstorrent.app.viewmodel

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import com.jstorrent.quickjs.log.EngineLogBuffer
import com.jstorrent.quickjs.log.LogBufferEntry
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn

enum class LogLevelFilter(val label: String, val ordinal_: Int) {
    DEBUG("Debug", 0),
    INFO("Info", 1),
    WARN("Warn", 2),
    ERROR("Error", 3);

    companion object {
        fun fromLogLevel(level: String): Int = when (level) {
            "debug" -> 0
            "info" -> 1
            "warn" -> 2
            "error" -> 3
            else -> 1
        }
    }
}

class LogViewerViewModel : ViewModel() {

    private val _levelFilter = MutableStateFlow(LogLevelFilter.DEBUG)
    val levelFilter: StateFlow<LogLevelFilter> = _levelFilter.asStateFlow()

    val filteredEntries: StateFlow<List<LogBufferEntry>> = combine(
        EngineLogBuffer.entries,
        _levelFilter
    ) { entries, filter ->
        if (filter == LogLevelFilter.DEBUG) {
            entries
        } else {
            entries.filter { LogLevelFilter.fromLogLevel(it.level) >= filter.ordinal_ }
        }
    }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5000), emptyList())

    fun setLevelFilter(filter: LogLevelFilter) {
        _levelFilter.value = filter
    }

    fun clearLogs() {
        EngineLogBuffer.clear()
    }
}
