// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.annotation.DrawableRes
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.SliderDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.boundsInWindow
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import kotlin.math.roundToInt

/** The parts of the edit sheet. */
enum class EditTab(val title: String) { Annotate(msg("Annotate")), Text(msg("Text")), Sign(msg("Sign")), Pages(msg("Pages")) }

private data class ToolButton(val tool: String, val title: String, @DrawableRes val icon: Int)

private val TOOLS = mapOf(
    EditTab.Annotate to listOf(
        ToolButton("pen", msg("Draw"), R.drawable.lc_pen_line),
        ToolButton("highlight", msg("Highlight"), R.drawable.lc_highlighter),
        ToolButton("rect", msg("Rectangle"), R.drawable.lc_square),
        ToolButton("ellipse", msg("Ellipse"), R.drawable.lc_circle),
        ToolButton("arrow", msg("Arrow"), R.drawable.lc_move_up_right),
        ToolButton("line", msg("Line"), R.drawable.lc_minus),
        ToolButton("note", msg("Comment"), R.drawable.lc_message_square),
        ToolButton("eraser", msg("Erase"), R.drawable.lc_eraser),
        ToolButton("whiteout", msg("White-out"), R.drawable.lc_rectangle_horizontal),
        ToolButton("redact", msg("Redact"), R.drawable.lc_eye_off),
    ),
    EditTab.Text to listOf(
        ToolButton("text", msg("Add text"), R.drawable.lc_type),
        ToolButton("edit-text", msg("Edit text"), R.drawable.lc_text_cursor_input),
        ToolButton("field", msg("Form field"), R.drawable.lc_text_cursor),
    ),
    EditTab.Sign to listOf(
        ToolButton("sign", msg("Sign"), R.drawable.lc_signature),
        ToolButton("stamp", msg("Stamp"), R.drawable.lc_stamp),
        ToolButton("image", msg("Image"), R.drawable.lc_image),
    ),
)

// the same colours as the desktop's options panel (src/renderer/styles.ts)
private val INK_COLORS = listOf("#1a1a1a", "#1d3f91", "#2b7bd6", "#1f8a5b", "#d1345b", "#e8590c", "#7c3aed", "#ffffff")
private val HIGHLIGHT_COLORS = listOf("#ffe169", "#b8f28b", "#9fe3ff", "#ffb3d1", "#ffc37a")
private val NOTE_COLORS = listOf("#ffd166", "#9be38a", "#8fd3ff", "#ffadc8", "#c9b6ff")
private val STAMP_COLORS = listOf("#1f8a5b", "#1d3f91", "#c4314b", "#b9620f", "#555555")
private val STAMPS = listOf("APPROVED", "PAID", "RECEIVED", "REVIEWED", "REJECTED", "CONFIDENTIAL", "DRAFT", "VOID")

