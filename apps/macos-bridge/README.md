<!-- SPDX-License-Identifier: Apache-2.0 -->

# KriyaDot macOS Bridge (Wave-6, DV-8) — SOURCE-LEVEL ONLY

**Status: unverified.** There is no Swift toolchain and no Apple
hardware on the build VM, so this package has **never been compiled
or run**. It is a source-level skeleton implementing the user's DV-8
decision (build a macOS bridge like the iOS companion) and must be
built and shaken out on a real Mac before the feature can be claimed
as working.

## What it is

A small Swift package that gives the KriyaDot API read/send access to
the user's **own** Messages (iMessage/SMS relay) and Mail apps on
their Mac, behind the same channel interfaces the Android phone-agent
already implements (`MessageChannel` / `MailChannel` in
`Sources/MacBridgeCore/ChannelProtocols.swift`, with the Android
`{ address, body, date, type }` message shape).

- `Sources/MacBridgeCore/AppleScriptRunner.swift` — talks to the apps
  via `/usr/bin/osascript`. AppleScript is used (not chat.db) because
  chat.db needs Full Disk Access and a private schema; scripting is
  gated by the user's Automation consent, and a missing consent maps
  to the stable error code `automation_not_granted`.
- `Sources/MacBridgeCore/MessagesChannel.swift` /
  `MailChannel.swift` — `recent` / `thread` / `body` reads + `send`.
- `Sources/KriyaDotMacBridge/main.swift` — executable skeleton:
  newline-delimited JSON on stdin/stdout (same discipline as the
  phone hub's data_query frames). It must only ever be driven by the
  local API over pipes — never exposed on a network port.

## Governance

Sends are actuations. The bridge holds no approval logic of its own:
the API must obtain a governance approval before dispatching any
`send` op, exactly as it does for the Android `phone_sms_send`
action. Reads follow the phone data-tool pattern (approval-gated
tools on the API side).

## What a Mac session must still do

1. `swift build` and fix whatever the compiler / scripting
   dictionaries reject (Messages' `direction`/`text of message`
   accessors are the likeliest friction points).
2. Grant Automation consent for Messages and Mail on first run and
   confirm the `automation_not_granted` mapping.
3. Sign the executable (ad-hoc is enough for personal use) and wire
   the API-side local-process adapter described in the wave-6 wiring
   note (`hidden_files/wave6-network-health-WIRING.md`).
