// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import android.os.Looper
import android.os.SystemClock
import android.view.MotionEvent
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Text
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.unit.dp
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config

/**
 * Lists on the native screens have to scroll (the Tools tab, the edit sheet's tools, the page
 * strip), even though those screens also keep their touches from the engine's page underneath.
 * Someone reported they didn't: a drag on a list was claimed by the screen before the list
 * could take it as a scroll.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class ScrollTest {
    private class Page(context: android.content.Context) : View(context) {
        var touches = 0
        override fun onTouchEvent(event: MotionEvent): Boolean {
            if (event.actionMasked == MotionEvent.ACTION_DOWN) touches++
            return true
        }
    }

    private fun settle() = repeat(5) {
        shadowOf(Looper.getMainLooper()).idle()
        Robolectric.flushForegroundThreadScheduler()
    }

    /** The engine's page, with a screen on top that holds one list, like the app's own layering. */
    private fun setUp(horizontal: Boolean): Triple<FrameLayout, Page, LazyListState> {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val root = FrameLayout(activity)
        val page = Page(activity)
        val list = LazyListState()
        val screen = ComposeView(activity).apply {
            setContent {
                Box(Modifier.fillMaxSize().ownTouches()) {
                    if (horizontal) {
                        LazyRow(state = list, modifier = Modifier.fillMaxWidth().height(120.dp)) {
                            items(60) { Text("Tool $it", Modifier.width(90.dp)) }
                        }
                    } else {
                        LazyColumn(state = list, modifier = Modifier.fillMaxSize()) {
                            items(100) { Text("Tool $it", Modifier.height(64.dp)) }
                        }
                    }
                }
            }
        }
        root.addView(page, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(screen, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        activity.setContentView(root)
        settle()
        return Triple(root, page, list)
    }

    /** A finger drag in small steps, the way a real swipe arrives. */
    private fun drag(root: View, x0: Float, y0: Float, x1: Float, y1: Float) {
        val t = SystemClock.uptimeMillis()
        root.dispatchTouchEvent(MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x0, y0, 0))
        val steps = 20
        for (i in 1..steps) {
            val f = i / steps.toFloat()
            root.dispatchTouchEvent(MotionEvent.obtain(t, t + i * 16L, MotionEvent.ACTION_MOVE, x0 + (x1 - x0) * f, y0 + (y1 - y0) * f, 0))
        }
        root.dispatchTouchEvent(MotionEvent.obtain(t, t + (steps + 1) * 16L, MotionEvent.ACTION_UP, x1, y1, 0))
        settle()
    }

    @Test fun aListScrollsUpAndDown() {
        val (root, page, list) = setUp(horizontal = false)
        drag(root, root.width / 2f, root.height * 0.8f, root.width / 2f, root.height * 0.2f)
        assertTrue("dragging up should scroll the list (first item is ${list.firstVisibleItemIndex})", list.firstVisibleItemIndex > 0)
        assertEquals("and the drag mustn't reach the page underneath", 0, page.touches)
    }

    @Test fun aRowScrollsSideways() {
        val (root, page, list) = setUp(horizontal = true)
        val y = 60f * root.resources.displayMetrics.density
        drag(root, root.width * 0.9f, y, root.width * 0.1f, y)
        assertTrue("dragging left should scroll the row (first item is ${list.firstVisibleItemIndex})", list.firstVisibleItemIndex > 0)
        assertEquals(0, page.touches)
    }

    /** The edit sheet: a row of tool buttons that scrolls sideways, at the bottom of the reader. */
    @Test fun theEditSheetsToolsScrollSideways() {
        val activity = Robolectric.buildActivity(ComponentActivity::class.java).setup().get()
        val root = FrameLayout(activity)
        val page = Page(activity)
        val row = ScrollState(0)
        val screen = ComposeView(activity).apply {
            setContent {
                Column(Modifier.fillMaxSize()) {
                    // the reader's middle, left clear for the page
                    Box(Modifier.weight(1f).fillMaxWidth())
                    Column(Modifier.fillMaxWidth().background(Color.DarkGray).ownTouches().padding(12.dp)) {
                        Row(Modifier.fillMaxWidth().horizontalScroll(row), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                            repeat(12) { Box(Modifier.size(64.dp).clickable { }) }
                        }
                    }
                }
            }
        }
        root.addView(page, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        root.addView(screen, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT))
        activity.setContentView(root)
        settle()
        val y = root.height - 50f * root.resources.displayMetrics.density
        drag(root, root.width * 0.85f, y, root.width * 0.1f, y)
        assertTrue("dragging along the sheet's tools should scroll them (moved ${row.value})", row.value > 0)
        assertEquals("and that drag mustn't reach the page", 0, page.touches)
        // the clear middle still belongs to the page
        drag(root, root.width / 2f, root.height * 0.3f, root.width / 2f, root.height * 0.4f)
        assertEquals("a drag above the sheet should reach the page", 1, page.touches)
    }

    @Test fun emptySpaceStillKeepsTouchesFromThePage() {
        val (root, page, _) = setUp(horizontal = true)
        // below the row: only the screen's background is here
        drag(root, root.width / 2f, root.height * 0.7f, root.width / 2f, root.height * 0.5f)
        assertEquals("the screen's empty space mustn't let touches through to the page", 0, page.touches)
    }
}