@Composable
fun ReaderScreen(state: UiState, actions: Actions, startEditing: EditTab? = null, onBack: () -> Unit) {
    val engine = state.engine
    val doc = engine.activeDoc ?: return
    val colors = Inkleaf.colors
    var editing by remember { mutableStateOf(startEditing != null) }
    var tab by remember { mutableStateOf(startEditing ?: EditTab.Annotate) }

    // closing the sheet goes back to plain reading
    val stopEditing = {
        editing = false
        if (engine.tool != "select") actions.setTool("select")
        actions.deselect()
    }
    DisposableEffect(Unit) { onDispose { actions.hidePage() } }

    Column(Modifier.fillMaxSize()) {
        ReaderBar(doc, engine, actions, onBack)
        Box(
            Modifier
                .weight(1f)
                .fillMaxWidth()
                // the page itself is drawn underneath, by the editor engine, in exactly this space
                .onGloballyPositioned { c ->
                    val r = c.boundsInWindow()
                    actions.pageArea(r.left.roundToInt(), r.top.roundToInt(), r.right.roundToInt(), r.bottom.roundToInt())
                },
        ) {
            if (engine.selection != null && !engine.editingText) {
                SelectionBar(engine.selection, actions, Modifier.align(Alignment.TopCenter).padding(top = 12.dp))
            }
            if (engine.pages > 0) {
                Text(
                    // kept left to right, so "1 / 3" doesn't read "3 / 1" in Arabic or Hebrew
                    "\u2066${engine.page} / ${engine.pages}\u2069",
                    Modifier
                        .align(Alignment.BottomCenter)
                        .padding(bottom = 14.dp)
                        .clip(CircleShape)
                        .background(colors.frame.copy(alpha = 0.86f))
                        .clickable { editing = true; tab = EditTab.Pages }
                        .padding(horizontal = 14.dp, vertical = 6.dp),
                    style = MaterialTheme.typography.labelMedium, color = colors.onFrame,
                )
            }
            if (!editing) {
                Box(
                    Modifier
                        .align(Alignment.BottomEnd)
                        .padding(18.dp)
                        .shadow(10.dp, RoundedCornerShape(20.dp))
                        .size(60.dp)
                        .clip(RoundedCornerShape(20.dp))
                        .background(MaterialTheme.colorScheme.primary)
                        .clickable(role = Role.Button, onClickLabel = tr("Edit")) { editing = true },
                    contentAlignment = Alignment.Center,
                ) { Lc(R.drawable.lc_pencil, tr("Edit"), tint = MaterialTheme.colorScheme.onPrimary, size = 24.dp) }
            }
            if (engine.busy != null) BusyChip(engine.busy, Modifier.align(Alignment.TopCenter).padding(top = 12.dp))
        }
        AnimatedVisibility(editing, enter = expandVertically() + fadeIn(), exit = shrinkVertically() + fadeOut()) {
            EditSheet(state, tab, { tab = it }, actions, onDone = stopEditing)
        }
        if (!editing) Spacer(Modifier.windowInsetsPadding(WindowInsets.navigationBars))
    }
}

