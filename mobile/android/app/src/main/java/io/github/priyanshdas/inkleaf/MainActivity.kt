// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf

import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import androidx.activity.OnBackPressedCallback
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.platform.ComposeView
import androidx.compose.ui.platform.ViewCompositionStrategy
import androidx.compose.runtime.collectAsState
import com.getcapacitor.BridgeActivity
import io.github.priyanshdas.inkleaf.ui.InkleafApp
import io.github.priyanshdas.inkleaf.ui.ThemeChoice
import kotlinx.coroutines.Job

/**
 * Inkleaf on Android: native screens (Kotlin + Compose, in the ui module) on top, and the
 * editor engine underneath in Capacitor's web view. The reader leaves its middle clear, so the
 * page the engine draws shows through there and gets the touches; everywhere else the native
 * screens cover it. While one of the editor's own dialogs is open (the options of an advanced
 * tool, pairing with a computer), the native screens step aside so it can be used.
 */
class MainActivity : BridgeActivity() {
    private lateinit var screens: ComposeView
    private var linkWatch: Job? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        registerPlugin(InkleafFilesPlugin::class.java)
        registerPlugin(EnginePlugin::class.java)
        registerPlugin(InkleafAiPlugin::class.java)
        super.onCreate(savedInstanceState)
        // the bars are Inkleaf's dark green, so the clock and icons above them stay light
        enableEdgeToEdge(SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT))

        Engine.attach(bridge.webView, resources.displayMetrics.density)

        // the back button when nothing on screen wants it: leave the app but keep it running,
        // so open documents are still there when you come back
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                moveTaskToBack(true)
            }
        })

        screens = ComposeView(this).apply {
            setViewCompositionStrategy(ViewCompositionStrategy.DisposeOnViewTreeLifecycleDestroyed)
            setContent {
                val state by Engine.state.collectAsState()
                val catalog by Engine.catalog.collectAsState()
                val dark = when (state.theme) {
                    ThemeChoice.Light -> false
                    ThemeChoice.Dark -> true
                    ThemeChoice.System -> isSystemInDarkTheme()
                }
                // step aside while the editor shows a dialog of its own
                LaunchedEffect(state.engine.overlay) {
                    visibility = if (state.engine.overlay) View.INVISIBLE else View.VISIBLE
                }
                InkleafApp(state, Engine, catalog, dark, Engine.notices, onBackToEngine = Engine::back)
            }
        }
        (findViewById<ViewGroup>(android.R.id.content)).addView(
            screens, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
        )

        // a PDF opened with Inkleaf, or shared to it, from another app
        InkleafFilesPlugin.handleIntent(this, intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        InkleafFilesPlugin.handleIntent(this, intent)
    }

    override fun onResume() {
        super.onResume()
        linkWatch = Engine.watchLink()
    }

    override fun onPause() {
        linkWatch?.cancel()
        super.onPause()
    }
}
