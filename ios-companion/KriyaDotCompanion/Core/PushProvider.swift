// SPDX-License-Identifier: Apache-2.0
import Foundation
import UIKit
import UserNotifications

/// APNs provider interface (Muse parity §4.5 C-13, source-level prep).
///
/// The push stack is split behind this protocol so the view model never
/// talks to UIKit notification APIs directly:
/// - `LiveAPNsProvider` is the production implementation: it delegates
///   to the existing `PushManager` (authorization + APNs registration +
///   token forwarding). It only works in a SIGNED build — APNs refuses
///   registration for unsigned/simulator builds, and the aps-environment
///   entitlement must match the server's APNS_ENV.
/// - `MockAPNsProvider` records requests and hands back a fixed token.
///   It exists for previews/tests and to make the credential gate
///   explicit in code: nothing in this file can produce a real APNs
///   registration without the founder's signing identity.
///
/// CREDENTIAL GATE (honest status): a signed build, a provisioning
/// profile with the Push Notifications capability, and a live APNs
/// round-trip CANNOT be produced or verified in this repo's build
/// environment (no Xcode, no Apple Developer credentials, no device).
/// See ios-companion/SIGNING.md for the exact founder steps.
protocol APNsPushProvider: AnyObject {
    /// Called with the hex APNs device token on registration + refresh.
    var onToken: ((String) -> Void)? { get set }
    /// Called with a tab route ("approvals" | "chat") on notification tap.
    var onNotificationTap: ((String) -> Void)? { get set }
    /// Ask for notification permission and, when granted, register with APNs.
    func requestAuthorizationAndRegister()
}

final class LiveAPNsProvider: APNsPushProvider {
    var onToken: ((String) -> Void)? {
        get { PushManager.shared.onToken }
        set { PushManager.shared.onToken = newValue }
    }
    var onNotificationTap: ((String) -> Void)? {
        get { PushManager.shared.onNotificationTap }
        set { PushManager.shared.onNotificationTap = newValue }
    }
    func requestAuthorizationAndRegister() {
        PushManager.shared.requestAuthorizationAndRegister()
    }
}

/// Offline stand-in: never touches APNs. `simulateRegistration()` lets
/// previews/tests exercise the token-forwarding path deterministically.
final class MockAPNsProvider: APNsPushProvider {
    var onToken: ((String) -> Void)?
    var onNotificationTap: ((String) -> Void)?
    private(set) var registrationRequests = 0
    let fixtureTokenHex = "00mock-apns-token-not-a-real-device-token00"

    func requestAuthorizationAndRegister() {
        registrationRequests += 1
        // Deliberately does NOT call onToken: a mock must never be
        // mistaken for a registered device by the server.
    }

    func simulateRegistration() {
        onToken?(fixtureTokenHex)
    }
}
