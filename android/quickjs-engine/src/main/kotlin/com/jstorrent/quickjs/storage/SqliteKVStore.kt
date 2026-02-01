package com.jstorrent.quickjs.storage

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper

/**
 * Simple key-value store backed by SQLite.
 *
 * Provides the same semantics as chrome.storage.local:
 * - String keys and values
 * - get, set, delete, keys operations
 *
 * Unlike SharedPreferences, SQLite:
 * - Doesn't load entire database into memory
 * - Handles large values efficiently
 * - Scales to many keys without performance degradation
 */
class SqliteKVStore(context: Context) : SQLiteOpenHelper(
    context,
    DATABASE_NAME,
    null,
    DATABASE_VERSION
) {

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("""
            CREATE TABLE $TABLE_NAME (
                $COLUMN_KEY TEXT PRIMARY KEY,
                $COLUMN_VALUE TEXT
            )
        """.trimIndent())
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // No migrations needed yet - this is v1
    }

    /**
     * Get a value by key.
     * @return The value, or null if key doesn't exist.
     */
    fun get(key: String): String? {
        return readableDatabase.query(
            TABLE_NAME,
            arrayOf(COLUMN_VALUE),
            "$COLUMN_KEY = ?",
            arrayOf(key),
            null, null, null
        ).use { cursor ->
            if (cursor.moveToFirst()) {
                cursor.getString(0)
            } else {
                null
            }
        }
    }

    /**
     * Set a value by key.
     * Inserts if key doesn't exist, updates if it does.
     */
    fun set(key: String, value: String) {
        val values = ContentValues().apply {
            put(COLUMN_KEY, key)
            put(COLUMN_VALUE, value)
        }
        writableDatabase.insertWithOnConflict(
            TABLE_NAME,
            null,
            values,
            SQLiteDatabase.CONFLICT_REPLACE
        )
    }

    /**
     * Delete a key.
     * @return true if key existed and was deleted.
     */
    fun delete(key: String): Boolean {
        val rows = writableDatabase.delete(
            TABLE_NAME,
            "$COLUMN_KEY = ?",
            arrayOf(key)
        )
        return rows > 0
    }

    /**
     * Get all keys matching a prefix.
     * @param prefix The prefix to match (empty string matches all keys).
     * @return List of matching keys.
     */
    fun keys(prefix: String): List<String> {
        val result = mutableListOf<String>()
        readableDatabase.query(
            TABLE_NAME,
            arrayOf(COLUMN_KEY),
            "$COLUMN_KEY LIKE ?",
            arrayOf("$prefix%"),
            null, null, null
        ).use { cursor ->
            while (cursor.moveToNext()) {
                result.add(cursor.getString(0))
            }
        }
        return result
    }

    /**
     * Get multiple values by keys in a single query.
     * @param keys The keys to retrieve.
     * @return Map of key to value (null values omitted).
     */
    fun getMulti(keys: List<String>): Map<String, String> {
        if (keys.isEmpty()) return emptyMap()

        val result = mutableMapOf<String, String>()
        val placeholders = keys.joinToString(",") { "?" }
        readableDatabase.rawQuery(
            "SELECT $COLUMN_KEY, $COLUMN_VALUE FROM $TABLE_NAME WHERE $COLUMN_KEY IN ($placeholders)",
            keys.toTypedArray()
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val key = cursor.getString(0)
                val value = cursor.getString(1)
                if (value != null) {
                    result[key] = value
                }
            }
        }
        return result
    }

    /**
     * Delete all keys matching a prefix.
     * @param prefix The prefix to match.
     * @return Number of keys deleted.
     */
    fun clear(prefix: String): Int {
        return writableDatabase.delete(
            TABLE_NAME,
            "$COLUMN_KEY LIKE ?",
            arrayOf("$prefix%")
        )
    }

    companion object {
        private const val DATABASE_NAME = "jstorrent_kv.db"
        private const val DATABASE_VERSION = 1
        private const val TABLE_NAME = "kv"
        private const val COLUMN_KEY = "key"
        private const val COLUMN_VALUE = "value"
    }
}
