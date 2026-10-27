// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.ImageBitmap

// What the screens show. The app module fills these in from the editor engine
// (see src/renderer/engine.ts for the other side) and from the phone's storage.

@Immutable
data class OpenDoc(
    val id: String,
    val name: String,
    val path: String?,
    val dirty: Boolean,
    val pages: Int,
    /** "saved", "saving", "dirty", "off", "new", "error", "protected" */
    val saveState: String,
)

@Immutable
data class PenStyle(val color: String = "#1d3f91", val width: Float = 2f, val opacity: Float = 1f)

@Immutable
data class ShapeStyle(val color: String = "#d1345b", val width: Float = 2f)

@Immutable
data class TextStyleChoice(
    val size: Float = 14f,
    val color: String = "#1a1a1a",
    val bold: Boolean = false,
    val italic: Boolean = false,
    val underline: Boolean = false,
)

@Immutable
data class StampChoice(val label: String = "APPROVED", val color: String = "#1f8a5b", val date: Boolean = true)

@Immutable
data class ToolStyles(
    val pen: PenStyle = PenStyle(),
    val highlight: String = "#ffe169",
    val shape: ShapeStyle = ShapeStyle(),
    val line: ShapeStyle = ShapeStyle(),
    val text: TextStyleChoice = TextStyleChoice(),
    val note: String = "#ffd166",
    val stamp: StampChoice = StampChoice(),
)

@Immutable
data class EngineState(
    val ready: Boolean = false,
    val docs: List<OpenDoc> = emptyList(),
    val active: String? = null,
    val page: Int = 0,
    val pages: Int = 0,
    val tool: String = "select",
    val styles: ToolStyles = ToolStyles(),
    val canUndo: Boolean = false,
    val canRedo: Boolean = false,
    /** the kind of mark selected on the page ("ink", "text", "rect"…), if any */
    val selection: String? = null,
    val editingText: Boolean = false,
    /** one of the editor's own dialogs is open, shown full screen over these screens */
    val overlay: Boolean = false,
    val busy: String? = null,
    val autosave: Boolean = true,
) {
    val activeDoc: OpenDoc? get() = docs.firstOrNull { it.id == active }
}

@Immutable
data class RecentFile(val path: String, val name: String, val openedAt: Long)

@Immutable
data class LinkedComputer(val id: String, val name: String, val online: Boolean)

enum class ThemeChoice(val key: String) { System("system"), Light("light"), Dark("dark") }

@Immutable
data class UiState(
    val engine: EngineState = EngineState(),
    val recents: List<RecentFile> = emptyList(),
    /** first-page pictures of recent files, by path */
    val thumbs: Map<String, ImageBitmap> = emptyMap(),
    /** pictures of the open document's pages, by page index */
    val pageImages: Map<Int, ImageBitmap> = emptyMap(),
    val computer: LinkedComputer? = null,
    val needsAgreement: Boolean = false,
    val theme: ThemeChoice = ThemeChoice.System,
    val languageName: String = "English",
    val version: String = "",
)

/** Everything the screens can ask for. */
interface Actions {
    fun agree() {}
    fun showLegal(kind: String) {}

    fun openFile() {}
    fun newBlank() {}
    fun openRecent(path: String) {}
    fun forgetRecent(path: String) {}
    fun activate(id: String) {}
    fun close(id: String, discard: Boolean) {}

    /** Runs one of the editor's commands ("compress", "ocr", "scan-to-pdf"…). */
    fun run(command: String) {}

    /** Runs a tool from the Tools tab, opening a PDF first if it needs one and none is open. */
    fun runTool(command: String, needsDoc: Boolean) {}

    fun setTool(tool: String) {}
    fun setStyle(group: String, patch: Map<String, Any?>) {}
    fun undo() {}
    fun redo() {}
    fun deleteSelection() {}
    fun duplicate() {}
    fun editText() {}
    fun deselect() {}
    fun goToPage(page: Int) {}
    fun requestPageImage(index: Int) {}
    fun save() {}

    /** Where the page should be drawn on screen, in window pixels; null when no page is showing. */
    fun pageArea(left: Int, top: Int, right: Int, bottom: Int) {}
    fun hidePage() {}

    fun setTheme(theme: ThemeChoice) {}
    fun chooseLanguage() {}
    fun forgetComputer(id: String) {}
    fun openLink(url: String) {}
}
