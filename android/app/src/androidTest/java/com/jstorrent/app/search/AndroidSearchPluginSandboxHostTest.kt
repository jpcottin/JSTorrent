package com.jstorrent.app.search

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
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
    }
}
