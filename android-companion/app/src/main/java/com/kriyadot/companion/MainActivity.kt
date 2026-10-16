// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion

import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.activity.viewModels
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Chat
import androidx.compose.material.icons.filled.Home
import androidx.compose.material.icons.filled.MoreHoriz
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.filled.Rule
import androidx.compose.material3.Badge
import androidx.compose.material3.BadgedBox
import androidx.compose.material3.Icon
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.navigation.NavDestination.Companion.hierarchy
import androidx.navigation.NavGraph.Companion.findStartDestination
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.currentBackStackEntryAsState
import androidx.navigation.compose.rememberNavController
import com.google.zxing.integration.android.IntentIntegrator
import com.kriyadot.companion.core.KriyaDotMessagingService
import com.kriyadot.companion.core.PushConfig
import com.kriyadot.companion.core.QrParser
import com.kriyadot.companion.ui.ActivityScreen
import com.kriyadot.companion.ui.ApprovalsScreen
import com.kriyadot.companion.ui.BriefingScreen
import com.kriyadot.companion.ui.ChatScreen
import com.kriyadot.companion.ui.CompanionViewModel
import com.kriyadot.companion.ui.HomeScreen
import com.kriyadot.companion.ui.MoreScreen
import com.kriyadot.companion.ui.PairingScreen
import com.kriyadot.companion.ui.RunsScreen
import com.kriyadot.companion.ui.KriyaDotTheme

class MainActivity : ComponentActivity() {

    private val vm: CompanionViewModel by viewModels { CompanionViewModel.Factory(application) }

    private val scanLauncher =
        registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
            val parsed = IntentIntegrator.parseActivityResult(result.resultCode, result.data)
            vm.onQrScanned(QrParser.parse(parsed?.contents))
        }

    /** Called from the Compose pairing screen: launches the ZXing scanner. */
    fun startQrScan() {
        val integrator = IntentIntegrator(this)
        integrator.setDesiredBarcodeFormats(IntentIntegrator.QR_CODE)
        integrator.setPrompt("Scan the pairing QR in KriyaDot Workspace → Devices")
        integrator.setBeepEnabled(false)
        integrator.setOrientationLocked(true)
        scanLauncher.launch(integrator.createScanIntent())
    }

    /** Last push-tap intent, as observable state so taps re-route navigation. */
    private val pushNavTarget = androidx.compose.runtime.mutableStateOf<String?>(null)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // Push notifications (Codync parity): manual Firebase init from
        // assets/fcm_config.json; silently disabled when unconfigured.
        PushConfig.init(this)
        requestNotificationPermission()
        pushNavTarget.value = pushRouteFor(intent)
        setContent {
            KriyaDotTheme {
                val paired by vm.paired.collectAsState()
                if (paired) MainShell(vm, pushNavTarget) else PairingScreen(vm, ::startQrScan)
            }
        }
    }

    override fun onNewIntent(intent: android.content.Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        pushNavTarget.value = pushRouteFor(intent)
    }

    /** Maps a push-tap intent to a bottom-nav route, or null when not a push tap. */
    private fun pushRouteFor(intent: android.content.Intent?): String? {
        val kind = intent?.getStringExtra(KriyaDotMessagingService.EXTRA_KIND) ?: return null
        return if (kind == "needsInput") "approvals" else "chat"
    }

    /** Android 13+ runtime permission for push; no-op on older versions. */
    private fun requestNotificationPermission() {
        if (android.os.Build.VERSION.SDK_INT < android.os.Build.VERSION_CODES.TIRAMISU) return
        if (checkSelfPermission(android.Manifest.permission.POST_NOTIFICATIONS) ==
            android.content.pm.PackageManager.PERMISSION_GRANTED
        ) return
        registerForActivityResult(
            ActivityResultContracts.RequestPermission(),
        ) { }.launch(android.Manifest.permission.POST_NOTIFICATIONS)
    }
}

private sealed class Tab(val route: String, val label: String, val icon: ImageVector) {
    data object Home : Tab("home", "Home", Icons.Filled.Home)
    data object Approvals : Tab("approvals", "Approvals", Icons.Filled.Rule)
    data object Runs : Tab("runs", "Runs", Icons.Filled.PlayArrow)
    data object Chat : Tab("chat", "Chat", Icons.Filled.Chat)
    data object More : Tab("more", "More", Icons.Filled.MoreHoriz)
}

private val TABS = listOf(Tab.Home, Tab.Approvals, Tab.Runs, Tab.Chat, Tab.More)

@Composable
private fun MainShell(
    vm: CompanionViewModel,
    pushNavTarget: androidx.compose.runtime.State<String?>,
) {
    val nav = rememberNavController()
    val approvals by vm.approvals.collectAsState()

    // Push tap routing: "needs you" -> approvals inbox, "done"/"failed" -> chat.
    val target by pushNavTarget
    androidx.compose.runtime.LaunchedEffect(target) {
        if (target != null) nav.navigate(target!!) { launchSingleTop = true }
    }
    Scaffold(
        bottomBar = {
            NavigationBar {
                val entry by nav.currentBackStackEntryAsState()
                val dest = entry?.destination
                TABS.forEach { tab ->
                    val selected = dest?.hierarchy?.any { it.route == tab.route } == true
                    NavigationBarItem(
                        selected = selected,
                        onClick = {
                            nav.navigate(tab.route) {
                                popUpTo(nav.graph.findStartDestination().id) { saveState = true }
                                launchSingleTop = true
                                restoreState = true
                            }
                        },
                        icon = {
                            if (tab == Tab.Approvals && approvals.isNotEmpty()) {
                                BadgedBox(badge = { Badge { Text(approvals.size.toString()) } }) {
                                    Icon(tab.icon, contentDescription = tab.label)
                                }
                            } else {
                                Icon(tab.icon, contentDescription = tab.label)
                            }
                        },
                        label = { Text(tab.label) },
                    )
                }
            }
        },
    ) { inner ->
        NavHost(
            navController = nav,
            startDestination = Tab.Home.route,
            modifier = Modifier.padding(inner),
        ) {
            composable(Tab.Home.route) { HomeScreen(vm) }
            composable(Tab.Approvals.route) { ApprovalsScreen(vm) }
            composable(Tab.Runs.route) { RunsScreen(vm) }
            composable(Tab.Chat.route) { ChatScreen(vm) }
            composable(Tab.More.route) { MoreScreen(vm, nav) }
            composable("activity") { ActivityScreen(vm, nav) }
            composable("briefing") { BriefingScreen(vm, nav) }
        }
    }
}
