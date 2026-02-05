package com.jstorrent.app.viewmodel

/**
 * Handle to an active subscription that allows releasing it.
 *
 * Each call to [TorrentRepository.subscribe] returns a unique handle.
 * The subscription remains active until [close] is called.
 *
 * Multiple handles can exist for the same topic (type + hash). The underlying
 * subscription is only removed when all handles for that topic are closed.
 *
 * Implements [AutoCloseable] for use with Kotlin's `use {}` blocks.
 */
interface SubscriptionHandle : AutoCloseable {
    /** Unique identifier for this subscription instance */
    val id: String

    /** Subscription type (e.g., "torrents", "peers", "files") */
    val type: String

    /** Torrent info hash, or empty string for global subscriptions */
    val hash: String

    /** Whether this handle has been closed */
    val isClosed: Boolean

    /**
     * Release this subscription.
     *
     * If this was the last handle for the topic, the underlying subscription
     * is removed. If other handles exist for the same topic, they continue
     * to receive updates.
     *
     * This method is idempotent - calling it multiple times has no effect.
     */
    override fun close()
}

/**
 * Internal implementation of [SubscriptionHandle].
 */
internal class SubscriptionHandleImpl(
    override val id: String,
    override val type: String,
    override val hash: String,
    private val onClose: (String) -> Unit
) : SubscriptionHandle {

    @Volatile
    override var isClosed: Boolean = false
        private set

    override fun close() {
        if (!isClosed) {
            isClosed = true
            onClose(id)
        }
    }
}
