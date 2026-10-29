# Parity Audit — OpenMausBot & TencentCloud Octop vs KriyaDot (2026-10-29)

> Original analysis only. No code from either reference product was copied; all evidence is
> file paths + behavioural descriptions. KriyaDot source was **not** modified by this audit.

## Scope, versions, method

- **OpenMausBot audited:** full clone of `milind-soni/OpenMausBot` at **main HEAD `c97fdf86`**
  (2026-10-29 16:29 IST), package version **0.1.132** — main HEAD is newer than the latest tag
  `v0.1.132` (`931ef06c`, same day), so HEAD was audited. Clone:
  `~/workspace/goals/all-in-one-ai-agent-saas-platform/hidden_files/openmausbot-clone/`.
  Previous baseline: `988e15ce` (2026-10-17, ~v0.1.114); 2,149 commits in between.
  Inventory: 303 user-facing features (89 new since baseline, 22 cloud-tagged).
- **Octop audited:** full clone of `TencentCloud/Octop` at **v1.0.3b1, HEAD `890111b7`**
  (2026-10-25), clone in `hidden_files/octop-clone/`. Inventory: 184 features.
- **KriyaDot audited:** local tree at
  `~/workspace/goals/all-in-one-ai-agent-saas-platform/mvp/` as of 2026-10-29;
  **pushed head `ccbfa900`**. Every status below was verified against KriyaDot source
  (routes, tool registry, packages, web UI), not docs. "Present" = implemented and wired
  end-to-end (route/tool/UI). "Partial" = exists but limited, differently shaped, or not
  fully wired — the limitation is stated. "Missing" = no implementation found.
- **Counting note:** the 2026-10-17 audit counted 153 OpenMausBot features at coarser
  granularity (81 P / 27 Pa / 45 M). This pass counts 303 finer-grained features, so the
  totals are not directly comparable line-by-line; the honest comparison is the gap list.
- **Exclusions (user's standing orders):** hosted-cloud layers (OpenMausBot "My Cloud",
  Octop's Tencent hosted deploy links) and China-specific adapters (Octop's CN channels,
  SSO, connectors, cloud backends, FnOS packaging) are listed in separate
  excluded-by-order sections and are **not** counted as gaps.

## Headline counts

| Product | Audited state | Scored features | Present | Partial | Missing | Excluded by order |
|---|---|---|---|---|---|---|
| OpenMausBot | main `c97fdf86` (v0.1.132+) | 281 | 127 | 112 | 42 | 22 cloud |
| Octop (TencentCloud) | v1.0.3b1 `890111b7` | 144 | 46 | 65 | 33 | 40 CN-specific |

(Counts are taken from the status columns of the tables below.)

---

# Part 1 — OpenMausBot parity

OpenMausBot evidence paths are relative to the clone root. KriyaDot evidence paths are
relative to `mvp/`.

