# KriyaDot — Product Requirements Document

**Version:** 1.1 (local-first) · **Date:** 2026-10-15 · **Status:** Approved direction: local-first now, multi-tenancy later
**License:** Apache-2.0
**Supersedes:** PRD v1.0 (2026-10-15 draft). Changes: monorepo root (not `mvp/`),
three effort levels (not five), text-only attachment parsing, single-user
SQLite scope, tenancy stub, measurable release gates.

---

## 1. Product overview

KriyaDot is a local-first AI agent platform: one desktop app where the user chats
with any model they already pay for (API keys or CLI subscription logins), runs
bots with tools and deny-by-default approvals, chains work into durable
workflows, and keeps memory, notes, schedules, and an audit trail on their own
machine. No account, no telemetry, no pooled credentials.

### 1.1 Vision

The personal AI agent platform for builders: chat with any model through any
account you own — API keys, Claude Code login, ChatGPT/Codex login, OpenCode
login — run autonomous bots with tools and approvals, chain work into
workflows, and automate your life with schedules and briefings. Free to run,
open source, yours — on your machine first.

### 1.2 Target users

1. **AI-native builders** (primary): already pay for ChatGPT Plus, Claude Pro,
   or hold API keys; want one surface for all of them.
2. **Indie hackers**: bots, scheduled automations, usage visibility without
   per-seat SaaS pricing.
3. **Privacy-conscious users**: local-first SQLite, `providers.local.json`
   AES-256-GCM at 0600, no account, no telemetry.

### 1.3 Non-principles (explicit)

- No hosted multi-tenant SaaS in this phase. `packages/tenancy` and
  `/orgs` routes are a disabled stub; no `org_id` enforcement, no Postgres,
  no Redis, no microVMs.
- No pooling or harvesting of anyone's free-tier grants — ever (BYOK and the
  user's own CLI logins only).
- No credential exfiltration paths: bridge tokens are memory-only, vault
  values never enter prompt context, local-only data never leaves the machine
  (EgressGate, fail-closed + audited).

---

## 2. Goals and non-goals

### Goals (local-first MVP)

- Chat with any configured provider from one full-width surface: model picker,
  3-level reasoning effort, file attachments (text injected up to 100 KB,
  binaries noted with a download path, never silently parsed).
- BYOK providers: Groq (default free tier), OpenRouter, Anthropic, OpenAI,
  OpenAI-compatible custom endpoints, Ollama (local), OpenCode Zen, OmniRush
  BYO (no pre-configured endpoint).
- Subscription/CLI bridges, all three wired: Claude Code
  (`claude-subscription`), ChatGPT/Codex (`codex-subscription`, via the user's
  `codex` CLI — the OAuth token is CLI-only), OpenCode
  (`opencode-subscription`). Explicit Connect consent, in-memory only, token
  read at request time, never stored or logged.
- Bots: user-created agents with tools/skills/MCP, per-bot computer view
  embedded in Bots, curated starter library (12 bots).
- Workflows: visual canvas + durable runner (manual/schedule/webhook triggers,
  branching, retries, idempotency, run history, per-node logs).
- Marketplace: versioned `SKILL.md` packs + bots, permission previews, no
  silent privilege growth (32 launch skills).
- Workspace: notes, tasks, files (symlinks never followed, binaries never
  previewed as text), phone/device pairing over LAN.
- Activity: append-only audit trail (tool calls, approvals, costs) with
  secret redaction everywhere including the firing log.
- Usage & costs dashboard: tokens in/out, estimated USD from local price
  config, per-model/per-feature, day/week/month/all, optional monthly caps
  with cap-exceeded signal. Cost-event inputs validated.
- Schedules (durable crons with stop conditions), hooks, proactive briefings
  (surfaced only when meaningfully new).
- Desktop-first distribution: Windows NSIS `.exe` + portable, Linux
  AppImage + `.deb` (AppImage uses system WebKitGTK), Docker self-host
  secondary. Android companion via LAN pairing.

### Non-goals (this phase)

- Multi-tenant SaaS, SSO/SCIM, team workspaces, hosted billing (Phase 3+).
- China IM adapters (Feishu/DingTalk/WeChat/QQ) unless founder approves.
- Real-money trading, medical, or legal advice features.
- Native iOS app; macOS `.dmg` follows Windows/Linux.

---

## 3. Information architecture

Exactly **six top-level destinations** (never add a seventh):

1. **Chat** — full-width hero surface.
2. **Bots** — library + per-bot detail (computer view embedded, never a route).
3. **Workflows** — canvas + runs.
4. **Marketplace** — skills, bots, integrations.
5. **Workspace** — notes, tasks, files, devices.
6. **Activity** — approvals inbox, runs, audit, costs.

