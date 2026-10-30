// SPDX-License-Identifier: Apache-2.0
import Foundation
import UIKit
import UserNotifications

/// APNs registration hooks — the iOS counterpart of Android's FCM flow.
///
/// Flow (mirrors CompanionViewModel.registerPushToken on Android):
/// 1. On first pairing (and on every launch while paired) the view model
///    calls requestAuthorizationAndRegister().
/// 2. UIKit asks the user for notification permission; on grant the app
///    registers with APNs.
/// 3. AppDelegate forwards the APNs device token (hex) here, and the
///    view model forwards it to the server via
///    KriyaDotAPI.registerPushToken — the same registration endpoint
///    Android uses for FCM tokens, with tokenType "apns".
/// 4. Token refreshes arrive through the same delegate callback and are
///    re-registered the same way (Android: onNewToken).
///
/// SERVER STATUS (updated for C-13): the server now implements BOTH
/// branches — PushService (apps/api/src/push.ts) sends via FCM and via
/// APNs (ES256 .p8 provider tokens, HTTP/2, sealed payloads, 410 token
/// pruning). What remains founder-gated is the SIGNED build itself:
/// APNs registration only succeeds with the aps-environment entitlement
/// signed under the founder's team (see SIGNING.md). The sealed-payload
/// decryption in SealedPush.swift is transport-agnostic and consumes
/// the APNs data fields (`kind`, `sealed`, `fallbackTitle`,
/// `fallbackBody`, `botId`, `chatId`, `approvalId`).
final class PushManager: NSObject {
    static let shared = PushManager()

    /// Set by the view model; invoked with the hex APNs token whenever
    /// APNs hands one over (initial registration + refreshes).
    var onToken: ((String) -> Void)?

    /// Route of the most recent notification tap: "approvals" for
    /// needsInput pushes, "chat" otherwise (mirrors Android's
    /// pushRouteFor in MainActivity).
    var onNotificationTap: ((String) -> Void)?

    private override init() { super.init() }

    /// Requests notification permission and, when granted, registers
    /// for remote notifications with APNs. Safe to call repeatedly.
    func requestAuthorizationAndRegister() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .badge, .sound]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Handles an APNs token delivered to the app delegate.
    func didRegister(deviceToken: Data) {
        let hex = deviceToken.map { String(format: "%02x", $0) }.joined()
        onToken?(hex)
    }

    /// Decodes a notification tap into a tab route, decrypting the
    /// sealed content when present (display itself is handled by iOS
    /// from the aps payload; the sealed fields carry the private body
    /// for the in-app view, same split as Android's FCM data messages).
    func route(for userInfo: [AnyHashable: Any]) -> String {
        let kind = userInfo["kind"] as? String ?? "done"
        return kind == "needsInput" ? "approvals" : "chat"
    }
}

/// UIKit app delegate wired in via @UIApplicationDelegateAdaptor:
/// APNs registration results + notification taps land here because
/// SwiftUI's App lifecycle has no direct equivalents.
final class AppDelegate: NSObject, UIApplicationDelegate, UNUserNotificationCenterDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        UNUserNotificationCenter.current().delegate = self
        return true
    }

    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        PushManager.shared.didRegister(deviceToken: deviceToken)
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Best-effort: the companion WebSocket covers the foreground case.
    }

    // Foreground presentation: show the banner like Android does.
    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification
    ) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse
    ) async {
        let route = PushManager.shared.route(for: response.notification.request.content.userInfo)
        PushManager.shared.onNotificationTap?(route)
    }
}
