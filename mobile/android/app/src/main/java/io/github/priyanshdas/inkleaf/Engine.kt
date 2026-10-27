// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf

import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.webkit.WebView
import androidx.compose.ui.graphics.ImageBitmap
import androidx.compose.ui.graphics.asImageBitmap
import io.github.priyanshdas.inkleaf.ui.Actions
import io.github.priyanshdas.inkleaf.ui.Catalog
import io.github.priyanshdas.inkleaf.ui.EngineState
import io.github.priyanshdas.inkleaf.ui.LinkedComputer
import io.github.priyanshdas.inkleaf.ui.Notice
import io.github.priyanshdas.inkleaf.ui.OpenDoc
import io.github.priyanshdas.inkleaf.ui.PenStyle
import io.github.priyanshdas.inkleaf.ui.RecentFile
import io.github.priyanshdas.inkleaf.ui.ShapeStyle
import io.github.priyanshdas.inkleaf.ui.StampChoice
import io.github.priyanshdas.inkleaf.ui.TextStyleChoice
import io.github.priyanshdas.inkleaf.ui.ThemeChoice
import io.github.priyanshdas.inkleaf.ui.ToolStyles
import io.github.priyanshdas.inkleaf.ui.UiState
import java.util.Locale
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONArray
import org.json.JSONObject

/**
 * The native app's side of the editor engine (src/renderer/engine.ts is the other side).
 *
 * The screens only show [state] and report taps through [Actions]; this turns those taps into
 * engine commands, and the engine's reports back into state. Everything runs on the main thread.
 */
object Engine : Actions {
    val state = MutableStateFlow(UiState())
    val catalog = MutableStateFlow(Catalog.English)
    val notices = MutableSharedFlow<Notice>(extraBufferCapacity = 8)

