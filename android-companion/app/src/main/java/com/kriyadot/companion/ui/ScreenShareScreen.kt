// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import android.graphics.Bitmap
import androidx.compose.foundation.Image
import androidx.compose.foundation.gestures.detectTransformGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.unit.dp
import androidx.navigation.NavController

/**
 * Remote screen: watch the paired PC's live screen from the phone.
 *
 * Flow: Start -> server mints an approval -> the PC owner approves in the
 * KriyaDot web UI -> frames stream over the WebSocket frame channel
 * (MJPEG-style PNG frames, not raw WebRTC). View-only: the phone cannot
 * drive the PC from this screen.
 */
@Composable
fun ScreenShareScreen(vm: CompanionViewModel, nav: NavController) {
    val session by vm.screenSession.collectAsState()
    val bitmap by vm.screenBitmap.collectAsState()
    val note by vm.screenNote.collectAsState()

    // Stop the session when the user actually navigates away — NOT on
    // rotation. A config change disposes this composable but leaves the nav
    // back stack untouched, so the route check below distinguishes the two:
    // rotate → still on "screen" → keep the session alive; navigate away →
    // route changed → stop.
    DisposableEffect(Unit) {
        onDispose {
            if (nav.currentDestination?.route != "screen") {
                vm.stopScreenShare()
            }
        }
    }

    ScreenScaffold(vm = vm, title = "Remote screen", nav = nav) {
        Column(
            modifier = Modifier.fillMaxSize().padding(16.dp),
            verticalArrangement = Arrangement.spacedBy(12.dp),
        ) {
            Text(
                "Watch this PC's screen live. Sharing starts only after you approve it in the KriyaDot web UI, and stops automatically after 30 minutes.",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )

            when {
                session == null && bitmap == null -> {
                    // Idle: nothing requested yet (or just ended).
                    if (!note.isNullOrBlank()) {
                        Text(note!!, style = MaterialTheme.typography.bodyMedium)
                    }
                    Button(onClick = { vm.startScreenShare() }, modifier = Modifier.fillMaxWidth()) {
                        Text("Start screen sharing")
                    }
                }
                bitmap == null -> {
                    // Waiting for approval / connecting.
                    Box(modifier = Modifier.fillMaxWidth().height(220.dp), contentAlignment = Alignment.Center) {
                        Column(horizontalAlignment = Alignment.CenterHorizontally) {
                            CircularProgressIndicator()
                            Spacer(Modifier.height(12.dp))
                            Text(note ?: "Connecting…", style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                    OutlinedButton(onClick = { vm.stopScreenShare() }, modifier = Modifier.fillMaxWidth()) {
                        Text("Cancel")
                    }
                }
                else -> {
                    // Live frames with pinch-to-zoom and pan.
                    var scale by remember { mutableFloatStateOf(1f) }
                    var offset by remember { mutableStateOf(Offset.Zero) }
                    Text(
                        (if (session?.mock == true) "Preview mode · " else "") + (note ?: "Live"),
                        style = MaterialTheme.typography.labelMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                    ZoomableScreenImage(bitmap = bitmap!!, scale = scale, offset = offset,
                        onTransform = { zoom, pan ->
                            scale = (scale * zoom).coerceIn(1f, 6f)
                            offset = if (scale <= 1f) Offset.Zero else offset + pan
                        })
                    OutlinedButton(onClick = { vm.stopScreenShare() }, modifier = Modifier.fillMaxWidth()) {
                        Text("Stop sharing")
                    }
                }
            }
        }
    }
}

@Composable
private fun ZoomableScreenImage(
    bitmap: Bitmap,
    scale: Float,
    offset: Offset,
    onTransform: (zoom: Float, pan: Offset) -> Unit,
) {
    val imageBitmap = remember(bitmap) { bitmap.asImageBitmap() }
    Image(
        bitmap = imageBitmap,
        contentDescription = "Live PC screen",
        contentScale = ContentScale.Fit,
        modifier = Modifier
            .fillMaxWidth()
            .weight(1f, fill = false)
            .graphicsLayer(
                scaleX = scale,
                scaleY = scale,
                translationX = offset.x,
                translationY = offset.y,
            )
            .pointerInput(Unit) {
                detectTransformGestures { _, pan, zoom, _ -> onTransform(zoom, pan) }
            },
    )
}
