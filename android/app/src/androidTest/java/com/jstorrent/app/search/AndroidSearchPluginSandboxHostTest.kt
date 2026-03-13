package com.jstorrent.app.search

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class AndroidSearchPluginSandboxHostTest {

    private lateinit var host: AndroidSearchPluginSandboxHost

    @Before
    fun setUp() {
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        host = AndroidSearchPluginSandboxHost(context)
    }

    @After
    fun tearDown() {
        host.dispose()
    }

    @Test
    fun inspectSource_andRunDraft_returnManifestAndResults() = runBlocking {
        val inspection = host.inspectSource(TEST_PLUGIN_SOURCE)
        assertEquals("Test Sandbox Plugin", inspection.manifest.name)
        assertEquals(listOf("example.com"), inspection.manifest.hosts)

        val result = host.runDraft(
            source = TEST_PLUGIN_SOURCE,
            input = SearchPluginSearchInput(query = "ubuntu")
        )

        assertTrue(result.trace.ok)
        assertEquals(1, result.trace.results.size)
        assertEquals("Result ubuntu", result.trace.results.first().name)
        assertEquals("magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567", result.trace.results.first().magnetUrl)
        assertEquals("info", result.trace.logs.first().level)
    }

    @Test
    fun inspectSource_recoversAfterMalformedManifest() = runBlocking {
        val failure = runCatching {
            host.inspectSource(INVALID_MANIFEST_PLUGIN_SOURCE)
        }

        assertTrue(failure.isFailure)
        assertEquals(
            "Plugin manifest must include at least one declared host",
            failure.exceptionOrNull()?.message
        )

        val inspection = host.inspectSource(TEST_PLUGIN_SOURCE)
        assertEquals("Test Sandbox Plugin", inspection.manifest.name)
    }

    @Test
    fun repeatedRequests_reuseSingleWebViewInstance() = runBlocking {
        assertEquals(null, host.currentWebViewInstanceId())

        host.inspectSource(TEST_PLUGIN_SOURCE)
        val firstWebViewId = host.currentWebViewInstanceId()
        assertNotNull(firstWebViewId)

        host.runDraft(
            source = TEST_PLUGIN_SOURCE,
            input = SearchPluginSearchInput(query = "debian")
        )
        val secondWebViewId = host.currentWebViewInstanceId()

        host.inspectSource(TEST_PLUGIN_SOURCE)

        assertEquals(firstWebViewId, secondWebViewId)
        assertEquals(firstWebViewId, host.currentWebViewInstanceId())
    }

    companion object {
        private const val TEST_PLUGIN_SOURCE = """
            export const manifest = {
              id: 'test.plugin',
              name: 'Test Sandbox Plugin',
              hosts: ['example.com']
            }

            export async function search(ctx, input) {
              ctx.log('info', 'running search')
              ctx.emitResult({
                name: 'Result ' + input.query,
                source: 'Test Sandbox Plugin',
                magnetUrl: 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'
              })
            }
        """

        private const val INVALID_MANIFEST_PLUGIN_SOURCE = """
            export const manifest = {
              id: 'broken.plugin',
              name: 'Broken Sandbox Plugin',
              hosts: []
            }

            export async function search() {}
        """
    }
}
