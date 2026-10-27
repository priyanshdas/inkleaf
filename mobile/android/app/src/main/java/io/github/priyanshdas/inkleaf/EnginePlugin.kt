// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf

import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * How the editor engine talks back to the native screens (src/renderer/engine.ts calls these).
 * It reports its state whenever something on screen should change, sends events such as
 * messages to show, and answers each command the app sent it.
 */
@CapacitorPlugin(name = "InkleafEngine")
class EnginePlugin : Plugin() {

    @PluginMethod
    fun state(call: PluginCall) {
        call.getObject("state")?.let { Engine.onState(it) }
        call.resolve()
    }

    @PluginMethod
    fun event(call: PluginCall) {
        Engine.onEvent(call.getString("type") ?: "", call.getString("text"), call.getString("kind"))
        call.resolve()
    }

    @PluginMethod
    fun reply(call: PluginCall) {
        val id = call.getInt("id") ?: return call.resolve()
        val ok = call.getBoolean("ok", false) == true
        Engine.onReply(id, ok, call.data.opt("result"), call.getString("error"))
        call.resolve()
    }
}