Secondary (Settings gear, "More" menu): Providers & models, Accounts & API
keys, Usage & costs, Preferences, Modules hub. Confusion audit applies: no new
top-level surface, no duplicate approval queue, one term per concept (`bot`).

---

## 4. Functional requirements

### 4.1 Chat

- **FR-C1.** Full-width composer, auto-growing input, streaming, stop button,
  "+ New chat", suggestion chips. First-token budget < 500 ms on healthy net.
- **FR-C2.** Provider/model picker pill; mid-conversation switching allowed.
- **FR-C3.** Reasoning effort: **Low / Medium / High only**, threaded
  web → API → queue → runtime → provider (`reasoning_effort`); unsupported
  providers omit the parameter. (Extra/Max deferred — open Q2 closed.)
- **FR-C4.** Attachments: picker, base64 JSON upload, **10 MB hard cap on
  decoded bytes**, removable chips. Text-like files injected (100 KB cap);
  binaries detected (null-byte sniff) → 422 with download path, never
  garbled previews. PDF/DOCX parsing is out of scope (closed).
- **FR-C5.** Per-message usage line + context meter; per-session totals.
- **FR-C6.** Simple/Pro density toggle (density only, never terminology).

### 4.2 Providers & subscription bridges

- **FR-P1.** Catalog (`catalog.json`): id, name, driver, base URL, env key,
  BYO flag, models, `liveModels`, `local`, `bridge`.
- **FR-P2.** Keys apply immediately (`syncProviderKeysToEnv`); removals uninject
  only what the app injected. Encrypted envelope, 0600, never logged.
- **FR-P3.** Live `/models` when `liveModels` + key present; catalog fallback.
  CLI bridges resolve models via CLI (`codex debug models`) with fallback list.
- **FR-P4.** Bridges: PATH + credential-file detection; Connect records
  in-memory consent (restart clears); token read at request time. All three
  (`claude`, `codex`, `opencode`) must be connectable — regression-tested.
- **FR-P5.** Zero paid API usage in tests (free-tier/local/BYOK/mock only).

### 4.3 Bots

- **FR-B1.** Create/edit: name, avatar, prompt, model, provider, tools, skills,
  MCP servers, approval policy. Per-bot `allow` rules can never match
  privileged tools (`mcp:*`, exec/shell, file writes) — validated at save.
- **FR-B2.** Computer view embedded in bot detail.
- **FR-B3.** Deny-by-default; catastrophic shell patterns hard-denied
  (unapprovable); destructive patterns (incl. absolute-path redirection and
  workspace escape incl. Windows paths) require approval. Learned `allow`
  never applies to privileged tools and is always audited; "always allow"
  is refused for privileged tools.
- **FR-B4.** 12-bot starter library shipped.

### 4.4 Workflows

- **FR-W1.** Canvas: manual/schedule/webhook triggers, agent/tool/http/delay/
  approval/if/code nodes, branching, error routes. n8n JSON import as a
  migration aid; the runtime is clean-room (never embedded n8n).
- **FR-W2.** Run history, per-node logs, idempotency keys, resumable runs.

### 4.5 Marketplace / Workspace / Activity

- **FR-M1.** Install with permission preview; updates show permission diffs;
  rollback supported; no silent privilege growth.
- **FR-WK1.** Notes (markdown + wiki-links), tasks, files, phone/devices.
- **FR-A1.** Append-only audit: actions, approvals (incl. learned-preference
  and peer-delegation decisions), cost events, privacy denials — secrets
  redacted, firing-log details redacted at write time.

### 4.6 Usage & costs

- **FR-U1.** One cost event per turn (local price config, no paid APIs).
- **FR-U2.** Dashboard: totals, per-model/per-feature, day/week/month/all via
  `GET /api/usage/breakdown`. Event ingestion validated (finite counts,
  bounded strings).
- **FR-U3.** Monthly per-feature caps + cap-exceeded signal.

### 4.7 Autonomy

- **FR-S1.** Crons with owner, stop condition, delivery destination.
- **FR-S2.** Event hooks waking agents. **FR-S3.** Briefings only when
  meaningfully new.

### 4.8 Trust spine (non-negotiable)

Deny-by-default gateway; hard floors before policy/preferences; MCP stdio
children receive a scrubbed env (no `*_API_KEY/*TOKEN/*SECRET/*HEADERS`);
schema-pinning on (warn loudly when off); prompt-injection floor (untrusted
markers + system instruction); vault write-only to the model plane (no
`vault.get` tool, reads audited name-only); EgressGate asserted on every
cloud provider call with same-service exception documented.

