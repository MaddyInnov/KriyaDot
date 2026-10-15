// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import android.Manifest
import android.content.pm.PackageManager
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import com.kriyadot.companion.core.PairingPayload
import com.kriyadot.companion.core.QrParser

/**
 * First-run pairing: scan the QR shown in KriyaDot Workspace -> Devices, confirm
 * the server, and exchange the one-time token for a long-lived device token.
 * Camera permission is requested with an in-app rationale; a manual entry
 * fallback stays available when the camera is denied or missing.
 */
@Composable
fun PairingScreen(vm: CompanionViewModel, onScanRequested: () -> Unit) {
    val context = LocalContext.current
    val pending by vm.pendingPairing.collectAsState()
    val busy by vm.pairingBusy.collectAsState()
    val pairError by vm.pairingError.collectAsState()
    var showManual by remember { mutableStateOf(false) }
    var showRationale by remember { mutableStateOf(false) }

    val permissionLauncher = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted ->
        if (granted) onScanRequested() else showRationale = true
    }

    fun requestScan() {
        when (PackageManager.PERMISSION_GRANTED) {
            ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) ->
                onScanRequested()
            else -> permissionLauncher.launch(Manifest.permission.CAMERA)
        }
    }

    Column(
        modifier = Modifier.fillMaxSize().padding(24.dp),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Text("Pair with KriyaDot", style = MaterialTheme.typography.headlineMedium)
        Spacer(Modifier.height(8.dp))
        Text(
            "Scan the QR code shown in KriyaDot Workspace → Devices on your PC.",
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        Spacer(Modifier.height(24.dp))
        Button(onClick = ::requestScan, modifier = Modifier.fillMaxWidth()) {
            Text("Scan QR code")
        }
        Spacer(Modifier.height(8.dp))
        OutlinedButton(onClick = { showManual = true }, modifier = Modifier.fillMaxWidth()) {
            Text("Enter details manually")
        }
        if (showRationale) {
            Spacer(Modifier.height(16.dp))
            Text(
                "Camera access is used only to scan the pairing QR. You can deny it " +
                    "and enter the host, port and token manually instead.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        pairError?.let {
            Spacer(Modifier.height(16.dp))
            Text(it, color = MaterialTheme.colorScheme.error)
        }
    }

    if (showManual) {
        ManualPairingDialog(
            onDismiss = { showManual = false },
            onConfirm = { payload ->
                showManual = false
                vm.onQrScanned(payload)
            },
        )
    }

    pending?.let { payload ->
        ConfirmPairingDialog(
            payload = payload,
            busy = busy,
            error = pairError,
            onDismiss = vm::clearPendingPairing,
            onConfirm = vm::confirmPairing,
        )
    }

    if (busy) {
        AlertDialog(
            onDismissRequest = {},
            confirmButton = {},
            text = {
                Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.fillMaxWidth()) {
                    CircularProgressIndicator()
                    Spacer(Modifier.height(12.dp))
                    Text("Exchanging pairing token…")
                }
            },
        )
    }
}

@Composable
private fun ConfirmPairingDialog(
    payload: PairingPayload,
    busy: Boolean,
    error: String?,
    onDismiss: () -> Unit,
    onConfirm: (deviceName: String) -> Unit,
) {
    var name by remember { mutableStateOf(android.os.Build.MODEL) }
    AlertDialog(
        onDismissRequest = { if (!busy) onDismiss() },
        title = { Text("Pair with this server?") },
        text = {
            Column {
                Text("Server: ${payload.serverLabel}")
                if (payload.isHosted) {
                    Spacer(Modifier.height(4.dp))
                    Text(
                        "Hosted server — the phone will connect over the internet.",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.height(12.dp))
                OutlinedTextField(
                    value = name,
                    onValueChange = { name = it },
                    label = { Text("Device name") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                error?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error)
                }
            }
        },
        confirmButton = {
            Button(onClick = { onConfirm(name) }, enabled = !busy) { Text("Pair") }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, enabled = !busy) { Text("Cancel") }
        },
    )
}

@Composable
private fun ManualPairingDialog(
    onDismiss: () -> Unit,
    onConfirm: (PairingPayload?) -> Unit,
) {
    var hosted by remember { mutableStateOf(false) }
    var host by remember { mutableStateOf("") }
    var port by remember { mutableStateOf("") }
    var serverUrl by remember { mutableStateOf("") }
    var token by remember { mutableStateOf("") }
    var invalid by remember { mutableStateOf(false) }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text("Enter pairing details") },
        text = {
            Column {
                Row(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.spacedBy(8.dp),
                ) {
                    Button(
                        onClick = { hosted = false; invalid = false },
                        modifier = Modifier.weight(1f),
                        enabled = hosted,
                    ) { Text("WiFi (LAN)") }
                    Button(
                        onClick = { hosted = true; invalid = false },
                        modifier = Modifier.weight(1f),
                        enabled = !hosted,
                    ) { Text("Hosted") }
                }
                Spacer(Modifier.height(12.dp))
                if (hosted) {
                    Text(
                        "Connect to a hosted KriyaDot server over the internet. " +
                            "Ask the server owner for its public URL and a pairing code " +
                            "(Workspace → Devices → Generate pairing code).",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = serverUrl, onValueChange = { serverUrl = it },
                        label = { Text("Server URL (https://…)") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri),
                        modifier = Modifier.fillMaxWidth(),
                    )
                } else {
                    OutlinedTextField(
                        value = host, onValueChange = { host = it },
                        label = { Text("Host (LAN IP)") }, singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    OutlinedTextField(
                        value = port, onValueChange = { port = it },
                        label = { Text("Port") }, singleLine = true,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                        modifier = Modifier.fillMaxWidth(),
                    )
                }
                Spacer(Modifier.height(8.dp))
                OutlinedTextField(
                    value = token, onValueChange = { token = it },
                    label = { Text("One-time token") }, singleLine = true,
                    modifier = Modifier.fillMaxWidth(),
                )
                if (invalid) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Those details don't form a valid pairing payload.",
                        color = MaterialTheme.colorScheme.error,
                    )
                }
            }
        },
        confirmButton = {
            Button(onClick = {
                val payload = if (hosted) {
                    val url = QrParser.normalizeServerUrl(serverUrl)
                    val ott = token.trim()
                    if (url != null && ott.isNotEmpty())
                        PairingPayload(host = "", port = 0, ott = ott, serverUrl = url)
                    else null
                } else {
                    QrParser.parse(
                        "kriyadot://pair?host=${host.trim()}&port=${port.trim()}&token=${token.trim()}",
                    )
                }
                invalid = payload == null
                if (payload != null) onConfirm(payload)
            }) { Text("Continue") }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}
