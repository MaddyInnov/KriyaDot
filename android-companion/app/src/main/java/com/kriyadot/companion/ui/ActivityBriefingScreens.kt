// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController
import com.kriyadot.companion.core.ActivityItem
import com.kriyadot.companion.core.Briefing

/** Activity feed: latest events from the KriyaDot instance. */
@Composable
fun ActivityScreen(vm: CompanionViewModel, nav: NavController) {
    val activity by vm.activity.collectAsState()
    ScreenScaffold(
        vm = vm,
        title = "Activity",
        nav = nav,
        actions = {
            IconButton(onClick = vm::refreshActivity) {
                Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
            }
        },
    ) {
        if (activity.isEmpty()) {
            EmptyHint("No activity yet.")
        } else {
            LazyColumn {
                items(activity, key = { it.id }) { item ->
                    ListItem(
                        headlineContent = { Text(item.text) },
                        supportingContent = {
                            val meta = listOf(item.kind, item.createdAt)
                                .filter { it.isNotEmpty() }.joinToString(" · ")
                            if (meta.isNotEmpty()) Text(meta)
                        },
                    )
                }
            }
        }
    }
}

/** Latest briefing digest from the server. */
@Composable
fun BriefingScreen(vm: CompanionViewModel, nav: NavController) {
    val briefing by vm.briefing.collectAsState()
    ScreenScaffold(
        vm = vm,
        title = "Briefing",
        nav = nav,
        actions = {
            IconButton(onClick = vm::refreshBriefing) {
                Icon(Icons.Filled.Refresh, contentDescription = "Refresh")
            }
        },
    ) {
        val b = briefing
        if (b == null || b.body.isEmpty()) {
            EmptyHint("No briefing available yet.")
        } else {
            Column(modifier = Modifier.verticalScroll(rememberScrollState())) {
                Text(b.title, style = MaterialTheme.typography.headlineSmall)
                if (b.generatedAt.isNotEmpty()) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        b.generatedAt,
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(12.dp))
                Card(modifier = Modifier.fillMaxWidth()) {
                    Text(b.body, modifier = Modifier.padding(16.dp))
                }
            }
        }
    }
}
