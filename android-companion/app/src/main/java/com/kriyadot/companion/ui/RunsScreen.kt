// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kriyadot.companion.core.RunSummary

/** Runs list with pause / resume / cancel actions (cancel asks for confirmation). */
@Composable
fun RunsScreen(vm: CompanionViewModel) {
    val runs by vm.runs.collectAsState()
    var cancelling by remember { mutableStateOf<RunSummary?>(null) }

    ScreenScaffold(
        vm = vm,
        title = "Runs",
        actions = {
            IconButton(onClick = vm::refreshRuns) {
                Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
            }
        },
    ) {
        if (runs.isEmpty()) {
            EmptyHint("No runs right now.")
        } else {
            LazyColumn {
                items(runs, key = { it.id }) { run ->
                    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Column(Modifier.padding(16.dp)) {
                            Row(modifier = Modifier.fillMaxWidth()) {
                                Text(
                                    run.label,
                                    style = MaterialTheme.typography.titleMedium,
                                    modifier = Modifier.weight(1f),
                                )
                                Text(
                                    run.state,
                                    style = MaterialTheme.typography.labelMedium,
                                    color = MaterialTheme.colorScheme.primary,
                                )
                            }
                            if (run.detail.isNotEmpty()) {
                                Spacer(Modifier.height(4.dp))
                                Text(run.detail, style = MaterialTheme.typography.bodyMedium)
                            }
                            Spacer(Modifier.height(12.dp))
                            Row {
                                val paused = run.state.equals("paused", ignoreCase = true)
                                if (paused) {
                                    Button(onClick = { vm.runAction(run.id, "resume") }) { Text("Resume") }
                                } else {
                                    OutlinedButton(onClick = { vm.runAction(run.id, "pause") }) { Text("Pause") }
                                }
                                Spacer(Modifier.padding(6.dp))
                                OutlinedButton(onClick = { cancelling = run }) { Text("Cancel") }
                            }
                        }
                    }
                }
            }
        }
    }

    cancelling?.let { run ->
        AlertDialog(
            onDismissRequest = { cancelling = null },
            title = { Text("Cancel this run?") },
            text = { Text("“${run.label}” will be stopped. This cannot be undone.") },
            confirmButton = {
                Button(
                    onClick = { vm.runAction(run.id, "cancel"); cancelling = null },
                ) { Text("Cancel run") }
            },
            dismissButton = {
                TextButton(onClick = { cancelling = null }) { Text("Keep") }
            },
        )
    }
}
