<!-- SPDX-License-Identifier: Apache-2.0 -->

# iOS signing + APNs — founder checklist (C-13)

**Status: SOURCE-LEVEL PREPARATION ONLY.** Nothing here has been — or can
be — verified without the founder's Apple Developer credentials, a Mac
with Xcode, and a physical iPhone. No signed build exists, no APNs
round-trip has been performed, and this document does not claim either.

## What is already prepared in source

- `KriyaDotCompanion.entitlements` — `aps-environment = development`
  (Debug), `UIBackgroundModes: remote-notification` in `Info.plist`.
- `KriyaDotCompanion-Release.entitlements` — `aps-environment =
  production` for Release (select it for the Release configuration).
- `Core/PushProvider.swift` — `APNsPushProvider` protocol with
  `LiveAPNsProvider` (delegates to the existing `PushManager`) and
  `MockAPNsProvider` (offline; can never register a real device).
- `Core/PushManager.swift` — authorization request, APNs registration,
  hex token forwarding to the server's push-token endpoint
  (`tokenType: "apns"`), sealed-payload tap routing.
- `Config/Signing.xcconfig.example` — team/bundle scaffolding.
- Server side is DONE and tested: `apps/api/src/push.ts` implements the
  APNs provider (ES256 provider-token JWT from the `.p8` key, HTTP/2 to
  `api.push.apple.com` / sandbox, sealed payloads, 410 token pruning),
  and `GET /api/ios/readiness` (ios-readiness.ts) reports exactly which
  of the items below are still missing.

## Founder steps (only the account holder can do these)

1. Enroll in the Apple Developer Program; note the 10-char Team ID.
2. In Certificates, Identifiers & Profiles: confirm the App ID
   `com.kriyadot.companion` has the **Push Notifications** capability.
3. Create an APNs Auth Key (.p8) — note its Key ID. Download the `.p8`
   once (Apple will not offer it again).
4. Copy `Config/Signing.xcconfig.example` → `Config/Signing.xcconfig`,
   set `DEVELOPMENT_TEAM`, and select it in Xcode (or paste the team
   under Signing & Capabilities; signing style is already Automatic).
5. Build to a physical iPhone from Xcode; accept the notification
   permission prompt so the device registers an APNs token.
6. On the server set `APNS_KEY_ID`, `APNS_TEAM_ID`,
   `APNS_BUNDLE_ID=com.kriyadot.companion`, and `APNS_KEY_PATH` (or
   `APNS_KEY_PEM`), plus `APNS_ENV=sandbox` while using development
   builds (`production` for Release/TestFlight).
7. Verify: trigger a bot run that finishes — the phone should receive
   the sealed push; `GET /api/ios/readiness` should report every item
   ok except the manual verification line, which you close by
   observing the delivery.

## What stays blocked until then

- Any signed `.ipa` / TestFlight / App Store build.
- Real-device APNs delivery (simulators cannot receive APNs pushes).
- Confirmation that the production entitlement + production APNs env
  pair works end to end.
