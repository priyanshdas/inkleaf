// SPDX-License-Identifier: GPL-3.0-or-later
package io.github.priyanshdas.inkleaf.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
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
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.SwitchDefaults
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp

// --- first run --------------------------------------------------------------------------------

@Composable
fun WelcomeScreen(actions: Actions) {
    val colors = Inkleaf.colors
    Column(
        Modifier
            .fillMaxSize()
            .background(colors.frame)
            .ownTouches()
            .windowInsetsPadding(WindowInsets.statusBars)
            .windowInsetsPadding(WindowInsets.navigationBars)
            .padding(horizontal = 28.dp, vertical = 24.dp),
    ) {
        Spacer(Modifier.weight(1f))
        LeafMark(72.dp)
        Spacer(Modifier.height(28.dp))
        Text(tr("Your PDFs, on your phone."), style = MaterialTheme.typography.displaySmall, color = colors.onFrame)
        Spacer(Modifier.height(14.dp))
        Text(
            tr("Edit, sign, fill and organise PDFs. Everything stays on this phone."),
            style = MaterialTheme.typography.bodyLarge, color = colors.onFrameMuted,
        )
        Spacer(Modifier.height(22.dp))
        for ((icon, line) in listOf(
            R.drawable.lc_shield_check to tr("No account, no ads, no tracking."),
            R.drawable.lc_monitor_smartphone to tr("Send PDFs back and forth over your Wi-Fi"),
            R.drawable.lc_heart to tr("Free and open source"),
        )) {
            Row(Modifier.padding(vertical = 6.dp), verticalAlignment = Alignment.CenterVertically) {
                Lc(icon, null, tint = colors.leaf, size = 20.dp)
                Spacer(Modifier.width(12.dp))
                Text(line, style = MaterialTheme.typography.bodyMedium, color = colors.onFrame)
            }
        }
        Spacer(Modifier.weight(1.4f))
        Button(
            onClick = actions::agree,
            modifier = Modifier.fillMaxWidth().height(54.dp),
            colors = ButtonDefaults.buttonColors(containerColor = colors.leaf, contentColor = colors.frame),
            shape = RoundedCornerShape(16.dp),
        ) { Text(tr("Agree and continue"), style = MaterialTheme.typography.titleSmall) }
        Spacer(Modifier.height(14.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center) {
            Text(
                tr("Terms of use"), style = MaterialTheme.typography.labelLarge, color = colors.onFrame,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { actions.showLegal("terms") }.padding(10.dp),
            )
            Text(
                tr("Privacy policy"), style = MaterialTheme.typography.labelLarge, color = colors.onFrame,
                modifier = Modifier.clip(RoundedCornerShape(8.dp)).clickable { actions.showLegal("privacy") }.padding(10.dp),
            )
        }
    }
}

// --- phone ↔ computer -------------------------------------------------------------------------

@Composable
fun DevicesScreen(state: UiState, actions: Actions, modifier: Modifier = Modifier) {
    val computer = state.computer
    val doc = state.engine.activeDoc
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState())) {
        FrameHeader(title = tr("Your computer")) {
            Text(
                tr("Files go straight between your devices over your Wi-Fi, encrypted. Nothing goes through the internet."),
                style = MaterialTheme.typography.bodyMedium, color = Inkleaf.colors.onFrameMuted,
            )
        }
        Spacer(Modifier.height(18.dp))
        if (computer == null) {
            Column(Modifier.padding(horizontal = 20.dp)) {
                Card {
                    Column(Modifier.padding(20.dp)) {
                        Box(Modifier.size(52.dp).clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) {
                            Lc(R.drawable.lc_qr_code, null, tint = MaterialTheme.colorScheme.primary, size = 26.dp)
                        }
                        Spacer(Modifier.height(16.dp))
                        Text(tr("Connect to a computer"), style = MaterialTheme.typography.titleMedium)
                        Spacer(Modifier.height(6.dp))
                        Step(1, tr("On your computer, open Inkleaf and choose Tools › Connect a Phone."))
                        Step(2, tr("Connect the phone to the same Wi-Fi as the computer."))
                        Step(3, tr("Tap the button below and scan the code on the computer’s screen."))
                        Spacer(Modifier.height(16.dp))
                        Button({ actions.run("link-pair") }, Modifier.fillMaxWidth().height(50.dp), shape = RoundedCornerShape(14.dp)) {
                            Lc(R.drawable.lc_scan_line, null, size = 18.dp)
                            Spacer(Modifier.width(8.dp))
                            Text(tr("Scan the code"))
                        }
                    }
                }
            }
        } else {
            Column(Modifier.padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Card {
                    Row(Modifier.padding(18.dp), verticalAlignment = Alignment.CenterVertically) {
                        Box(Modifier.size(52.dp).clip(RoundedCornerShape(16.dp)).background(MaterialTheme.colorScheme.secondaryContainer), contentAlignment = Alignment.Center) {
                            Lc(R.drawable.lc_monitor, null, tint = MaterialTheme.colorScheme.primary, size = 26.dp)
                        }
                        Spacer(Modifier.width(14.dp))
                        Column(Modifier.weight(1f)) {
                            Text(computer.name, style = MaterialTheme.typography.titleMedium)
                            Text(
                                if (computer.online) tr("Connected") else tr("Not connected right now"),
                                style = MaterialTheme.typography.bodySmall,
                                color = if (computer.online) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
                            )
                        }
                    }
                }
                Button(
                    { actions.run("link-send") }, Modifier.fillMaxWidth().height(52.dp), enabled = doc != null, shape = RoundedCornerShape(14.dp),
                ) {
                    Lc(R.drawable.lc_send, null, size = 18.dp)
                    Spacer(Modifier.width(8.dp))
                    Text(if (doc != null) tr("Send “{name}”", "name" to doc.name) else tr("Open a PDF to send it"))
                }
                Text(
                    tr("Files you send arrive on the computer straight away. Files sent from the computer open here while Inkleaf is open."),
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    OutlinedButton({ actions.run("link-pair") }, shape = RoundedCornerShape(12.dp)) { Text(tr("Connect a different computer")) }
                    OutlinedButton({ actions.forgetComputer(computer.id) }, shape = RoundedCornerShape(12.dp)) { Text(tr("Remove")) }
                }
            }
        }
    }
}

