package com.jstorrent.quickjs.bindings

import android.content.Context
import com.jstorrent.quickjs.QuickJsContext
import com.jstorrent.quickjs.storage.SqliteKVStore
import org.json.JSONArray

/**
 * Storage bindings for QuickJS using SQLite KV store.
 *
 * Implements the following native functions:
 * - __jstorrent_storage_get(key) -> string | null
 * - __jstorrent_storage_set(key, value) -> void
 * - __jstorrent_storage_delete(key) -> void
 * - __jstorrent_storage_keys(prefix) -> string (JSON array)
 *
 * Uses SQLite instead of SharedPreferences to handle large values
 * (torrent infodicts, bitfields) efficiently without loading everything
 * into memory.
 *
 * All operations are synchronous - they block the JS thread until complete.
 * SQLite operations are generally very fast for this use case.
 */
class StorageBindings(context: Context) {

    private val store = SqliteKVStore(context)

    /**
     * Register all storage bindings on the given context.
     */
    fun register(ctx: QuickJsContext) {
        // __jstorrent_storage_get(key: string): string | null
        ctx.setGlobalFunction("__jstorrent_storage_get") { args ->
            val key = args.getOrNull(0) ?: return@setGlobalFunction null
            store.get(key)
        }

        // __jstorrent_storage_set(key: string, value: string): void
        ctx.setGlobalFunction("__jstorrent_storage_set") { args ->
            val key = args.getOrNull(0)
            val value = args.getOrNull(1)

            if (key != null && value != null) {
                store.set(key, value)
            }
            null
        }

        // __jstorrent_storage_delete(key: string): void
        ctx.setGlobalFunction("__jstorrent_storage_delete") { args ->
            val key = args.getOrNull(0)

            if (key != null) {
                store.delete(key)
            }
            null
        }

        // __jstorrent_storage_keys(prefix: string): string (JSON array)
        ctx.setGlobalFunction("__jstorrent_storage_keys") { args ->
            val prefix = args.getOrNull(0) ?: ""

            val keys = store.keys(prefix)

            JSONArray().apply {
                keys.forEach { put(it) }
            }.toString()
        }
    }
}
