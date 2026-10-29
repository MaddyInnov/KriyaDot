// SPDX-License-Identifier: Apache-2.0
import SwiftUI

/// KriyaDot Companion (iOS) — remote control for your KriyaDot
/// instance: the phone -> PC direction of the KriyaDot MVP. Pair once
/// over WiFi by scanning a QR code, then monitor runs, approve/deny
/// pending approvals, pause/resume/cancel runs, chat with the agent,
/// and read the activity feed and briefing — all from your phone.
/// Mirrors the Android companion (android-companion/).
@main
struct KriyaDotCompanionApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    init() {
        KriyaDotTheme.apply()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .preferredColorScheme(.dark)
        }
    }
}
