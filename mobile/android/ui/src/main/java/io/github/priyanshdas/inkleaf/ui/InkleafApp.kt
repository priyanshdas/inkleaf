// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.activity.compose.BackHandler
import androidx.annotation.DrawableRes
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.emptyFlow

enum class Tab(val title: String, @DrawableRes val icon: Int) {
    Files(msg("Files"), R.drawable.lc_files),
    Tools(msg("Tools"), R.drawable.lc_wrench),
    Devices(msg("Computer"), R.drawable.lc_monitor_smartphone),
}

private enum class Screen { Main, Settings, Reader }

/** A message to show briefly (what the desktop shows as a toast). */
data class Notice(val text: String, val error: Boolean = false)

/**
 * The whole phone app. [state] comes from the engine and storage; [actions] does the work.
 * The page itself is drawn by the engine underneath, wherever [Actions.pageArea] says.
 */
@Composable
fun InkleafApp(
    state: UiState,
    actions: Actions,
    catalog: Catalog,
    dark: Boolean,
    notices: Flow<Notice> = emptyFlow(),
    /** the back button: true when the engine had a dialog of its own open and closed it */
    onBackToEngine: () -> Unit = {},
) {
    CompositionLocalProvider(
        LocalCatalog provides catalog,
        LocalLayoutDirection provides if (catalog.locale in RTL_LOCALES) LayoutDirection.Rtl else LayoutDirection.Ltr,
    ) {
        InkleafTheme(dark) {
            val snackbar = remember { SnackbarHostState() }
            LaunchedEffect(notices) { notices.collect { snackbar.showSnackbar(it.text) } }
            Box(Modifier.fillMaxSize()) {
                if (state.needsAgreement) WelcomeScreen(actions) else Main(state, actions)
                SnackbarHost(snackbar, Modifier.align(Alignment.BottomCenter).windowInsetsPadding(WindowInsets.navigationBars).padding(bottom = 72.dp))
            }
            // the editor's own dialogs sit on top; back closes them first
            BackHandler(state.engine.overlay) { onBackToEngine() }
        }
    }
}

@Composable
private fun Main(state: UiState, actions: Actions) {
    var tab by rememberSaveable { mutableStateOf(Tab.Files) }
    var screen by rememberSaveable { mutableStateOf(Screen.Main) }
    var lastActive by remember { mutableStateOf<String?>(null) }

    // whenever a document is opened (from here, another app, or the computer), show it
    val active = state.engine.active
    LaunchedEffect(active) {
        if (active != null && active != lastActive) screen = Screen.Reader
        if (active == null && screen == Screen.Reader) screen = Screen.Main
        lastActive = active
    }
    BackHandler(screen != Screen.Main) { screen = Screen.Main }
    BackHandler(screen == Screen.Main && tab != Tab.Files) { tab = Tab.Files }

    val background = MaterialTheme.colorScheme.background
    AnimatedContent(screen, transitionSpec = { fadeIn() togetherWith fadeOut() }, label = "screen") { shown ->
        when (shown) {
            // the reader leaves its middle clear for the page drawn underneath
            Screen.Reader -> ReaderScreen(state, actions, onBack = { screen = Screen.Main })
            Screen.Settings -> Box(Modifier.fillMaxSize().background(background).ownTouches()) {
                SettingsScreen(state, actions, onBack = { screen = Screen.Main })
            }
            Screen.Main -> Column(Modifier.fillMaxSize().background(background).ownTouches()) {
                Box(Modifier.weight(1f)) {
                    when (tab) {
                        Tab.Files -> HomeScreen(
                            state, actions,
                            onSettings = { screen = Screen.Settings },
                            onOpenDoc = { doc ->
                                if (doc.id == state.engine.active) screen = Screen.Reader else actions.activate(doc.id)
                            },
                        )
                        Tab.Tools -> ToolsScreen(state, onTool = { tool ->
                            // tools that work on a document need one; the engine asks for a file first if there isn't
                            actions.runTool(tool.command, needsDoc = !tool.standalone)
                        })
                        Tab.Devices -> DevicesScreen(state, actions)
                    }
                }
                BottomBar(tab) { tab = it }
            }
        }
    }
}

@Composable
private fun BottomBar(current: Tab, onSelect: (Tab) -> Unit) {
    val colors = Inkleaf.colors
    Column(Modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer)) {
        Box(Modifier.fillMaxWidth().height(1.dp).background(MaterialTheme.colorScheme.outlineVariant))
        Row(Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).height(68.dp), verticalAlignment = Alignment.CenterVertically) {
            for (t in Tab.entries) {
                val on = t == current
                Column(
                    Modifier.weight(1f).clip(RoundedCornerShape(16.dp)).clickable(role = Role.Tab) { onSelect(t) }.padding(vertical = 6.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Box(
                        Modifier.size(width = 58.dp, height = 30.dp).clip(CircleShape)
                            .background(if (on) MaterialTheme.colorScheme.primaryContainer else Color.Transparent),
                        contentAlignment = Alignment.Center,
                    ) {
                        Lc(t.icon, null, tint = if (on) MaterialTheme.colorScheme.onPrimaryContainer else colors.muted, size = 21.dp)
                    }
                    Spacer(Modifier.height(3.dp))
                    Text(tr(t.title), style = MaterialTheme.typography.labelMedium, color = if (on) MaterialTheme.colorScheme.onSurface else colors.muted)
                }
            }
        }
    }
}
