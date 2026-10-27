// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// Inkleaf's look, as on the desktop app and the website: a deep leaf-green frame
// around a calm, warm-paper workspace, where the page is the brightest thing.
// Green means "active". Nothing else is coloured.

/** Colours Material's scheme has no name for. */
@Immutable
data class InkleafColors(
    /** the deep green of headers, the reader's bars and the edit sheet */
    val frame: Color,
    val frameHigh: Color,
    val onFrame: Color,
    val onFrameMuted: Color,
    /** the bright leaf green used for "on" inside the frame */
    val leaf: Color,
    /** the workspace behind pages */
    val reader: Color,
    val paper: Color,
    val line: Color,
    val muted: Color,
)

private val Light = InkleafColors(
    frame = Color(0xFF123B2F),
    frameHigh = Color(0xFF1C4A3C),
    onFrame = Color(0xFFF4F1EA),
    onFrameMuted = Color(0xFF9DBBAE),
    leaf = Color(0xFF74D4A4),
    reader = Color(0xFFE5E1D7),
    paper = Color(0xFFF4F1EA),
    line = Color(0xFFE1DDD3),
    muted = Color(0xFF66736C),
)

private val Dark = InkleafColors(
    frame = Color(0xFF0D241D),
    frameHigh = Color(0xFF163429),
    onFrame = Color(0xFFDCEBE4),
    onFrameMuted = Color(0xFF8FAE9F),
    leaf = Color(0xFF74D4A4),
    reader = Color(0xFF0B1814),
    paper = Color(0xFF111C18),
    line = Color(0xFF26332E),
    muted = Color(0xFF93A39B),
)

private val LightScheme: ColorScheme = lightColorScheme(
    primary = Color(0xFF2B7356),
    onPrimary = Color.White,
    primaryContainer = Color(0xFFCFEBDD),
    onPrimaryContainer = Color(0xFF0D3324),
    secondary = Color(0xFF123B2F),
    onSecondary = Color(0xFFF4F1EA),
    secondaryContainer = Color(0xFFE3EDE7),
    onSecondaryContainer = Color(0xFF123B2F),
    background = Light.paper,
    onBackground = Color(0xFF14201B),
    surface = Light.paper,
    onSurface = Color(0xFF14201B),
    surfaceVariant = Color(0xFFEAE6DD),
    onSurfaceVariant = Color(0xFF4F5C55),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color(0xFFFAF8F3),
    surfaceContainer = Color(0xFFFFFFFF),
    surfaceContainerHigh = Color(0xFFF0EDE5),
    surfaceContainerHighest = Color(0xFFE9E5DC),
    outline = Color(0xFFC2CBC5),
    outlineVariant = Light.line,
    error = Color(0xFFC4314B),
)

private val DarkScheme: ColorScheme = darkColorScheme(
    primary = Color(0xFF74D4A4),
    onPrimary = Color(0xFF06261A),
    primaryContainer = Color(0xFF1F5A43),
    onPrimaryContainer = Color(0xFFCFEBDD),
    secondary = Color(0xFF8FAE9F),
    onSecondary = Color(0xFF0D241D),
    secondaryContainer = Color(0xFF1C3A30),
    onSecondaryContainer = Color(0xFFDCEBE4),
    background = Dark.paper,
    onBackground = Color(0xFFE3ECE7),
    surface = Dark.paper,
    onSurface = Color(0xFFE3ECE7),
    surfaceVariant = Color(0xFF1B2823),
    onSurfaceVariant = Color(0xFFA9B8B0),
    surfaceContainerLowest = Color(0xFF0B1512),
    surfaceContainerLow = Color(0xFF14211C),
    surfaceContainer = Color(0xFF17251F),
    surfaceContainerHigh = Color(0xFF1C2B25),
    surfaceContainerHighest = Color(0xFF22322B),
    outline = Color(0xFF3A4540),
    outlineVariant = Dark.line,
    error = Color(0xFFFF8A9B),
)

val InstrumentSans = FontFamily(
    Font(R.font.instrument_sans_regular, FontWeight.Normal),
    Font(R.font.instrument_sans_medium, FontWeight.Medium),
    Font(R.font.instrument_sans_semibold, FontWeight.SemiBold),
    Font(R.font.instrument_sans_bold, FontWeight.Bold),
)

private fun style(size: Int, weight: FontWeight, line: Int, tracking: Double = 0.0) = TextStyle(
    fontFamily = InstrumentSans, fontWeight = weight, fontSize = size.sp, lineHeight = line.sp, letterSpacing = tracking.sp,
)

private val InkleafType = Typography(
    displaySmall = style(34, FontWeight.Bold, 40, -0.6),
    headlineMedium = style(26, FontWeight.Bold, 32, -0.4),
    headlineSmall = style(22, FontWeight.SemiBold, 28, -0.3),
    titleLarge = style(20, FontWeight.SemiBold, 26, -0.2),
    titleMedium = style(16, FontWeight.SemiBold, 22),
    titleSmall = style(14, FontWeight.SemiBold, 20),
    bodyLarge = style(16, FontWeight.Normal, 23),
    bodyMedium = style(14, FontWeight.Normal, 20),
    bodySmall = style(12, FontWeight.Normal, 16),
    labelLarge = style(14, FontWeight.SemiBold, 20),
    labelMedium = style(12, FontWeight.SemiBold, 16, 0.1),
    labelSmall = style(11, FontWeight.SemiBold, 14, 0.6),
)

private val InkleafShapes = Shapes(
    extraSmall = RoundedCornerShape(6.dp),
    small = RoundedCornerShape(10.dp),
    medium = RoundedCornerShape(14.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(28.dp),
)

val LocalInkleafColors = staticCompositionLocalOf { Light }

/** Shortcut for the extra colours: Inkleaf.colors.frame */
object Inkleaf {
    val colors: InkleafColors
        @Composable get() = LocalInkleafColors.current
}

@Composable
fun InkleafTheme(dark: Boolean, content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalInkleafColors provides if (dark) Dark else Light) {
        val scheme = if (dark) DarkScheme else LightScheme
        MaterialTheme(colorScheme = scheme, typography = InkleafType, shapes = InkleafShapes) {
            // text is ink-on-paper by default (or paper-on-ink in the dark)
            CompositionLocalProvider(androidx.compose.material3.LocalContentColor provides scheme.onBackground, content = content)
        }
    }
}
