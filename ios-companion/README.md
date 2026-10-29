<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot Companion (iOS)

Remote control for your KriyaDot instance: the **phone → PC** direction of the
KriyaDot MVP. Pair once over WiFi by scanning a QR code, then monitor runs,
approve/deny pending approvals, pause/resume/cancel runs, chat with the agent,
and read the activity feed and briefing — all from your phone. This is the iOS
counterpart of the Android companion in `../android-companion/` and speaks the
**identical server protocol** (same endpoints, same device-token auth, same
payload shapes — see `apps/api/src/companion-PROTOCOL.md`).

> **No compiled app is provided in this repo.** This environment has no
> Xcode/macOS toolchain, so only Swift source + a hand-authored Xcode project
> are shipped. The project builds on macOS (locally in Xcode, or via the
> `iOS` GitHub Actions workflow on `macos-latest`). CI builds are **unsigned
> simulator builds** — they prove the code compiles; they cannot be installed
> on a physical iPhone without your own signing setup (see below).

## Build

Requirements: Xcode 15 or newer, iOS deployment target **16.0**, Swift 5.
Bundle id: `com.kriyadot.companion` (mirrors the Android `applicationId`).

### Xcode

1. Open `ios-companion/KriyaDotCompanion.xcodeproj` in Xcode.
2. Select the `KriyaDotCompanion` scheme and a simulator (or your iPhone).
3. To run on a physical device, set your development team under
   Signing & Capabilities (the project uses automatic signing).
4. Run (⌘R).

### Command line

```sh
xcodebuild build \
  -project ios-companion/KriyaDotCompanion.xcodeproj \
  -scheme KriyaDotCompanion \
  -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO
```

### CI

`.github/workflows/ios.yml` runs the same unsigned simulator build on
`macos-latest` for pushes to `main` touching `ios-companion/**` (and on
manual dispatch), uploading the `.app` bundle as the
`kriyadot-companion-ios-debug` artifact plus the build log.

## Libraries

None beyond the Apple SDK — zero third-party dependencies, zero paid APIs.

| Framework | Purpose |
|---|---|
| SwiftUI | UI (tab shell mirroring the Android bottom navigation) |
| AVFoundation | QR pairing scan (`AVCaptureSession` + QR metadata) — camera used for nothing else |
| Security | Keychain storage for the device token (Android: EncryptedSharedPreferences) |
| Foundation `URLSession` | REST client (async/await) + SSE chat streaming |
| Foundation `URLSessionWebSocketTask` | Companion push socket + remote-screen frame channel |
| CryptoKit | AES-256-GCM decryption of sealed push payloads |
| UserNotifications / UIKit | APNs registration + notification-tap routing |

## Permissions (rationale)

| Permission | Why |
|---|---|
| Camera (`NSCameraUsageDescription`) | **QR pairing scan only.** iOS shows the system prompt; deny it and the manual host/port/token entry still works. |
| Local Network (`NSLocalNetworkUsageDescription`, `NSAllowsLocalNetworking`) | The MVP talks plain HTTP on the LAN (`http://<lan-ip>:<port>`, `ws://…`). ATS is relaxed **only for local networking**; hosted mode uses full HTTPS/WSS. Switch both ends to TLS before any use outside a trusted LAN. |
| Notifications | "Done" / "needs you" alerts (see Push below). The app works without it via the WebSocket while foregrounded. |
| Push (`aps-environment` entitlement, `remote-notification` background mode) | APNs registration; delivery depends on server support — see Push. |

## How to pair

Identical to Android:

1. On your PC: KriyaDot Workspace → **Devices** → *Pair new phone*. A QR code appears encoding
   `kriyadot://pair?host=<lan-ip>&port=<port>&token=<ott>` (one-time token).
2. In the app: tap **Scan QR code**, point at the code (or use *Enter details manually*).
3. Confirm the server address, give the phone a name, tap **Pair**.
4. The app `POST`s `/api/companion/pairing/exchange` with `{ott, deviceName, platform: "ios"}` and
   stores the returned `{deviceToken, deviceId}` (and the `pushKey`) in the
   **Keychain**. The one-time token is exchanged once and never stored.
5. Home shows server health, active runs, and pending approvals. Push updates
   arrive over `ws://<host>:<port>/api/companion/ws?token=<deviceToken>` —
   the client sends `{t:'hello'}` first, per protocol §5 — with
   exponential-backoff reconnect (1s → 60s cap + jitter).

All subsequent calls carry `Authorization: Bearer <deviceToken>`.

