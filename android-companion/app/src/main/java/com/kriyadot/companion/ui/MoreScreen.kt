// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Logout
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.kriyadot.companion.core.Briefing
import com.kriyadot.companion.core.PairingStore

/** Overflow tab: links to Activity + Briefing, pairing details, unpair. */
@Composable
fun MoreScreen(vm: CompanionViewModel, nav: NavController) {
    var confirmUnpair by remember { mutableStateOf(false) }

    ScreenScaffold(vm = vm, title = "More") {
        Card(modifier = Modifier.fillMaxWidth()) {
            Column(Modifier.padding(16.dp)) {
                Text("Paired server", style = MaterialTheme.typography.labelMedium)
                Text("${vm.store.host}:${vm.store.port}", style = MaterialTheme.typography.titleMedium)
                Spacer(Modifier.height(4.dp))
                Text(
                    "Device: ${vm.store.deviceName.ifEmpty { "this device" }}",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
        Spacer(Modifier.height(12.dp))
        ListItem(
            headlineContent = { Text("Activity feed") },
            modifier = Modifier.clickable { nav.navigate("activity") },
        )
        HorizontalDivider()
        ListItem(
            headlineContent = { Text("Briefing") },
            modifier = Modifier.clickable { nav.navigate("briefing") },
        )
        HorizontalDivider()
        ListItem(
            headlineContent = { Text("Unpair this device", color = MaterialTheme.colorScheme.error) },
            leadingContent = {
                Icon(Icons.Filled.Logout, contentDescription = null, tint = MaterialTheme.colorScheme.error)
            },
            modifier = Modifier.clickable { confirmUnpair = true },
        )
        Spacer(Modifier.height(24.dp))
        Text(
            "KriyaDot Companion 1.0.0 — MVP",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }

    if (confirmUnpair) {
        AlertDialog(
            onDismissRequest = { confirmUnpair = false },
            title = { Text("Unpair this device?") },
            text = { Text("The stored device token is deleted and this phone stops controlling the KriyaDot instance.") },
            confirmButton = {
                Button(onClick = { vm.unpair(); confirmUnpair = false }) { Text("Unpair") }
            },
            dismissButton = {
                TextButton(onClick = { confirmUnpair = false }) { Text("Cancel") }
            },
        )
    }
}
