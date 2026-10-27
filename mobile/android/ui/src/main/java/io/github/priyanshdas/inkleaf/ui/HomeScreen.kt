// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.grid.GridCells
import androidx.compose.foundation.lazy.grid.GridItemSpan
import androidx.compose.foundation.lazy.grid.LazyVerticalGrid
import androidx.compose.foundation.lazy.grid.items
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import java.text.DateFormat
import java.util.Date

@Composable
fun HomeScreen(state: UiState, actions: Actions, onSettings: () -> Unit, onOpenDoc: (OpenDoc) -> Unit, modifier: Modifier = Modifier) {
    var query by remember { mutableStateOf("") }
    var creating by remember { mutableStateOf(false) }
    val q = query.trim().lowercase()
    val recents = state.recents.filter { q.isEmpty() || it.name.lowercase().contains(q) }
    // documents open in the editor right now that aren't in the recent list yet (new, not saved)
    val openUnsaved = state.engine.docs.filter { d -> d.path == null || state.recents.none { it.path == d.path } }

    Box(modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            FrameHeader(
                title = "Inkleaf",
                leading = { LeafMark(26.dp) },
                actions = { FrameIconButton(R.drawable.lc_settings, tr("Settings"), onClick = onSettings) },
            ) {
                SearchField(query, { query = it }, tr("Search your PDFs"))
            }
            LazyVerticalGrid(
                GridCells.Adaptive(150.dp),
                Modifier.fillMaxSize(),
                contentPadding = PaddingValues(start = 18.dp, end = 18.dp, bottom = 110.dp),
                horizontalArrangement = Arrangement.spacedBy(16.dp),
                verticalArrangement = Arrangement.spacedBy(18.dp),
            ) {
                if (openUnsaved.isNotEmpty() && q.isEmpty()) {
                    item(span = { GridItemSpan(maxLineSpan) }) { SectionLabel(tr("Open now"), Modifier.padding(top = 10.dp)) }
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        LazyRow(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                            items(openUnsaved, key = { it.id }) { doc -> OpenChip(doc) { onOpenDoc(doc) } }
                        }
                    }
                }
                item(span = { GridItemSpan(maxLineSpan) }) { SectionLabel(tr("Recent files"), Modifier.padding(top = 10.dp)) }
                if (recents.isEmpty()) {
                    item(span = { GridItemSpan(maxLineSpan) }) {
                        EmptyRecent(searching = q.isNotEmpty())
                    }
                }
                items(recents, key = { it.path }) { file ->
                    val open = state.engine.docs.firstOrNull { it.path == file.path }
                    RecentCard(
                        file = file,
                        image = state.thumbs[file.path],
                        open = open != null,
                        onOpen = { if (open != null) onOpenDoc(open) else actions.openRecent(file.path) },
                        onForget = { actions.forgetRecent(file.path) },
                    )
                }
            }
        }
        NewButton(Modifier.align(Alignment.BottomEnd).padding(18.dp)) { creating = true }
        if (creating) NewSheet(onDismiss = { creating = false }) { choice ->
            creating = false
            when (choice) {
                "open" -> actions.openFile()
                "new" -> actions.newBlank()
                else -> actions.run(choice)
            }
        }
    }
}

