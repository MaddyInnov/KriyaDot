<!-- SPDX-License-Identifier: Apache-2.0 -->
# Workstream D — Protocols, Voice, Computer Use: founder input needed

Phase 4, Workstream D shipped interop protocols (A2A, AG-UI, MCP Tasks),
voice (STT/TTS), and sandboxed computer-use tooling with **everything
mocked** (zero paid usage in testing). This doc is the split the founder
asked for: what YOU must provide for production vs. what is already mocked
and ready.

## What the founder must provide (real, production)

### 1. Real STT / TTS provider keys (env vars only)
The MVP ships `MockSTTProvider` / `MockTTSProvider` only
(`packages/voice/src/voice.ts`): transcription returns canned deterministic
text, synthesis returns a short WAV tone — **no real speech, no network, no
cost**. Provider selection is env-driven:

- `VOICE_STT_PROVIDER` — default `mock`. Any other id currently throws a
  clear error ("unknown STT provider") until the integrator wires a real one.
- `VOICE_TTS_PROVIDER` — default `mock`, same contract.

To go live with a real provider (e.g. Deepgram/Whisper for STT,
ElevenLabs/Cartesia for TTS), you must:
- Create the provider account and generate an API key.
- Provide the key as an **env var only** — never hardcoded, never committed.
  Suggested names: `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`,
  `ELEVENLABS_API_KEY` (pick per provider; the real provider
  implementation reads them from `process.env`).
- Implement the `STTProvider` / `TTSProvider` interfaces
  (`packages/voice/src/voice.ts`) for that provider and register the new id
  in `selectSTTProvider()` / `selectTTSProvider()`. The route shapes
  (`POST /api/voice/stt`, `POST /api/voice/tts`, `GET /api/voice/providers`)
  and the `VoiceControls` web component do not change.
- Expected spend: STT ~$0.004–0.01/min, TTS ~$15–30 per 1M chars, depending
  on provider/tier. The mocks keep costing $0 until you flip the env vars.

### 2. OS-access permissions for computer use (per deployment target)
Computer use ships with `MockOSScreenLayer` only
(`packages/agent-runtime/src/tools/computer.ts`): calls are **recorded**,
never executed; screenshots return a fixture PNG. Mutating actions
(`computer_click`, `computer_type`, `computer_key`, `computer_scroll`,
`computer_drag`, `computer_move`) are **approval-gated by
policy** (`computerUsePolicyRules()` → `require-approval`) and validation
hardened (click bounds, key allowlist, type length cap) — none of that
changes when you swap the OS layer.

To drive a real screen, you must BOTH:
- Inject a real `OSScreenLayer` implementation (robotjs, nut.js, or a
  platform accessibility API) where the integrator constructs the tools —
  `registerComputerUseTool(registry, { os: new RealOSScreenLayer() })`.
  The default remains the mock, so this is an explicit opt-in.
- Grant the OS-level permissions the deployment target requires, and run
  computer use **only inside a sandboxed session** (dedicated VM/container
  or explicit user-consent screenshare — never the founder's primary
  desktop unattended):
  - **macOS:** System Settings → Privacy & Security → Accessibility (and
    Screen Recording for screenshots) for the node process / app bundle.
  - **Linux:** X11 (XTEST) or Wayland compositor remote-desktop portal
    approval; headless servers need Xvfb or equivalent.
  - **Windows:** UIAccess / administrator integrity for cross-integrity
    input; standard users get same-integrity targets only.
- Never weaken the approval gate: the `computer-use-require-approval`
  policy rule must stay `require-approval` in production. Deny-by-default
  still applies to everything unmatched.

### 3. Telephony — N/A
Voice here is browser mic/speaker + STT/TTS only. There is **no telephony
dialer, no PSTN/SIP, no phone numbers** in this workstream — nothing to
provision, no DLT/TRAI considerations arise from it.

## Already mocked and ready (no founder action)
- A2A agent-to-agent: agent card model, JSON-RPC `message/send` /
  `tasks/get` / `tasks/cancel`, submitted→working→completed/failed/canceled
  lifecycle, in-memory transport, `MockA2APeer` for round-trip tests.
- AG-UI agent-to-UI: event schema (text deltas, tool-call lifecycle, state
  snapshots/deltas, custom widget payloads), `AGUIEmitter` server-side,
  `GET /api/protocols/agui/stream` SSE endpoint, runtime `StreamEvent`
  bridge for the integrator.
- MCP Tasks: `mcp:<server>:tasks_create|tasks_status|tasks_cancel|tasks_result`
  tools following the repo's MCP naming/registry conventions, `MCPTaskManager`
  client, in-memory mock server for tests.
- Voice routes: `GET /api/voice/providers`, `POST /api/voice/stt`,
  `POST /api/voice/tts` — all served by mocks today.
- Protocol routes: `GET /api/protocols/agent-card`, `POST /api/protocols/a2a`,
  `GET /api/protocols/agui/stream` (plus the `/.well-known/agent-card.json`
  mount snippet in `apps/api/src/protocols.ts` for spec-correct discovery).
- Web: `apps/web/components/voice-controls.tsx` — mic (Web Speech API with
  MediaRecorder→`/api/voice/stt` fallback) + speaker (`/api/voice/tts`).

## Founder checklist (copy into your tracker)
- [ ] Choose STT provider → account + key → env var
- [ ] Choose TTS provider → account + key → env var
- [ ] Approve OS target + permission grants for computer use (sandboxed VM/container only)
- [ ] Confirm the `computer-use-require-approval` policy rule stays `require-approval` in prod
- [ ] Telephony: none — no action
