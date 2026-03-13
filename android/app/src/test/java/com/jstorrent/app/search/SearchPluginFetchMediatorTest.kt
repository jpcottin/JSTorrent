package com.jstorrent.app.search

import kotlinx.coroutines.test.runTest
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.IOException

class SearchPluginFetchMediatorTest {

    @Test
    fun `fetch follows redirects within allowed host`() = runTest {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setResponseCode(302)
                .addHeader("Location", "/final")
        )
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("done")
        )
        server.start()

        try {
            val mediator = SearchPluginFetchMediator()
            val response = mediator.fetch(
                input = SearchPluginFetchInput(
                    url = server.url("/redirect").toString()
                ),
                policy = SearchPluginFetchPolicy(allowedHosts = listOf("localhost"))
            )

            assertEquals(200, response.statusCode)
            assertEquals("done", response.bodyText)
            assertEquals(server.url("/final").toString(), response.finalUrl)
        } finally {
            server.close()
        }
    }

    @Test(expected = IllegalArgumentException::class)
    fun `fetch rejects host outside allowlist`() = runTest {
        val mediator = SearchPluginFetchMediator()
        mediator.fetch(
            input = SearchPluginFetchInput(url = "https://archive.org/"),
            policy = SearchPluginFetchPolicy(allowedHosts = listOf("example.com"))
        )
    }

    @Test
    fun `fetch enforces response size cap`() = runTest {
        val server = MockWebServer()
        server.enqueue(
            MockResponse()
                .setResponseCode(200)
                .setBody("x".repeat(128))
        )
        server.start()

        try {
            val mediator = SearchPluginFetchMediator(maxResponseBytes = 64)
            try {
                mediator.fetch(
                    input = SearchPluginFetchInput(
                        url = server.url("/large").toString()
                    )
                )
            } catch (error: IOException) {
                assertTrue(error.message!!.contains("max response size"))
                return@runTest
            }
            throw AssertionError("Expected fetch to fail due to response size cap")
        } finally {
            server.close()
        }
    }
}
