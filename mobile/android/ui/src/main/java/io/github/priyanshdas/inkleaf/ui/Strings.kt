// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.compose.runtime.Composable
import androidx.compose.runtime.staticCompositionLocalOf

// The native screens use the same translations as the rest of Inkleaf. Every
// sentence is written in English in the code, as tr("Open file"), and looked
// up in the language's catalog (src/renderer/i18n/<code>.json) by a short
// fingerprint of the English text, exactly as src/shared/i18n.ts does.
// scripts/i18n.mjs finds tr("…") calls in these Kotlin files too, so new
// sentences are listed for translators along with the desktop ones.

/** A language's translations: fingerprint of the English sentence -> translation. */
class Catalog(val locale: String, private val strings: Map<String, String>) {
    fun translate(english: String): String = strings[fingerprint(english)] ?: english

    companion object {
        val English = Catalog("en", emptyMap())

        /** FNV-1a over UTF-16 code units, base 36, padded to 7 — the same key the TypeScript side uses. */
        fun fingerprint(text: String): String {
            var hash = 0x811c9dc5.toInt()
            for (ch in text) hash = (hash xor ch.code) * 0x01000193
            return java.lang.Long.toString(hash.toLong() and 0xffffffffL, 36).padStart(7, '0')
        }
    }
}

val LocalCatalog = staticCompositionLocalOf { Catalog.English }

/** Translates an English sentence, filling in {placeholders}. */
@Composable
fun tr(english: String, vararg values: Pair<String, Any>): String =
    fill(LocalCatalog.current.translate(english), values)

/** The same, for use outside composition (for example in a callback). */
fun Catalog.tr(english: String, vararg values: Pair<String, Any>): String = fill(translate(english), values)

private fun fill(text: String, values: Array<out Pair<String, Any>>): String {
    if (values.isEmpty()) return text
    var out = text
    for ((name, value) in values) out = out.replace("{$name}", value.toString())
    return out
}

/** Marks an English label kept in a list or enum for translation; tr() translates it when shown. */
fun msg(english: String): String = english

/** Right-to-left languages, to mirror the layout. */
val RTL_LOCALES = setOf("ar", "he", "fa", "ur")
