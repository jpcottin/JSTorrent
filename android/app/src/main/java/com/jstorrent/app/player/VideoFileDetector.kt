package com.jstorrent.app.player

/**
 * Lightweight file-extension detector for deciding whether a torrent file should
 * be considered a video playback candidate inside the app.
 *
 * This is intentionally conservative and does not guarantee the file will play.
 * Media3 capability probing comes later.
 */
object VideoFileDetector {

    private val VIDEO_EXTENSIONS = setOf(
        "mp4",
        "m4v",
        "mkv",
        "webm",
        "avi",
        "mov",
        "mpg",
        "mpeg",
        "wmv",
        "flv",
        "3gp"
    )

    fun isLikelyVideoFile(path: String): Boolean {
        val extension = path.substringAfterLast('.', "").lowercase()
        return extension in VIDEO_EXTENSIONS
    }
}