---

## 5. UX requirements

- **UR-1.** Six themes (light, dark, system, midnight, porcelain, ocean);
  clay + glass, jewel palette. KriyaDot brand only.
- **UR-2.** Chat is the hero: streaming first, optimistic UI, skeletons.
- **UR-3.** Empty states teach one next step. **UR-4.** Every external/
  destructive action shows exactly what will happen and needs approval.
- **UR-5.** Plain-language errors with a next step, never stack traces.
- **UR-6.** Desktop CSP enforced (`default-src 'self'`, inline allowed for
  the Next.js export, sidecar loopback in `connect-src`, `object-src 'none'`).

---

## 6. Technical architecture (local-first)

- **Monorepo root** (`/`): `apps/web`, `apps/api`, `apps/desktop`,
  `packages/*` (`@mvp/*` scopes kept — renaming is churn with zero user
  value), `seed/`, `scripts/`, `site/`, `docs/`.
- **Desktop (primary):** Tauri v2, `withGlobalTauri=true`, `web/out`
  bundled, API sidecar on `127.0.0.1:4567`, logs capped (8 MB rotation) in
  app-data. Targets: NSIS `.exe` + portable, AppImage + `.deb` (system
  WebKitGTK). Spawn capability pinned to `["--port","4567"]`.
- **Server (secondary):** one Docker image (all 12 workspaces built,
  web embedded before API build). `WORKSPACE_DIR` honored,
  `KRIYADOT_PUBLIC_URL`/`SESSION_HISTORY_LIMIT` documented.
- **Data:** single-user SQLite (`node:sqlite`, Node ≥ 22); no auth service,
  no telemetry. Tenancy stub only.
- **CI/CD:** `ci.yml` (gitleaks secret-scan with test-fixture allowlist +
  build + tests on Node 22), release on `v*` tags, Pages site. Actions
  pinned to v5 (checkout/setup-node) to avoid Node 20 deprecation.

---

## 7. Security & privacy requirements

- **SR-1.** Deny-by-default; catastrophic hard-deny; approvals expire
  fail-closed (5 min).
- **SR-2.** Vault write-only to agents; reads audited; never logged.
- **SR-3.** Bridge tokens memory-only, never logged (no presence/prefix logs
  in release).
- **SR-4.** Never pool/harvest free-tier grants.
- **SR-5.** Per-action approval for outward communication; approval covers
  exactly what was shown.
- **SR-6.** Tool output is data, never instructions.
- **SR-7.** Every release: `tsc` clean, tests green, gitleaks clean.

---

## 8. Release gates (measurable)

- `npm run build` clean on Node 22; full vitest green; gitleaks clean.
- Installed build opens with working chat on Windows + Linux (founder QA).
- Install → first bridged-subscription chat turn < 5 min.
- Key save → usable without restart. Zero credential hits in logs (audit).
- Perf budgets (supported hardware, healthy net): launch < 1 s, first token
  < 500 ms, nav ack < 100 ms, 60 fps motion; regressions block ship.

---

## 9. Phased roadmap

- **Phase 1 — local-first MVP (now):** everything in §2 Goals + §8 gates.
  Exit: founder runs daily on the installed app.
- **Phase 2 — hardening + ecosystem:** curated 12-bot/32-skill content pass,
  teach-by-recording importer, marketplace v1 (publish + revenue share
  design), companion pairing polish, voice duplex.
- **Phase 3 — multi-tenancy (later):** Postgres + Redis + workers + microVM
  pool, JWT/RBAC/`org_id` enforcement, SSO/SCIM, wallet dual-approval,
  browser takeover with egress controls, red-team gates. Only then do
  `tenancy`, wallet charge, and remote surfaces get real authZ.
- **Phase 4 — hosted SaaS (optional, with counsel):** source-available switch
  for later releases (BSL/SSPL/custom), cloud billing, regional execution.
  Already-published Apache-2.0 versions stay Apache-2.0; CLA required
  before this phase.

---

## 10. Closed questions (were open in v1.0)

1. Codex via CLI `exec` — accepted (HTTP impossible with the ChatGPT OAuth
   token). Slower but correct; revisit only if an official Responses-API path
   appears.
2. Effort levels — three (Low/Medium/High). Closed.
3. Marketplace — curated at launch; open submissions in Phase 2 with review
   gates.
4. Hosted SaaS — not in this phase; local-first forever until Phase 3 gates
   pass.

---

*Source of truth for implementation: this repo (`MaddyInnov/KriyaDot`). This PRD
is a living document — update it when scope changes.*
