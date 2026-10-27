// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.unit.dp

/** The green header at the top of the main screens: title, optional actions, then whatever goes under it. */
@Composable
fun FrameHeader(
    title: String,
    modifier: Modifier = Modifier,
    leading: (@Composable () -> Unit)? = null,
    actions: @Composable () -> Unit = {},
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val colors = Inkleaf.colors
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(bottomStart = 24.dp, bottomEnd = 24.dp))
            .background(colors.frame)
            .windowInsetsPadding(WindowInsets.statusBars)
            .padding(start = 20.dp, end = 8.dp, top = 6.dp, bottom = 18.dp),
    ) {
        Row(Modifier.fillMaxWidth().height(52.dp), verticalAlignment = Alignment.CenterVertically) {
            if (leading != null) {
                leading()
                Spacer(Modifier.size(10.dp))
            }
            Text(title, style = MaterialTheme.typography.titleLarge, color = colors.onFrame, modifier = Modifier.weight(1f))
            actions()
        }
        Column(Modifier.padding(end = 12.dp), content = content)
    }
}

/** The search box that sits on the green header. */
@Composable
fun SearchField(value: String, onChange: (String) -> Unit, placeholder: String) {
    val colors = Inkleaf.colors
    val shape = RoundedCornerShape(14.dp)
    Row(
        Modifier
            .fillMaxWidth()
            .height(48.dp)
            .clip(shape)
            .background(colors.onFrame.copy(alpha = 0.09f))
            .border(1.dp, colors.onFrame.copy(alpha = 0.12f), shape)
            .padding(horizontal = 14.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Lc(R.drawable.lc_search, null, tint = colors.onFrameMuted, size = 18.dp)
        Spacer(Modifier.size(10.dp))
        Box(Modifier.weight(1f)) {
            if (value.isEmpty()) Text(placeholder, style = MaterialTheme.typography.bodyMedium, color = colors.onFrameMuted)
            BasicTextField(
                value, onChange, singleLine = true,
                textStyle = MaterialTheme.typography.bodyMedium.copy(color = colors.onFrame),
                cursorBrush = SolidColor(colors.leaf),
                modifier = Modifier.fillMaxWidth(),
            )
        }
    }
}

/** The leaf mark, drawn from the same shape as the app icon. */
@Composable
fun LeafMark(size: androidx.compose.ui.unit.Dp = 26.dp) {
    androidx.compose.foundation.Image(
        androidx.compose.ui.res.painterResource(R.drawable.leaf_mark), null, Modifier.size(size),
    )
}
