package com.jstorrent.quickjs

import androidx.test.ext.junit.runners.AndroidJUnit4
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import kotlin.test.assertContentEquals
import kotlin.test.assertNull

@RunWith(AndroidJUnit4::class)
class QuickJsEnginePromiseBinaryTest {

    private lateinit var engine: QuickJsEngine

    @Before
    fun setUp() {
        engine = QuickJsEngine()
        engine.evaluate(
            """
            globalThis.__test_make_bytes = async () => new Uint8Array([1, 2, 3, 255]);
            globalThis.__test_make_null = async () => null;
            """.trimIndent()
        )
    }

    @After
    fun tearDown() {
        engine.close()
    }

    @Test
    fun awaitPromiseBinaryReturnsUint8ArrayBytes() = runBlocking {
        val result = engine.callGlobalFunctionAwaitPromiseBinary("__test_make_bytes")
        assertContentEquals(byteArrayOf(1, 2, 3, (-1).toByte()), result)
    }

    @Test
    fun awaitPromiseBinaryReturnsNullForNullPromiseResult() = runBlocking {
        val result = engine.callGlobalFunctionAwaitPromiseBinary("__test_make_null")
        assertNull(result)
    }
}
