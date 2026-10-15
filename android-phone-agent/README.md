<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot Phone Agent (Android)

Companion app for KriyaDot's remote-phone control (Workspace → Phone tab).
Streams the phone screen to the KriyaDot API over a token-authenticated
WebSocket (MJPEG v1) and executes input commands (tap / swipe / text / keys)
from the web UI.

> **No compiled APK is shipped in this repo.** There is no Android SDK in this
> environment, so only source is provided. Build it yourself in Android Studio
> (see below).

## Build

1. Open `android-phone-agent/` in Android Studio (Hedgehog or newer).
2. Let Gradle sync; it pulls `androidx.core`, `okhttp`, and
   `kotlinx-coroutines` from Maven Central.
3. Run on a physical device (API 29+, Android 10) — emulators work for screen
   capture but Accessibility input needs the real service flow below.
4. Build → Build APK(s). Install the APK on **your own** phone.

## Required permissions (rationale)

| Permission | Why |
|---|---|
| `FOREGROUND_SERVICE` + `FOREGROUND_SERVICE_MEDIA_PROJECTION` | Screen capture runs as a foreground service with a persistent notification — Android requires this for MediaProjection. |
| MediaProjection (runtime consent) | The system capture dialog (`createScreenCaptureIntent()`) asks the user to allow screen sharing **every time the service starts**. No silent capture is possible. |
| `BIND_ACCESSIBILITY_SERVICE` | Input injection (tap/swipe/text/keys) goes through `InputService`, an `AccessibilityService` the user must **manually enable** in Settings → Accessibility. The app cannot enable it itself. |
| `INTERNET` | WebSocket to the KriyaDot API (`ws://<your-server>/api/phone/ws`). |

## Pairing steps

1. In the KriyaDot web UI: Workspace → Phone tab → **Pair new phone**. A
   6-digit code + expiry countdown appears.
2. In the app: enter the server URL, type the 6-digit code, tap **Pair**.
3. **Accept on the phone**: the app shows the code and asks you to confirm.
   Only after you tap *Accept* does the app send `POST /api/phone/pair/confirm`.
4. The app stores the returned `{ deviceId, token }` in EncryptedSharedPreferences.
5. Tap **Start sharing** → grant the MediaProjection dialog → the live screen
   appears in the KriyaDot web UI. Stop anytime from the notification or the app.

## Protocol

See `apps/api/src/phone-PROTOCOL.md`. Phone → server: `{t:'hello', deviceId,
token}`, then `{t:'frame', jpg, w, h, ts}`. Server → phone: `{t:'tap', x, y}`,
`{t:'swipe', x1,y1,x2,y2, ms}`, `{t:'text', text}`, `{t:'key', key}`.

## Security notes

- The token is 256-bit, issued once at pairing, stored encrypted; the server
  keeps only its SHA-256 hash.
- The app connects only to the server URL **you** type in. Use `wss://` in
  production.
- Screen capture stops the moment the service is destroyed; a persistent
  notification is always visible while sharing.

## Files

- `app/src/main/java/com/kriyadot/phoneagent/MainActivity.kt` — pairing UI (enter/show code, accept), service controls, server URL config.
- `.../ScreenCaptureService.kt` — MediaProjection → ImageReader → JPEG frames → WebSocket.
- `.../InputService.kt` — AccessibilityService: tap/swipe/text/key from server commands.
- `.../WsClient.kt` — OkHttp WebSocket wrapper (hello auth, frame send, command dispatch).
- `app/src/main/AndroidManifest.xml` — permissions + service declarations.
- `app/build.gradle.kts` — dependencies (OkHttp, coroutines, androidx).
