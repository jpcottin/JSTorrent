package com.jstorrent.companion.server

import android.util.Base64
import android.util.Log
import com.jstorrent.io.file.FileManager
import com.jstorrent.io.file.FileManagerException
import com.jstorrent.io.hash.Hasher
import io.ktor.http.*
import io.ktor.server.application.*
import io.ktor.server.request.*
import io.ktor.server.response.*
import io.ktor.server.routing.*

private const val MAX_BODY_SIZE = 64 * 1024 * 1024 // 64MB
private const val TAG = "FileRoutes"

// Track concurrent writes
private val concurrentWrites = java.util.concurrent.atomic.AtomicInteger(0)
private val totalWrites = java.util.concurrent.atomic.AtomicLong(0)
private val totalWriteBytes = java.util.concurrent.atomic.AtomicLong(0)
private val totalWriteTimeMs = java.util.concurrent.atomic.AtomicLong(0)

/**
 * HTTP routes for file read/write operations.
 *
 * This is a thin adapter layer that:
 * - Validates HTTP parameters
 * - Resolves root keys to SAF URIs via RootStoreProvider
 * - Delegates to FileManager for actual I/O
 * - Translates FileManagerException to HTTP status codes
 */
fun Route.fileRoutes(rootStore: RootStoreProvider, fileManager: FileManager) {

    get("/read/{root_key}") {
        val rootKey = call.parameters["root_key"]
            ?: return@get call.respond(HttpStatusCode.BadRequest, "Missing root_key")

        val pathBase64 = call.request.header("X-Path-Base64")
            ?: return@get call.respond(HttpStatusCode.BadRequest, "Missing X-Path-Base64 header")

        val relativePath = try {
            String(Base64.decode(pathBase64, Base64.DEFAULT))
        } catch (e: Exception) {
            return@get call.respond(HttpStatusCode.BadRequest, "Invalid base64 in X-Path-Base64")
        }

        val offset = call.request.header("X-Offset")?.toLongOrNull() ?: 0L
        val length = call.request.header("X-Length")?.toIntOrNull()
            ?: return@get call.respond(HttpStatusCode.BadRequest, "Missing X-Length header")

        // Validate path (prevent directory traversal)
        if (relativePath.contains("..")) {
            return@get call.respond(HttpStatusCode.BadRequest, "Invalid path")
        }

        // Resolve root key to SAF URI
        val rootUri = rootStore.resolveKey(rootKey)
            ?: return@get call.respond(HttpStatusCode.Forbidden, "Invalid root key")

        try {
            val bytes = fileManager.read(rootUri, relativePath, offset, length)
            call.respondBytes(bytes, ContentType.Application.OctetStream)
        } catch (e: FileManagerException) {
            val (status, message) = e.toHttpResponse()
            call.respond(status, message)
        }
    }

    post("/write/{root_key}") {
        val concurrent = concurrentWrites.incrementAndGet()
        val t0 = System.nanoTime()

        val rootKey = call.parameters["root_key"]
            ?: return@post call.respond(HttpStatusCode.BadRequest, "Missing root_key")

        val pathBase64 = call.request.header("X-Path-Base64")
            ?: return@post call.respond(HttpStatusCode.BadRequest, "Missing X-Path-Base64 header")

        val relativePath = try {
            String(Base64.decode(pathBase64, Base64.DEFAULT))
        } catch (e: Exception) {
            return@post call.respond(HttpStatusCode.BadRequest, "Invalid base64 in X-Path-Base64")
        }

        val offset = call.request.header("X-Offset")?.toLongOrNull() ?: 0L
        val expectedSha1 = call.request.header("X-Expected-SHA1")

        // Validate path
        if (relativePath.contains("..")) {
            return@post call.respond(HttpStatusCode.BadRequest, "Invalid path")
        }

        // Resolve root key to SAF URI
        val rootUri = rootStore.resolveKey(rootKey)
            ?: return@post call.respond(HttpStatusCode.Forbidden, "Invalid root key")

        val tReceiveStart = System.nanoTime()
        val body = call.receive<ByteArray>()
        val receiveMs = (System.nanoTime() - tReceiveStart) / 1_000_000

        if (body.size > MAX_BODY_SIZE) {
            return@post call.respond(HttpStatusCode.PayloadTooLarge, "Body too large")
        }

        // Hash verification FIRST (before any file operations)
        var hashMs = 0L
        if (expectedSha1 != null) {
            val tHashStart = System.nanoTime()
            val actualHash = Hasher.sha1Hex(body)
            hashMs = (System.nanoTime() - tHashStart) / 1_000_000
            if (!actualHash.equals(expectedSha1, ignoreCase = true)) {
                return@post call.respond(
                    HttpStatusCode.Conflict,
                    "Hash mismatch: expected $expectedSha1, got $actualHash"
                )
            }
        }

        try {
            val tWriteStart = System.nanoTime()
            fileManager.write(rootUri, relativePath, offset, body)
            val writeMs = (System.nanoTime() - tWriteStart) / 1_000_000
            val totalMs = (System.nanoTime() - t0) / 1_000_000

            // Track stats
            val writeNum = totalWrites.incrementAndGet()
            totalWriteBytes.addAndGet(body.size.toLong())
            totalWriteTimeMs.addAndGet(totalMs)
            concurrentWrites.decrementAndGet()

            // Log every write with concurrency info
            Log.i(TAG, "WRITE #$writeNum: ${body.size/1024}KB in ${totalMs}ms (recv=${receiveMs}ms, hash=${hashMs}ms, write=${writeMs}ms) concurrent=$concurrent")

            call.respond(HttpStatusCode.OK)
        } catch (e: FileManagerException) {
            concurrentWrites.decrementAndGet()
            val (status, message) = e.toHttpResponse()
            call.respond(status, message)
        }
    }
}

/**
 * Convert FileManagerException to HTTP status code and message.
 */
private fun FileManagerException.toHttpResponse(): Pair<HttpStatusCode, String> {
    return when (this) {
        is FileManagerException.FileNotFound -> HttpStatusCode.NotFound to message!!
        is FileManagerException.CannotCreateFile -> HttpStatusCode.InternalServerError to message!!
        is FileManagerException.CannotOpenFile -> HttpStatusCode.InternalServerError to message!!
        is FileManagerException.InsufficientData -> HttpStatusCode.InternalServerError to message!!
        is FileManagerException.ReadError -> HttpStatusCode.InternalServerError to (message ?: "Read error")
        is FileManagerException.WriteError -> HttpStatusCode.InternalServerError to (message ?: "Write error")
        is FileManagerException.DiskFull -> HttpStatusCode.InsufficientStorage to message!!
    }
}
