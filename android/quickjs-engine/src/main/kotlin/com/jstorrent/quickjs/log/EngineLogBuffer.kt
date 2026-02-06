package com.jstorrent.quickjs.log

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import java.util.concurrent.atomic.AtomicLong

data class LogBufferEntry(
    val id: Long,
    val timestamp: Long,
    val level: String,
    val message: String
)

object EngineLogBuffer {
    private const val MAX_ENTRIES = 1000
    private const val TRIM_THRESHOLD = 1500

    private val _entries = MutableStateFlow<List<LogBufferEntry>>(emptyList())
    val entries: StateFlow<List<LogBufferEntry>> = _entries.asStateFlow()
    private val nextId = AtomicLong(0)

    fun add(level: String, message: String) {
        _entries.update { current ->
            val entry = LogBufferEntry(nextId.getAndIncrement(), System.currentTimeMillis(), level, message)
            val newList = current + entry
            if (newList.size > TRIM_THRESHOLD) newList.takeLast(MAX_ENTRIES) else newList
        }
    }

    fun clear() {
        _entries.value = emptyList()
    }
}
