<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot Companion (Android)

Remote control for your KriyaDot instance: the **phone → PC** direction of the
KriyaDot MVP. Pair once over WiFi by scanning a QR code, then monitor runs,
approve/deny pending approvals, pause/resume/cancel runs, chat with the agent,
and read the activity feed and briefing — all from your phone.

> **No compiled APK is provided in this repo.** There is no Android SDK in this
> environment, so only Kotlin source is shipped. Build it yourself in Android
> Studio (see below).

## Build

1. Open `android-companion/` in Android Studio (Hedgehog or newer).
2. Let Gradle sync; it pulls the dependencies below from Maven Central/Google.
3. Run on a physical device (API 29+, Android 10) or an emulator.
4. Build → Build APK(s). Install the APK on **your own** phone.

Requirements: `compileSdk 34`, `minSdk 29` (Android 10), `targetSdk 34`,
Java 17. UI is 100% Jetpack Compose (Material 3).

## Libraries

| Library | Version | Purpose |
|---|---|---|
| Jetpack Compose BOM + Material 3 + Navigation Compose | 2024.06.00 / 2.7.7 | UI |
| `com.journeyapps:zxing-android-embedded` | 4.3.0 | QR pairing scan — **no Google Play Services**, works on de-Googled devices |
| `com.squareup.okhttp3:okhttp` | 4.12.0 | REST client + WebSocket push channel |
| `androidx.security:security-crypto` | 1.1.0-alpha06 | EncryptedSharedPreferences for the device token |
| `org.jetbrains.kotlinx:kotlinx-coroutines-android` | 1.8.1 | Async |
| `org.json:json` | 20240303 | Lenient JSON parsing |

Zero paid APIs. No Play Services dependency anywhere.

## Permissions (rationale)

| Permission | Why |
|---|---|
| `CAMERA` | **QR pairing scan only.** Requested at runtime with an in-app rationale. Deny it and the manual host/port/token entry still works; the camera is never used for anything else. Declared `android.hardware.camera.any` as `required="false"` so camera-less devices can install. |
| `INTERNET` | REST + WebSocket to the KriyaDot instance on your LAN (`http://<lan-ip>:<port>`, `ws://…`). |
| `usesCleartextTraffic="true"` | Required because the MVP talks plain HTTP on the LAN (no TLS yet). Switch both ends to HTTPS/WSS before any use outside a trusted LAN. |

## How to pair

1. On your PC: KriyaDot Workspace → **Devices** → *Pair new phone*. A QR code appears encoding
   `kriyadot://pair?host=<lan-ip>&port=<port>&token=<ott>` (one-time token).
2. In the app: tap **Scan QR code**, point at the code (or use *Enter details manually*).
3. Confirm the server address, give the phone a name, tap **Pair**.
4. The app `POST`s `/api/companion/pairing/exchange` with `{ott, deviceName}` and
   stores the returned `{deviceToken, deviceId}` in EncryptedSharedPreferences.
   The one-time token is exchanged once and never stored.
5. Home shows server health, active runs, and pending approvals. Push updates
   arrive over `ws://<host>:<port>/api/companion/ws?token=<deviceToken>` with
   exponential-backoff reconnect (1s → 60s cap + jitter).

All subsequent calls carry `Authorization: Bearer <deviceToken>`.

## Screens

- **Home** — server health, active-run count, pending-approval count, live/reconnecting indicator.
- **Approvals** — pending list; Approve/Deny each open a confirmation dialog with an optional note.
- **Runs** — list with Pause/Resume/Cancel (cancel confirms).
- **Chat** — conversation view; sends to the web API's `POST /chat` and streams the SSE reply token-by-token.
- **Activity** — server activity feed (also under More).
- **Briefing** — latest digest (also under More).
- **More** — paired-server details, links, **Unpair** (wipes the token).

## API contract notes

The app codes against the companion contract from the server workstream:

- `GET /api/companion/status` → health + runs summary + pending-approval count
- `GET /api/companion/approvals`, `POST …/approvals/:id/approve|deny {note?}`
- `POST /api/companion/runs/:id/pause|resume|cancel`
- `GET /api/companion/activity`, `GET /api/companion/briefing`
- WS push events `{type:'run-status'|'approval'|'activity', …}` → affected lists re-fetch

Because the server workstream is being built in parallel, all JSON parsing is
**lenient** (`opt*` accessors with fallbacks): unknown or missing fields degrade
gracefully instead of crashing. Tighten the models once the server contract is frozen.

**Chat TODO:** the bot id sent to `POST /chat` is currently the placeholder
`KriyaDotApi.DEFAULT_BOT_ID = "default"` (marked `TODO(chat)` in code). No
default bot id was discoverable in the web app sources; wire it to a bot
picker (`GET /api/bots`) or a settings field once the server exposes one.

## Security notes (MVP)

- LAN-only by design: the QR carries a LAN IP; the app never talks to the internet.
- Device token is 256-bit, issued once at pairing, stored encrypted; the OTT is single-use.
- No TLS in the MVP — `usesCleartextTraffic` is set and the token travels in the
  clear on your own WiFi. Do not use on untrusted networks until HTTPS/WSS lands.
- Unpairing wipes the token from the phone. (Server-side revocation is the
  server workstream's job.)

## Files

- `app/src/main/java/com/kriyadot/companion/MainActivity.kt` — activity, QR-scan launcher, bottom-nav shell.
- `…/data/PairingStore.kt` — EncryptedSharedPreferences (host/port/token/deviceId).
- `…/data/QrParser.kt` — `kriyadot://pair` payload parsing/validation.
- `…/data/KriyaDotApi.kt` — OkHttp REST client + `POST /chat` SSE streaming.
- `…/data/CompanionSocket.kt` — WebSocket client with exponential-backoff reconnect.
- `…/data/Models.kt` — lenient contract models.
- `…/ui/CompanionViewModel.kt` — pairing state, live data, chat, socket lifecycle.
- `…/ui/` screens: `PairingScreen`, `HomeScreen`, `ApprovalsScreen`, `RunsScreen`,
  `ChatScreen`, `ActivityBriefingScreens`, `MoreScreen`, `Common` (shared scaffold), `Theme`.
- `app/src/main/AndroidManifest.xml` — CAMERA + INTERNET, cleartext for LAN HTTP.

## Hosted mode — pair over the internet

When KriyaDot runs on a hosted machine (VPS, home server), the app pairs over
the internet instead of WiFi:

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