    // a refresh that fails (the engine restarting, say) is retried later; it must never crash the app
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate + CoroutineExceptionHandler { _, e ->
        android.util.Log.w("Inkleaf", "engine call failed", e)
    })
    private val main = Handler(Looper.getMainLooper())
    private var webView: WebView? = null
    private var density = 1f
    private var nextId = 1
    private val waiting = HashMap<Int, CompletableDeferred<Any?>>()

    fun attach(view: WebView, screenDensity: Float) {
        webView = view
        density = screenDensity
    }

    // --- talking to the engine -----------------------------------------------------------------

    /** Sends one command and waits for its answer. Throws with the engine's message if it failed. */
    suspend fun call(cmd: String, args: Map<String, Any?> = emptyMap()): Any? {
        val view = webView ?: throw IllegalStateException("The editor isn't running")
        val id = nextId++
        val answer = CompletableDeferred<Any?>()
        waiting[id] = answer
        val message = JSONObject().put("id", id).put("cmd", cmd).put("args", JSONObject(args))
        withContext(Dispatchers.Main) {
            view.evaluateJavascript("window.inkleafEngine ? (window.inkleafEngine.call($message), 1) : 0") { started ->
                // still loading: say so rather than wait forever
                if (started != "1") waiting.remove(id)?.completeExceptionally(EngineError(""))
            }
        }
        return answer.await()
    }

    /** Fire and forget: shows the engine's message if the command fails. */
    private fun send(cmd: String, args: Map<String, Any?> = emptyMap()) {
        scope.launch {
            try {
                call(cmd, args)
            } catch (e: Exception) {
                e.message?.takeIf { it.isNotBlank() }?.let { notices.tryEmit(Notice(it, error = true)) }
            }
        }
    }

    fun onReply(id: Int, ok: Boolean, result: Any?, error: String?) {
        main.post {
            val answer = waiting.remove(id) ?: return@post
            if (ok) answer.complete(if (result == JSONObject.NULL) null else result)
            else answer.completeExceptionally(EngineError(error ?: ""))
        }
    }

    fun onEvent(type: String, text: String?, kind: String?) {
        main.post {
            when (type) {
                // the engine has (re)started, for example after the language changed
                "ready" -> scope.launch { refreshAll() }
                "toast" -> if (!text.isNullOrBlank()) notices.tryEmit(Notice(text, error = kind == "error"))
            }
        }
    }

    fun onState(json: JSONObject) {
        main.post {
            val before = state.value.engine
            val next = parseState(json)
            state.update { it.copy(engine = next) }
            // a document came or went: the recent list may have changed
            if (before.docs.map { it.id } != next.docs.map { it.id }) scope.launch { refreshRecents() }
            // another document is shown: its page pictures don't apply any more
            if (before.active != next.active) state.update { it.copy(pageImages = emptyMap()) }
            // a dialog of the editor's own just closed (pairing, settings…): things may have changed
            if (before.overlay && !next.overlay) scope.launch { refreshLink(); refreshSettings() }
        }
    }

    class EngineError(message: String) : Exception(message)

    // --- refreshing what the screens show -------------------------------------------------------

    suspend fun refreshAll() {
        runCatching { refreshCatalog() }
        runCatching { refreshSettings() }
        runCatching { refreshRecents() }
        runCatching { refreshLink() }
        runCatching { (call("state") as? JSONObject)?.let { onState(it) } }
    }

    private suspend fun refreshCatalog() {
        val json = call("catalog") as? JSONObject ?: return
        val strings = json.optJSONObject("strings") ?: JSONObject()
        val map = HashMap<String, String>(strings.length())
        for (key in strings.keys()) map[key] = strings.optString(key)
        val locale = json.optString("locale", "en")
        catalog.value = Catalog(locale, map)
        val language = Locale.forLanguageTag(locale)
        state.update {
            it.copy(languageName = language.getDisplayName(language).replaceFirstChar { c -> c.titlecase(language) })
        }
    }

    private suspend fun refreshSettings() {
        val info = call("info") as? JSONObject
        val theme = call("theme") as? String
        state.update {
            it.copy(
                version = info?.optString("version") ?: it.version,
                needsAgreement = info?.optBoolean("needsAgreement") ?: it.needsAgreement,
                theme = ThemeChoice.entries.firstOrNull { t -> t.key == theme } ?: it.theme,
            )
        }
    }

    suspend fun refreshRecents() {
        val list = call("recents") as? JSONArray ?: return
        val recents = ArrayList<RecentFile>()
        val thumbs = HashMap(state.value.thumbs)
        for (i in 0 until list.length()) {
            val r = list.optJSONObject(i) ?: continue
            val path = r.optString("path")
            recents += RecentFile(path, r.optString("name"), r.optLong("openedAt"))
            if (path !in thumbs) {
                r.optString("thumb").takeIf { it.startsWith("data:") }?.let { picture(it) }?.let { thumbs[path] = it }
            }
        }
        state.update { it.copy(recents = recents, thumbs = thumbs) }
    }

    suspend fun refreshLink() {
        val status = call("linkStatus") as? JSONObject ?: return
        val device = status.optJSONArray("devices")?.optJSONObject(0)
        state.update {
            it.copy(computer = device?.let { d -> LinkedComputer(d.optString("id"), d.optString("name"), d.optBoolean("online")) })
        }
    }

    /** Keeps "Connected" on the Computer tab honest while the app is on screen. */
    fun watchLink(): kotlinx.coroutines.Job = scope.launch {
        while (true) {
            delay(20_000)
            runCatching { refreshLink() }
        }
    }

    // --- the screens' actions ------------------------------------------------------------------

    override fun agree() {
        scope.launch {
            runCatching { call("agree") }
            state.update { it.copy(needsAgreement = false) }
        }
    }

    override fun showLegal(kind: String) = send("run", mapOf("command" to kind))
    override fun openFile() = send("open")
    override fun newBlank() = send("new")
    override fun openRecent(path: String) = send("openPath", mapOf("path" to path))

    override fun forgetRecent(path: String) {
        scope.launch {
            runCatching { call("forgetRecent", mapOf("path" to path)) }
            state.update { it.copy(thumbs = it.thumbs - path) }
            refreshRecents()
        }
    }

    override fun activate(id: String) = send("activate", mapOf("id" to id))
    override fun close(id: String, discard: Boolean) = send("close", mapOf("id" to id, "discard" to discard))
    override fun run(command: String) = send("run", mapOf("command" to command))
    override fun runTool(command: String, needsDoc: Boolean) = send("hubTool", mapOf("command" to command, "needsDoc" to needsDoc))
    override fun setTool(tool: String) = send("tool", mapOf("tool" to tool))
    override fun setStyle(group: String, patch: Map<String, Any?>) = send("style", mapOf("group" to group, "patch" to JSONObject(patch)))
    override fun undo() = send("undo")
    override fun redo() = send("redo")
    override fun deleteSelection() = send("deleteSelection")
    override fun duplicate() = send("duplicate")
    override fun editText() = send("editText")
    override fun deselect() = send("deselect")
    override fun goToPage(page: Int) = send("goToPage", mapOf("page" to page))
    override fun save() = send("save")

    override fun requestPageImage(index: Int) {
        val docId = state.value.engine.active
        scope.launch {
            val url = runCatching { call("pageImage", mapOf("index" to index, "width" to 200)) }.getOrNull() as? String ?: return@launch
            val image = picture(url) ?: return@launch
            // only if the same document is still showing
            if (state.value.engine.active == docId) state.update { it.copy(pageImages = it.pageImages + (index to image)) }
        }
    }

    private var lastArea = Pair(-1, -1)

    /** The reader's free space, in window pixels, becomes the engine's page area (in CSS pixels). */
    override fun pageArea(left: Int, top: Int, right: Int, bottom: Int) {
        val view = webView ?: return
        val origin = IntArray(2)
        view.getLocationInWindow(origin)
        val fromTop = ((top - origin[1]) / density).toInt().coerceAtLeast(0)
        val fromBottom = ((origin[1] + view.height - bottom) / density).toInt().coerceAtLeast(0)
        if (lastArea == Pair(fromTop, fromBottom)) return
        lastArea = Pair(fromTop, fromBottom)
        send("area", mapOf("top" to fromTop, "bottom" to fromBottom))
    }

    override fun setTheme(theme: ThemeChoice) {
        state.update { it.copy(theme = theme) }
        send("setTheme", mapOf("theme" to theme.key))
    }

    override fun chooseLanguage() = send("run", mapOf("command" to "language"))

    override fun forgetComputer(id: String) {
        scope.launch {
            runCatching { call("linkForget", mapOf("id" to id)) }
            refreshLink()
        }
    }

    /** The back button, while one of the editor's own dialogs is open. */
    fun back() = send("back")

    // --- reading the engine's reports ------------------------------------------------------------

    private fun picture(dataUrl: String): ImageBitmap? = runCatching {
        val bytes = Base64.decode(dataUrl.substringAfter(','), Base64.DEFAULT)
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size)?.asImageBitmap()
    }.getOrNull()

    private fun parseState(j: JSONObject): EngineState {
        val docs = j.optJSONArray("docs") ?: JSONArray()
        val s = j.optJSONObject("styles") ?: JSONObject()
        val pen = s.optJSONObject("pen") ?: JSONObject()
        val shape = s.optJSONObject("shape") ?: JSONObject()
        val line = s.optJSONObject("line") ?: JSONObject()
        val text = s.optJSONObject("text") ?: JSONObject()
        val stamp = s.optJSONObject("stamp") ?: JSONObject()
        val defaults = ToolStyles()
        return EngineState(
            ready = true,
            docs = List(docs.length()) { i ->
                val d = docs.getJSONObject(i)
                OpenDoc(
                    id = d.optString("id"),
                    name = d.optString("name"),
                    path = d.optString("path").takeIf { !d.isNull("path") && it.isNotEmpty() },
                    dirty = d.optBoolean("dirty"),
                    pages = d.optInt("pages"),
                    saveState = d.optString("saveState"),
                )
            },
            active = j.optString("active").takeIf { !j.isNull("active") && it.isNotEmpty() },
            page = j.optInt("page"),
            pages = j.optInt("pages"),
            tool = j.optString("tool", "select"),
            styles = ToolStyles(
                pen = PenStyle(pen.optString("color", defaults.pen.color), pen.optDouble("width", 2.0).toFloat(), pen.optDouble("opacity", 1.0).toFloat()),
                highlight = s.optJSONObject("highlight")?.optString("color") ?: defaults.highlight,
                shape = ShapeStyle(shape.optString("color", defaults.shape.color), shape.optDouble("width", 2.0).toFloat()),
                line = ShapeStyle(line.optString("color", defaults.line.color), line.optDouble("width", 2.0).toFloat()),
                text = TextStyleChoice(
                    size = text.optDouble("size", 14.0).toFloat(),
                    color = text.optString("color", defaults.text.color),
                    bold = text.optBoolean("bold"),
                    italic = text.optBoolean("italic"),
                    underline = text.optBoolean("underline"),
                ),
                note = s.optJSONObject("note")?.optString("color") ?: defaults.note,
                stamp = StampChoice(stamp.optString("label", "APPROVED"), stamp.optString("color", defaults.stamp.color), stamp.optBoolean("date", true)),
            ),
            canUndo = j.optBoolean("canUndo"),
            canRedo = j.optBoolean("canRedo"),
            selection = j.optString("selection").takeIf { !j.isNull("selection") && it.isNotEmpty() },
            editingText = j.optBoolean("editingText"),
            overlay = j.optBoolean("overlay"),
            busy = j.optString("busy").takeIf { !j.isNull("busy") && it.isNotEmpty() },
            autosave = j.optBoolean("autosave", true),
        )
    }
}