@Composable
private fun ReaderBar(doc: OpenDoc, engine: EngineState, actions: Actions, onBack: () -> Unit) {
    val colors = Inkleaf.colors
    var menu by remember { mutableStateOf(false) }
    Row(
        Modifier
            .fillMaxWidth()
            .background(colors.frame)
            .ownTouches()
            .windowInsetsPadding(WindowInsets.statusBars)
            .height(60.dp)
            .padding(horizontal = 4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        FrameIconButton(R.drawable.lc_arrow_left, tr("Back"), onClick = onBack)
        Column(Modifier.weight(1f).padding(horizontal = 4.dp)) {
            Text(doc.name.removeSuffix(".pdf"), style = MaterialTheme.typography.titleMedium, color = colors.onFrame, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(saveLabel(doc.saveState), style = MaterialTheme.typography.bodySmall, color = colors.onFrameMuted, maxLines = 1)
        }
        FrameIconButton(R.drawable.lc_undo_2, tr("Undo"), enabled = engine.canUndo, onClick = actions::undo)
        FrameIconButton(R.drawable.lc_redo_2, tr("Redo"), enabled = engine.canRedo, onClick = actions::redo)
        Box {
            FrameIconButton(R.drawable.lc_ellipsis_vertical, tr("More"), onClick = { menu = true })
            DropdownMenu(menu, { menu = false }) {
                val item = @Composable { icon: Int, label: String, run: () -> Unit ->
                    DropdownMenuItem(text = { Text(label) }, leadingIcon = { Lc(icon, null, size = 20.dp) }, onClick = { menu = false; run() })
                }
                item(R.drawable.lc_save, tr("Save")) { actions.save() }
                item(R.drawable.lc_share_2, tr("Share…")) { actions.run("share") }
                item(R.drawable.lc_download, tr("Save a copy…")) { actions.run("save-as") }
                item(R.drawable.lc_send, tr("Send to computer")) { actions.run("link-send") }
                item(R.drawable.lc_printer, tr("Print…")) { actions.run("print") }
                item(R.drawable.lc_search, tr("Find")) { actions.run("find") }
                item(R.drawable.lc_maximize_2, tr("Fit width")) { actions.run("zoom-fit-width") }
                item(R.drawable.lc_x, tr("Close")) { actions.close(doc.id, discard = false) }
            }
        }
    }
}

@Composable
private fun saveLabel(state: String): String = when (state) {
    "saved" -> tr("Saved")
    "saving" -> tr("Saving…")
    "new" -> tr("Not saved yet")
    "error" -> tr("Couldn’t auto-save")
    else -> tr("Not saved")
}

/** What you can do with the mark you've tapped. */
@Composable
private fun SelectionBar(kind: String, actions: Actions, modifier: Modifier) {
    val colors = Inkleaf.colors
    Row(
        modifier
            .shadow(8.dp, RoundedCornerShape(18.dp))
            .clip(RoundedCornerShape(18.dp))
            .background(colors.frame)
            .padding(4.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        if (kind == "text" || kind == "replace") FrameIconButton(R.drawable.lc_pencil, tr("Edit text"), onClick = actions::editText)
        FrameIconButton(R.drawable.lc_copy, tr("Duplicate"), onClick = actions::duplicate)
        FrameIconButton(R.drawable.lc_trash_2, tr("Delete"), onClick = actions::deleteSelection)
        Box(Modifier.width(1.dp).height(24.dp).background(colors.onFrame.copy(alpha = 0.2f)))
        FrameIconButton(R.drawable.lc_check, tr("Done"), onClick = actions::deselect)
    }
}

@Composable
private fun BusyChip(text: String, modifier: Modifier) {
    val colors = Inkleaf.colors
    Row(
        modifier.clip(CircleShape).background(colors.frame).padding(horizontal = 16.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        androidx.compose.material3.CircularProgressIndicator(Modifier.size(16.dp), color = colors.leaf, strokeWidth = 2.dp)
        Spacer(Modifier.width(10.dp))
        Text(text, style = MaterialTheme.typography.labelMedium, color = colors.onFrame, maxLines = 1)
    }
}

// --- the edit sheet ----------------------------------------------------------------------------

@Composable
fun EditSheet(state: UiState, tab: EditTab, onTab: (EditTab) -> Unit, actions: Actions, onDone: () -> Unit) {
    val colors = Inkleaf.colors
    val engine = state.engine
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(topStart = 24.dp, topEnd = 24.dp))
            .background(colors.frame)
            .ownTouches()
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(start = 12.dp, end = 12.dp, top = 12.dp, bottom = 10.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Row(
                Modifier.weight(1f).clip(RoundedCornerShape(14.dp)).background(colors.onFrame.copy(alpha = 0.07f)).padding(4.dp),
            ) {
                for (t in EditTab.entries) {
                    val on = t == tab
                    Text(
                        tr(t.title),
                        Modifier
                            .weight(1f)
                            .clip(RoundedCornerShape(10.dp))
                            .background(if (on) colors.onFrame else Color.Transparent)
                            .clickable(role = Role.Tab) { onTab(t) }
                            .padding(vertical = 8.dp),
                        style = MaterialTheme.typography.labelLarge,
                        color = if (on) colors.frame else colors.onFrameMuted,
                        textAlign = androidx.compose.ui.text.style.TextAlign.Center,
                        maxLines = 1,
                    )
                }
            }
            Spacer(Modifier.width(6.dp))
            FrameIconButton(R.drawable.lc_check, tr("Done"), onClick = onDone)
        }
        Spacer(Modifier.height(12.dp))
        if (tab == EditTab.Pages) {
            PagesPanel(state, actions)
        } else {
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (b in TOOLS.getValue(tab)) {
                    ToolTile(b, on = engine.tool == b.tool || (b.tool == "rect" && engine.tool == "rect")) {
                        actions.setTool(if (engine.tool == b.tool) "select" else b.tool)
                    }
                }
            }
            ToolOptions(engine, actions)
        }
    }
}

@Composable
private fun ToolTile(b: ToolButton, on: Boolean, onClick: () -> Unit) {
    val colors = Inkleaf.colors
    Column(
        Modifier.width(68.dp).clip(RoundedCornerShape(14.dp)).clickable(role = Role.RadioButton, onClick = onClick).padding(vertical = 4.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            Modifier.size(width = 54.dp, height = 46.dp).clip(RoundedCornerShape(13.dp))
                .background(if (on) colors.leaf else colors.onFrame.copy(alpha = 0.07f)),
            contentAlignment = Alignment.Center,
        ) { Lc(b.icon, null, tint = if (on) colors.frame else colors.onFrame, size = 22.dp) }
        Spacer(Modifier.height(5.dp))
        Text(tr(b.title), style = MaterialTheme.typography.labelSmall, color = if (on) colors.onFrame else colors.onFrameMuted, maxLines = 1, overflow = TextOverflow.Ellipsis)
    }
}

/** Colours, sizes and the like for the tool in hand (or the mark that's selected). */
@Composable
private fun ToolOptions(engine: EngineState, actions: Actions) {
    val colors = Inkleaf.colors
    val s = engine.styles
    val group = when (engine.selection ?: engine.tool) {
        "pen", "ink" -> "pen"
        "highlight" -> "highlight"
        "rect", "ellipse" -> "shape"
        "line", "arrow" -> "line"
        "text", "replace" -> "text"
        "note" -> "note"
        "stamp" -> "stamp"
        else -> null
    } ?: run {
        val hint = when (engine.tool) {
            "eraser" -> tr("Tap or drag across marks to remove them.")
            "whiteout" -> tr("Drag over anything to cover it.")
            "redact" -> tr("Drag over anything private. It’s removed for good when you save.")
            "edit-text" -> tr("Tap a line of text on the page to change it.")
            "field" -> tr("Drag a box on the page to add a fillable field.")
            else -> tr("Pick a tool, then draw or tap on the page. Pinch to zoom.")
        }
        Text(hint, Modifier.padding(start = 6.dp, top = 12.dp, end = 6.dp, bottom = 4.dp), style = MaterialTheme.typography.bodySmall, color = colors.onFrameMuted)
        return
    }
    Box(Modifier.padding(top = 10.dp).fillMaxWidth().height(1.dp).background(colors.onFrame.copy(alpha = 0.1f)))
    Spacer(Modifier.height(8.dp))
    val swatches = @Composable { list: List<String>, current: String, key: String ->
        Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(2.dp)) {
            for (c in list) Swatch(c, c.equals(current, ignoreCase = true), colors.leaf) { actions.setStyle(group, mapOf(key to c)) }
        }
    }
    when (group) {
        "pen" -> {
            swatches(INK_COLORS, s.pen.color, "color")
            WidthSlider(s.pen.width, 1f..12f) { actions.setStyle("pen", mapOf("width" to it)) }
        }
        "highlight" -> swatches(HIGHLIGHT_COLORS, s.highlight, "color")
        "shape" -> {
            swatches(INK_COLORS.take(7), s.shape.color, "color")
            WidthSlider(s.shape.width, 1f..10f) { actions.setStyle("shape", mapOf("width" to it)) }
        }
        "line" -> {
            swatches(INK_COLORS.take(7), s.line.color, "color")
            WidthSlider(s.line.width, 1f..10f) { actions.setStyle("line", mapOf("width" to it)) }
        }
        "note" -> swatches(NOTE_COLORS, s.note, "color")
        "text" -> {
            Row(verticalAlignment = Alignment.CenterVertically) {
                StyleToggle(R.drawable.lc_bold, tr("Bold"), s.text.bold) { actions.setStyle("text", mapOf("bold" to !s.text.bold)) }
                StyleToggle(R.drawable.lc_italic, tr("Italic"), s.text.italic) { actions.setStyle("text", mapOf("italic" to !s.text.italic)) }
                StyleToggle(R.drawable.lc_underline, tr("Underline"), s.text.underline) { actions.setStyle("text", mapOf("underline" to !s.text.underline)) }
                Spacer(Modifier.weight(1f))
                FrameIconButton(R.drawable.lc_minus, tr("Smaller")) { actions.setStyle("text", mapOf("size" to (s.text.size - 1).coerceAtLeast(6f))) }
                Text("${s.text.size.roundToInt()}", style = MaterialTheme.typography.titleSmall, color = colors.onFrame, modifier = Modifier.width(30.dp), textAlign = androidx.compose.ui.text.style.TextAlign.Center)
                FrameIconButton(R.drawable.lc_plus, tr("Bigger")) { actions.setStyle("text", mapOf("size" to (s.text.size + 1).coerceAtMost(96f))) }
            }
            swatches(INK_COLORS, s.text.color, "color")
        }
        "stamp" -> {
            Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                for (label in STAMPS) {
                    val on = label == s.stamp.label
                    Text(
                        label,
                        Modifier
                            .clip(RoundedCornerShape(8.dp))
                            .border(1.5.dp, if (on) colors.leaf else colors.onFrame.copy(alpha = 0.25f), RoundedCornerShape(8.dp))
                            .clickable { actions.setStyle("stamp", mapOf("label" to label)) }
                            .padding(horizontal = 10.dp, vertical = 6.dp),
                        style = MaterialTheme.typography.labelMedium.copy(fontWeight = FontWeight.Bold),
                        color = if (on) colors.leaf else colors.onFrame,
                    )
                }
            }
            Spacer(Modifier.height(6.dp))
            swatches(STAMP_COLORS, s.stamp.color, "color")
        }
    }
}

