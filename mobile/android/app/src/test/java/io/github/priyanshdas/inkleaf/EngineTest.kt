// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf

import android.os.Looper
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import kotlinx.coroutines.launch
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/** The engine's reports (a real one, recorded from src/renderer/engine.ts) become what the screens show. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35])
class EngineTest {
    private fun report(): JSONObject =
        JSONObject(javaClass.classLoader!!.getResource("engine-state.json")!!.readText())

    private fun deliver(json: JSONObject) {
        Engine.onState(json)
        shadowOf(Looper.getMainLooper()).idle()
    }

    @Test fun readsAnOpenDocument() {
        deliver(report())
        val e = Engine.state.value.engine
        assertTrue(e.ready)
        assertEquals(1, e.docs.size)
        assertEquals("Untitled.pdf", e.docs[0].name)
        // JSON null must not turn into the text "null"
        assertNull(e.docs[0].path)
        assertEquals("new", e.docs[0].saveState)
        assertEquals(e.docs[0].id, e.active)
        assertEquals(1, e.page)
        assertEquals("highlight", e.tool)
    }

    @Test fun readsToolStyles() {
        deliver(report())
        val s = Engine.state.value.engine.styles
        assertEquals("#ffe169", s.highlight)
        assertEquals("#1d3f91", s.pen.color)
        assertEquals(2f, s.pen.width)
        assertEquals(14f, s.text.size)
        assertEquals("APPROVED", s.stamp.label)
    }

    @Test fun nothingSelectedOrBusyIsNull() {
        deliver(report())
        val e = Engine.state.value.engine
        assertNull(e.selection)
        assertNull(e.busy)
        assertFalse(e.overlay)
    }

    @Test fun noDocumentOpen() {
        deliver(report().put("docs", org.json.JSONArray()).put("active", JSONObject.NULL).put("pages", 0))
        val e = Engine.state.value.engine
        assertNull(e.active)
        assertNull(e.activeDoc)
    }

    @Test fun aSelectionAndBusyMessage() {
        deliver(report().put("selection", "ink").put("busy", "Compressing…").put("overlay", true))
        val e = Engine.state.value.engine
        assertEquals("ink", e.selection)
        assertEquals("Compressing…", e.busy)
        assertTrue(e.overlay)
    }

    @Test fun messagesFromTheEditorBecomeNotices() {
        val seen = mutableListOf<String>()
        val job = kotlinx.coroutines.CoroutineScope(kotlinx.coroutines.Dispatchers.Main.immediate)
            .launch(start = kotlinx.coroutines.CoroutineStart.UNDISPATCHED) { Engine.notices.collect { seen += it.text } }
        Engine.onEvent("toast", "Saved “Report.pdf”", "success")
        shadowOf(Looper.getMainLooper()).idle()
        job.cancel()
        assertEquals(listOf("Saved “Report.pdf”"), seen)
    }
}