## 1.1 Bots & chat UX

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Bot roster as contacts | Present | `src/components/Sidebar.tsx` → bots sidebar, `apps/api/src/routes.ts` (`GET /bots`) |
| Per-bot profile / identity (name, soul, colour, picture) | Partial | `server/bot-profile.ts` → profile/persona editable (`apps/api/src/bot-personas.ts`); no bot picture/mascot, avatar colours only |
| Bot context-menu management | Partial | `src/components/SidebarBotMenu.tsx` → pin/unread/duplicate/hide/copy-ID built; direct delete absent — deletion is a Chief proposal only (`packages/agent-runtime/src/tools/chief.ts`) |
| Duplicate bot | Present | `src/lib/bot-duplicate.ts` → roster duplicate (context menu) |
| Bot folders / sidebar departments | Partial | `server/bot-folder.ts` → teams + Chief doctrine approximate it; no sidebar department grouping of bots |
| Threads (independent conversations) | Present | `server/routes/threads.ts` → `packages/agent-runtime/src/sessions.ts`, `apps/api/src/chat-threads-routes.ts` |
| Thread folders | Missing | `src/components/NewTaskFolderDialog.tsx` → no thread-folder concept found |
| 16 parallel threads per bot | Present | commit `feat(threads): allow 16 parallel threads…` → `MAX_PARALLEL_THREADS_PER_BOT = 16`, `packages/agent-runtime/src/turn-scheduler.ts` |
| Streaming replies with tool-activity chips | Present | `src/components/ToolActivity.tsx` → SSE turn stream, `packages/agent-runtime/src/runtime.ts` |
| Live step line / Now card | Present | `src/components/NowCard.tsx` → `apps/api/src/routes.ts` (`GET /chat/now`), `apps/web/components/chat/step-line.tsx` |
| Progress lines kept, finished steps fold | Partial | `src/components/ChatView.tsx` → step line exists; finished-step folding behaviour not verified |
| Queueing messages to a busy thread | Present | `server/channel-queue.ts` → `apps/api/src/chat-queue.ts` (max 50 pending) |
| Steering a running turn | Partial | `server/steer-queue.ts` → queue + run cancel exist; true mid-turn steering of a generating turn not wired |
| First-reply rescue | Missing | `server/first-reply-rescue.ts` → no watchdog for a first reply that never comes |
| Edit / rewind / branch a conversation | Present | `server/checkpoints.ts` → thread branching (`packages/cli/src/commands.ts`) + checkpoint restore (`apps/api/src/checkpoints.ts`) |
| Reactions as answers | Partial | `server/reactions.ts` → 👍/👎 only, and only against a named pending approval/widget target (`apps/api/src/chat-ux.ts`); OMB accepts ❤️😂🎉👀 too |
| @mentions (bots and people) | Partial | `src/components/MentionMenu.tsx` → people mentions wired in Pages/inbox (`apps/api/src/pages.ts`); no unified composer mention menu for bots+people in chat |
| Slash commands in composer | Present | `src/components/SlashCommandMenu.tsx` → `/goal` built-in + user-defined template commands (`apps/api/src/slash-commands.ts`) |
| /goal per conversation | Present | `server/host/goal-turns.ts` → `apps/web/app/page.tsx` (`/goal`, GoalStatusCard) |
| Inline charts in chat | Present | `server/data/chart-compiler.ts` → `chart` widget kind (`packages/agent-runtime/src/widgets.ts`); bar/line only, no Vega-style expressions |
| Rich tables in chat | Present | `src/components/RichTable.tsx` → `table` widget + markdown tables (`apps/web/components/widgets.tsx`) |
| Chat markdown with code blocks | Present | `src/components/ChatMarkdown.tsx` → standard chat rendering |
| Citations UI | Partial | `src/components/CitationUI.tsx` → provenance chip exists (`apps/web/components/provenance-chip.tsx`); no dedicated citations rendering for research answers |
| Attachments (images/files) | Present | `server/attachments.ts` → uploads + document extraction (`apps/api/src/document-extract.ts`) |
| Voice-note bubbles in chat | Missing | `src/components/VoiceNoteBubble.tsx` → voice exists in calls/PTT surfaces, not as recordable/playable note bubbles in chat |
| Screenshots of bot work in transcript | Partial | `server/turn-images.ts` → computer/phone screenshots exist as tool surfaces; automatic folding into the transcript not verified |
| Message search | Present | `server/message-search-query.ts` → `apps/api/src/message-search-routes.ts` |
| In-chat find bar | Missing | `src/components/ChatFindBar.tsx` → no in-conversation find UI found |
| Pin messages / pinned banner | Missing | `src/components/ChatPinnedBanner.tsx` → pinning exists for bots/memory, not messages |
| Unread dividers, counts, app badge | Partial | `src/lib/bot-unread.ts` → mark-unread exists; in-chat unread divider and title/badge counts not verified |
| Spoilers / rich message rows | Partial | `src/components/RichMessageRow.tsx` → rich widgets exist; spoiler masking absent |
| Export / share transcript | Missing | `src/components/ExportTranscriptMenu.tsx` → team export exists; conversation transcript export not found |
| Chat width / follow-bottom controls | Partial | `src/lib/chat-width.ts` → adjustable chat width not found; follow-bottom unverified |
| Per-turn model switch ("Switch AI") | Partial | `src/components/ModelPicker.tsx` → per-bot model config exists; a per-turn-only picker is not wired |
| Token & cost chip per chat | Partial | `src/lib/chat-usage-summary.ts` → spans carry per-run cost and Usage pages exist; a per-chat hover chip not verified |
| Context-budget warning | Missing | `server/context-budget.ts` → no approaching-context-limit warning found |
| Context compaction | Missing | `server/compaction-summary.ts` → memory summaries exist, but in-conversation compaction/summarisation of long threads not found |
| Cursor mascots (SupaMaus) | Missing | `src/components/CursorAvatar.tsx` → not chased (branding; see Oct-17 audit's deliberate exclusions) |
| Mascot customisation (face colour, bodies) | Missing | `src/components/MascotFaceColorPicker.tsx` → not chased (branding) |
| Skins / themes | Present | `src/components/SkinPicker.tsx` → 6 themes + per-user accent (`apps/web/lib/theme.ts`) — exceeds |
| Simple mode (redesigned) | Present | `src/components/SettingsSimplePages.tsx` → Simple/Pro modes (`apps/web/lib/ux-mode.ts`) |
| Advanced mode restyle | Present | `src/styles.css` → Pro mode is a full second interface language |
| Pinned web panels / Places rail | Missing | `src/components/PlacesRail.tsx` → fixed six destinations; arbitrary web panels cannot be pinned in a rail |
| Command palette | Missing | `src/components/CommandPalette.tsx` → no keyboard command palette found |
| Turn narration | Present | `src/components/TurnNarrationRun.tsx` → live step line + Now cards (`packages/agent-runtime/src/turn-state.ts`) |

## 1.2 Teams / multiplayer

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Departments (sections) with shared instructions | Partial | `server/bot-folder.ts` → teams exist (`packages/agent-runtime/src/teams.ts`); department-style shared instructions ride on Chief doctrine, not a department object |
| Rename / delete department | Partial | `src/components/SidebarTeamMenu.tsx` → team CRUD exists; department semantics (delete → General, conversations intact) not applicable as such |
| Department membership dialog | Missing | `apps/docs/content/docs/features/chat-and-teams.mdx` → no move-bots-between-departments dialog |
| Group chats / rooms | Present | `server/room-context.ts` → `apps/api/src/group-chats.ts` + 21 routes (members, settings, holds, queue) |
| Room responder rules incl. Auto (decision model) | Present | `server/room-reply.ts` → per-room responder rules + message router with decision log (`packages/agent-runtime/src/routing-decisions.ts`) |
| Hold / resume a bot in a room | Present | `server/room-holds.ts` → hold/halt/release in `apps/api/src/group-chats-routes.ts` |
| Room working folder | Present | `server/room-cwd.ts` → per-room settings incl. working folder |
| Room queue & turn timeout | Partial | `server/room-queue.ts` → room queue exists; configurable per-participant timeout not verified |
| Room bulletin / description | Partial | `src/components/RoomBulletin.tsx` → per-room settings exist; a bulletin board surface not verified |
| Chief of Staff role | Present | `server/chief-of-staff.ts` → `apps/api/src/chief-routes.ts`, `packages/agent-runtime/src/tools/chief.ts` |
| Appoint / replace a Chief | Partial | `server/routes/internal-chief-team.ts` → per-person Chief assignment exists (`POST /people/:id/chief`); Chief-appoints-Chief reviewed-plan flow only partly matched |
| Chief creates specialists | Partial | `server/drivers/agents-catalog.ts` → Chief `create_bot` is an approval-gated proposal, not an autonomous create-with-Undo |
| Chief builds a ready-made team from the library | Partial | `server/team-library.ts` → Chief team-setup proposals exist; Chief reading a team library and building unaided not verified |
| New workspace starts with a Chief | Partial | commit `feat(chief): a new workspace starts with its Chief of Staff…` → Chief wiring exists; new-install-starts-with-Chief behaviour not verified |
| Bot-to-bot delegation | Present | `server/coordinator.ts` → `delegate`/`ask_bot`/`message_bot` (`packages/agent-runtime/src/tools/delegate.ts`) |
| Every bot can reach every bot (+ optional allowlist) | Present | `apps/docs/content/docs/features/chat-and-teams.mdx` → delegation default-on + team delegation policy (`apps/api/src/teams-routes.ts`) |
| Peer approvals | Present | `server/peer-approval.ts` → `packages/agent-runtime/src/peer-approval.ts` |
| Work handed into a room reaches an outside bot directly | Present | commit #3580 → delegation targets any bot in its own thread (`apps/api/src/delegate-wiring.ts`) |
| Bot ownership / reporting lines | Present | `server/bot-owners.ts` → `BotConfig.ownerId`, `addresseePersonId` (`packages/agent-runtime/src/people.ts`) |
| Team map: who reports to whom (drag to reassign) | Present | `src/components/TeamMapPage.tsx` → org map with reassign (`GET /org`, `apps/api/src/people-routes.ts`) |
| Set owner for all bots in a department | Partial | `apps/docs/content/docs/features/chat-and-teams.mdx` → bulk owner reassignment not verified |
| Per-person Chief / personal inbox | Present | `server/host/person-inbox.ts` → per-person Chief + team inbox with Needs-you / FYI / Done (`apps/api/src/people-routes.ts`) |
| Inbox counts (sidebar / app icon / tab) | Partial | `apps/docs/content/docs/features/chat-and-teams.mdx` → team inbox exists; live counts synced to icon/tab not verified |
| Assistant answers simple facts for a person | Missing | `server/host/representative.ts` → a person's Chief serves that person, never teammates on their behalf (no calendar busy/free sharing either — no server-side calendar sync) |
| @mention people; bots message a person | Present | `server/person-replies.ts` → @mentions + approval-gated `relay_to_person` (`packages/agent-runtime/src/tools/relay.ts`) |
| People in the sidebar with pictures | Partial | `src/components/SidebarPeople.tsx` → people directory exists with avatar colours, not photos |
| Person holds / stops | Partial | `server/person-stops.ts` → room holds + global pause exist; a person stopping work addressed to them specifically not verified |
| Team escalations | Present | `server/escalations.ts` → `raise_escalation` Chief tool + incidents (`apps/api/src/chief-routes.ts`) |
| Team incidents | Present | `server/incidents.ts` → incident records with resolve/retry |
| Shared-workspace governance & trust | Present | `docs/verification/shared-workspace-governance.md` → tenancy roles + bot visibility (`packages/tenancy/src/index.ts`) |
| Group voice calls | Partial | `src/components/GroupCallView.tsx` → voice calls are 1:1 bot calls (`apps/api/src/voice-call.ts`); no multi-bot call view |

## 1.3 Providers / engines / routing

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Model picker with provider rail | Present | `src/components/ModelPicker.tsx` → Providers page + live model listing (`apps/api/src/routes.ts` `GET /models`) |
| Claude engine (Claude Code CLI) | Present | `server/drivers/claude.ts` → native CLI driver (`packages/agent-runtime/src/providers/cli-driver.ts`) |
| Codex engine | Present | `server/drivers/codex.ts` → native CLI driver, same file |
| Grok engine | Partial | `server/drivers/grok.ts` → Grok is in the 40-entry detection registry; no ACP preset or native driver — generic ACP/one-shot paths only (`packages/agent-runtime/src/providers/agent-registry.json`) |
| GitHub Copilot CLI engine | Present | commit #3740 → ACP preset `agent/copilot/<model>` (`packages/agent-runtime/src/providers/acp-engines.ts`) |
| DeepSeek Harness engine | Partial | `server/drivers/builtIn.ts` → DeepSeek is a first-class API preset (`deepseek-chat`/`deepseek-reasoner`), not an ACP harness engine with per-bot thinking selection |
| Antigravity (Google Gemini) engine | Missing | `server/drivers/antigravity.ts` → no Antigravity/Gemini-subscription engine; Gemini reachable only via OpenRouter/BYO endpoints |
| OpenCode / OpenCode Go engine | Present | `server/drivers/acp/opencode-go.ts` → ACP preset + opencode-subscription bridge |
| Cursor engine | Partial | `docs/cursor.md` → Cursor is detection-registered and delegatable; no ACP engine preset |
| Pi engine | Partial | `server/drivers/pi.ts` → no Pi preset; drivable only via the generic ACP-session API |
| More ACP engines (Gemini, Kimi, Droid, Qwen, Hermes, Cline) | Partial | `server/drivers/builtIn.ts` → several are in the detection registry (Gemini, Kimi, Qwen…); none has an engine preset |
| API-key model providers (Mistral, Cerebras, MiniMax, Meta…) | Partial | `server/drivers/mistral.ts` et al. → Groq is a preset; Mistral/Cerebras/MiniMax/Meta only via OpenRouter or a custom BYO preset |
| OpenAI-compatible endpoints | Present | `server/drivers/openai-compat.ts` → `custom-*` BYO presets + OpenAI-compatible driver (`packages/agent-runtime/src/providers/catalog.ts`) |
| ChatGPT-plan sign-in | Present | `server/drivers/chatgpt-plan-auth.ts` → codex-subscription bridge (`packages/agent-runtime/src/providers/cli-bridge.ts`) |
| Multiple Claude accounts | Partial | `server/claude-accounts.ts` → subscription bridge reads the CLI credential at request time; multiple switchable accounts not verified |
| Custom engines (BYO ACP CLI) | Partial | `docs/custom-engines.md` → any detected CLI can serve as an inference backend (`providers/agent-cli.ts`); a Settings-level custom ACP binary with model discovery is not wired |
| Per-bot custom ACP model & thinking selection | Partial | `docs/verification/custom-acp-models.md` → per-bot `modelOptions` exist; ACP-specific model/thinking picks are advisory only (Copilot picks the serving model) |
| Standalone engine install (no Node.js) | Missing | `server/engine-standalone.ts` → KriyaDot detects installed CLIs but does not install verified standalone engine builds |
| Engine detection & live check | Present | `server/engine-check.ts` → 40-entry detection registry + routes (`apps/api/src/agent-detect-routes.ts`) |
| Per-engine homes / sign-ins isolation | Partial | `server/engine-homes/engine-homes.ts` → per-bot MCP isolation exists; per-engine home directories do not |
| Local models (LM Studio etc.) | Partial | commit #3630 → Ollama + llama.cpp are first-class (`providers/ollama.ts`, `local-llm.ts`); LM Studio only via a generic OpenAI-compatible endpoint, no native catalog |
| Local-model reply timeout choice | Missing | commit #3805 → no per-provider local reply-timeout setting found |
| Decision model for room routing (Jev/OpenRouter/Clef) | Present | `docs/decision-model.md` → message router + decision log with tunable weights and agreement stats (`packages/agent-runtime/src/routing-decisions.ts`); deterministic heuristics, honestly labelled — not an ML classifier |
| Decide & extract helper models for every bot | Partial | `server/extractor/` → cheap-model triage exists (`routeModel`, watch/notification triage); a general typed-value extraction tool (text/images) for every bot does not |
| Usage-limit failover | Present | `server/limit-failover.ts` → `packages/agent-runtime/src/failover.ts` (hard-limit classification, one switch per turn, backup provider/model) |
| Run-when-limit-resets automations | Present | `server/routes/limit-resets.ts` → persistent limit-reset resumes (`apps/api/src/limit-reset-resumes.ts`) |
| Quick model fallback | Partial | `server/quick-model-fallback.ts` → failover covers hard limits; a fast per-turn fallback when the picked model merely cannot run is not a distinct mechanism |
| Provider recovery | Partial | `docs/verification/provider-recovery.md` → failover + crash-recovery orphan resume exist; provider auth-recovery semantics not matched |
| Claude tool search for third-party MCP | Partial | commit #3759 → KriyaDot solves the same pressure in its own harness (lazy MCP stubs, per-bot isolation); Claude Code's tool-search integration itself is absent |
| 128-tool-limit fitting for API-key models | Partial | commit #3811 → lazy MCP loading reduces tool count; explicit schema compaction to a 128-tool ceiling not verified |

## 1.4 Tools & browser

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Agents tool bridge (bounded internal catalog) | Present | `docs/agents-tool-bridge.md` → tool registry assembly (`apps/api/src/tool-registry.ts`) |
| Built-in browser for bots | Present | `server/browser/service.ts` → Playwright Chromium (`packages/agent-runtime/src/tools/computer-playwright.ts`); real backend is env opt-in |
| Browser live view in panel | Present | `src/components/BrowserPanel.tsx` → per-bot computer view (`apps/api/src/computer-view.ts`) |
| Per-bot persistent browser profiles | Present | `src/lib/browser-profiles.ts` → `launchPersistentContext(<dataDir>/browser-profiles/<botId>/)` + wipe endpoint |
| Browser sign-in handling (card → take control → Done) | Present | `server/login-handoff.ts` → sign-in requests settled by typing "done" after a status re-check (`apps/api/src/chat-ux.ts`) |
| Saved logins & fill_login (incl. 1Password) | Partial | `server/login-fill.ts` → `type_login` types vault logins, password never shown to the model; 1Password as an in-product vault source is absent |
| Bots enter sign-in codes | Present | `server/routes/sign-in.ts` → `enter_sign_in_code` (approval first, fresh Gmail code via Composio, never logged) (`apps/api/src/sign-in-code-tools.ts`) |
| Browser holds follow the person | Partial | commit #3726 → room holds exist; a per-person browser hold that follows them does not |
| Connected apps via Composio (500+ apps) | Present | `docs/composio.md` → same backbone: `composio_list_actions`/`composio_call` (`apps/api/src/composio-tools.ts`) |
| Multiple accounts per connected app | Present | `server/mcp-app-connections.ts` → per-account resolution (`apps/api/src/composio-accounts.ts`) |
| Self-hosted Composio / own OAuth apps | Partial | `docs/composio.md` → generic provider OAuth exists (`apps/api/src/oauth.ts`); self-hosted Composio project support not verified |
| Per-bot app access | Present | `src/lib/bot-app-access.ts` → per-bot app enablement in Composio tools |
| Custom MCP servers (BYO) | Present | `docs/custom-mcp-servers.md` → stdio + Streamable HTTP clients, directory installs, per-bot private servers (`packages/agent-runtime/src/mcp-private.ts`) |
| MCP OAuth sign-in | Present | `server/mcp-oauth.ts` → `packages/agent-runtime/src/mcp-oauth.ts` + routes |
| MCP apps in chat (interactive frames) | Missing | `server/chat-apps.ts` → chat widgets are native kinds only; MCP App servers do not render as sandboxed frames in chat |
| HighLevel CRM native integration | Partial | `docs/highlevel.md` → no native HighLevel surface; reachable only generically via Composio/MCP if connected |
| Postiz social publishing in Apps | Partial | `server/postiz/service.ts` → social tools exist via muse-modules (`packages/muse-modules/src/tools.ts`); no Postiz scheduling/publishing integration |
| X (Twitter) research tools | Partial | `server/x-research.ts` → web search + social search exist; dedicated `x_search`/`x_post` tools with a per-bot key do not |
| Research tools for bots | Present | `server/research.ts` → `research_deep` + `web_search` (`packages/agent-runtime/src/tools/builtin.ts`) |
| Data & charts tooling | Present | `server/data/engine.ts` → chart widgets + data dashboards |
| Tool-result budgeting & spill | Partial | `server/tool-result-spill.ts` → document extraction truncates at 100 KB with a flag; general tool-result spill-to-file not verified |
| Whop connector | Missing | `docs/verification/whop.md` → no Whop surface found |

## 1.5 Computer / phone control

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Every bot gets a computer | Present | `src/components/ComputerPanel.tsx` → per-bot computer surfaces (`packages/agent-runtime/src/tools/computer-surfaces.ts`) |
| This computer — host control, macOS (Cua) | Partial | `server/local-computer.ts` → real desktop backend exists but is env opt-in (`COMPUTER_USE_REAL=1`) and is not the Cua driver |
| This computer — Ubuntu Xorg (beta) | Partial | `docs/linux-desktop.md` → same real backend; Xorg-specific beta hardening/pinning not matched |
| Wayland host control (disabled in OMB) | Partial | `docs/linux-desktop.md` → OMB itself disables it; KriyaDot has no Wayland-specific gating either way |
| Only the desktop app's own server may use this computer | Partial | commit `Only the desktop app's own server…` → loopback bearer auth restricts the API (`apps/api/src/loopback-auth.ts`); the consent rule is not stated in the same form |
| Local VM desktops (Docker/Podman) | Present | `server/container-computer.ts` → docker computer surface + E2B/Dot environments (`apps/api/src/dots.ts`) |
| Local VM preserves user-installed apps across updates | Partial | commit #3812 → browser profiles persist; VM app persistence across app updates not verified |
| Boat cloud computers (third-party) | Partial | `server/boat.ts` → functional analogues exist (E2B/Dots, VPS); the Boat backend itself is absent |
| Bring Your Own VPS computers | Present | `docs/byo-vps.md` → per-bot VPS profiles + remote execution (`packages/agent-runtime/src/tools/vps.ts`) |
| Auto / local / cloud computer selection | Present | `server/computer-selection.ts` → `computerSurface: auto\|local\|docker\|browser\|off` per bot |
| Take control / desktop takeover | Present | `src/components/DesktopViewer.tsx` → computer view + companion remote screen (`apps/api/src/remote-screen.ts`) |
| Computer files pane | Partial | `src/components/ComputerFilesPane.tsx` → per-bot file listing exists (`apps/api/src/files.ts`); a files pane on the computer panel not verified |
| Computer contention reporting | Partial | `shared/computer-contention.ts` → per-bot turn scheduling exists; explicit contention reporting for a shared physical computer not verified |
| USB Android control (Phone Harness) | Present | `skills/phone-harness/` → ADB device path + phone-agent app (`apps/api/src/phone-adb.ts`) |
| Phone apps as bot tools | Partial | commit #3457 → KriyaDot bots *operate* phone apps via accessibility (`phone_open_app/tap/type/…`); OMB's are *data* tools (Calendar/Reminders/Contacts/Location/Messages) — KriyaDot has no such data-level phone tools |
| Phone jobs & revocation | Partial | `server/phones/jobs.ts` → phone tools are approval-gated per call; per-job grants with instant session revocation not modelled |

## 1.6 Automations / routines / triggers

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Routines (schedules) | Present | `server/routines.ts` → `apps/api/src/bot-routines.ts` (19 routes, timezone-aware) |
| Advanced cron for routines | Present | `server/routine-schedules.ts` → cron-style schedules (`apps/api/src/routine-schedules.ts`) |
| Optional advanced run limit for routines | Partial | `server/routine-intervals.ts` → run cancel exists; a per-routine timeout setting not verified |
| Triggers page (calendar + run history) | Partial | `src/components/TriggersPage.tsx` → routines UI + run history exist; a unified triggers calendar view not verified |
| Bots manage triggers from chat | Missing | `server/trigger-tools.ts` → no in-turn trigger CRUD tools with a live card found |
| Webhook triggers | Present | `server/webhooks.ts` → per-routine secret hook URLs + workflow webhooks (`apps/api/src/routine-hooks.ts`) |
| Dedicated webhook receiver (isolated port) | Partial | `server/webhook-address.ts` → webhooks terminate on the main API; no separate locked-down receiver process |
| Webhooks that post straight into a room | Partial | commit `feat(webhooks): post straight into a room…` → workflow webhooks + rooms exist; post-without-a-run into a room not verified |
| App-event triggers | Present | `server/app-triggers.ts` → polling event triggers over Gmail/Slack/GitHub/Stripe/Calendar via Composio, dedupe + catch-up + daily caps (`apps/api/src/routine-events.ts`) |
| Routine results land in the bot's chat | Present | `server/routine-execution.ts` → run results post back; silent "nothing new" behaviour matched by watch triage |
| Routine run receipts & logs | Present | `server/routine-outcomes.ts` → run history/detail + cancel/retry (`apps/api/src/routine-runs.ts`) |
| Remember the last run | Partial | `apps/docs/content/docs/features/automation.mdx` → prompt templates exist; previous-report injection into the next run not verified |
| Run when the app starts | Missing | `apps/docs/content/docs/features/automation.mdx` → no fire-on-app-start routine option found |
| Pre-AI checks for routines | Partial | `server/host/check-plan.ts` → event triggers poll with no AI turn; a zero-AI check gating a routine run is not a distinct feature |
| Read-and-draft routine runs | Partial | `server/read-and-draft.ts` → read-only sandbox mode + approval modes exist per bot; a routine-level tool-allowlist run type does not |
| Automatic retry of failed runs | Partial | `server/automatic-recovery.ts` → manual retry endpoints + crash-recovery orphan resume exist; automatic once-retry with "recovered" reporting does not |
| Proactive routines / morning brief | Present | `docs/proactive-routines.md` → daily briefing (`apps/api/src/briefing.ts`) |
| Automation destinations (Brief card / thread) | Partial | `server/automation-destinations.ts` → briefing consumes platform state; routines delivering into the brief as an editable card not verified |

## 1.7 Memory

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Readable, editable bot memory | Present | `docs/memory.md` → per-bot markdown memory + editor API (`packages/agent-runtime/src/memory.ts`) |
| Layered memory files (MEMORY.md + topics, token budget) | Partial | `server/memory-topics.ts` → per-bot file + tiered atoms approximate layering; topic files under an explicit token budget not modelled |
| Memory journal & capture | Present | `server/memory-capture.ts` → background capture (memory keeper) + undoable journal (`apps/api/src/memory-upkeep-routes.ts`) |
| Memory search / recall with disclosure | Partial | `server/recall.ts` → hybrid search (trigram + FTS + RRF); a recall disclosure line shown to the user not verified |
| Remember & forget in plain words | Present | `server/memory-forget.ts` → `memory_store` + atom delete, Simple-mode friendly |
| Memory upkeep, tidy & organise | Present | `server/memory-upkeep.ts` → upkeep capture/tidy endpoints |
| Nightly dreaming | Missing | `server/memory-dream.ts` → nightly tidy exists; dream-generated brief ideas do not |
| Profile learning ("About you") | Present | `server/about-me.ts` → `GET/PUT /about-me` profile used as context |

## 1.8 Voice

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Spoken replies (TTS) | Partial | `server/routes/tts.ts` → TTS exists but the **default provider is a mock** (sine tone); real Groq/OpenAI TTS is key-gated (`packages/voice/src/voice.ts`) |
| TTS provider breadth (ElevenLabs, Fish, Grok, Mac voices, Chatterbox) | Partial | `server/tts/elevenlabs.ts` et al. → only Groq + OpenAI; no ElevenLabs/Fish/Chatterbox/system voices — a gap carried over from the Oct-17 audit, still open |
| Per-bot voice | Present | `src/components/VoicePicker.tsx` → per-bot `voice {sttProvider, ttsProvider, voice, vad}` (`apps/api/src/bot-voice.ts`) |
| Voice pickers search provider catalogs | Missing | commits `ElevenLabs voice picker searches the Voice Library…` → fixed voice lists only; no catalog search |
| Speak sooner (streaming speech) | Present | `server/tts/speech-text.ts` → sentence-chunked streaming TTS in chat (`apps/api/src/chat-streaming-tts.ts`) |
| Call mode (voice calls with a bot) | Present | `docs/voice-mode.md` → server-driven STT→turn→TTS call loop (`apps/api/src/voice-call.ts`); OMB's is macOS-only, KriyaDot's is web/WebSocket |
| Call records | Partial | `src/components/CallRecordRow.tsx` → call create/get/end exist; a call-records list UI not verified |
| Native macOS dictation | Missing | `docs/verification/dictation.md` → STT is server-side Whisper; no OS dictation integration |
| Global push-to-talk | Partial | commit #3764 → push-to-talk exists inside calls (plus client VAD); a **system-wide hotkey (⌃⌥Space) is not wired** (`apps/web/lib/vad.ts`, `packages/voice/src/voice.ts`) |
| Speech-text preparation | Partial | `server/tts/speech-text.ts` → sentence chunking exists; markdown-to-speech rewriting not verified |

## 1.9 Marketplace / library / presets / skills

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Connected-apps marketplace | Present | `src/components/SidebarConnectApps.tsx` → Composio marketplace + local registry UI (`apps/web/app/marketplace/page.tsx`) |
| Team packages from BotMRR (one-Markdown-file teams) | Present | `server/installed-playbooks.ts` → BotMRR-style Markdown team import/export, round-trip for covered fields (`packages/agent-runtime/src/team-markdown.ts`) |
| Share a whole department as one file | Present | `docs/team-sharing.md` → team manifest export/import with checksum (`packages/agent-runtime/src/team-manifest.ts`) + roster export |
| Preset bots | Partial | `docs/presets.md` → seed bots + marketplace entries exist; a user "share as preset" flow with defaults travelling is not a distinct surface |
| Ready-made bot gallery / templates | Present | `src/components/ReadyBotGallery.tsx` → 17 marketplace bots + 12 seed bots, install-to-local |
| Team library | Partial | `server/team-library.ts` → marketplace + team manifests cover installs; a browsable team library as such is thinner |
| Organization library | Missing | `docs/org-library.md` → no per-org shared library surface found (`seed/bots.json` + marketplace are the closest equivalents) |
| Skills system (SKILL.md) | Present | `server/skills.ts` → skill store, review queue, attach/detach (`apps/api/src/skill-store-routes.ts`) |
| Skill library & assignment | Present | `server/skill-library.ts` → per-bot assignment + enable/disable; user skills start disabled |
| Skill sharing / export / fetch | Partial | `server/skill-share.ts` → proposals/review exist; share/export/fetch-by-reference flows not verified |
| Skill learning from work | Present | `server/skill-learn.ts` → `learn_skill` tool + proposal review queue |
| Bundled skills | Present | `skills/data-dashboards/` et al. → 32 seed skills (`seed/skills/`) |
| New-bot defaults | Partial | `server/new-bot-defaults.ts` → setup propose→apply flow exists; global new-bot defaults (model/permissions/look) in Settings not verified |

## 1.10 Publishing / pages

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Bot-made pages shown inline in chat | Partial | `server/pages/service.ts` → Pages (co-edit docs) + `publish_page` exist; an inline artifact card for every bot-made page in chat is not the model |
| Page preview pane beside chat (point-to-change) | Missing | `server/pages/client.ts` → no preview pane with point-at-a-part change requests |
| JSX pages compile to static HTML | Missing | `server/jsx-compile.ts` → publishing renders markdown→sanitised HTML; JSX authoring is absent |

## 1.11 Observability / activity

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Activity panel | Present | `src/components/ActivityPanel.tsx` → Activity destination with panels |
| Usage traces (per-turn spans) | Present | `server/usage-trace/recorder.ts` → span store + waterfall + recorded replay (`packages/agent-runtime/src/spans.ts`) |
| Usage ledger & per-bot/session costs | Present | `server/usage-ledger.ts` → ledger + cost breakdown + CSV (`packages/billing/src/ledger.ts`) |
| Today / Brief outcome view | Present | `server/today.ts` → daily briefing (`apps/api/src/briefing.ts`) |
| Admin activity & audit | Present | `server/admin-activity.ts` → append-only audit log + Audit page (`apps/web/app/audit/page.tsx`) |
| Sentinel (local diagnostics) | Present | `docs/sentinel.md` → run-health scanner + regression detection (`packages/run-health/src/*`) |
| Recent work / recent log | Partial | `server/recent-work.ts` → briefing + activity cover the need; a per-bot "recent work" digest as such is not a surface |
| Diagnostics & logs access | Partial | `src/components/DiagnosticsRow.tsx` → health routes exist; "open the logs folder" from Settings not verified |
| Opt-in anonymous analytics | Present | `docs/analytics.md` → local, opt-in product analytics (`packages/agent-runtime/src/product-analytics.ts`); local-only rather than PostHog |

## 1.12 Mobile companions

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| iOS companion app | Partial | `docs/ios-companion.md` → full SwiftUI source exists and CI compiles it (unsigned simulator build); it is **not a distributed/signed app**, and the server has **no APNs send path** (FCM only) (`ios-companion/README.md`, `apps/api/src/push.ts`) |
| iOS pairing (QR / code / multi-computer) | Partial | `docs/ios-companion.md` → QR pairing exists (Android + iOS source); six-digit code flow and multi-computer switcher not verified |
| iOS privacy boundary | Partial | `docs/ios-privacy.md` → loopback auth + sealed push approximate it; no equivalent stated privacy boundary for companion config |
| Phone web app (PWA) | Present | `docs/phone-web-app.md` → PWA install + offline page (`apps/web/components/pwa-install.tsx`) |
| Phone-optimised web UI | Partial | commits `feat(mobile): …` → PWA exists; the phone-specific full-screen bot list / tools grid redesign is not matched |
| Companion service (mDNS relay) | Partial | `companion/src/index.ts` → companion routes + WebSocket exist; an mDNS-advertising relay service does not |
| Desktop-to-desktop companion mode | Partial | `docs/desktop-companion.md` → remote screen + VPS access exist; pairing a desktop as a companion client to another host is not a flow |

## 1.13 Desktop app

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Desktop app for macOS / Windows / Ubuntu | Present | `electron/main.mjs` → Tauri shell with published installers (.exe/.AppImage/.deb on v0.1.0-alpha) instead of Electron (`apps/desktop/src-tauri/`) |
| Embedded server (no separate setup) | Present | `scripts/bundle-server.mjs` → API sidecar on `127.0.0.1:4567` with health probe (`apps/desktop/src-tauri/src/main.rs`) |
| Places rail as window chrome | Missing | commit #3739 → no rail-as-chrome in the Tauri shell |
| Open at login | Present | commit #3603 → OS autostart entries via API (`apps/api/src/autostart.ts`) |
| Automatic updates | Present | commit #3624 → self-update with idle-time applier (`packages/agent-runtime/src/self-update.ts`) |
| Desktop chat links (deep links) | Missing | `docs/desktop-chat-links.md` → no deep-link-to-chat handling found |
| Desktop library | Missing | `docs/desktop-library.md` → no desktop library surface (marketplace/Pages are web surfaces) |
| Tray / startup behaviour | Present | `docs/verification/startup-tray.md` → tray menu (Show / status / Restart API / Quit) |
| macOS install-window art | Missing | `build/dmg/` → cosmetic; no DMG artwork |

## 1.14 CLI / headless / MCP server

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Terminal install & launch | Partial | `docs/cli-onboarding.md` → CLI exists (`packages/cli/`); a guided arrow-key first-launch setup is not the flow |
| `setup` reconfigure command | Partial | `server/cli-setup.ts` → `config`/`login` commands exist; a dedicated reconfigure-without-reset flow is thinner |
| `serve` (background / VPS, tunnel modes) | Partial | `docs/deploy-vps.md` → `serve --port` exists; `--tunnel`/`--tailscale` serve modes not verified |
| Headless CLI for scripts & CI | Present | `docs/headless-cli.md` → `run --bot --message` with exit codes + `team apply`/`team export` (`packages/cli/src/commands.ts`) |
| Outbound MCP server (control plane) | Present | `docs/mcp-server.md` → platform MCP server (stdio + HTTP/SSE), governance-gated, no self-approve (`packages/agent-runtime/src/mcp-server.ts`) |
| Self-hosting (headless server) | Present | `docs/self-hosting.md` → Docker compose + server binary (`docker-compose.yml`, `scripts/build-server-binary.sh`) |

## 1.15 i18n

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Locale breadth (16 locales) | Partial | `src/locales/*.json` → KriyaDot ships 7 (en, hi, ru, it, pl, ja, pt-BR); **missing de, es, fr, tr, uk, vi, zh, zh-TW** (`apps/web/lib/locales.ts`) |
| Italian locale | Present | commit #3622 → `it` in `apps/web/lib/locales.ts` (machine-quality, per `docs/I18N.md`) |
| Polish locale | Present | `src/locales/pl.json` → `pl` shipped |
| Russian locale | Present | commit #3612 → `ru` shipped |
| Release-time source-hash checking of translations | Missing | `docs/localization.md` → KriyaDot enforces key/placeholder parity by tests; source-hash release checking is absent |

## 1.16 Governance / approvals / spend

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Approval cards in chat (unified question/approval card) | Present | `src/components/ApprovalCard.tsx` → approval cards + ask widgets through one governance path (`packages/governance/src/gateway.ts`) |
| Permission broker (one decision for all engines) | Present | `server/permission-proxy.ts` → deny-by-default gateway incl. CLI-driver brokering |
| Approval levels (per-bot, changeable mid-work) | Present | `docs/approval-levels.md` → plan/auto/bypass per bot; a bot reading its own files never asks (`packages/agent-runtime/src/approval-modes.ts`) |
| Command allowlist | Present | `server/command-allowlist.ts` → per-bot policy rules + "allow this tool" learning (`apps/api/src/bot-policies.ts`) |
| Options / ask cards | Present | `server/options-card.ts` → widget kinds incl. buttons/select/input/confirm (`packages/agent-runtime/src/widgets.ts`) |
| Bot secret requests (secure card) | Present | `server/routes/secret-cards.ts` → credential proposals → encrypted vault; model never sees values (`packages/agent-runtime/src/credential-proposals.ts`) |
| Secrets write-only in Settings | Present | `server/secret-vault.ts` → AES-encrypted vault (`packages/vault/src/vault.ts`) — stronger than OMB's plaintext `config.json` (0600) noted in its own CLI docs |
| Safety floor | Present | `server/safety-floor.ts` → Tier-1 catastrophic hard floor, never approvable (`packages/governance/src/hard-floors.ts`) |
| Guarded requests / outbound hold | Present | `server/guarded-requests.ts` → outbound messaging is a Tier-2 approval action; relays fenced (`apps/api/src/messaging.ts`) |
| Spend caps & budgets (core) | Present | `server/spend.ts` → global + per-bot caps enforced before the provider call (`packages/billing/src/spend-caps.ts`) |
| Undo for bot-made changes | Partial | `server/routes/undo.ts` → undoable memory journal + checkpoint restore exist; a general one-line Undo for bot changes (routine edits, team changes) does not |
| Inspector | Partial | `src/components/InspectorPanel.tsx` → span waterfall + run detail covers most of it; no dedicated Inspector panel per run |
| Verify cards | Partial | `src/components/VerifyCard.tsx` → verify tools exist (`packages/agent-runtime/src/tools/verify.ts`); results as in-chat cards not verified |
| @devs bug reporting | Missing | `server/devs-report.ts` → vendor-specific (reports to the MausBot team); no in-product equivalent |

## 1.17 Setup / onboarding / helper personas

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Two-screen first run | Partial | `src/components/MausBotWelcome.tsx` → setup flows exist; a scripted two-screen first run (meet app → meet Chief → chat) is not the flow |
| First-hour flow | Partial | `server/host/first-hour.ts` → "Set me up" + setup suggestions cover part; scripted first-hour guidance does not |
| "Set me up" under a new bot's greeting | Present | `server/routes/setup-request.ts` → one-sentence setup → inert proposal → one approval (W12) |
| Setup card with personal answers (Simple mode) | Partial | `server/setup-suggestions.ts` → the setup proposal is one-shot; a personal-questions card whose answers follow the bot's name is not matched |
| New bot is instant (no popup) | Partial | commit `New bot makes the bot at once…` → creation goes through propose→apply / import / Chief / marketplace, not an instant create |
| Helper persona (MausBot) | Partial | `server/drivers/agents-mausbot-tools.ts` → Chief + notification triage cover pieces; a dedicated helper persona that watches notifications and changes allowlisted settings in chat does not exist as such |
| Helper key suggestions | Missing | `src/components/HelperKeySuggestion.tsx` → no "the one add-a-key action that unlocks the most" suggestion |
| The Brief (daily, replaces Today) | Partial | `server/host/brief.ts` → daily briefing exists (`apps/api/src/briefing.ts`); meeting-prep cards (no server-side calendar sync) and dream-sourced ideas are absent |
| Chief's default watch routine | Partial | commit `feat(chief): the Chief keeps an eye on the day…` → watch rules exist but are user-created; no default Chief watch routine out of the box |
| Grok Bot import | Missing | `src/components/GrokImportFlow.tsx` → agent import covers Claude/Codex/other installs (`packages/agent-runtime/src/agent-import.ts`); a Grok Bot finish-setup import does not |
| Import settings | Partial | `src/components/ImportSettings.tsx` → agent/session import covers much; a settings-file import during setup is thinner |
| CLI onboarding | Partial | `docs/cli-onboarding.md` → CLI login/config exist; guided terminal onboarding (AI access → model → phone) is not matched |

## 1.18 Cloud-adjacent (scored — not a hosted-cloud feature)

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Workspace backups (incl. team backups) | Partial | `server/workspace-backup.ts` → backup/restore/rollback exists (`apps/api/src/workspace-backup.ts`); scheduled backups with a retention policy not verified |

## 1.19 Enterprise

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Enterprise edition gating (signed license key) | Missing | `enterprise/server/license.ts` → no enterprise edition or license-key gating |
| White-label branding | Missing | `server/brand.ts` → themes/accent exist; name/logo/tagline white-labelling from a brand file does not |
| Workspace budgets (enterprise) | Present | `enterprise/FEATURES` → the capability exists in KriyaDot core (global spend cap), not enterprise-gated |
| Billing / sell prices (enterprise) | Partial | `enterprise/FEATURES` → cost breakdown + ledger CSV exist; per-model sell prices with a billable column do not |
| Installations admin (enterprise) | Missing | `enterprise/README.md` → no installations admin surface |
| SSO via OIDC (enterprise) | Missing | `enterprise/FEATURES` → absent in KriyaDot; note OMB itself marks this **planned — "nothing checks it yet"** |
| Organization identity & branding (core) | Partial | `src/components/OrganizationIdentity.tsx` → tenancy orgs exist; org name/picture settings UI not verified |

## 1.20 Evals

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Eval harness | Present | `evals/runners/run-evals.ts` → eval definitions + runs with streaming results (`packages/agent-runtime/src/evals.ts`) |
| Coordination / local-VM eval worlds | Partial | `evals/runners/coordination-world.ts` → generic evals + red-team suites exist; simulated coordination worlds do not |
| Skill bench | Missing | `evals/skill-bench/` → no skill benchmark runner |
| Live provider evals | Partial | `evals/live/` → evals run against configured providers; dedicated live-provider suites not verified |

## 1.21 Misc: files, data, search, notifications

| Feature | Status | Evidence — OpenMausBot → KriyaDot |
|---|---|---|
| Files view | Present | `src/components/FilesView.tsx` → uploads + per-bot file listing (`apps/api/src/files.ts`) |
| Full transcript search | Present | `server/message-search-query.ts` → message search + index rebuild |
| Notifications panel & settings | Present | `src/components/NotificationsPanel.tsx` → notification triage + push prefs (`apps/api/src/notification-triage.ts`) |
| Sidebar attention panel ("needs you") | Present | `src/components/SidebarAttentionPanel.tsx` → team inbox + watch "needs you" + Now cards |
| Digests | Present | `server/digest.ts` → daily briefing is the digest surface |
| Avatar generation & storage | Partial | `server/avatar-image.ts` → avatar colours for people/bots; AI-generated bot avatar images not found |
| Bulk select & bulk delete | Missing | `src/components/BulkSelectBar.tsx` → no multi-select bulk operations on bots/threads |
| Time-zone handling | Present | `server/time-zone.ts` → timezone-aware routines with next-runs preview |
| Cache keep-warm | Missing | `server/cache-keepwarm.ts` → no provider prompt-cache warming setting |
| Thread cleanup & retention settings | Partial | `src/components/ThreadCleanupSettings.tsx` → thread delete exists; retention/cleanup settings incl. delete-all not verified |
| Data dashboards as a bot deliverable | Present | `skills/data-dashboards/` → chart widgets + dashboards via data tooling |

## 1.22 Where KriyaDot is lacking vs OpenMausBot (ranked by user impact)

**Missing (42):**
1. **TTS provider breadth + catalog voice pickers** (§1.8) — no ElevenLabs/Fish/Chatterbox/system voices and no searchable voice catalogs; compounded by the mock TTS default (Partial, §1.8). The oldest open gap — already Partial in Oct-17.
2. **MCP Apps in chat** (§1.4) — MCP servers cannot render interactive apps/frames inside chat; widgets are native kinds only. New since baseline.
3. **Representative assistant** (§1.2) — nobody's Chief answers teammates' simple factual questions on their behalf (busy/free, shared notes, status).
4. **Pages depth: preview pane with point-to-change + JSX page authoring** (§1.10) — KriyaDot publishes markdown→HTML to its own server; OMB's inline preview/point-to-change loop and JSX→static-HTML pages are absent.
5. **Context health: compaction + context-budget warning** (§1.1) — long conversations have no in-thread compaction or approaching-limit warning.
6. **Eight locales** (§1.5) — de, es, fr, tr, uk, vi, zh, zh-TW missing from the 7 shipped.
7. **Chat polish cluster** (§1.1) — first-reply rescue, message pinning, in-chat find, transcript export, voice-note bubbles, command palette, Places rail: individually small, collectively the daily-driver feel.
8. **Engine depth** (§1.3) — Antigravity engine absent; standalone (no-Node) engine installs absent; local-model reply timeout absent.
9. **Organization library** (§1.9) — no admin-shared per-org template library.
10. **Enterprise pack** (§1.19) — white-label branding, license gating, installations admin absent (SSO is a stub in OMB itself). Matters only if KriyaDot targets org resale.
11. **Automation depth** (§1.6) — bots managing triggers from chat; run-on-app-start routines.
12. **Smaller singles** — thread folders (§1.1), department membership dialog (§1.2), helper key suggestions (§1.7), Grok Bot import (§1.7), @devs reporting (§1.16, vendor-specific), skill bench (§1.20), bulk select/delete (§1.21), cache keep-warm (§1.21), desktop deep links + desktop library + Places-rail chrome + DMG art (§1.13), translation source-hash checking (§1.15), nightly dreaming (§1.7 memory), native macOS dictation (§1.8), Whop connector (§1.4).

**Partial (112) — the ones that matter most:**
1. **iOS companion is source + CI, not a shipped app** (§1.12) — unsigned simulator builds only; no APNs send path on the server (FCM only, and FCM itself no-ops without Firebase credentials).
2. **Voice defaults to a mock** (§1.8) — real STT/TTS (Groq/OpenAI) is key-gated and non-default; the OpenAI Realtime bridge has never been live-fired.
3. **Global push-to-talk is not a system hotkey** (§1.8) — PTT exists inside calls only.
4. **Computer use real backends are env opt-ins** (§1.5) — the default OS layer is the mock; `COMPUTER_USE_REAL=1` / `COMPUTER_USE_PLAYWRIGHT=1` gate the real thing.
5. **Engine fleet depth** (§1.3) — Grok/Cursor/Pi and six more ACP engines are detection-only; DeepSeek is an API preset, not a harness engine; per-engine homes and multiple Claude accounts unmodelled.
6. **Chief autonomy** (§1.2/§1.17) — Chief creates specialists only as approval-gated proposals; no ready-made-team building from a library, no default watch routine, new bots aren't instant.
7. **Multiplayer finish** (§1.2) — people have avatar colours not pictures; inbox counts don't sync to icon/tab; bulk owner reassignment and person-level stops unverified.
8. **Bot lifecycle basics** (§1.1) — no direct bot delete (Chief proposal only) and no plain `POST /bots`; creation is setup/import/Chief/marketplace only.
9. **Automation finish** (§1.6) — no automatic retry of failed runs, no previous-run memory, no routine timeouts; triggers page lacks the calendar view.
10. **Money is mocked end-to-end** (not an OMB feature, noted for honesty) — platform billing is `MockBillingProvider` only; bot purchasing logic is real but browser checkout deliberately stops before the pay step and Stripe Link needs a user-enabled vault setting.

## 1.23 Excluded by your order — OpenMausBot cloud (22 features, not counted as gaps)

Hosted "My Cloud" layer: My Cloud home; cloud plans (Starter/Personal/Pro); cloud usage meter
& upgrade; rail of Clouds/places; "send everything to My Cloud" auto-migration; cloud sync;
cloud credential broker / bot box (bubblewrap + seccomp); lending your computer (terminal,
folder/drive, screen, Chrome, internet) to a Cloud home, incl. lent-screen guidance; MausBot
connector (Cloud home on your own server); Team Cloud hosting; a new Cloud's first hour;
cloud welcome/intent flow; included Composio service on Cloud installs; hosted Slack
management; custom domain for a Cloud workspace; team phone access codes; team shared memory
scopes (part of Team Cloud); "My Chrome" (cloud bots driving your real Chrome on a lent
machine); published-page hosting on **mausbot.page**.

Local equivalents KriyaDot already has, for the record: public page publishing on the user's
own server (`/p/<slug>`, unguessable 32-char slugs, sanitised, CSP) instead of mausbot.page;
per-bot persistent browser profiles instead of lent Chrome; workspace backup/restore instead
of cloud sync/migration.

---

---

# Part 2 — Octop (TencentCloud) parity

Octop evidence paths are relative to the Octop clone root; feature numbers match the
inventory (`hidden_files/audit-scratch/octop-inventory.md`). KriyaDot evidence is relative
to `mvp/`. Octop is a self-hosted product, so almost everything in its repo is in scope;
the hosted layer is only a pair of Tencent Cloud deploy links (excluded, §2.24).
China-specific adapters are excluded per your standing order (§2.24) — 40 numbered
features. Scored universe: 184 − 40 = **144**.

## 2.1 Platform, deployment & lifecycle (inventory §A)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 1 | Single-process self-hosted server | Present | `src/octop/launch.py` → API server + `serve` CLI + Docker (`apps/api/src/cli.ts`, `docker-compose.yml`) |
| 2 | Control-plane DB: SQLite or PostgreSQL | Partial | `src/octop/infra/db/migrations/` → KriyaDot stores are SQLite-only; no PostgreSQL option |
| 3 | First-run setup wizard + `octop init` | Partial | `src/octop/infra/setup/` → bootstrap endpoint + bot-setup flow exist; an install wizard creating the first admin account is thinner |
| 4 | One-line installers / PyPI | Partial | `scripts/install.sh` → desktop installers + build scripts exist; no curl one-liner or package-index install |
| 5 | System-service mode (systemd/launchd/Windows service) | Partial | `src/octop/cli/commands/service.py` → open-at-login autostart exists (`apps/api/src/autostart.ts`); a service start/stop/status manager does not |
| 6 | In-place self-update | Present | `src/octop/infra/setup/self_update.py` → self-update with idle applier (`packages/agent-runtime/src/self-update.ts`) |
| 7 | Backup & restore (incl. scheduled auto-backups) | Partial | `src/octop/cli/commands/backup.py` → workspace backup/restore/rollback exists (`apps/api/src/workspace-backup.ts`); full-deployment archives + scheduled automatic backups do not |
| 8 | TLS / HTTPS with Let's Encrypt (built-in ACME) | Missing | `src/octop/infra/setup/tls/` → no built-in certificate issuance/renewal |
| 9 | Subpath (reverse-proxy prefix) deployment | Missing | `CHANGELOG.md [1.0.3b1]` → no base-path deployment support found |
| 10 | Internationalisation (en / zh) | Partial | `src/octop/i18n/` → KriyaDot ships 7 locales (en, hi, ru, it, pl, ja, pt-BR) but **not zh** (`apps/web/lib/locales.ts`) |
| 11 | Server-timezone-aware display & scheduling | Present | `src/octop/config.py` → timezone-aware routines with next-runs preview |
| 12 | Interactive API docs (Scalar/OpenAPI UI) | Missing | `src/octop/api/openapi_meta.py` → no OpenAPI/Scalar docs surface |
| 13 | PWA support | Present | `dashboard/src/components/PwaInstallPrompt` → PWA install + offline page (`apps/web/components/pwa-install.tsx`) |

## 2.2 Users, auth, roles & sharing (§B; SSO items 23–25 excluded as CN)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 14 | Multi-user accounts with admin role | Present | `src/octop/infra/users/` → tenancy orgs with owner>admin>member>viewer (`packages/tenancy/src/index.ts`, 11 routes) |
| 15 | JWT authentication & per-user isolation | Partial | `src/octop/api/middleware/jwt_auth.py` → local mode uses a loopback bearer token; tenancy supplies real auth, JWT specifically not verified |
| 16 | Household / small-team sharing model | Partial | `README.md` (Highlights) → people layer is a UI-level selector (source states it is *not* a security boundary); household accounts ride on tenancy |
| 17 | Per-user workspaces (+ storage/token quotas) | Partial | `src/octop/infra/agents/workspace/` → per-*bot* workspaces exist; per-user storage/token quotas do not (spend caps are per bot/global) |
| 18 | Role templates (RBAC) | Partial | `src/octop/api/routers/user_roles.py` → tenancy roles exist; reusable role *templates* assignable at invite not verified |
| 19 | User groups with resource-visibility grants | Partial | `src/octop/api/routers/user_groups.py` → tenant scoping + viewer masking are adjacent; per-group grants over skills/KBs/connectors/models do not exist |
| 20 | Invite links | Present | `src/octop/api/routers/invites.py` → tenancy invites wired |
| 21 | OIDC single sign-on (login) | Missing | `src/octop/infra/auth/sso/` → OAuth exists for connected accounts, not as login SSO |
| 22 | LDAP directory login | Missing | `src/octop/infra/auth/ldap/` → no LDAP login |
| 26 | Login captcha | Missing | `src/octop/infra/auth/captcha/` → no login captcha |
| 27 | Expert sharing within a deployment | Partial | `src/octop/infra/db/repos/published_experts.py` → team manifests + local marketplace cover sharing by file; user-to-user in-deployment expert sharing is thinner |
| 28 | Per-resource audience / visibility controls | Partial | `dashboard/src/components/ResourceVisibilityFields` → tenancy viewer masking is adjacent; granular per-resource audience fields do not exist |
| 29 | Encrypted secret storage | Present | `src/octop/infra/crypto/fernet.py` → AES-encrypted vault (`packages/vault/src/vault.ts`) |
| 30 | Audit log & token-usage accounting | Present | `src/octop/infra/db/repos/usage.py` → append-only audit + usage ledger with CSV export (Octop exports Excel) |

## 2.3 Experts (agents) (§C)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 31 | Multiple experts per user | Present | `src/octop/infra/agents/manager.py` → multi-bot roster |
| 32 | Built-in expert library (23 templates) | Present | `src/octop/infra/agents/experts/library/` → 12 seed bots + 17 marketplace bots; fewer templates, same capability |
| 33 | Expert market (users publish for the deployment) | Partial | `src/octop/api/routers/experts.py` → marketplace is a bundled local registry (43 entries), never network-fetched and not user-published in-deployment |
| 34 | Publish an expert as an installable template | Partial | `CHANGELOG.md [0.9.24]` → team/roster export covers the snapshot mechanics; publish-to-market by users is not a flow |
| 35 | Create expert from template or blank (dashboard or CLI) | Partial | `src/octop/cli/commands/agent.py` → creation via setup/import/Chief/marketplace; no plain `POST /bots` and no CLI create |
| 36 | Per-expert model & provider configuration | Present | `src/octop/api/routers/providers.py` → per-bot provider/model/backup (`PUT /bots/:id/model`) |
| 37 | Per-expert system prompt / SOUL.md | Present | `docs/personas.md` → per-bot `systemPrompt`, editable |
| 38 | Per-expert tool configuration (hot update) | Partial | `src/octop/api/routers/agent_tools.py` → per-bot `tools[]` config exists; single-tool hot toggling not verified |
| 39 | Conversation modes: Ask / Plan / Craft | Partial | `src/octop/infra/agents/conversation_mode.py` → KriyaDot's plan/auto/bypass are *approval* modes; an Ask (no-work) / Craft distinction per thread is not the same axis |
| 40 | Expert lifecycle (start/stop/reload/delete) | Partial | `docs/cli.md` → bots aren't processes; delete exists only as a Chief proposal, not a direct endpoint |
| 41 | Pin, search & sidebar organisation of experts | Partial | `CHANGELOG.md [1.0.2b9]` → bot context menu (pin etc.) exists; expert search/sidebar layout customisation not verified |
| 42 | Built-in product assistant expert | Partial | `CHANGELOG.md [1.0.2]` → "Set me up" setup helper flow instead of a product-Q&A expert |

## 2.4 MBTI personas (§D)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 43 | 16 MBTI persona templates | Present | `src/octop/infra/agents/persona/mbti_profiles.py` → all 16 types in `packages/agent-runtime/src/personas.ts` (built for Octop parity in an earlier round) |
| 44 | Interactive MBTI quiz | Present | `dashboard/src/locales/en.json` → `POST /personas/quiz` (`apps/api/src/bot-personas.ts`) |
| 45 | Persona switching via API/CLI | Present | `docs/personas.md` → `PUT /bots/:id/persona` |

## 2.5 AgentTeams & collaboration (§E)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 46 | AgentTeams — coordinator schedules member experts (Beta in Octop) | Present | `docs/expert-teams.md` → teams (coordinator + members, delegation policy) + Chief coordination (`apps/api/src/teams-routes.ts`, 18 routes) |
| 47 | Team composition rules (≥2 members, no nesting, member protection) | Partial | `docs/expert-teams.md` → teams exist; the ≥2/no-nesting/in-flight-member rules are not modelled |
| 48 | Team room & IM relay | Partial | `docs/expert-teams.md` → team runs stream in-app; relay of team activity to IM channels is thinner |
| 49 | Host tool restriction (scheduling tools only) | Partial | `docs/expert-teams.md` → the Chief has its own toolset; a hard host restriction (no fs/browser/MCP) is not enforced as such |
| 50 | `ask_agent` expert-to-expert calls | Present | `docs/agent-call-agent.md` → `ask_bot`/`message_bot`/`delegate` (`packages/agent-runtime/src/tools/delegate.ts`) |
| 51 | Sub-agent library (~490 profiles) | Missing | `src/octop/infra/agents/subagents/library/` → delegation exists, but no bundled specialist-profile library of this breadth (32 seed skills is the closest) |
| 52 | Decision model for skill/tool/team invocation | Missing | `src/octop/infra/agents/settings/decision.py` → KriyaDot's decision log covers message→bot routing only, not confidence-gated skill/tool/team invocation |

## 2.6 Chat experience & surfaces (§F)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 53 | Web Dashboard | Present | `dashboard/src/pages/` → six-destination web app (Chat, Bots, Workflows, Marketplace, Workspace, Activity) |
| 54 | Streaming chat with live tool/thinking display + mid-turn steering | Partial | `src/octop/api/routers/chat/` → SSE streaming + step line exist; mid-turn steering of a generating reply is not wired (queue-after only) |
| 55 | Chat history, threads & forking | Present | `src/octop/infra/history/` → thread branching + checkpoints/restore |
| 56 | File & media attachments in chat (+ @-mention files) | Partial | `src/octop/api/routers/uploads.py` → uploads + document extraction exist; @-mentioning workspace files in the composer not verified |
| 57 | Human-in-the-loop question cards | Present | `src/octop/infra/gateway/hitl/` → `ask_user_question` widgets + approval cards |
| 58 | Slash commands (25 built-ins) | Partial | `src/octop/infra/gateway/slash/catalog.py` → KriyaDot slash commands are user-defined templates plus `/goal`; no built-in system set (`/compact`, `/model`, `/memory`…) |
| 59 | Skill insertion & AI text polish in the composer | Missing | `src/octop/api/routers/text_assist.py` → no composer skill insertion or text-assist |
| 60 | HTTP / SSE / WebSocket programmatic API | Present | `docs/api.md` → REST + SSE streaming + A2A/AG-UI protocol surfaces (`packages/protocols/`) |
| 61 | Usage & trajectory inspection | Present | `src/octop/api/routers/chat/trajectory.py` → span store, waterfall, per-message usage |

## 2.7 IM channels (§G; CN channels 62–66, 69, 70 excluded)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 67 | Telegram channel | Present | `dashboard/src/pages/Agent/Channels/components/constants.ts` → Telegram gateway (`apps/api/src/messaging.ts`) |
| 68 | Discord channel | Present | `docs/discord-channel.md` → Discord gateway, same file |
| 71 | MQTT channel | Missing | `constants.ts` (`mqtt`) → no MQTT ingress |
| 72 | Channel display & response controls | Partial | `src/octop/infra/gateway/process/response_mode.py` → channel config API exists; per-channel response mode (invoke/stream/final-only) and display toggles are thinner |
| 73 | Plugin-provided channels | Missing | `docs/plugin-channels.md` → no plugin system to register channel kinds |

## 2.8 Cloud collaboration / Bridge (§H)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 74 | Bridge instance linking | Missing | `src/octop/infra/bridge/` → no instance-to-instance linking |
| 75 | Browse & use peer experts | Missing | `docs/bridge.md` §1 → no remote-expert sidebar section |
| 76 | Cross-instance chat | Partial | `src/octop/infra/bridge/peer_turn.py` → A2A + the outbound MCP server allow remote agent invocation, but there is no peer-expert chat experience with home-instance execution |
| 77 | Remote workspace editing via Bridge | Missing | `docs/bridge.md` §3 → no tunnelled workspace/cron/personalisation access to a peer |
| 78 | History stays on the expert's side | Missing | `docs/bridge.md` §1 → no federation, so no home-authoritative history model |
| 79 | Bridge management surfaces + scoped tunnel policy | Missing | `src/octop/infra/bridge/tunnel_policy.py` → no Bridge settings, CLI, or tunnel policy |

## 2.9 Connectors (§I; 23 CN connectors excluded)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 98 | Notion connector | Present | `catalog.json` (`notion`) → Notion via Composio connected apps + Notion import |
| 99 | OpenAlex connector | Missing | `catalog.json` (`openalex`) → no scholarly-search connector (web search is the only approximation) |
| 100 | TickTick (Dida365) connector | Missing | `catalog.json` (`dida365`) → platform tasks are internal; no TickTick sync |
| 104 | Agent Mail (Agently) connector + mail-event triggers | Partial | `catalog.json` (`agently-cli`) → the *pattern* is covered by Gmail event triggers (`apps/api/src/routine-events.ts`); Agently itself is a Tencent mailbox, not integrated |
| 105 | Obsidian connector | Missing | `catalog.json` (`obsidian-cli`) → notes are KriyaDot's own system; no Obsidian vault access |
| 108 | Dify connector | Missing | `catalog.json` (`dify`) → no Dify app connector |
| 109 | Custom MCP servers (incl. OAuth remote MCP) | Present | `src/octop/api/routers/connectors.py` → MCP client (stdio/HTTP) + OAuth flows + directory (`packages/agent-runtime/src/mcp-oauth.ts`) |
| 110 | Connector selection per conversation | Partial | `CHANGELOG.md [1.0.2b1]` → enablement is per-bot; per-conversation connector selection is not a control |
| 111 | Outbound Agent MCP gateway (agent as an MCP tool) | Present | `src/octop/infra/agent_mcp/` → platform MCP server exposes bot invocation to external clients (`packages/agent-runtime/src/mcp-server.ts`) |

## 2.10 ACP (§J)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 112 | Inbound ACP server (`octop acp` — your agent driven by IDEs) | Missing | `docs/acp.md` → KriyaDot *consumes* ACP engines and serves MCP/A2A/AG-UI, but does not expose a bot over ACP |
| 113 | Outbound ACP delegation (`acp_runner`) | Present | `docs/acp.md` → ACP sessions API + delegation (`apps/api/src/acp-sessions-routes.ts`) |
| 114 | Built-in ACP runners (7: OpenCode, CodeBuddy, Claude Code, Codex, Kimi, Cursor, Pi) | Partial | `docs/acp.md` → first-class ACP presets only for Copilot + OpenCode; the rest are detection-registry entries via generic paths |

## 2.11 Models & providers (§K; DashScope preset 116 excluded as CN)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 115 | OpenAI-compatible provider presets | Present | `src/octop/infra/agents/providers/presets.py` → 12 presets + custom BYO OpenAI-compatible (`packages/agent-runtime/src/providers/catalog.json`) |
| 117 | Ollama local models | Present | `docs/cli.md` (`octop models`) → Ollama driver + local LLM management |
| 118 | OpenAI (ChatGPT) Codex OAuth provider | Present | `src/octop/infra/agents/providers/codex_oauth.py` → codex-subscription bridge (device-style CLI login reuse) |
| 119 | Reasoning-effort adaptation per provider/model | Partial | `src/octop/infra/agents/providers/reasoning.py` → per-bot `modelOptions` pass through; per-family reasoning-profile mapping not verified |
| 120 | Automatic model failover on health | Partial | `src/octop/infra/agents/providers/health.py` → failover exists but triggers on hard quota limits, not provider/model health |
| 121 | Local ONNX embedding provider | Partial | `src/octop/infra/agents/providers/onnx_service.py` → embeddings exist (local embedder behind memory hybrid search); a downloadable ONNX model catalog is not the mechanism |
| 122 | Cloud embedding presets | Partial | `presets.py` (`_embedding_cloud_presets`) → no distinct embedding-provider presets surface |
| 123 | Web-search providers (keyless fallback + keyed probing) | Partial | `src/octop/api/routers/search.py` → one built-in `web_search` implementation; multi-provider probing/fallback not matched |
| 124 | Image & video generation models | Partial | `src/octop/infra/agents/settings/media_generation.py` → media generation exists via muse-modules; Octop's named providers (Volcengine/DashScope/MiniMax) are CN — scored on the capability, which is thinner in KriyaDot |

## 2.12 Voice & multimodal (§L; Tencent realtime ASR 127 excluded as CN)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 125 | Speech-to-text | Partial | `src/octop/infra/voice/adapters.py` → real Whisper STT (Groq/OpenAI) exists but the **default is a mock** returning canned text |
| 126 | Text-to-speech | Partial | `src/octop/infra/voice/manager.py` → real TTS exists but the default is a mock sine tone; provider breadth is two key-gated services |
| 128 | Vision input handling | Partial | `src/octop/infra/gateway/media/` → image attachments exist; EXIF-aware downscaling and automatic upgrade to a vision model not verified |

## 2.13 Memory (§M)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 129 | Octop Memory (hierarchical recall + full-text search) | Present | `src/octop/infra/agents/memory/` → tiered atoms + hybrid search (trigram + FTS + RRF) |
| 130 | Portable memory (pack / adopt / doctor) | Partial | `src/octop/api/routers/memory_portable.py` → agent/session import exists; a memory-specific pack/adopt/doctor ritual does not |
| 131 | Hand-editable USER.md & MEMORY.md (manual wins, conflict review) | Present | `CHANGELOG.md [1.0.2]` → about-me profile + memory editor + memory-fabric conflict resolution |
| 132 | Memory backup, restore & slim | Partial | `docs/memory-slim.md` → nightly tidy is the slim analogue; memory-specific backup/restore commands are not distinct |
| 133 | Configurable memory extraction | Partial | `CHANGELOG.md [1.0.2b6]` → memory keeper is configurable (incl. optional live distill); extraction budgets/timeouts are not exposed |
| 134 | Manual memory-tree editing | Present | `src/octop/api/routers/memory.py` → atom create/correct/delete via API |

## 2.14 Knowledge base / RAG (§N)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 135 | Document knowledge bases (folders, limits, in-app editing) | Partial | `src/octop/infra/knowledge/` → document extraction + `kb_search` + notes exist; a managed corpus surface (folders, per-KB limits, original-layout preview) does not |
| 136 | Embedding sources for KB (local/cloud, rerank detection) | Partial | `src/octop/infra/knowledge/embed.py` → embeddings serve memory search; KB-specific embedding/rerank options are not a surface |
| 137 | OCR ingestion | Missing | `src/octop/infra/knowledge/ocr.py` → no OCR for scanned/image documents |
| 138 | Cited retrieval in chat | Partial | `src/octop/infra/knowledge/citations.py` → research tools return sources; KB citation markers clickable through to the source document not verified |
| 139 | In-deployment corpus sharing | Missing | `src/octop/infra/db/repos/knowledge.py` → no share-a-corpus-with-deployment-users feature |

## 2.15 Workspace storage backends (§O; COS 143, OSS 145, OBS 146 excluded as CN)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 140 | Local disk / filesystem backend | Present | `src/octop/infra/backend/adapter.py` → per-bot workspaces on local disk |
| 141 | Docker sandbox backend | Partial | `src/octop/infra/backend/docker_spec.py` → a docker *computer surface* exists; a pluggable per-expert storage/execution backend system does not |
| 142 | PostgreSQL workspace backend | Missing | `src/octop/infra/backend/postgres_spec.py` → expert files cannot live in PostgreSQL |
| 144 | S3-compatible backend | Missing | `adapter.py` (`s3`) → no S3/MinIO workspace backend |
| 147 | OpenSandbox remote sandbox backend | Partial | `adapter.py` (`opensandbox`) → E2B/Dot environments are the functional analogue (`apps/api/src/dots.ts`); OpenSandbox itself is absent |
| 148 | Composite & named backends + storage admin | Missing | `src/octop/infra/backend/resolver.py` → no named-backend registry or storage admin |
| 149 | Workspace file management in dashboard (docx editing, ZIP export/import) | Partial | `src/octop/api/routers/workspace.py` → file listing/upload exists; in-dashboard docx editing and ZIP workspace export/import do not |

## 2.16 Skills (§P)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 150 | Per-agent skills | Present | `src/octop/api/routers/skills.py` → skill store + per-bot assignment |
| 151 | SkillHub marketplace (network installs) | Partial | `src/octop/infra/skills/` → marketplace installs are from a bundled local registry only; no network skill hub |
| 152 | Conversational skill manager | Present | `src/octop/infra/agents/builtin_skills/skill-manager/SKILL.md` → `create_skill`/`learn_skill` tools let bots manage skills from chat |
| 153 | Global skill packages (mount, share, edit) | Partial | `src/octop/api/routers/skill_packages.py` → skill store covers attach/detach; mountable shared packages are thinner |
| 154 | Skill export/import with copy policy (`lock`/`deny`) | Missing | `CHANGELOG.md [1.0.2]` → no skill-package export with watermark/lock/deny copy policy |

## 2.17 Plugins (§Q)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 155 | Plugin system (tool / skill / hook / UI / channel kinds) | Missing | `plugins/README.md` → extension is MCP + skills; no plugin runtime with UI/hook/channel kinds |
| 156 | Bundled plugins (27 applets, seeded off) | Partial | `src/octop/infra/agents/plugins/bundled/` → muse-modules provide similar built-in applets (feed/goals/ideas/places/shopping…) but as product modules, not toggleable plugins |
| 157 | Demo / sample plugins in-repo | Missing | `plugins/demo-toolkit/plugin.yaml` et al. → no plugin demos (no plugin system) |
| 158 | Plugin install paths & marketplace page | Missing | `src/octop/cli/commands/plugin.py` → no plugin install (ZIP/URL/dir) or plugin market page |

## 2.18 Security & guardrails (§R)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 159 | Tool approval (HITL) flow | Present | `src/octop/infra/agents/security/policy_store.py` → governance approval cards; KriyaDot's default is stricter (deny-by-default; Octop ships with HITL off, guard in warn mode) |
| 160 | Shell command guardrails (user-editable YAML rules) | Partial | `src/octop/infra/agents/security/tool_guard_rules.py` → denylist + hard floors + per-bot policy exist; a user-editable YAML rule file is not the mechanism |
| 161 | PII redaction | Present | `src/octop/api/routers/security.py` → recursive secret/PII redaction + privacy tiers (`packages/governance/src/redact.ts`) |
| 162 | Filesystem & binary-read guards (+ bubblewrap jail) | Partial | `src/octop/infra/agents/middleware/binary_read_guard.py` → workspace confinement + sandbox modes exist; a bubblewrap execution jail does not |
| 163 | Sandboxed execution options | Partial | `docs/agent-backend-file-io.md` §13 → docker surface + E2B/Dots are options, not a backend-level sandbox choice per expert |

## 2.19 Scheduling, automation & proactivity (§S)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 164 | Cron jobs (agent or text tasks, multiple trigger kinds) | Present | `src/octop/infra/cron/` → routines with cron/interval/date-style schedules + event triggers; Octop's mail-event trigger is its own mail connector — the Gmail-polling equivalent exists (`apps/api/src/routine-events.ts`) |
| 165 | Cron from slash commands & IM | Partial | `src/octop/infra/cron/tools.py` → routines are managed via UI/API/CLI; slash/IM cron management is thinner |
| 166 | Proactive care pushes (agent-initiated check-ins) | Missing | `src/octop/infra/proactive/` → KriyaDot's proactivity is account-event *watching/triage*; an agent initiating a personal check-in from scored memory episodes does not exist |
| 167 | System scheduled tasks (TLS renewal, auto-backup) | Partial | `CHANGELOG.md [1.0.2b1]` → idle self-update exists; a general internal scheduled-task layer does not |

## 2.20 Host control: browser, terminal, desktop, mobile (§T)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 168 | Browser AI+ (persistent profiles, remote browsing) | Present | `src/octop/infra/control/browser/` → per-bot persistent Playwright profiles + live computer view |
| 169 | Browser session record → skill | Partial | `src/octop/api/routers/browser/record_replay.py` → KriyaDot records computer actions → *workflow* (`packages/workflows/src/recording-compiler.ts`), not → skill; Octop's own recorder is early-stage per its roadmap |
| 170 | Terminal AI+ (shared browser terminal) | Present | `src/octop/api/routers/terminal.py` → interactive terminal sessions with AI suggest/run (`apps/api/src/terminal.ts`) |
| 171 | Remote desktop (host screen streaming + input) | Partial | `src/octop/infra/control/desktop/` → companion remote screen exists; host-desktop streaming rides the env-opt-in real computer backend |
| 172 | Remote mobile phone (experimental in Octop) | Present | `src/octop/infra/control/mobile/` → phone-agent (accessibility actions, notification listener) + ADB path + bot phone tools — a shipped KriyaDot surface vs Octop's experimental one |

## 2.21 Desktop app, Docker (§U; FnOS 175 and cloud deploy buttons 177 excluded as CN)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 173 | Native desktop client (Wails shell) | Present | `desktop/README.md` → Tauri shell instead of Wails; tray, sidecar server, installers |
| 174 | Green portable runtime | Partial | `desktop/portable/` → a server binary build exists (`scripts/build-server-binary.sh`); a relocatable portable runtime zip as such does not |
| 176 | Docker deployment | Present | `docker/docker-compose.yml` → `docker-compose.yml` (secondary path; desktop is primary) |

## 2.22 CLI surface (§V)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 178 | Core lifecycle commands (init/run/service/update/clean/config) | Partial | `docs/cli.md` → serve/run/update/config analogues exist across CLI + API; a `service` manager command and `clean` do not |
| 179 | Resource commands (user/agent/channel/provider/models/skills/plugin/cron/backup/admin/captcha) | Partial | `docs/cli.md` → CLI covers bots/routines/models/MCP/teams/threads; user/channel/provider/plugin/backup/admin/captcha commands do not exist |
| 180 | `chats` REPL & session management | Present | `src/octop/cli/commands/chats.py` → CLI chat REPL + `threads list/show/branch/delete` |
| 181 | `acp` & `bridge` CLI groups | Partial | `docs/cli.md` → neither an ACP-server command nor Bridge commands exist (ACP is consumed via API/engines) |
| 182 | CLI acting-user/agent pinning & JSON output | Partial | `docs/cli.md` → CLI login/config with masked token exists; `--user`/`--agent` pinning for multi-user operation does not |

## 2.23 Observability & misc (§W)

| # | Feature | Status | Evidence — Octop → KriyaDot |
|---|---|---|---|
| 183 | Langfuse tracing integration | Missing | `src/octop/infra/agents/settings/langfuse.py` → KriyaDot has its own span store; no Langfuse export |
| 184 | Environment-variable management UI | Missing | `src/octop/api/routers/envs.py` → no admin env-file editor (settings exist for specific features only) |

## 2.24 Where KriyaDot is lacking vs Octop (ranked by user impact)

**Missing (33):**
1. **Bridge federation** (§2.8, #74–75, #77–79) — link two self-hosted instances, browse and chat with a peer's experts while history stays home-authoritative. KriyaDot has no instance federation at all; A2A/MCP cover only programmatic invocation. Octop's most distinctive capability.
2. **Proactive care** (§2.19, #166) — agents initiating check-ins on a randomised in-hours schedule, topic chosen by scoring memory episodes. KriyaDot watches *accounts*; it never reaches out socially on its own initiative.
3. **Plugin system** (§2.17, #155, #157–158) — no third-party plugin runtime (tool/skill/hook/UI/channel kinds), no plugin installs or market page. Extension today is MCP + skills only.
4. **Login SSO: OIDC + LDAP** (§2.2, #21–22) — matters the moment KriyaDot serves a real team/organisation rather than one local user; plus login captcha (#26).
5. **Decision model for skill/tool/team invocation** (§2.5, #52) — confidence-gated invocation decisions; KriyaDot's decision log only routes messages to bots.
6. **Knowledge-base depth** (§2.14) — OCR ingestion (#137) and in-deployment corpus sharing (#139) are missing outright; managed corpora with folders/limits are only Partial (#135).
7. **Pluggable workspace backends** (§2.15) — PostgreSQL (#142) and S3 (#144) expert-file backends and a named-backend registry (#148) are absent; files live on local disk (or a docker surface).
8. **Skill ecosystem reach** (§2.16) — no network SkillHub installs (Partial #151) and no copy-policy (`lock`/`deny`) skill-package export (#154).
9. **Inbound ACP server** (§2.10, #112) — a KriyaDot bot cannot be driven from Zed/IDEs over ACP; KriyaDot is an ACP *client* only.
10. **Deployment polish** (§2.1) — built-in TLS/Let's Encrypt (#8), subpath deployment (#9), interactive API docs (#12).
11. **Sub-agent profile library** (§2.5, #51) — no bundled library of hundreds of specialist profiles.
12. **Smaller singles** — MQTT channel (#71), plugin-provided channels (#73), OpenAlex/TickTick/Obsidian/Dify connectors (#99, #100, #105, #108 — each individually minor, and custom MCP covers some), composer skill insertion + text polish (#59), Langfuse export (#183), env-var management UI (#184).

**Partial (65) — the ones that matter most:**
1. **Voice defaults to mocks** (§2.12) — same root issue as in Part 1: real STT/TTS exist but are key-gated and non-default.
2. **Multi-user is real but shallow locally** (§2.2) — tenancy provides orgs/roles/invites, yet the everyday local mode is a loopback token + a UI-level people layer that the source itself says is not a security boundary; JWT, role templates, group resource grants and per-resource audiences are all thinner than Octop's.
3. **Expert market is a bundled file** (§2.3, #33–34) — 43 local entries, never fetched, not publishable by users of the deployment; expert creation/deletion also lack plain endpoints (#35, #40).
4. **Failover trigger differs** (§2.11, #120) — quota-limit failover exists; health-based automatic model switching does not.
5. **Memory portability ritual** (§2.13, #130, #132) — import exists; pack/adopt/doctor and memory-specific backup/slim do not.
6. **Conversation modes** (§2.3, #39) — Ask/Plan/Craft (what the agent may *do* this thread) is a different axis from KriyaDot's approval modes and isn't offered per thread.
7. **CLI breadth** (§2.22) — KriyaDot's CLI is chat/ops-focused; Octop's administers the whole deployment (users, channels, providers, plugins, backup, admin).
8. **Federation-adjacent chat** (§2.6, #54) — no mid-turn steering in chat; Octop steers a generating reply.

## 2.25 Excluded by your order — Octop CN-specific + hosted items (not counted as gaps)

Per your standing order, China-specific adapters are out of scope permanently. The 40
excluded numbered features: **IM channels** — Feishu/Lark (#62), DingTalk (#63), QQ (#64),
WeChat/weixin (#65), WeCom (#66), Tencent Yuanbao (#69), Huawei Xiaoyi (#70); **SSO** —
Feishu (#23), DingTalk (#24), WeCom (#25) OAuth logins; **connectors** — Tencent Docs
(#80), Tencent IMA (#81), Tencent Meeting (#82), Tencent News (#83), Weixin Reading (#84),
Tencent Lexiang (#85), Tencent Weiyun (#86), QQ Mail (#87), QQ Music (#88), Fliggy (#89),
Baidu Maps (#90), Trip.com Wendao (#91), Meituan Travel (#92), DiDi (#93), Yuandian (#94),
Qichacha (#95), Tencent Ardot (#96), Youdao Note (#97), Feishu CLI (#101), WeCom CLI
(#102), DingTalk CLI (#103), Yuque (#106), WeKnora (#107); **provider/backend/ASR** —
DashScope preset (#116), Tencent realtime ASR (#127), Tencent COS (#143), Alibaba OSS
(#145), Huawei OBS (#146) workspace backends; **packaging/deploy** — FnOS NAS .fpk
packages (#175), Tencent Cloud one-click deploy buttons (#177, also the only hosted-cloud
surface — Octop is otherwise fully self-hosted).

Also not counted, because they are **not in Octop's repo at all** (its own roadmap marks
them planned/closed): hosted Managed Agents, the native mobile client (closed beta),
cloud–edge continuum, project-scoped workspaces, self-evolution (auto-distilling skills),
conversational control plane, Octop Pet. AgentTeams **is** shipped but explicitly Beta —
it was scored as Present for KriyaDot on the strength of KriyaDot's teams + Chief, and
Octop's Beta limits (no nesting, no team sharing in v1) are noted in §2.5.

---

# Part 3 — Method, honesty notes, and where KriyaDot exceeds both

## Method

Both reference repos were cloned in full (all history and tags) and inventoried from
source + docs + changelogs by parallel inventory passes; KriyaDot was mapped independently
(226 capabilities checked against the composition root `apps/api/src/index.ts`, the main
router, the tool registry and the web UI) and every row above was scored against that map
with spot re-verification in source (e.g. the 16 MBTI templates in
`packages/agent-runtime/src/personas.ts`). Inventories are preserved at
`hidden_files/audit-scratch/openmausbot-inventory.md`,
`hidden_files/audit-scratch/octop-inventory.md`,
`hidden_files/audit-scratch/kriyadot-capability-map.md`.

## Honesty notes (KriyaDot weaknesses the scoring surfaced, whichever product exposed them)

- **Money is mocked end-to-end** in the platform billing layer (`MockBillingProvider` is
  the only provider; the vault wallet refuses charges). Bot *purchasing* logic is real, but
  browser checkout deliberately stops before the pay step and Stripe Link depends on a
  user-enabled vault setting.
- **Defaults are mocks in three user-facing places**: voice (STT/TTS), computer use (OS
  layer), and push (FCM no-ops without Firebase credentials; APNs has no server send path).
  The real implementations exist behind keys/env flags in each case.
- **Mobile/desktop are source-and-CI artefacts, not store artefacts**: Android APKs and the
  iOS app build in CI (iOS unsigned-simulator only); nothing is signed for distribution.
- **People-layer identity is not authentication** — KriyaDot's own source says so.
- **Figma briefing signals do not exist** (deliberately skipped in source, not faked);
  GitHub briefing signals are real.
- **Approval "families"** as a named taxonomy do not exist; approvals differ by tool,
  policy rule and provenance.

## Where KriyaDot exceeds both reference products

- **Observability**: span store with waterfall + recorded replay, outcome labels, per-bot
  success rates, tool-cost attribution and loop detection (neither reference product ships
  this combination; Octop offers an optional Langfuse export instead).
- **Purchasing governance**: approval-gated purchases with hard category blocks enforced
  twice and a spend ledger (OpenMausBot has spend caps only; Octop has no purchasing).
- **Phone operation**: a dedicated Android phone-agent (accessibility actions, notification
  listener feeding server-side triage) — deeper than Octop's experimental remote phone and
  broader than OpenMausBot's data-level phone tools in the control direction.
- **Proactive account watching with triage** (Gmail/Slack/GitHub/Stripe/Calendar) and a
  "needs you" inbox — neither reference product watches connected accounts this way.
- **Workflow engine**: node/edge workflows with versions, triggers, code sandbox and n8n
  import/export; a TUI; a red-team harness; A2A + AG-UI protocol surfaces; per-bot MCP
  isolation with schema pinning (TOFU); git worktrees per session; user data tables.
- **Safety posture**: deny-by-default governance with a non-approvable catastrophic floor
  (Octop ships its guard in warn mode with HITL off by default).