## Screens

- **Home** — server health, active-run count, pending-approval count, live/reconnecting indicator.
- **Approvals** — pending list; Approve/Deny each open a confirmation sheet with an optional note.
- **Runs** — list with Pause/Resume/Cancel (cancel confirms).
- **Chat** — conversation view with a bot picker (roster from `GET /api/companion/bots`,
  selection persisted, sent as `botId`); sends to `POST /api/chat` and streams the SSE reply token-by-token.
- **Activity** — server activity feed (under More).
- **Briefing** — latest digest (under More).
- **More** — paired-server details, links, **Unpair** (wipes the token from the Keychain).

## API contract notes

The app codes against the same companion contract as Android:

- `GET /api/companion/status` → health + runs summary + pending-approval count
- `GET /api/companion/approvals`, `POST …/approvals/:id/approve|deny {note?}`
- `GET /api/companion/runs`, `POST …/runs/:id/pause|resume|cancel`
- `GET /api/companion/activity`, `GET /api/companion/briefing`
- `GET /api/companion/bots` → bot roster for the chat picker
- WS push events `{type:'run-status'|'approval'|'activity', …}` → affected lists re-fetch
- Auth failures on the push socket (4401 close / in-band `auth_failed`) stop
  reconnecting and surface a "re-pair required" state, exactly like Android.

All JSON parsing is **lenient** (opt*-style accessors with fallbacks, mirroring
`Models.kt`): unknown or missing fields degrade gracefully instead of failing.

## Security notes (MVP)

- LAN-only by design in LAN mode: the QR carries a LAN IP.
- Device token is 256-bit, issued once at pairing, stored in the Keychain
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`); the OTT is single-use.
- No TLS in LAN MVP mode — the token travels in the clear on your own WiFi.
  Do not use on untrusted networks until HTTPS/WSS lands. Hosted mode (below)
  is TLS end-to-end.
- Unpairing wipes the token from the phone. (Server-side revocation is the
  server workstream's job.)

## Push notifications ("done" / "needs you") — APNs status

The Android app receives FCM data messages whose title/body are sealed with
AES-256-GCM under a per-device key issued at pairing, decrypted locally.

**What the iOS app implements (client side, complete):**

- Permission request flow (`UNUserNotificationCenter`), APNs registration via
  `UIApplication.registerForRemoteNotifications`, and token-refresh handling
  (the app delegate forwards every APNs token to the view model).
- Registration with the server through the **same endpoint Android uses** —
  `POST /api/companion/devices/:id/fcm-token` — adapted for Apple:
  the body is `{token, tokenType: "apns", platform: "ios", apnsToken}`.
  Registration is best-effort; failures are swallowed and the WebSocket
  covers the foreground case.
- Notification-tap routing: `needsInput` → Approvals, otherwise → Chat
  (same mapping as Android).
- `SealedPush.swift` decrypts the sealed payload format with CryptoKit, so
  the moment APNs delivery exists, private content renders locally exactly
  like on Android.

**What does NOT exist yet (server side — not faked here):**

- The server's registration route only reads `fcmToken`
  (`apps/api/src/companion-routes.ts`), and `PushService`
  (`apps/api/src/push.ts`) only sends through FCM. **There is no APNs send
  path on the server today**, so iOS pushes will not arrive until the
  server workstream adds one.

**Server contract needed to light up APNs:**

1. Extend `POST /api/companion/devices/:id/fcm-token` (or add a sibling
   `…/push-token` route) to accept `{token, tokenType: "apns"}` and store it
   separately from the FCM token, keyed by the same device id.
2. Add an APNs provider to `PushService` (HTTP/2 to
   `api.push.apple.com`, token-based `.p8` auth or certificate auth —
   credentials via environment, never committed) that sends, per device,
   the same routing fields FCM carries (`kind`, `botId`, `chatId`,
   `approvalId`, `fallbackTitle`, `fallbackBody`, `sealed`) as custom keys
   alongside the `aps` dictionary.
3. Honor the same per-bot prefs (`all` / `approvals` / `none`).

## Remote screen

More → Remote screen watches the paired PC's live screen.
Tapping Start asks the PC to share (`POST /api/remote-screen/start`); the PC
owner must approve the "Allow screen sharing?" card in the KriyaDot web UI
before any frame flows, and a red banner on the PC shows while sharing is
active. The app polls `GET /api/remote-screen/session/:id`, then opens the
frame WebSocket (`/api/remote-screen/ws?sessionId=…&token=…`): base64 PNG
frames at ~4 fps, view-only, with pinch-to-zoom (`MagnificationGesture`,
1x–6x, pan while zoomed). Leaving the screen stops the session
(`POST /api/remote-screen/stop`); sessions also stop automatically after
30 minutes on the server. Rotation does not stop the session — the view
stays on the navigation stack, mirroring Android's rotation-safe behavior.

Server setup: `npm install screenshot-desktop` where the KriyaDot API runs
(optional dependency, loaded lazily). Without it the app shows a clear
"screen capture unavailable" error. For development without a display, set
`REMOTE_SCREEN_MOCK=1` on the server for a labeled test-pattern feed.

## Files

- `KriyaDotCompanion/KriyaDotCompanionApp.swift` — SwiftUI app entry (+ app delegate adaptor for APNs).
- `KriyaDotCompanion/Core/Models.swift` — lenient contract models (field-for-field with Android's `Models.kt`).
- `KriyaDotCompanion/Core/QrParser.swift` — `kriyadot://pair` payload parsing/validation.
- `KriyaDotCompanion/Core/KeychainStore.swift` — Keychain wrapper + `PairingStore` (host/port/token/deviceId/pushKey).
- `KriyaDotCompanion/Core/KriyaDotAPI.swift` — REST client (URLSession, async/await) + `POST /api/chat` SSE streaming.
- `KriyaDotCompanion/Core/CompanionSocket.swift` — WebSocket push client with exponential-backoff reconnect + auth-failure stop.
- `KriyaDotCompanion/Core/RemoteScreenSocket.swift` — remote-screen frame channel.
- `KriyaDotCompanion/Core/SealedPush.swift` — AES-256-GCM sealed-push decryption (CryptoKit).
- `KriyaDotCompanion/Core/PushManager.swift` — APNs registration hooks + app delegate + tap routing.
- `KriyaDotCompanion/UI/CompanionViewModel.swift` — pairing state, live data, chat, socket + screen-share lifecycle.
- `KriyaDotCompanion/UI/` screens: `RootView` (tab shell), `PairingView`, `QRScannerView`,
  `HomeView`, `ApprovalsView`, `RunsView`, `ChatView`, `ActivityBriefingViews`,
  `MoreView`, `RemoteScreenView`, `CommonViews` (shared helpers), `Theme`.
