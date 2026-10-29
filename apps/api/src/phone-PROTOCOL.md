<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot Remote-Phone Control — Wire Protocol v1 + Threat Model

Scope: remote view/control of the user's **own paired Android phone** from the
KriyaDot web UI (Workspace → Phone tab). There are two transport paths:

1. **Phone-app path** (primary): the `android-phone-agent` app on the phone
   streams MJPEG frames and receives input over a token-authenticated
   WebSocket at `/api/phone/ws`.
2. **ADB path** (dev fallback): no app needed; the API shells out to a local
   `adb` binary for screencap + input. Only works when the phone is attached
   to the machine running the API.

## 1. Wire protocol (JSON over WebSocket text frames)

All messages are JSON objects with a `t` (type) discriminator.

### Phone → server

| t | fields | notes |
|---|--------|-------|
| `hello` | `deviceId`, `token` | First message. `token` is the 256-bit pairing token issued at confirm time. |
| `frame` | `jpg` (base64 JPEG), `w`, `h` (px), `ts` (ms epoch) | MJPEG v1: each frame is a complete JPEG. Server relays to watchers and caches the latest. |

### Viewer (web UI) → server

| t | fields | notes |
|---|--------|-------|
| `watch` | `deviceId` | Subscribe to a device's frames. |
| `tap` | `x`, `y` | Normalized 0..1 floats. |
| `swipe` | `x1,y1,x2,y2` (0..1), `ms` (50..5000) | Drag gesture. |
| `text` | `text` (1..1024 chars) | Typed into the focused field on the phone. |
| `key` | `key`: `back` \| `home` \| `wake` | System keys. |

### Server → client

| t | fields | notes |
|---|--------|-------|
| `ok` | `sessionId?`, `v`, `online?`, `latest?` | Ack to hello/watch/input. |
| `error` | `detail` | Malformed message, auth failure, offline device, etc. |
| `frame` | `jpg`, `w`, `h`, `ts` | Relayed to watchers of the device. |
| `tap`/`swipe`/`text`/`key` | as above | Relayed to the phone (input commands). |

### Validation rules (enforced server-side, `validateMessage`)

- Unknown `t` → `{t:'error', detail:'unknown_type'}`; malformed JSON → `invalid_json`.
- Coordinates must be finite numbers in `[0,1]`; `ms` in `[50,5000]`.
- `text` must be a string of 1..1024 chars.
- `key` must be one of `back|home|wake`.
- `frame.jpg` must be base64 and ≤ 3 MB; `w`/`h` integers in `[1,4096]`.
- Input from a viewer is routed **only** to the device that viewer is
  watching, and only while that device has a live authenticated phone
  connection. Otherwise → `no_device_watched` / `device_offline`.

## 2. Pairing flow (explicit on-phone acceptance)

```
Web UI                          API                              Phone app
  |  POST /api/phone/pair/request  |                                  |
  | -----------------------------> |                                  |
  |  { pairingCode, expiresAt }    |                                  |
  | <----------------------------- |                                  |
  |  (UI shows 6-digit code +      |                                  |
  |   5-minute expiry countdown)   |                                  |
  |                                |   user types code in app, taps   |
  |                                |   "Accept" on the phone          |
  |                                |  POST /api/phone/pair/confirm    |
  |                                |  { code, deviceName, platform }  |
  |                                | ----------------------------->   |
  |                                |  { deviceId, token }             |
  |                                | <-----------------------------   |
```

- The code is random 6-digit, single-use, expires in 5 minutes; at most 3
  pending codes exist at once.
- Pairing only completes if the user physically taps **Accept** on the phone.
  The web UI cannot pair a device by itself.
- `confirm` is rate-limited: 10 attempts per IP per 10 minutes → HTTP 429.
- The token is 256 bits of `crypto.randomBytes`, handed to the phone **once**
  in the confirm response. The server stores only its SHA-256 hash
  (constant-time compare on use). Losing the token means re-pairing.

## 3. Sessions + audit

- A phone connecting with a valid `hello` opens a **control session** row
  (`sessions` table): id, device_id, started_at, frame_count, input_count;
  `ended_at` is set on disconnect.
