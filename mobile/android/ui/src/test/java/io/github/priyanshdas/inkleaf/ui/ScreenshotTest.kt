// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.ui.unit.dp
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

// Pictures of every screen, made without a phone:
//   ./gradlew :ui:testDebugUnitTest -Droborazzi.test.record=true
// They land in ui/build/shots/. The reader's page is drawn by the editor engine on a real
// phone; here a plain sheet stands in for it.

private val now = System.currentTimeMillis()
private val docs = listOf(
    OpenDoc("t1", "Invoice-2041.pdf", "library/Invoice-2041.pdf", dirty = false, pages = 3, saveState = "saved"),
    OpenDoc("t2", "Untitled.pdf", null, dirty = true, pages = 1, saveState = "new"),
)
private val sample = UiState(
    engine = EngineState(ready = true, docs = docs, active = "t1", page = 1, pages = 3, canUndo = true),
    recents = listOf(
        RecentFile("library/Invoice-2041.pdf", "Invoice-2041.pdf", now - 120_000),
        RecentFile("library/Lease agreement.pdf", "Lease agreement.pdf", now - 26 * 3_600_000),
        RecentFile("library/CV - Priyansh.pdf", "CV - Priyansh.pdf", now - 3 * 86_400_000),
        RecentFile("library/Menu draft.pdf", "Menu draft.pdf", now - 8 * 86_400_000),
    ),
    computer = LinkedComputer("pc", "Priyansh-Laptop", online = true),
    version = "3.0.0",
)

@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [35], qualifiers = "w411dp-h891dp-xxhdpi")
class ScreenshotTest {
    private fun shot(name: String, dark: Boolean = false, content: @Composable () -> Unit) =
        captureRoboImage("build/shots/$name.png") { InkleafTheme(dark) { content() } }

    private val none = object : Actions {}

    @Composable
    private fun App(state: UiState, dark: Boolean = false) = InkleafApp(state, none, Catalog.English, dark)

    @Test fun welcome() = shot("01-welcome") { App(sample.copy(needsAgreement = true)) }

    @Test fun home() = shot("02-home") { App(sample.copy(engine = sample.engine.copy(active = null))) }

    @Test fun homeDark() = shot("03-home-dark", dark = true) { App(sample.copy(engine = sample.engine.copy(active = null)), dark = true) }

    @Test fun homeEmpty() = shot("04-home-empty") { App(UiState(engine = EngineState(ready = true))) }

    @Test fun tools() = shot("05-tools") { Box(Modifier.background(Color(0xFFF4F1EA))) { ToolsScreen(sample, {}) } }

    @Test fun devices() = shot("06-computer") { Box(Modifier.fillMaxSize().background(Color(0xFFF4F1EA))) { DevicesScreen(sample, none) } }

    @Test fun devicesNone() = shot("07-computer-none") { Box(Modifier.fillMaxSize().background(Color(0xFFF4F1EA))) { DevicesScreen(sample.copy(computer = null), none) } }

    @Test fun settings() = shot("08-settings") { Box(Modifier.fillMaxSize().background(Color(0xFFF4F1EA))) { SettingsScreen(sample, none) {} } }

    @Test fun reader() = shot("09-reader") { Reader(sample) }

    @Test fun readerEditing() = shot("10-reader-draw") {
        Reader(sample.copy(engine = sample.engine.copy(tool = "pen")), editing = EditTab.Annotate)
    }

    @Test fun readerText() = shot("11-reader-text") {
        Reader(sample.copy(engine = sample.engine.copy(tool = "text")), editing = EditTab.Text)
    }

    @Test fun readerPages() = shot("12-reader-pages") { Reader(sample, editing = EditTab.Pages) }

    @Test fun readerSelection() = shot("13-reader-selected") {
        Reader(sample.copy(engine = sample.engine.copy(selection = "text")))
    }

    @Test fun readerDark() = shot("14-reader-dark", dark = true) {
        Reader(sample.copy(engine = sample.engine.copy(tool = "pen")), editing = EditTab.Annotate)
    }

    /** A language's real catalog, the same file the editor uses. */
    private fun catalog(code: String): Catalog {
        val json = org.json.JSONObject(java.io.File("../../../src/renderer/i18n/$code.json").readText()).getJSONObject("strings")
        return Catalog(code, json.keys().asSequence().associateWith { json.getString(it) })
    }

    @Test fun hindi() = shot("15-home-hindi") {
        InkleafApp(sample.copy(engine = sample.engine.copy(active = null)), none, catalog("hi"), dark = false)
    }

    @Test fun arabicReader() = shot("16-reader-arabic") {
        androidx.compose.runtime.CompositionLocalProvider(LocalCatalog provides catalog("ar"),
            androidx.compose.ui.platform.LocalLayoutDirection provides androidx.compose.ui.unit.LayoutDirection.Rtl) {
            Reader(sample, editing = EditTab.Annotate)
        }
    }

    /** The reader over a stand-in page, the way the engine draws it underneath. */
    @Composable
    private fun Reader(state: UiState, editing: EditTab? = null) {
        Box(Modifier.fillMaxSize().background(Inkleaf.colors.reader)) {
            Box(Modifier.fillMaxSize().padding(start = 26.dp, end = 26.dp, top = 130.dp, bottom = 150.dp).background(Color.White))
            ReaderScreen(state, none, startEditing = editing) {}
        }
    }
}
