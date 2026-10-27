// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp

/** One tool. The English titles are the desktop's "All tools" names, so they share translations. */
data class HubTool(
    val title: String,
    val detail: String,
    @DrawableRes val icon: Int,
    val command: String,
    /** works without a document open (it opens or makes one itself) */
    val standalone: Boolean = false,
)

data class HubGroup(val name: String, val tools: List<HubTool>)

val HUB = listOf(
    HubGroup(msg("Organize"), listOf(
        HubTool(msg("Merge PDF"), msg("Add another PDF’s pages to this one."), R.drawable.lc_file_plus, "insert-pdf"),
        HubTool(msg("Split PDF"), msg("Break it into several files."), R.drawable.lc_scissors, "split"),
        HubTool(msg("Extract pages"), msg("Save some pages as a new PDF."), R.drawable.lc_file_output, "extract"),
        HubTool(msg("Scan to PDF"), msg("Use your camera or phone photos."), R.drawable.lc_scan_line, "scan-to-pdf", standalone = true),
    )),
    HubGroup(msg("Optimize"), listOf(
        HubTool(msg("Compress PDF"), msg("Make the file smaller."), R.drawable.lc_file_archive, "compress"),
        HubTool(msg("Repair PDF"), msg("Rescue a damaged file."), R.drawable.lc_wrench, "repair", standalone = true),
        HubTool(msg("OCR PDF"), msg("Make scanned text searchable."), R.drawable.lc_scan_text, "ocr"),
    )),
    HubGroup(msg("Convert to PDF"), listOf(
        HubTool(msg("JPG to PDF"), msg("Pictures, one per page."), R.drawable.lc_file_image, "images-to-pdf", standalone = true),
        HubTool(msg("Word to PDF"), ".docx, .doc, .odt, .rtf", R.drawable.lc_file_text, "convert-to-pdf", standalone = true),
        HubTool(msg("PowerPoint to PDF"), ".pptx, .ppt, .odp", R.drawable.lc_presentation, "convert-to-pdf", standalone = true),
        HubTool(msg("Excel to PDF"), ".xlsx, .xls, .ods, .csv", R.drawable.lc_sheet, "convert-to-pdf", standalone = true),
        HubTool(msg("HTML to PDF"), msg("A web address or an .html file."), R.drawable.lc_globe, "web-to-pdf", standalone = true),
    )),
    HubGroup(msg("Convert from PDF"), listOf(
        HubTool(msg("PDF to JPG"), msg("Each page as a picture."), R.drawable.lc_file_image, "pdf-to-images"),
        HubTool(msg("PDF to Word"), msg("Editable text and pictures."), R.drawable.lc_file_text, "pdf-to-word"),
        HubTool(msg("PDF to PowerPoint"), msg("One slide per page."), R.drawable.lc_presentation, "pdf-to-pptx"),
        HubTool(msg("PDF to Excel"), msg("Tables into rows and columns."), R.drawable.lc_sheet, "pdf-to-xlsx"),
        HubTool(msg("PDF to PDF/A"), msg("For long-term archiving."), R.drawable.lc_archive, "pdf-to-pdfa"),
    )),
    HubGroup(msg("Edit"), listOf(
        HubTool(msg("Add page numbers"), msg("Numbers, headers and footers."), R.drawable.lc_list_ordered, "decor"),
        HubTool(msg("Add watermark"), msg("Text across every page."), R.drawable.lc_droplets, "decor"),
        HubTool(msg("Crop PDF"), msg("Trim the edges of pages."), R.drawable.lc_crop, "crop"),
        HubTool(msg("Edit PDF"), msg("Change the text that’s already there."), R.drawable.lc_square_pen, "edit-text"),
        HubTool(msg("PDF forms"), msg("Add fields people can fill in."), R.drawable.lc_text_cursor, "form-builder"),
    )),
    HubGroup(msg("Security"), listOf(
        HubTool(msg("Unlock PDF"), msg("Remove a password you know."), R.drawable.lc_lock_open, "unlock", standalone = true),
        HubTool(msg("Protect PDF"), msg("Add a password."), R.drawable.lc_shield_check, "protect"),
        HubTool(msg("Sign PDF"), msg("Draw, type or add your signature."), R.drawable.lc_signature, "sign"),
        HubTool(msg("Redact PDF"), msg("Black out and remove private text."), R.drawable.lc_eye_off, "redact"),
        HubTool(msg("Compare PDF"), msg("See what changed between two."), R.drawable.lc_git_compare, "compare"),
    )),
    HubGroup(msg("Intelligence"), listOf(
        HubTool(msg("AI Summarizer"), msg("The key points, in seconds."), R.drawable.lc_sparkles, "ai-summarize"),
        HubTool(msg("Translate PDF"), msg("Into 56 languages, layout kept."), R.drawable.lc_languages, "ai-translate"),
        HubTool(msg("PDF to Markdown"), msg("Text with headings and lists."), R.drawable.lc_hash, "pdf-to-md"),
    )),
)

@Composable
fun ToolsScreen(state: UiState, onTool: (HubTool) -> Unit, modifier: Modifier = Modifier) {
    var query by remember { mutableStateOf("") }
    val catalog = LocalCatalog.current
    val doc = state.engine.activeDoc
    Column(modifier.fillMaxSize()) {
        FrameHeader(title = tr("Tools")) {
            SearchField(query, { query = it }, tr("Find a tool…"))
            if (doc != null) {
                Spacer(Modifier.height(10.dp))
                Text(
                    tr("Working on {name}", "name" to doc.name),
                    style = MaterialTheme.typography.bodySmall, color = Inkleaf.colors.onFrameMuted, maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
            }
        }
        val q = query.trim().lowercase()
        val groups = HUB.map { g ->
            g to g.tools.filter { t ->
                q.isEmpty() || "${catalog.translate(t.title)} ${catalog.translate(t.detail)} ${t.title}".lowercase().contains(q)
            }
        }.filter { it.second.isNotEmpty() }
        LazyVerticalGrid(
            GridCells.Adaptive(160.dp),
            Modifier.fillMaxSize(),
            contentPadding = androidx.compose.foundation.layout.PaddingValues(start = 14.dp, end = 14.dp, bottom = 24.dp),
            horizontalArrangement = Arrangement.spacedBy(10.dp),
            verticalArrangement = Arrangement.spacedBy(10.dp),
        ) {
            if (groups.isEmpty()) {
                item(span = { GridItemSpan(maxLineSpan) }) {
                    Text(tr("No tool matches that."), Modifier.padding(24.dp), color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            for ((group, tools) in groups) {
                item(span = { GridItemSpan(maxLineSpan) }) { SectionLabel(tr(group.name), Modifier.padding(top = 8.dp)) }
                items(tools, key = { group.name + it.title }) { tool -> ToolCard(tool, needsDoc = !tool.standalone && doc == null) { onTool(tool) } }
            }
        }
    }
}

@Composable
private fun ToolCard(tool: HubTool, needsDoc: Boolean, onClick: () -> Unit) {
    val shape = RoundedCornerShape(16.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .height(124.dp)
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(14.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(Modifier.size(38.dp).clip(RoundedCornerShape(11.dp)).background(MaterialTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) {
                Lc(tool.icon, null, tint = MaterialTheme.colorScheme.primary, size = 20.dp)
            }
            Spacer(Modifier.weight(1f))
            if (needsDoc) Lc(R.drawable.lc_folder_open, tr("Opens a PDF first"), tint = Inkleaf.colors.muted, size = 16.dp)
        }
        Spacer(Modifier.height(10.dp))
        Text(tr(tool.title), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(tr(tool.detail), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}
