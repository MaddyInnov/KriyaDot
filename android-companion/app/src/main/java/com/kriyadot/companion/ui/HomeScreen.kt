// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kriyadot.companion.core.PairingStore
import com.kriyadot.companion.core.ServerStatus

/** Home: server health, active runs summary, pending approvals count. */
@Composable
fun HomeScreen(vm: CompanionViewModel) {
    val status by vm.status.collectAsState()
    ScreenScaffold(
        vm = vm,
        title = "KriyaDot",
        actions = {
            IconButton(onClick = vm::refreshAll) {
                Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
            }
        },
    ) {
        SocketStatusLine(vm)
        Spacer(Modifier.height(12.dp))
        val s = status
        if (s == null) {
            Text(
                "Connecting to ${vm.store.serverLabel}…",
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        } else {
            Card(modifier = Modifier.fillMaxWidth()) {
                Column(Modifier.padding(16.dp)) {
                    Text(
                        if (s.healthy) "● Server healthy" else "● Server unreachable",
                        style = MaterialTheme.typography.titleMedium,
                        color = if (s.healthy) MaterialTheme.colorScheme.primary
                        else MaterialTheme.colorScheme.error,
                    )
                    Spacer(Modifier.height(4.dp))
                    val ver = if (s.version.isNotEmpty()) " v${s.version}" else ""
                    Text("${s.serverName}$ver", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "Connected to ${vm.store.serverLabel}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Text(
                        "Paired as ${vm.store.deviceName.ifEmpty { "this device" }}",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            Spacer(Modifier.height(12.dp))
            Row(modifier = Modifier.fillMaxWidth()) {
                StatCard(
                    value = s.activeRuns.toString(),
                    label = "Active runs",
                    modifier = Modifier.weight(1f),
                )
                Spacer(Modifier.padding(6.dp))
                StatCard(
                    value = s.pendingApprovals.toString(),
                    label = "Pending approvals",
                    modifier = Modifier.weight(1f),
                    highlight = s.pendingApprovals > 0,
                )
            }
        }
    }
}

@Composable
private fun StatCard(value: String, label: String, modifier: Modifier = Modifier, highlight: Boolean = false) {
    Card(modifier = modifier) {
        Column(Modifier.padding(16.dp)) {
            Text(
                value,
                style = MaterialTheme.typography.headlineMedium,
                color = if (highlight) MaterialTheme.colorScheme.error
                else MaterialTheme.colorScheme.onSurface,
            )
            Text(label, style = MaterialTheme.typography.bodySmall)
        }
    }
}