- Every pairing event (`phone.pair_requested`, `phone.paired`,
  `phone.pair_failed`, `phone.pair_rate_limited`, `phone.unpaired`) and every
  session start/end is written to the governance audit log
  (`governance.audit(...)`), visible in the Activity tab. Phone frames are
  never logged; input events log the input *type*, not its content.
- ADB watch sessions (`POST /api/phone/adb/watch/start|end`) are audited the
  same way.

## 4. Threat model

| Threat | Mitigation |
|--------|-----------|
| Silent remote control of a phone the user never approved | Pairing requires a 6-digit code **typed and accepted on the phone itself**; the web UI alone cannot create a device. |
| Token theft (network / logs) | Token transmitted only over the WS connection; server stores SHA-256 hash only, constant-time compare. Raw token shown once. |
| Brute-forcing pairing codes | 6-digit code, single-use, 5-min expiry, max 3 pending, 10 confirm attempts / 10 min / IP. |
| Impersonating a phone on the WS | `hello` must present a valid token for a known deviceId; failures are audit-logged and the socket is closed (4401). |
| A viewer driving a *different* phone | Input routes only to the watched device; the watched device must be live and paired. No deviceId is accepted in input messages. |
| Command injection via ADB path | Device serial is validated against the **live** `adb devices` output on every call (strict `^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$`); `input text` uses a conservative alphanumeric/%s encoding — no shell string building. |
| Oversized / malformed frames crashing the hub | Frame cap 3 MB, dimension caps, JSON shape validation; binary WS frames rejected; >16 MB frames close the socket (1009). |
| Unbounded pending pairing codes | Capped at 3; expired codes are swept. |

### Production expectations (NOT yet implemented)

- **TLS**: the MVP binds to 127.0.0.1 / same-origin; any deployment that
  exposes the API on a network must terminate TLS (wss://) so tokens and
  screen frames are not in cleartext.
- The web UI has no login in the MVP — anyone who can reach the API can open
  the viewer. Pairing and control stay protected by the phone-side accept +
  token, but a viewer-auth layer should be added before multi-user use.
- Frames are MJPEG v1 (JPEG per frame, JSON base64). H.264/WebRTC would cut
  bandwidth ~10x but is out of scope for v1.

## 6. W14 extensions: phone-app actions + notification events

New-style messages use a `type` discriminator (the v1 messages above keep
their `t` discriminator).

### Server → phone

| type | fields | notes |
|------|--------|-------|
| `action` | `id`, `action`: `open_app` \| `tap` \| `type` \| `scroll` \| `send_message` \| `call`, `params` | Dispatched ONLY after governance approval of the matching `phone_*` tool call (see phone-actions.ts). `params` carries exactly the approved arguments — for `send_message`, the exact text to send. |

### Phone → server

| type | fields | notes |
|------|--------|-------|
| `action_result` | `id`, `ok`, `error?` | Ack for one `action`. The hub resolves the pending dispatch; no ack within the timeout resolves `{ok:false, error:'timeout'}`. Unknown actions must be acked with `ok:false, error:'unknown_action'`. |
| `notification` | `appPackage`, `appName?`, `title`, `ts` | Notification event for server-side triage. Title + app ONLY — notification bodies are never sent, accepted, or stored (the server validator drops any body field). |

Every dispatched action is audit-logged server-side in plain language
("Opened WhatsApp", "Sent message to \<contact name\>") — the audit holds
the action and the contact NAME, never message or typed text. While the
global pause (system-pause.ts) is active, phone tools refuse to dispatch.

## 7. ADB fallback endpoints

- `GET /api/phone/adb/status` → `{ available, devices[] }`
- `GET /api/phone/adb/:serial/frame` → one PNG screencap (base64)
- `POST /api/phone/adb/:serial/input` → `{t:'tap'|'swipe'|'text'|'key', …}` body (same validation)
- `POST /api/phone/adb/watch/start|end` → audited session rows
- ADB devices appear in `GET /api/phone/devices` with `kind: 'adb'` and id
  `adb:<serial>`. If adb is not on PATH, everything degrades to
  `available: false` / empty lists — no crash.
