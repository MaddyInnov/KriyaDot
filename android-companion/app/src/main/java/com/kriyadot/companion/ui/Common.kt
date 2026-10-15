// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowBack
import androidx.compose.material3.CenterAlignedTopAppBar
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController

/**
 * Shared screen chrome: top bar with optional back button, error snackbar fed
 * from the ViewModel's error flow.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ScreenScaffold(
    vm: CompanionViewModel,
    title: String,
    nav: NavController? = null,
    actions: @Composable () -> Unit = {},
    content: @Composable () -> Unit,
) {
    val error by vm.error.collectAsState()
    val snackbar = remember { SnackbarHostState() }
    LaunchedEffect(error) {
        error?.let { snackbar.showSnackbar(it); vm.clearError() }
    }
    Scaffold(
        topBar = {
            CenterAlignedTopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    if (nav != null) {
                        IconButton(onClick = { nav.popBackStack() }) {
                            Icon(Icons.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                actions = { actions() },
            )
        },
        snackbarHost = { SnackbarHost(snackbar) },
    ) { inner ->
        Column(
            modifier = Modifier
                .fillMaxSize()
                .padding(inner)
                .padding(16.dp),
        ) {
            content()
        }
    }
}

@Composable
fun EmptyHint(text: String) {
    Spacer(Modifier.height(24.dp))
    Text(text, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
}

@Composable
fun SocketStatusLine(vm: CompanionViewModel) {
    val live by vm.socketLive.collectAsState()
    Text(
        if (live) "● Live updates" else "○ Reconnecting…",
        style = MaterialTheme.typography.labelMedium,
        color = if (live) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
