package com.jstorrent.app.debug

import android.content.ComponentCallbacks2
import com.jstorrent.quickjs.model.AppMemorySnapshot
import kotlin.math.roundToInt

const val MEMORY_TAG = "JSTorrent-Mem"

private const val MIB = 1024L * 1024L

fun trimLevelName(level: Int?): String {
    return when (level) {
        null -> "none"
        ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE -> "RUNNING_MODERATE"
        ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW -> "RUNNING_LOW"
        ComponentCallbacks2.TRIM_MEMORY_RUNNING_CRITICAL -> "RUNNING_CRITICAL"
        ComponentCallbacks2.TRIM_MEMORY_UI_HIDDEN -> "UI_HIDDEN"
        ComponentCallbacks2.TRIM_MEMORY_BACKGROUND -> "BACKGROUND"
        ComponentCallbacks2.TRIM_MEMORY_MODERATE -> "MODERATE"
        ComponentCallbacks2.TRIM_MEMORY_COMPLETE -> "COMPLETE"
        else -> "LEVEL_$level"
    }
}

private fun formatMiB(bytes: Long): String {
    return "${(bytes / MIB.toDouble()).roundToInt()}M"
}

fun formatMemorySummary(snapshot: AppMemorySnapshot, reason: String? = null): String {
    val quickJs = snapshot.quickJs
    val engine = snapshot.engine
    val lastTrimAtMs = snapshot.lastTrimAtMs
    val trimText = if (snapshot.lastTrimLevel != null && lastTrimAtMs != null) {
        val ageSeconds = ((snapshot.timestampMs - lastTrimAtMs).coerceAtLeast(0) / 1000)
        "${trimLevelName(snapshot.lastTrimLevel)}@${ageSeconds}s"
    } else {
        "none"
    }

    val reasonPrefix = reason?.let { "[$it] " } ?: ""
    return buildString {
        append("[MEM] ")
        append(reasonPrefix)
        append("fg=")
        append(if (snapshot.appInForeground) "1" else "0")
        append(" pss:")
        append(snapshot.process.totalPssKb / 1024)
        append("M native:")
        append(formatMiB(snapshot.process.nativeHeapAllocatedBytes))
        append(" jvm:")
        append(formatMiB(snapshot.process.jvmUsedBytes))
        append("/")
        append(formatMiB(snapshot.process.jvmMaxBytes))
        append(" js:")
        append(quickJs?.let { formatMiB(it.memoryUsedSize) } ?: "n/a")
        append(" pieces:")
        append(engine?.totalActivePieces ?: 0)
        append(" buf:")
        append(engine?.let { formatMiB(it.totalBufferedBytes) } ?: "0M")
        append(" peers:")
        append(engine?.totalConnectedPeers ?: 0)
        append(" known:")
        append(engine?.totalKnownPeers ?: 0)
        append(" trim:")
        append(trimText)
    }
}

fun formatMemoryDetails(snapshot: AppMemorySnapshot): List<String> {
    val lines = mutableListOf<String>()
    lines += "=== MEMORY SNAPSHOT ==="
    lines += formatMemorySummary(snapshot)

    val process = snapshot.process
    lines += "Process: pss=${process.totalPssKb / 1024}M privateDirty=${process.totalPrivateDirtyKb / 1024}M " +
        "nativeHeap=${formatMiB(process.nativeHeapAllocatedBytes)} dalvikPss=${process.dalvikPssKb / 1024}M " +
        "nativePss=${process.nativePssKb / 1024}M otherPss=${process.otherPssKb / 1024}M"
    lines += "JVM: used=${formatMiB(process.jvmUsedBytes)} free=${formatMiB(process.jvmFreeBytes)} max=${formatMiB(process.jvmMaxBytes)}"
    lines += "System: avail=${formatMiB(process.systemAvailMemBytes)} lowMemory=${process.systemLowMemory} threshold=${formatMiB(process.systemThresholdBytes)}"

    snapshot.quickJs?.let { quickJs ->
        lines += "QuickJS: used=${formatMiB(quickJs.memoryUsedSize)} malloc=${formatMiB(quickJs.mallocSize)} " +
            "atoms=${formatMiB(quickJs.atomSize)} strings=${formatMiB(quickJs.strSize)} " +
            "objects=${quickJs.objCount} arrays=${quickJs.arrayCount} binary=${formatMiB(quickJs.binaryObjectSize)}"
    } ?: run {
        lines += "QuickJS: unavailable"
    }

    snapshot.engine?.let { engine ->
        lines += "Engine: torrents=${engine.torrentCount} downloading=${engine.activeDownloadingCount} " +
            "pieces=${engine.totalActivePieces} buffered=${formatMiB(engine.totalBufferedBytes)} " +
            "peers=${engine.totalConnectedPeers} known=${engine.totalKnownPeers} dhtNodes=${engine.dhtNodeCount ?: 0}"

        engine.torrents.forEach { torrent ->
            val pool = torrent.bufferPool?.let {
                " pool=${it.pooled}/${formatMiB(it.pooledBytes)} hit=${(it.hitRate * 100).roundToInt()}%"
            } ?: ""
            lines += "Torrent ${torrent.name}: status=${torrent.status} progress=${(torrent.progress * 100).roundToInt()}% " +
                "endgame=${torrent.isEndgame} pieces=${torrent.activePieces.total} " +
                "(p=${torrent.activePieces.partial},r=${torrent.activePieces.fullyRequested},w=${torrent.activePieces.fullyResponded}) " +
                "buf=${formatMiB(torrent.bufferedBytes)} peers=${torrent.peers.connected}/${torrent.peers.known}$pool"
        }
    } ?: run {
        lines += "Engine: unavailable"
    }

    lines += "=== END MEMORY SNAPSHOT ==="
    return lines
}
