// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable

private val KriyaDotColors = darkColorScheme()

/** App theme: dark Material 3. */
@Composable
fun KriyaDotTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = KriyaDotColors,
        content = content,
    )
}