@Composable
private fun WidthSlider(value: Float, range: ClosedFloatingPointRange<Float>, onDone: (Float) -> Unit) {
    val colors = Inkleaf.colors
    var v by remember(value) { mutableFloatStateOf(value) }
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(horizontal = 6.dp)) {
        Text(tr("Thickness"), style = MaterialTheme.typography.labelMedium, color = colors.onFrameMuted)
        Spacer(Modifier.width(12.dp))
        Slider(
            v, { v = it }, Modifier.weight(1f), valueRange = range, onValueChangeFinished = { onDone((v * 2).roundToInt() / 2f) },
            colors = SliderDefaults.colors(thumbColor = colors.leaf, activeTrackColor = colors.leaf, inactiveTrackColor = colors.onFrame.copy(alpha = 0.2f)),
        )
        Box(Modifier.width(34.dp), contentAlignment = Alignment.Center) {
            Box(Modifier.size(width = 22.dp, height = (v.coerceIn(1f, 12f)).dp).clip(CircleShape).background(colors.onFrame))
        }
    }
}

@Composable
private fun StyleToggle(@DrawableRes icon: Int, label: String, on: Boolean, onClick: () -> Unit) {
    val colors = Inkleaf.colors
    Box(
        Modifier.size(44.dp).clip(RoundedCornerShape(12.dp)).background(if (on) colors.leaf else Color.Transparent)
            .clickable(role = Role.Checkbox, onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) { Lc(icon, label, tint = if (on) colors.frame else colors.onFrame, size = 20.dp) }
}

// --- pages ---------------------------------------------------------------------------------------

@Composable
private fun PagesPanel(state: UiState, actions: Actions) {
    val colors = Inkleaf.colors
    val engine = state.engine
    LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp), contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = 4.dp)) {
        itemsIndexed(List(engine.pages) { it }) { _, index ->
            LaunchedEffect(index, engine.canUndo, engine.pages) { actions.requestPageImage(index) }
            val current = index + 1 == engine.page
            Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.clickable { actions.goToPage(index + 1) }) {
                Box(
                    Modifier.width(64.dp).then(
                        if (current) Modifier.border(2.5.dp, colors.leaf, RoundedCornerShape(9.dp)).padding(3.dp) else Modifier.padding(3.dp),
                    ),
                ) { PagePicture(state.pageImages[index], Modifier.fillMaxWidth(), corner = 5.dp) }
                Spacer(Modifier.height(4.dp))
                Text("${index + 1}", style = MaterialTheme.typography.labelSmall, color = if (current) colors.onFrame else colors.onFrameMuted)
            }
        }
    }
    Spacer(Modifier.height(10.dp))
    Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        for ((icon, label, command) in listOf(
            Triple(R.drawable.lc_rotate_ccw, msg("Turn left"), "rotate-left"),
            Triple(R.drawable.lc_rotate_cw, msg("Turn right"), "rotate-right"),
            Triple(R.drawable.lc_file_plus, msg("Add page"), "insert-blank"),
            Triple(R.drawable.lc_files, msg("Merge"), "insert-pdf"),
            Triple(R.drawable.lc_file_output, msg("Extract"), "extract"),
            Triple(R.drawable.lc_crop, msg("Crop"), "crop"),
            Triple(R.drawable.lc_trash_2, msg("Delete"), "delete-pages"),
        )) {
            ToolTile(ToolButton(command, label, icon), on = false) { actions.run(command) }
        }
    }
}