- `KriyaDotCompanion/Info.plist` — camera/local-network rationale, LAN ATS exception, background modes.
- `KriyaDotCompanion/KriyaDotCompanion.entitlements` — `aps-environment` (development).
- `KriyaDotCompanion.xcodeproj/` — hand-authored project (object version 56, Xcode 14 format).

## Hosted mode — pair over the internet

When KriyaDot runs on a hosted machine (VPS, home server), the app pairs over
the internet instead of WiFi — identical to Android:

1. The server owner puts the API behind a reverse proxy with TLS and starts
   it with `KRIYADOT_PUBLIC_URL=https://kriyadot.example.com` (see
   `apps/api/src/companion-PROTOCOL.md` §9 for the nginx config).
2. In Workspace → Devices the QR then encodes
   `kriyadot://pair?url=https://kriyadot.example.com&token=<ott>` — scan it as
   usual, and the app connects to the public URL (REST over https, push
   socket over wss).
3. No QR handy? Tap **Enter details manually** → **Hosted**, type the server
   URL (`https://…`) and the pairing code shown in Workspace → Devices
   (*Generate pairing code*), then pair.

The Home screen's connection line shows which server the app is attached to
(URL in hosted mode, `host:port` on LAN). Pairing, device tokens and the push
channel work identically in both modes — only the transport address changes.
Never pair with a server you don't trust: a paired phone can approve tool
calls and drive chat sessions on that KriyaDot instance.

## Honest limitations

- **Unsigned CI build**: the workflow builds for the iOS Simulator with
  `CODE_SIGNING_ALLOWED=NO`. Installing on a real iPhone requires your Apple
  ID / development team in Xcode signing settings.
- **App icon**: the asset catalog carries the full size table with no pixel
  artwork yet — add a 1024×1024 marketing icon (and per-size renders or a
  single-size icon set) before any App Store submission.
- **APNs delivery**: client-complete, server-pending (see Push above).
- **Not compiled in the authoring environment**: this tree was written and
  consistency-checked on Linux (file-reference checks, plist/XML validity,
  endpoint-parity diff against the Android client). The first `macos-latest`
  CI run is the first real compile.
