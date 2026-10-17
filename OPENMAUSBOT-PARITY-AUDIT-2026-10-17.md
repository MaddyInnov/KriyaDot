# OpenMausBot Parity Audit — Fresh Pass (2026-10-17)

> Source: subagent re-audit report delivered 2026-10-17 (worker handoff). The worker's full
> write-up at /tmp/omb-parity-audit-fresh.md was lost to /tmp eviction; this file preserves the
> verified summary. The per-feature table should be regenerated if needed.

- **OpenMausBot audited**: fresh clone of `milind-soni/OpenMausBot`, commit `988e15ce`
  (2026-10-17 11:18:47 +0530), cloned to `/tmp/omb-fresh` (read-only reference; no code copied).
- **KriyaDot source**: current `.../all-in-one-ai-agent-saas-platform/mvp/`, every claimed
  feature spot-checked in source (routes, packages, web UI, CLI); generated blobs excluded.
- **Prior baseline**: 45 present / 77 partial / 142 missing (264 features, OMB v0.1.113) — now stale.

## Updated counts: 81 Present / 27 Partial / 45 Missing

Counted over 153 OpenMausBot user-facing features (+1 N/A: MausBot Cloud Pro, a commercial
offering). All earlier parity builds were verified actually present in source.

## Top 15 gaps (ranked by importance) — status after this round

1. **BotMRR markdown team import** — MISSING → **BUILT** (G1: import/export markdown team specs)
2. **Real Jev decision classifier** — KriyaDot uses deterministic heuristics → **honest upgrade**
   (G11: RouterDecisionLog, tunable weights, agreement stats, no ML claims)
3. **iOS companion app** — MISSING → **DEFERRED** (too large for this round)
4. **Org library + preset bots** — team-sharing ecosystem pieces (partially covered by
   team-sharing manifest + BotMRR markdown import/export)
5. **Bot context-menu management** — MISSING → **BUILT** (G2: pin/unread/duplicate/hide/copy ID)
6. **Memory upkeep suite** — MISSING → **BUILT** (G3: background capture, nightly tidy,
   about-me profile, undoable journal)
7. **Automatic crash recovery** — MISSING → **BUILT** (G4: boot reconciliation + orphan resume)
8. **TTS provider breadth** — Partial (mock/groq/openai only; no ElevenLabs/Fish/Chatterbox/Mac
   voices) — **still partial**
9. **CLI `team apply`/`team export` + `serve`** — MISSING → **BUILT** (G5 + W1)
10. **Channel richness** — Partial → **BUILT** (G6: per-channel instructions/working folder/
    responder rules)
11. **Sentinel health scanner** — MISSING → **BUILT** (G7)
12. **In-app account sign-in (Antigravity)** — MISSING → **BUILT** (G8: `agy` OAuth walkthrough
    flow mirroring the claude/codex pattern; tokens stay in the OS keyring)
13. **Profile/credential proposal cards** — MISSING → **BUILT** (G9: `request_credential` →
    approval-style card → SecureVault)
14. **Guarded external messages** — MISSING → **BUILT** (G10: relayed flag + onBehalfOf ledger;
    relayed approvals fail closed)
15. **Desktop app maturity** — Tauri shell was a minimal stub → **BUILT** (G12: tray icon/menu,
    API-server health probe + one-click restart) — **CI must run `cargo check` (no Rust
    toolchain in this environment)**

Also closed: CLI `routines runs`, CLI `threads delete`, `clearSessionCircuitState` wired to
thread/session deletion.

## Deliberately not chased

- MausBot Cloud Pro (commercial offering — N/A)
- Boat cloud (docker surface is the functional equivalent)
- Mascots / bidi text / Cua re-implementation
- iOS companion app (deferred, too large)

## Where KriyaDot exceeds OpenMausBot

TUI, multi-tenancy package, red-team suite, n8n workflows, terminal access, notes+tasks,
document extract, Notion import, cost-breakdown dashboard, live catastrophic kill-switch
(not just a denylist), MCP server over stdio+HTTP+SSE, approval-gated remote screen,
Claude/Codex session import, group goals with routine-as-goal, global+per-bot spend caps.

## Honesty caveats

- The Grok CLI engine is wired but its flags are marked best-effort/unverified in source
  comments.
- "Jev equivalent" no longer overclaims: the routing UI states deterministic-heuristics
  truth explicitly; accuracy is only measured over user-judged decisions (labeled agreement).
