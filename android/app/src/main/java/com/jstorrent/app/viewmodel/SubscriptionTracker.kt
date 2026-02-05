package com.jstorrent.app.viewmodel

import android.util.Log
import java.util.UUID

/**
 * Tracks subscriptions with reference counting.
 *
 * Multiple consumers can subscribe to the same topic (type + hash). The tracker
 * only forwards actual subscribe/unsubscribe calls to the underlying system when
 * the reference count transitions 0↔1.
 *
 * This eliminates the problem where one consumer unsubscribing breaks other
 * consumers' subscriptions.
 *
 * Also handles visibility (pause/resume) automatically:
 * - Calls [onResume] when first subscription is created
 * - Calls [onPause] when last subscription is closed
 *
 * Thread-safe: All operations are synchronized.
 *
 * @param onSubscribe Called when first subscriber for a topic subscribes
 * @param onUnsubscribe Called when last subscriber for a topic unsubscribes
 * @param onPause Called when all subscriptions are closed (no consumers)
 * @param onResume Called when first subscription is created (has consumers)
 */
class SubscriptionTracker(
    private val onSubscribe: (type: String, hash: String, intervalMs: Int) -> Unit,
    private val onUnsubscribe: (type: String, hash: String) -> Unit,
    private val onPause: () -> Unit,
    private val onResume: () -> Unit
) {
    companion object {
        private const val TAG = "SubscriptionTracker"
    }

    /**
     * Key for grouping subscriptions by topic.
     */
    data class SubscriptionKey(val type: String, val hash: String)

    /**
     * Record of an individual subscription.
     */
    private data class SubscriptionRecord(
        val id: String,
        val key: SubscriptionKey,
        val intervalMs: Int
    )

    private val lock = Any()

    // All active subscriptions by ID
    private val subscriptions = mutableMapOf<String, SubscriptionRecord>()

    // Reference count per topic
    private val refCounts = mutableMapOf<SubscriptionKey, Int>()

    // Intervals per topic: key -> (subscriptionId -> interval)
    // Used to calculate minimum interval when subscribers have different preferences
    private val intervals = mutableMapOf<SubscriptionKey, MutableMap<String, Int>>()

    /**
     * Create a new subscription and return a handle to release it.
     *
     * If this is the first subscriber for the topic, [onSubscribe] is called.
     * If this is the first subscription overall, [onResume] is called.
     *
     * @param type Subscription type (e.g., "torrents", "peers")
     * @param hash Torrent info hash, or empty string for global subscriptions
     * @param intervalMs Desired push interval in milliseconds
     * @return Handle to release this subscription
     */
    fun subscribe(type: String, hash: String, intervalMs: Int): SubscriptionHandle {
        val id = UUID.randomUUID().toString()
        val key = SubscriptionKey(type, hash)

        synchronized(lock) {
            val wasEmpty = subscriptions.isEmpty()
            subscriptions[id] = SubscriptionRecord(id, key, intervalMs)

            val count = refCounts.getOrDefault(key, 0)
            refCounts[key] = count + 1

            // Track interval for this subscription
            intervals.getOrPut(key) { mutableMapOf() }[id] = intervalMs

            Log.d(TAG, "subscribe: $type for ${hashDisplay(hash)}, " +
                "id=${id.take(8)}..., refCount=${count + 1}, total=${subscriptions.size}")

            if (count == 0) {
                // First subscriber for this topic - actually subscribe
                val effectiveInterval = intervals[key]?.values?.minOrNull() ?: intervalMs
                onSubscribe(type, hash, effectiveInterval)
            }

            if (wasEmpty) {
                Log.d(TAG, "First subscription - resuming")
                onResume()
            }
        }

        return SubscriptionHandleImpl(id, type, hash, this::unsubscribe)
    }

    /**
     * Release a subscription by ID.
     *
     * If this was the last subscriber for the topic, [onUnsubscribe] is called.
     * If this was the last subscription overall, [onPause] is called.
     *
     * This is called internally by [SubscriptionHandle.close].
     */
    private fun unsubscribe(id: String) {
        synchronized(lock) {
            val record = subscriptions.remove(id) ?: return
            val key = record.key

            // Remove this subscription's interval
            intervals[key]?.remove(id)

            val count = refCounts[key] ?: return

            Log.d(TAG, "unsubscribe: ${key.type} for ${hashDisplay(key.hash)}, " +
                "id=${id.take(8)}..., refCount=${count - 1}, total=${subscriptions.size}")

            if (count <= 1) {
                refCounts.remove(key)
                intervals.remove(key)
                onUnsubscribe(key.type, key.hash)
            } else {
                refCounts[key] = count - 1
                // Note: We don't update the interval when subscribers leave.
                // JS side ignores interval changes anyway - it uses the first interval.
            }

            if (subscriptions.isEmpty()) {
                Log.d(TAG, "Last subscription closed - pausing")
                onPause()
            }
        }
    }

    /**
     * Replay all active subscriptions to a new controller.
     *
     * Call this when the engine restarts and a new controller is available.
     * This ensures subscriptions survive engine restarts.
     *
     * @param subscribe Function to call for each active subscription
     * @param resume Function to call if there are any active subscriptions
     */
    fun replayTo(
        subscribe: (type: String, hash: String, intervalMs: Int) -> Unit,
        resume: () -> Unit
    ) {
        synchronized(lock) {
            if (subscriptions.isEmpty()) {
                Log.d(TAG, "replayTo: no subscriptions to replay")
                return
            }

            Log.d(TAG, "replayTo: replaying ${refCounts.size} topics, ${subscriptions.size} total handles")

            // Resume first (so subscription pushes are active)
            resume()

            // Then replay each unique topic with its minimum interval
            for ((key, subIntervals) in intervals) {
                val minInterval = subIntervals.values.minOrNull() ?: 1000
                Log.d(TAG, "replayTo: ${key.type} for ${hashDisplay(key.hash)}, interval=$minInterval")
                subscribe(key.type, key.hash, minInterval)
            }
        }
    }

    /**
     * Get the number of active subscription handles.
     */
    fun getSubscriptionCount(): Int = synchronized(lock) { subscriptions.size }

    /**
     * Get the number of unique topics being subscribed to.
     */
    fun getTopicCount(): Int = synchronized(lock) { refCounts.size }

    /**
     * Check if there are any active subscriptions.
     */
    fun hasSubscriptions(): Boolean = synchronized(lock) { subscriptions.isNotEmpty() }

    /**
     * Clear all subscriptions (e.g., when repository is destroyed).
     */
    fun clear() {
        synchronized(lock) {
            if (subscriptions.isNotEmpty()) {
                Log.d(TAG, "clear: removing ${subscriptions.size} subscriptions")
                // Unsubscribe from all topics
                for (key in refCounts.keys.toList()) {
                    onUnsubscribe(key.type, key.hash)
                }
                subscriptions.clear()
                refCounts.clear()
                intervals.clear()
                onPause()
            }
        }
    }

    private fun hashDisplay(hash: String): String =
        if (hash.isEmpty()) "all" else "${hash.take(8)}..."
}