@Composable
private fun Step(n: Int, text: String) {
    Row(Modifier.padding(top = 10.dp)) {
        Box(Modifier.size(22.dp).clip(CircleShape).background(MaterialTheme.colorScheme.primary), contentAlignment = Alignment.Center) {
            Text("$n", style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onPrimary)
        }
        Spacer(Modifier.width(12.dp))
        Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}

@Composable
fun Card(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxWidth().clip(RoundedCornerShape(20.dp)).background(MaterialTheme.colorScheme.surfaceContainer)) { content() }
}

// --- settings ----------------------------------------------------------------------------------

@Composable
fun SettingsScreen(state: UiState, actions: Actions, onBack: () -> Unit) {
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).windowInsetsPadding(WindowInsets.navigationBars)) {
        FrameHeader(
            title = tr("Settings"),
            leading = { FrameIconButton(R.drawable.lc_arrow_left, tr("Back"), onClick = onBack) },
        )
        SectionLabel(tr("Appearance"), Modifier.padding(top = 12.dp))
        Row(Modifier.padding(horizontal = 20.dp).fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(10.dp)) {
            for ((choice, icon, label) in listOf(
                Triple(ThemeChoice.System, R.drawable.lc_sun_moon, tr("Match system")),
                Triple(ThemeChoice.Light, R.drawable.lc_sun, tr("Light")),
                Triple(ThemeChoice.Dark, R.drawable.lc_moon, tr("Dark")),
            )) {
                val on = state.theme == choice
                Column(
                    Modifier
                        .weight(1f)
                        .clip(RoundedCornerShape(16.dp))
                        .background(if (on) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer)
                        .clickable(role = Role.RadioButton) { actions.setTheme(choice) }
                        .padding(vertical = 14.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Lc(icon, null, tint = if (on) MaterialTheme.colorScheme.onPrimaryContainer else MaterialTheme.colorScheme.onSurfaceVariant)
                    Spacer(Modifier.height(6.dp))
                    Text(label, style = MaterialTheme.typography.labelMedium, textAlign = TextAlign.Center)
                }
            }
        }
        ListRow(R.drawable.lc_globe, tr("Language"), state.languageName) { actions.chooseLanguage() }

        SectionLabel(tr("Editing"), Modifier.padding(top = 8.dp))
        ListRow(
            R.drawable.lc_save, tr("Auto-save"), tr("Documents you’ve saved before are kept saved as you work."),
            trailing = {
                Switch(state.engine.autosave, { actions.run("toggle-autosave") }, colors = SwitchDefaults.colors(checkedTrackColor = MaterialTheme.colorScheme.primary))
            },
        ) { actions.run("toggle-autosave") }
        ListRow(R.drawable.lc_history, tr("Backups"), tr("Copies of documents from before they were saved over.")) { actions.run("open-backups") }
        ListRow(R.drawable.lc_sparkles, tr("AI settings"), tr("Summarize, translate and ask questions with the AI you choose.")) { actions.run("ai-settings") }
        ListRow(R.drawable.lc_key_round, tr("My receive code"), tr("Let people lock PDFs just for you.")) { actions.run("receive-code") }

        SectionLabel(tr("About"), Modifier.padding(top = 8.dp))
        ListRow(R.drawable.lc_info, "Inkleaf", tr("Version {version}", "version" to state.version))
        ListRow(R.drawable.lc_refresh_cw, tr("Check for updates"), null) { actions.run("check-updates") }
        ListRow(R.drawable.lc_heart, tr("Buy me a coffee"), tr("Inkleaf is free. If it helps you, you can buy me a coffee on Ko-fi")) { actions.run("donate") }
        ListRow(R.drawable.lc_book_open, tr("Source code"), "github.com/priyanshdas/inkleaf") { actions.run("open-github") }
        ListRow(R.drawable.lc_alert_circle, tr("Report a problem"), null) { actions.run("report-problem") }
        HorizontalDivider(Modifier.padding(horizontal = 20.dp, vertical = 8.dp), color = MaterialTheme.colorScheme.outlineVariant)
        ListRow(R.drawable.lc_file_text, tr("Terms of use"), null) { actions.showLegal("terms") }
        ListRow(R.drawable.lc_shield_check, tr("Privacy policy"), null) { actions.showLegal("privacy") }
        Text(
            tr("Built by EPD (Priyansh Das). Licensed under the GNU GPL, version 3 or later: you’re free to use, study, share and change it."),
            Modifier.padding(20.dp), style = MaterialTheme.typography.bodySmall, color = Inkleaf.colors.muted,
        )
    }
}
