// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Send
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import com.kriyadot.companion.core.Bot
import com.kriyadot.companion.core.ChatMessage

/**
 * Chat with the KriyaDot instance. Mirrors the web app's POST /chat turn API:
 * the assistant reply streams token-by-token into the last bubble.
 *
 * The bot the message is addressed to is picked from the roster
 * (GET /api/companion/bots) with the picker above the conversation; the
 * selection persists in PairingStore and is sent as botId in the request.
 */
@Composable
fun ChatScreen(vm: CompanionViewModel) {
    val messages by vm.messages.collectAsState()
    val busy by vm.chatBusy.collectAsState()
    val error by vm.error.collectAsState()
    val bots by vm.bots.collectAsState()
    val selectedBotId by vm.selectedBotId.collectAsState()
    val botsLoading by vm.botsLoading.collectAsState()
    var input by remember { mutableStateOf("") }
    val listState = rememberLazyListState()
    val snackbar = remember { SnackbarHostState() }

    LaunchedEffect(error) {
        error?.let { snackbar.showSnackbar(it); vm.clearError() }
    }
    LaunchedEffect(Unit) { vm.ensureBots() }
    LaunchedEffect(messages.size) {
        if (messages.isNotEmpty()) listState.animateScrollToItem(messages.size - 1)
    }

    Scaffold(
        snackbarHost = { SnackbarHost(snackbar) },
        bottomBar = {
            Row(
                modifier = Modifier.fillMaxWidth().padding(8.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                OutlinedTextField(
                    value = input,
                    onValueChange = { input = it },
                    placeholder = { Text("Message KriyaDot…") },
                    modifier = Modifier.weight(1f),
                    maxLines = 4,
                )
                IconButton(
                    onClick = { vm.sendChat(input); input = "" },
                    enabled = input.isNotBlank() && !busy && selectedBotId != null,
                ) {
                    Icon(Icons.Filled.Send, contentDescription = "Send")
                }
                IconButton(onClick = vm::clearChat, enabled = messages.isNotEmpty() && !busy) {
                    Icon(Icons.Filled.Delete, contentDescription = "Clear chat")
                }
            }
        },
    ) { inner ->
        Column(modifier = Modifier.fillMaxSize().padding(inner)) {
            BotPickerRow(
                bots = bots,
                selectedBotId = selectedBotId,
                loading = botsLoading,
                onSelect = vm::selectBot,
            )
            if (messages.isEmpty()) {
                Column(
                    modifier = Modifier.fillMaxSize().padding(24.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Spacer(Modifier.height(48.dp))
                    Text(
                        "Ask KriyaDot anything.",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                LazyColumn(
                    state = listState,
                    modifier = Modifier.fillMaxSize().padding(horizontal = 12.dp),
                ) {
                    items(messages, key = { it.id }) { msg ->
                        val isUser = msg.role == "user"
                        Row(modifier = Modifier.fillMaxWidth().padding(vertical = 4.dp)) {
                            if (isUser) Spacer(Modifier.weight(1f))
                            Card(
                                modifier = Modifier.fillMaxWidth(if (isUser) 0.85f else 1f),
                                colors = CardDefaults.cardColors(
                                    containerColor = if (isUser) MaterialTheme.colorScheme.primaryContainer
                                    else MaterialTheme.colorScheme.surfaceVariant,
                                ),
                            ) {
                                Text(
                                    msg.text.ifEmpty { "…" },
                                    modifier = Modifier.padding(12.dp),
                                    style = MaterialTheme.typography.bodyMedium,
                                )
                            }
                            if (!isUser) Spacer(Modifier.weight(0.001f))
                        }
                    }
                    item { Spacer(Modifier.height(8.dp)) }
                }
            }
        }
    }
}

/**
 * Chat bot picker backed by GET /api/companion/bots: a dropdown of the roster
 * (defaults to the first bot), "Loading bots…" while fetching, and
 * "No bots available" when the roster comes back empty.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun BotPickerRow(
    bots: List<Bot>,
    selectedBotId: String?,
    loading: Boolean,
    onSelect: (String) -> Unit,
) {
    var expanded by remember { mutableStateOf(false) }
    val selected = bots.find { it.id == selectedBotId }
    Row(
        modifier = Modifier.fillMaxWidth().padding(horizontal = 12.dp, vertical = 8.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        when {
            loading && bots.isEmpty() -> {
                CircularProgressIndicator(modifier = Modifier.size(20.dp), strokeWidth = 2.dp)
                Spacer(Modifier.width(8.dp))
                Text("Loading bots…", style = MaterialTheme.typography.bodyMedium)
            }
            bots.isEmpty() -> {
                Text(
                    "No bots available",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                )
            }
            else -> {
                ExposedDropdownMenuBox(
                    expanded = expanded,
                    onExpandedChange = { expanded = !expanded },
                ) {
                    OutlinedTextField(
                        value = selected?.name ?: "",
                        onValueChange = {},
                        readOnly = true,
                        label = { Text("Bot") },
                        trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
                        modifier = Modifier.menuAnchor().fillMaxWidth(),
                    )
                    ExposedDropdownMenu(
                        expanded = expanded,
                        onDismissRequest = { expanded = false },
                    ) {
                        bots.forEach { bot ->
                            DropdownMenuItem(
                                text = { Text(bot.name) },
                                onClick = {
                                    onSelect(bot.id)
                                    expanded = false
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}