@Composable
private fun NewButton(modifier: Modifier, onClick: () -> Unit) {
    val shape = RoundedCornerShape(28.dp)
    Row(
        modifier
            .shadow(10.dp, shape, ambientColor = Color(0x552B7356), spotColor = Color(0x552B7356))
            .clip(shape)
            .background(MaterialTheme.colorScheme.primary)
            .clickable(role = Role.Button, onClick = onClick)
            .height(56.dp)
            .padding(horizontal = 22.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Lc(R.drawable.lc_plus, null, tint = MaterialTheme.colorScheme.onPrimary, size = 22.dp)
        Spacer(Modifier.width(8.dp))
        Text(tr("New"), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onPrimary)
    }
}

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun RecentCard(file: RecentFile, image: androidx.compose.ui.graphics.ImageBitmap?, open: Boolean, onOpen: () -> Unit, onForget: () -> Unit) {
    var menu by remember { mutableStateOf(false) }
    Column(
        Modifier
            .clip(RoundedCornerShape(12.dp))
            .combinedClickable(onClick = onOpen, onLongClick = { menu = true })
            .padding(4.dp),
    ) {
        Box {
            PagePicture(image, Modifier.fillMaxWidth())
            if (open) {
                Text(
                    tr("Open"),
                    Modifier.align(Alignment.TopEnd).padding(8.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary).padding(horizontal = 8.dp, vertical = 2.dp),
                    style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimary,
                )
            }
            DropdownMenu(menu, { menu = false }) {
                DropdownMenuItem(text = { Text(tr("Remove from recent files")) }, onClick = { menu = false; onForget() })
            }
        }
        Spacer(Modifier.height(9.dp))
        Text(file.name.removeSuffix(".pdf"), style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        Text(whenOpened(file.openedAt), style = MaterialTheme.typography.bodySmall, color = Inkleaf.colors.muted, maxLines = 1)
    }
}

@Composable
private fun whenOpened(at: Long): String {
    val minutes = (System.currentTimeMillis() - at) / 60_000
    return when {
        minutes < 1 -> tr("Just now")
        minutes < 60 -> tr("{n} min ago", "n" to minutes)
        minutes < 60 * 24 -> tr("{n} h ago", "n" to minutes / 60)
        // in the app's language, which can differ from the phone's
        else -> DateFormat.getDateInstance(DateFormat.MEDIUM, java.util.Locale.forLanguageTag(LocalCatalog.current.locale)).format(Date(at))
    }
}

@Composable
private fun OpenChip(doc: OpenDoc, onClick: () -> Unit) {
    val shape = RoundedCornerShape(14.dp)
    Row(
        Modifier
            .clip(shape)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, shape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = 14.dp, vertical = 10.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Lc(R.drawable.lc_file_text, null, tint = MaterialTheme.colorScheme.primary, size = 18.dp)
        Spacer(Modifier.width(8.dp))
        Text(doc.name.removeSuffix(".pdf"), style = MaterialTheme.typography.labelLarge, maxLines = 1)
        if (doc.dirty) {
            Spacer(Modifier.width(8.dp))
            Box(Modifier.size(7.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary))
        }
    }
}

@Composable
private fun EmptyRecent(searching: Boolean) {
    val shape = RoundedCornerShape(18.dp)
    Column(
        Modifier
            .fillMaxWidth()
            .padding(top = 4.dp)
            .clip(shape)
            .border(1.5.dp, MaterialTheme.colorScheme.outline.copy(alpha = 0.6f), shape)
            .padding(horizontal = 24.dp, vertical = 30.dp),
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Lc(if (searching) R.drawable.lc_search else R.drawable.lc_files, null, tint = Inkleaf.colors.muted, size = 30.dp)
        Spacer(Modifier.height(12.dp))
        Text(
            if (searching) tr("No PDFs match that.") else tr("Files you open will show up here, along with PDFs you share to Inkleaf from other apps or send from your computer."),
            style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NewSheet(onDismiss: () -> Unit, onChoose: (String) -> Unit) {
    ModalBottomSheet(onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surface) {
        Column(Modifier.padding(bottom = 24.dp)) {
            ListRow(R.drawable.lc_folder_open, tr("Open file"), tr("From your phone or cloud storage")) { onChoose("open") }
            ListRow(R.drawable.lc_scan_line, tr("Scan to PDF"), tr("Use your camera or phone photos.")) { onChoose("scan-to-pdf") }
            ListRow(R.drawable.lc_file_plus, tr("New blank PDF"), tr("Start from an empty page")) { onChoose("new") }
            ListRow(R.drawable.lc_file_input, tr("Convert to PDF"), tr("Word, Excel, PowerPoint, pictures…")) { onChoose("convert-to-pdf") }
            ListRow(R.drawable.lc_images, tr("JPG to PDF"), tr("Pictures, one per page.")) { onChoose("images-to-pdf") }
        }
    }
}
