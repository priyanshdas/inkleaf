// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.annotation.DrawableRes
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/** One of the Lucide icons (res/drawable/lc_*.xml), tinted like text. */
/**
 * Keeps touches from reaching the editor engine's page, which sits underneath the native
 * screens. Everything opaque uses this; only the reader's page area leaves touches alone.
 * It takes what its children left, so their buttons and lists still work as usual.
 */
fun Modifier.ownTouches(): Modifier = pointerInput(Unit) {
    awaitPointerEventScope {
        while (true) awaitPointerEvent().changes.forEach { it.consume() }
    }
}

@Composable
fun Lc(@DrawableRes icon: Int, contentDescription: String?, modifier: Modifier = Modifier, tint: Color = Color.Unspecified, size: Dp = 22.dp) {
    if (tint == Color.Unspecified) Icon(painterResource(icon), contentDescription, modifier.size(size))
    else Icon(painterResource(icon), contentDescription, modifier.size(size), tint = tint)
}

fun parseColor(hex: String): Color = runCatching {
    val clean = hex.removePrefix("#")
    val value = clean.toLong(16)
    if (clean.length == 6) Color(0xFF000000 or value) else Color(value)
}.getOrDefault(Color.Black)

/** A page picture with a soft paper shadow, or a plain sheet with lines while there isn't one yet. */
@Composable
fun PagePicture(image: ImageBitmap?, modifier: Modifier = Modifier, corner: Dp = 8.dp) {
    val shape = RoundedCornerShape(corner)
    Box(
        modifier
            .aspectRatio(0.72f)
            .shadow(4.dp, shape, ambientColor = Color(0x2214201B), spotColor = Color(0x2214201B))
            .clip(shape)
            .background(Color.White)
            .border(1.dp, Color(0x1214201B), shape),
    ) {
        if (image != null) {
            Image(image, null, Modifier.matchParentSize(), contentScale = ContentScale.Crop, alignment = Alignment.TopCenter)
        } else {
            Column(Modifier.padding(horizontal = 14.dp, vertical = 16.dp), verticalArrangement = Arrangement.spacedBy(7.dp)) {
                Box(Modifier.fillMaxWidth(0.5f).height(5.dp).clip(CircleShape).background(Color(0xFFC9D0CC)))
                repeat(5) { i ->
                    Box(Modifier.fillMaxWidth(if (i == 4) 0.6f else 1f).height(3.dp).clip(CircleShape).background(Color(0xFFE1E5E2)))
                }
            }
        }
    }
}

/** "RECENT", "ORGANIZE": the small caps label above a group. */
@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier, trailing: (@Composable () -> Unit)? = null) {
    Row(modifier.fillMaxWidth().padding(horizontal = 20.dp, vertical = 10.dp), verticalAlignment = Alignment.CenterVertically) {
        Text(text.uppercase(), style = MaterialTheme.typography.labelSmall, color = Inkleaf.colors.muted, modifier = Modifier.weight(1f))
        trailing?.invoke()
    }
}

/** A round icon button that sits on the green frame. */
@Composable
fun FrameIconButton(@DrawableRes icon: Int, label: String, enabled: Boolean = true, onClick: () -> Unit) {
    val colors = Inkleaf.colors
    Box(
        Modifier
            .size(44.dp)
            .clip(CircleShape)
            .clickable(enabled = enabled, role = Role.Button, onClickLabel = label, onClick = onClick),
        contentAlignment = Alignment.Center,
    ) {
        Lc(icon, label, tint = if (enabled) colors.onFrame else colors.onFrame.copy(alpha = 0.35f))
    }
}

/** A row in a list: icon in a soft tile, title, optional detail, optional trailing part. */
@Composable
fun ListRow(
    @DrawableRes icon: Int,
    title: String,
    detail: String? = null,
    modifier: Modifier = Modifier,
    tileColor: Color = MaterialTheme.colorScheme.secondaryContainer,
    iconColor: Color = MaterialTheme.colorScheme.onSecondaryContainer,
    trailing: (@Composable () -> Unit)? = null,
    onClick: (() -> Unit)? = null,
) {
    Row(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(role = Role.Button, onClick = onClick) else Modifier)
            .padding(horizontal = 20.dp, vertical = 12.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(Modifier.size(42.dp).clip(RoundedCornerShape(12.dp)).background(tileColor), contentAlignment = Alignment.Center) {
            Lc(icon, null, tint = iconColor, size = 21.dp)
        }
        Spacer(Modifier.size(14.dp))
        Column(Modifier.weight(1f)) {
            Text(title, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
            if (detail != null) {
                Text(detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
        }
        trailing?.invoke()
    }
}

/** A colour swatch; ringed when chosen. */
@Composable
fun Swatch(color: String, selected: Boolean, ring: Color, onClick: () -> Unit) {
    Box(
        Modifier
            .size(36.dp)
            .clip(CircleShape)
            .clickable(role = Role.RadioButton, onClick = onClick)
            .then(if (selected) Modifier.border(2.5.dp, ring, CircleShape) else Modifier)
            .padding(5.dp)
            .clip(CircleShape)
            .background(parseColor(color))
            .border(1.dp, Color(0x33000000), CircleShape),
    )
}
