// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.ComposeView
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * On a phone the editor engine draws the page underneath these screens. Touches on the page
 * must reach it, and touches anywhere else must not (or a tap on the home screen could draw on
 * a hidden page). A plain view stands in for the engine here and counts what reaches it.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class TouchTest {
    private class Page(context: android.content.Context) : View(context) {
        var touches = 0
        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (event.actionMasked == MotionEvent.ACTION_DOWN) touches++
            return true
        }
    }

    private val docs = listOf(OpenDoc("t1", "Invoice.pdf", "library/Invoice.pdf", dirty = false, pages = 3, saveState = "saved"))
    private val reading = UiState(engine = EngineState(ready = true, docs = docs, active = "t1", page = 1, pages = 3))
    private val home = reading.copy(engine = reading.engine.copy(active = null))

    private lateinit var root: FrameLayout
    private lateinit var page: Page
    private val state = mutableStateOf(reading)
    private val asked = mutableListOf<String>()

    @Before fun setUp() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        root = FrameLayout(activity)
        page = Page(activity)
        val screens = ComposeView(activity).apply {
            setContent {
                InkleafApp(state.value, object : Actions {
                    override fun setTool(tool: String) { asked += "tool:$tool" }
                }, Catalog.English, dark = false)
            }
        }
        root.addView(page, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(screens, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        activity.setContentView(root)
        settle()
    }

    private fun settle() {
        repeat(5) {
            shadowOf(Looper.getMainLooper()).idle()
            Robolectric.flushForegroundThreadScheduler()
        }
    }

    /** A finger down and up at a fraction of the screen's width and height. */
    private fun tap(x: Float, y: Float) {
        val px = root.width * x
        val py = root.height * y
        val t = SystemClock.uptimeMillis()
        root.dispatchTouchEvent(MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, px, py, 0))
        root.dispatchTouchEvent(MotionEvent.obtain(t, t + 50, MotionEvent.ACTION_UP, px, py, 0))
        settle()
    }

    @Test fun touchesOnThePageReachTheEngine() {
        tap(0.5f, 0.45f)
        assertEquals("a tap in the middle of the reader should reach the page", 1, page.touches)
    }

    @Test fun theTopBarKeepsItsTouches() {
        tap(0.5f, 0.04f)
        assertEquals(0, page.touches)
    }

    @Test fun theEditButtonIsNotThePage() {
        // the round edit button sits in the bottom corner
        tap(0.9f, 0.92f)
        assertEquals(0, page.touches)
    }

    @Test fun pageStillReachableWhileEditing() {
        tap(0.9f, 0.92f) // open the edit sheet
        tap(0.5f, 0.3f)
        assertEquals("the page above the sheet should still get touches", 1, page.touches)
        // and the sheet itself keeps its own: a tap on the sheet's lower part isn't a page touch
        tap(0.5f, 0.97f)
        assertEquals(1, page.touches)
    }

    @Test fun homeScreenCoversThePage() {
        state.value = home
        settle()
        for (y in listOf(0.2f, 0.5f, 0.8f, 0.95f)) tap(0.5f, y)
        for (y in listOf(0.3f, 0.6f)) tap(0.97f, y)
        assertEquals("nothing on the home screen should reach a page hidden underneath", 0, page.touches)
    }

    @Test fun computerTabCoversThePage() {
        state.value = home
        settle()
        tap(0.83f, 0.965f) // the Computer tab, in the bottom bar
        // the empty space below the card
        for (y in listOf(0.6f, 0.75f, 0.85f)) tap(0.5f, y)
        assertEquals("nothing on the Computer tab should reach a page hidden underneath", 0, page.touches)
    }

    @Test fun theEditSheetPicksTools() {
        tap(0.9f, 0.92f)
        assertTrue("the sheet opens on the Annotate tools", asked.isEmpty())
    }
}
