// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf

import android.app.ActivityManager
import android.content.Context
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlin.concurrent.thread

/**
 * The built-in AI as the editor sees it (src/mobile/bridge.ts). Which models
 * exist is decided on the editor's side (src/shared/local-models.ts); this
 * downloads, checks and runs whichever file it's given.
 *
 * Events: "progress" {file, received, total} while downloading, and
 * "chunk" {streamId, text} while an answer is being written.
 */
@CapacitorPlugin(name = "InkleafAi")
class InkleafAiPlugin : Plugin() {

    @PluginMethod
    fun status(call: PluginCall) {
        val files = call.getArray("files")?.toList<String>() ?: emptyList()
        val sizes = call.getArray("sizes")?.toList<Any>()?.map { (it as Number).toLong() } ?: emptyList()
        val ctx = context
        val remaining = JSObject()
        files.forEachIndexed { i, f -> remaining.put(f, InkleafAi.remaining(ctx, f, sizes.getOrElse(i) { 0L })) }
        val job = InkleafAi.downloading
        call.resolve(JSObject().apply {
            put("supported", InkleafAi.supported(ctx))
            put("installed", JSArray(InkleafAi.installed(ctx, files)))
            put("remaining", remaining)
            put("downloading", job?.let { JSObject().put("file", it.file).put("received", it.received).put("total", it.total) })
            put("memory", totalMemory(ctx))
            put("free", InkleafAi.freeSpace(ctx))
        })
    }

    @PluginMethod
    fun download(call: PluginCall) {
        val file = call.getString("file") ?: return call.reject("file")
        val url = call.getString("url") ?: return call.reject("url")
        val sha = call.getString("sha256") ?: return call.reject("sha256")
        val size = call.getLong("size") ?: return call.reject("size")
        val ctx = context
        thread(name = "inkleaf-ai-download") {
            try {
                InkleafAi.download(ctx, file, url, sha, size) { received, total ->
                    notifyListeners("progress", JSObject().put("file", file).put("received", received).put("total", total))
                }
                call.resolve()
            } catch (e: Throwable) {
                call.reject(reason(e), reason(e))
            }
        }
    }

    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        InkleafAi.cancelDownload()
        call.resolve()
    }

    @PluginMethod
    fun remove(call: PluginCall) {
        val file = call.getString("file") ?: return call.reject("file")
        InkleafAi.remove(context, file)
        call.resolve()
    }

    @PluginMethod
    fun generate(call: PluginCall) {
        val file = call.getString("file") ?: return call.reject("file")
        val prompt = call.getString("prompt") ?: return call.reject("prompt")
        val contextSize = call.getInt("context") ?: 4096
        val maxTokens = call.getInt("maxTokens") ?: 1024
        val streamId = call.getString("streamId")
        val ctx = context
        thread(name = "inkleaf-ai-answer") {
            val answer = StringBuilder()
            try {
                val tokens = InkleafAi.generate(ctx, file, prompt, contextSize, maxTokens) { bytes ->
                    val text = String(bytes, Charsets.UTF_8)
                    answer.append(text)
                    if (streamId != null) notifyListeners("chunk", JSObject().put("streamId", streamId).put("text", text))
                    true
                }
                call.resolve(JSObject().put("text", answer.toString()).put("tokens", tokens))
            } catch (e: Throwable) {
                call.reject(reason(e), reason(e))
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        InkleafAi.stop()
        call.resolve()
    }

    private fun reason(e: Throwable) = (e as? IllegalStateException)?.message ?: "failed"

    private fun totalMemory(ctx: Context): Long {
        val info = ActivityManager.MemoryInfo()
        (ctx.getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager).getMemoryInfo(info)
        return info.totalMem
    }
}
