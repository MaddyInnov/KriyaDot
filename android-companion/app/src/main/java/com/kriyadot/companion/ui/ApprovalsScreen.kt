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
import androidx.compose.material3.OutlinedTextField
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
import com.kriyadot.companion.core.Approval

/** Pending approvals with approve/deny + confirmation dialog + optional note. */
@Composable
fun ApprovalsScreen(vm: CompanionViewModel) {
    val approvals by vm.approvals.collectAsState()
    var deciding by remember { mutableStateOf<Pair<Approval, Boolean>?>(null) }

    ScreenScaffold(
        vm = vm,
        title = "Approvals",
        actions = {
            IconButton(onClick = vm::refreshApprovals) {
                Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
            }
        },
    ) {
        if (approvals.isEmpty()) {
            EmptyHint("Nothing waiting for approval.")
        } else {
            LazyColumn {
                items(approvals, key = { it.id }) { approval ->
                    Card(modifier = Modifier.fillMaxWidth().padding(vertical = 6.dp)) {
                        Column(Modifier.padding(16.dp)) {
                            Text(approval.title, style = MaterialTheme.typography.titleMedium)
                            if (approval.detail.isNotEmpty()) {
                                Spacer(Modifier.height(4.dp))
                                Text(approval.detail, style = MaterialTheme.typography.bodyMedium)
                            }
                            if (approval.sessionId.isNotEmpty() || approval.createdAt.isNotEmpty()) {
                                Spacer(Modifier.height(4.dp))
                                Text(
                                    listOf(approval.sessionId, approval.createdAt)
                                        .filter { it.isNotEmpty() }.joinToString(" · "),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Spacer(Modifier.height(12.dp))
                            Row {
                                Button(onClick = { deciding = approval to true }) { Text("Approve") }
                                Spacer(Modifier.padding(6.dp))
                                TextButton(onClick = { deciding = approval to false }) { Text("Deny") }
                            }
                        }
                    }
                }
            }
        }
    }

    deciding?.let { (approval, approve) ->
        var note by remember { mutableStateOf("") }
        AlertDialog(
            onDismissRequest = { deciding = null },
            title = { Text(if (approve) "Approve this?" else "Deny this?") },
            text = {
                Column {
                    Text(approval.title, style = MaterialTheme.typography.bodyMedium)
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = note,
                        onValueChange = { note = it },
                        label = { Text("Note (optional)") },
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
            },
            confirmButton = {
                Button(onClick = {
                    vm.decideApproval(approval.id, approve, note.ifBlank { null })
                    deciding = null
                }) { Text(if (approve) "Approve" else "Deny") }
            },
            dismissButton = {
                TextButton(onClick = { deciding = null }) { Text("Cancel") }
            },
        )
    }
}
